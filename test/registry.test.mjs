/**
 * Lifecycle tests for the attempt registry, driven by stubs of the two seams.
 *
 * The stubs implement the documented seam contracts, not this plugin's
 * expectations of them, so a change in how the registry treats a notice, a
 * prompt, a withdrawal or an outcome shows up here rather than in a browser.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { AttemptRegistry, LoginError, keyId, keyScope } from '../lib/registry.js'

/** A stub of `ctx.authorization` following its documented contract. */
function authorizationStub() {
  const flows = []
  const running = new Map()
  return {
    flows,
    /** Offer a flow; the returned disposer withdraws it. */
    registerFlow(flow) {
      flows.push(flow)
      return () => {
        const index = flows.indexOf(flow)
        if (index >= 0) flows.splice(index, 1)
      }
    },
    list() {
      return flows.map((flow) => ({
        key: flow.key,
        label: flow.label,
        methods: flow.methods,
        inFlight: running.has(String(flow.key)),
      }))
    },
    describe(key) {
      const flow = flows.find((candidate) => String(candidate.key) === String(key))
      if (flow === undefined) return undefined
      return {
        key: flow.key,
        label: flow.label,
        methods: flow.methods,
        inFlight: running.has(String(flow.key)),
      }
    },
    cancel(key) {
      const active = running.get(String(key))
      if (active !== undefined) active.controller.abort(new Error('cancelled'))
    },
    async begin({ key, method, interaction, signal }) {
      const text = String(key)
      const flow = flows.find((candidate) => String(candidate.key) === text)
      if (flow === undefined) throw new Error(`NO_FLOW ${text}`)
      if (running.has(text)) throw new Error(`ALREADY_IN_FLIGHT ${text}`)
      const controller = new AbortController()
      running.set(text, { controller })
      const session = {
        method: method ?? flow.methods[0].id,
        signal: controller.signal,
        notify: (notice) => interaction.notify(notice),
        prompt: (prompt) => interaction.prompt(prompt),
      }
      try {
        await flow.run(session)
        return { status: 'authorized' }
      } catch (error) {
        // The documented rule: a withdrawn attempt settles cancelled, anything
        // else reaches the caller as a thrown error.
        if (controller.signal.aborted) return { status: 'cancelled' }
        throw error
      } finally {
        running.delete(text)
      }
    },
  }
}

/** A stub of `ctx.credentials` over an in-memory record map. */
function credentialsStub(seed = {}) {
  const records = new Map(Object.entries(seed))
  return {
    records,
    async listRecords() {
      return [...records.entries()].map(([key, record]) => ({ key, kind: record.kind }))
    },
    async describeRecord(key) {
      const record = records.get(String(key))
      return record === undefined
        ? { configured: false, writable: true }
        : { configured: true, kind: record.kind, writable: true }
    },
    async deleteRecord(key) {
      records.delete(String(key))
    },
  }
}

/** A registry over fresh stubs, plus the pieces a test needs to drive it. */
function harness({ seed, timeoutMs } = {}) {
  const authorization = authorizationStub()
  const credentials = credentialsStub(seed)
  const registry = new AttemptRegistry({
    authorization,
    credentials,
    ...(timeoutMs === undefined ? {} : { attemptTimeoutMs: timeoutMs }),
  })
  return { authorization, credentials, registry }
}

/**
 * Poll like the browser does until the attempt is over.
 *
 * One `wait()` is not enough by design: events and the terminal outcome are
 * separate deliveries, so a client that answered a prompt sees the answer
 * acknowledged first and the outcome on its next poll.
 */
async function untilDone(registry, attemptId, cursor = 0) {
  let page = await registry.wait(attemptId, cursor, 500)
  for (let attempt = 0; attempt < 20 && !page.done; attempt += 1) {
    page = await registry.wait(attemptId, page.cursor, 500)
  }
  assert.equal(page.done, true, 'attempt never settled')
  return page
}

test('key helpers split the documented <scope>/<id> grammar', () => {
  assert.equal(keyId('llm-pi-ai/openai-codex'), 'openai-codex')
  assert.equal(keyScope('llm-pi-ai/openai-codex'), 'llm-pi-ai')
  assert.equal(keyId('bare'), 'bare')
  assert.equal(keyScope('bare'), '')
})

