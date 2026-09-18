/**
 * Router tests: the HTTP shape of the console, exercised without a socket.
 *
 * The router is a pure function of the registry and one already-parsed request,
 * so every status, code, and delegation below is the real behaviour a browser
 * sees — the Node request/response adapter and the connection trust fence live
 * in `lib/index.js` and are covered separately.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { BASE_PATH, createRouter } from '../lib/router.js'
import { LoginError } from '../lib/registry.js'

/** A registry stand-in recording how each route delegated. */
function registryStub(overrides = {}) {
  const calls = []
  return {
    calls,
    async list() {
      calls.push(['list'])
      return { flows: [], orphaned: [] }
    },
    async begin(key, method) {
      calls.push(['begin', key, method])
      return { attemptId: 'a1', key, label: 'OpenAI Codex', method: method ?? 'oauth' }
    },
    async wait(attemptId, cursor, timeoutMs) {
      calls.push(['wait', attemptId, cursor, timeoutMs])
      return { attemptId, events: [], cursor, done: false }
    },
    answer(attemptId, promptId, value) {
      calls.push(['answer', attemptId, promptId, value])
      return { ok: true }
    },
    cancel(attemptId) {
      calls.push(['cancel', attemptId])
      return { ok: true }
    },
    async logout(key) {
      calls.push(['logout', key])
      return { ok: true }
    },
    ...overrides,
  }
}

const request = (method, path, extra = {}) => ({ method, path: BASE_PATH + path, ...extra })

test('GET flows answers with the registry listing', async () => {
  const registry = registryStub({
    async list() {
      return { flows: [{ key: 'llm-pi-ai/anthropic' }], orphaned: [] }
    },
  })
  const response = await createRouter(registry)(request('GET', 'flows'))
  assert.equal(response.status, 200)
  assert.deepEqual(response.body.flows, [{ key: 'llm-pi-ai/anthropic' }])
})

test('POST attempts starts one and answers 201 with its identity', async () => {
  const registry = registryStub()
  const response = await createRouter(registry)(
    request('POST', 'attempts', { body: { key: 'llm-pi-ai/openai-codex' } }),
  )
  assert.equal(response.status, 201)
  assert.equal(response.body.attemptId, 'a1')
  assert.deepEqual(registry.calls, [['begin', 'llm-pi-ai/openai-codex', undefined]])
})

test('POST attempts passes an explicitly chosen method through', async () => {
  const registry = registryStub()
  await createRouter(registry)(
    request('POST', 'attempts', { body: { key: 'llm-pi-ai/anthropic', method: 'api-key' } }),
  )
  assert.deepEqual(registry.calls, [['begin', 'llm-pi-ai/anthropic', 'api-key']])
})

test('POST attempts without a key is a coded 400', async () => {
  const response = await createRouter(registryStub())(request('POST', 'attempts', { body: {} }))
  assert.equal(response.status, 400)
  assert.equal(response.body.code, 'BAD_REQUEST')
})

test('GET attempts/<id> forwards the cursor and the requested wait', async () => {
  const registry = registryStub()
  const response = await createRouter(registry)(
    request('GET', 'attempts/a7', { query: { cursor: '4', timeout: '1500' } }),
  )
  assert.equal(response.status, 200)
  assert.deepEqual(registry.calls, [['wait', 'a7', 4, 1500]])
})

test('GET attempts/<id> clamps an unreasonable wait and defaults an absent one', async () => {
  const registry = registryStub()
  const router = createRouter(registry)
  await router(request('GET', 'attempts/a7', { query: { timeout: '999999' } }))
  await router(request('GET', 'attempts/a7', { query: {} }))
  assert.deepEqual(registry.calls[0], ['wait', 'a7', 0, 60_000])
  assert.deepEqual(registry.calls[1], ['wait', 'a7', 0, 25_000])
})

test('POST answers and cancel address one attempt', async () => {
  const registry = registryStub()
  const router = createRouter(registry)
  await router(request('POST', 'attempts/a3/answers', { body: { promptId: 'p1', value: 'CODE' } }))
  await router(request('POST', 'attempts/a3/cancel', { body: {} }))
  assert.deepEqual(registry.calls, [
    ['answer', 'a3', 'p1', 'CODE'],
    ['cancel', 'a3'],
  ])
})

test('POST answers without a promptId is a coded 400', async () => {
  const response = await createRouter(registryStub())(
    request('POST', 'attempts/a3/answers', { body: { value: 'x' } }),
  )
  assert.equal(response.status, 400)
  assert.equal(response.body.code, 'BAD_REQUEST')
})

test('POST logout names one record', async () => {
  const registry = registryStub()
  await createRouter(registry)(request('POST', 'logout', { body: { key: 'llm-pi-ai/openai-codex' } }))
  assert.deepEqual(registry.calls, [['logout', 'llm-pi-ai/openai-codex']])
})

test('a trailing slash and a query string do not change the route', async () => {
  const registry = registryStub()
  const response = await createRouter(registry)({
    method: 'GET',
    path: BASE_PATH + 'flows/',
    query: { ignored: '1' },
  })
  assert.equal(response.status, 200)
})

test('an unknown path is a 404 and a wrong method is a 405 naming the right one', async () => {
  const router = createRouter(registryStub())
  const missing = await router(request('GET', 'nope'))
  assert.equal(missing.status, 404)

  const wrong = await router(request('GET', 'attempts', { body: {} }))
  assert.equal(wrong.status, 405)
  assert.equal(wrong.headers.allow, 'POST')
})

test('a request outside the plugin prefix is not this router at all', async () => {
  const response = await createRouter(registryStub())({ method: 'GET', path: '/api/other' })
  assert.equal(response.status, 404)
  assert.equal(response.body.code, 'NOT_FOUND')
})

test('a LoginError becomes its own status and code', async () => {
  const registry = registryStub({
    async begin() {
      throw new LoginError(409, 'ALREADY_IN_FLIGHT', 'a sign-in is already running')
    },
  })
  const response = await createRouter(registry)(
    request('POST', 'attempts', { body: { key: 'llm-pi-ai/openai-codex' } }),
  )
  assert.equal(response.status, 409)
  assert.equal(response.body.code, 'ALREADY_IN_FLIGHT')
  assert.equal(response.body.message, 'a sign-in is already running')
})

test('an unexpected throw is reported as this plugin failing, not as a flow outcome', async () => {
  const registry = registryStub({
    async list() {
      throw new TypeError('registry is broken')
    },
  })
  const response = await createRouter(registry)(request('GET', 'flows'))
  assert.equal(response.status, 500)
  assert.equal(response.body.code, 'INTERNAL')
  assert.equal(response.body.message, 'registry is broken')
})