test('list() reports each flow with the state of the record it writes', async () => {
  const { authorization, credentials, registry } = harness({
    seed: { 'llm-pi-ai/anthropic': { kind: 'grant' } },
  })
  authorization.registerFlow({
    key: 'llm-pi-ai/anthropic',
    label: 'Anthropic',
    methods: [{ id: 'oauth', label: 'Sign in with Claude' }],
    run: async () => {},
  })
  authorization.registerFlow({
    key: 'llm-pi-ai/github-copilot',
    label: 'GitHub Copilot',
    methods: [{ id: 'oauth', label: 'Sign in with GitHub' }],
    run: async () => {},
  })

  const { flows, orphaned } = await registry.list()
  assert.equal(flows.length, 2)
  assert.deepEqual(flows[0], {
    key: 'llm-pi-ai/anthropic',
    id: 'anthropic',
    scope: 'llm-pi-ai',
    label: 'Anthropic',
    methods: [{ id: 'oauth', label: 'Sign in with Claude' }],
    inFlight: false,
    record: { configured: true, kind: 'grant', writable: true },
  })
  assert.equal(flows[1].record.configured, false)
  assert.deepEqual(orphaned, [])
  assert.equal(credentials.records.size, 1)
})

test('list() reports records in scope that no flow claims, and nothing outside it', async () => {
  const { authorization, registry } = harness({
    seed: {
      'llm-pi-ai/openai-codex': { kind: 'grant' },
      'llm-pi-ai/retired-provider': { kind: 'grant' },
      'some-other-plugin/thing': { kind: 'api-key' },
    },
  })
  authorization.registerFlow({
    key: 'llm-pi-ai/openai-codex',
    label: 'OpenAI Codex',
    methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
    run: async () => {},
  })

  const { orphaned } = await registry.list()
  assert.deepEqual(orphaned, [
    { key: 'llm-pi-ai/retired-provider', id: 'retired-provider', scope: 'llm-pi-ai', kind: 'grant' },
  ])
})

test('begin() refuses a key no flow claims', async () => {
  const { registry } = harness()
  await assert.rejects(
    () => registry.begin('llm-pi-ai/nope'),
    (error) => error instanceof LoginError && error.status === 404 && error.code === 'NO_FLOW',
  )
})

test('begin() refuses a method the flow does not offer', async () => {
  const { authorization, registry } = harness()
  authorization.registerFlow({
    key: 'llm-pi-ai/anthropic',
    label: 'Anthropic',
    methods: [{ id: 'oauth', label: 'OAuth' }],
    run: async () => {},
  })
  await assert.rejects(
    () => registry.begin('llm-pi-ai/anthropic', 'api-key'),
    (error) => error instanceof LoginError && error.status === 400 && error.code === 'UNKNOWN_METHOD',
  )
})

test('begin() refuses a second attempt for the same key', async () => {
  const { authorization, registry } = harness()
  let release
  authorization.registerFlow({
    key: 'llm-pi-ai/openai-codex',
    label: 'OpenAI Codex',
    methods: [{ id: 'oauth', label: 'OAuth' }],
    run: () => new Promise((resolve) => { release = resolve }),
  })

  const first = await registry.begin('llm-pi-ai/openai-codex')
  assert.equal(first.method, 'oauth')
  await assert.rejects(
    () => registry.begin('llm-pi-ai/openai-codex'),
    (error) => error instanceof LoginError && error.status === 409 && error.code === 'ALREADY_IN_FLIGHT',
  )

  registry.cancel(first.attemptId)
  release()
})

test('a notice reaches a waiting client, projected to its three fields', async () => {
  const { authorization, registry } = harness()
  authorization.registerFlow({
    key: 'llm-pi-ai/openai-codex',
    label: 'OpenAI Codex',
    methods: [{ id: 'oauth', label: 'OAuth' }],
    async run(session) {
      session.notify({
        message: 'Continue in your browser',
        url: 'https://auth.example/start',
        code: 'ABCD-1234',
        secret: 'must-not-cross-the-wire',
      })
    },
  })

  const { attemptId } = await registry.begin('llm-pi-ai/openai-codex')
  const page = await registry.wait(attemptId, 0, 50)
  const notice = page.events.find((event) => event.type === 'notice')
  assert.deepEqual(notice.notice, {
    message: 'Continue in your browser',
    url: 'https://auth.example/start',
    code: 'ABCD-1234',
  })
  assert.equal(JSON.stringify(page).includes('must-not-cross-the-wire'), false)
})

test('a prompt parks the flow until the client answers it', async () => {
  const { authorization, registry } = harness()
  let received
  authorization.registerFlow({
    key: 'llm-pi-ai/github-copilot',
    label: 'GitHub Copilot',
    methods: [{ id: 'oauth', label: 'OAuth' }],
    async run(session) {
      received = await session.prompt({ kind: 'secret', message: 'Paste the device code', placeholder: 'XXXX' })
    },
  })

  const { attemptId } = await registry.begin('llm-pi-ai/github-copilot')
  const asked = await registry.wait(attemptId, 0, 50)
  const prompt = asked.events.find((event) => event.type === 'prompt')
  assert.equal(prompt.prompt.kind, 'secret')
  assert.equal(prompt.prompt.message, 'Paste the device code')
  assert.equal(prompt.prompt.placeholder, 'XXXX')

  registry.answer(attemptId, prompt.promptId, 'WXYZ-9876')
  const settled = await untilDone(registry, attemptId, asked.cursor)
  assert.equal(received, 'WXYZ-9876')
  assert.equal(settled.outcome, 'authorized')
})

test('a select prompt carries its options and answers with the chosen id', async () => {
  const { authorization, registry } = harness()
  let received
  authorization.registerFlow({
    key: 'llm-pi-ai/github-copilot',
    label: 'GitHub Copilot',
    methods: [{ id: 'oauth', label: 'OAuth' }],
    async run(session) {
      received = await session.prompt({
        kind: 'select',
        message: 'Which account?',
        options: [
          { id: 'personal', label: 'Personal', description: 'github.com' },
          { id: 'work', label: 'Work' },
        ],
      })
    },
  })

  const { attemptId } = await registry.begin('llm-pi-ai/github-copilot')
  const asked = await registry.wait(attemptId, 0, 50)
  const prompt = asked.events.find((event) => event.type === 'prompt')
  assert.deepEqual(prompt.prompt.options, [
    { id: 'personal', label: 'Personal', description: 'github.com' },
    { id: 'work', label: 'Work' },
  ])

  registry.answer(attemptId, prompt.promptId, 'work')
  const settled = await untilDone(registry, attemptId, asked.cursor)
  assert.equal(received, 'work')
  assert.equal(settled.outcome, 'authorized')
})

test('answer() refuses a question the attempt is not waiting on', async () => {
  const { authorization, registry } = harness()
  authorization.registerFlow({
    key: 'llm-pi-ai/anthropic',
    label: 'Anthropic',
    methods: [{ id: 'oauth', label: 'OAuth' }],
    run: () => new Promise(() => {}),
  })
  const { attemptId } = await registry.begin('llm-pi-ai/anthropic')
  assert.throws(
    () => registry.answer(attemptId, 'p404', 'x'),
    (error) => error instanceof LoginError && error.code === 'NO_PROMPT',
  )
  registry.cancel(attemptId)
})

test('a prompt withdrawn by its own signal rejects without cancelling the attempt', async () => {
  const { authorization, registry } = harness()
  let outcome
  authorization.registerFlow({
    key: 'llm-pi-ai/openai-codex',
    label: 'OpenAI Codex',
    methods: [{ id: 'oauth', label: 'OAuth' }],
    async run(session) {
      const controller = new AbortController()
      const racing = session.prompt({ kind: 'text', message: 'typing?', signal: controller.signal })
      controller.abort()
      try {
        await racing
        outcome = 'resolved'
      } catch {
        outcome = 'withdrawn'
      }
    },
  })

  const { attemptId } = await registry.begin('llm-pi-ai/openai-codex')
  const done = await untilDone(registry, attemptId)
  assert.equal(outcome, 'withdrawn')
  // The losing half of a race is not the human declining, so the attempt still
  // finishes as authorized rather than cancelled.
  assert.equal(done.outcome, 'authorized')
})

test('cancel() settles the attempt as cancelled and frees the key', async () => {
  const { authorization, registry } = harness()
  authorization.registerFlow({
    key: 'llm-pi-ai/openai-codex',
    label: 'OpenAI Codex',
    methods: [{ id: 'oauth', label: 'OAuth' }],
    run: (session) =>
      new Promise((_resolve, reject) => {
        session.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
  })

  const { attemptId } = await registry.begin('llm-pi-ai/openai-codex')
  registry.cancel(attemptId)
  const page = await registry.wait(attemptId, 0, 50)
  assert.equal(page.done, true)
  assert.equal(page.outcome, 'cancelled')
  assert.equal(page.failure, undefined)
})

test('a flow that fails for another reason reports the failure, not an outcome', async () => {
  const { authorization, registry } = harness()
  authorization.registerFlow({
    key: 'llm-pi-ai/openrouter',
    label: 'OpenRouter',
    methods: [{ id: 'oauth', label: 'OAuth' }],
    async run() {
      throw new Error('token exchange returned 502')
    },
  })

  const { attemptId } = await registry.begin('llm-pi-ai/openrouter')
  const page = await registry.wait(attemptId, 0, 200)
  assert.equal(page.done, true)
  assert.equal(page.outcome, undefined)
  assert.equal(page.failure, 'token exchange returned 502')
})

test('an idle attempt is abandoned at its deadline', async () => {
  const { authorization, registry } = harness({ timeoutMs: 20 })
  authorization.registerFlow({
    key: 'llm-pi-ai/openai-codex',
    label: 'OpenAI Codex',
    methods: [{ id: 'oauth', label: 'OAuth' }],
    run: (session) =>
      new Promise((_resolve, reject) => {
        session.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
  })

  const { attemptId } = await registry.begin('llm-pi-ai/openai-codex')
  const page = await untilDone(registry, attemptId)
  assert.equal(page.outcome, 'cancelled')
})

test('logout() deletes in-scope records and refuses everything else', async () => {
  const { authorization, credentials, registry } = harness({
    seed: {
      'llm-pi-ai/openai-codex': { kind: 'grant' },
      'other-plugin/secret': { kind: 'api-key' },
    },
  })
  authorization.registerFlow({
    key: 'llm-pi-ai/openai-codex',
    label: 'OpenAI Codex',
    methods: [{ id: 'oauth', label: 'OAuth' }],
    run: async () => {},
  })

  await registry.logout('llm-pi-ai/openai-codex')
  assert.equal(credentials.records.has('llm-pi-ai/openai-codex'), false)

  await assert.rejects(
    () => registry.logout('other-plugin/secret'),
    (error) => error instanceof LoginError && error.code === 'NO_RECORD',
  )
  assert.equal(credentials.records.has('other-plugin/secret'), true)

  await assert.rejects(
    () => registry.logout('llm-pi-ai/never-existed'),
    (error) => error instanceof LoginError && error.code === 'NO_RECORD',
  )
})

test('wait() parks, then reports nothing new rather than inventing an event', async () => {
  const { authorization, registry } = harness()
  authorization.registerFlow({
    key: 'llm-pi-ai/anthropic',
    label: 'Anthropic',
    methods: [{ id: 'oauth', label: 'OAuth' }],
    run: () => new Promise(() => {}),
  })
  const { attemptId } = await registry.begin('llm-pi-ai/anthropic')
  const started = Date.now()
  const page = await registry.wait(attemptId, 0, 60)
  assert.equal(page.events.length, 0)
  assert.equal(page.cursor, 0)
  assert.equal(page.done, false)
  assert.ok(Date.now() - started >= 40, 'the wait should have parked for its timeout')
  registry.cancel(attemptId)
})

test('dispose() withdraws every running attempt', async () => {
  const { authorization, registry } = harness()
  let aborted = false
  authorization.registerFlow({
    key: 'llm-pi-ai/openai-codex',
    label: 'OpenAI Codex',
    methods: [{ id: 'oauth', label: 'OAuth' }],
    run: (session) =>
      new Promise((_resolve, reject) => {
        session.signal.addEventListener(
          'abort',
          () => {
            aborted = true
            reject(new Error('aborted'))
          },
          { once: true },
        )
      }),
  })

  await registry.begin('llm-pi-ai/openai-codex')
  registry.dispose()
  assert.equal(aborted, true)
  await assert.rejects(
    () => registry.wait('a1', 0, 10),
    (error) => error instanceof LoginError && error.code === 'NO_ATTEMPT',
  )
})
