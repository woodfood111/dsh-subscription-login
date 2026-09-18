/**
 * Browser-half tests: the real `lib/client.js` driven through stubs.
 *
 * The file under test is the artifact that ships — it is hand-written in the
 * client module format and never bundled — so it is loaded here exactly the way
 * the shell loads it: a `window.__ModuleLoader__.load` registration whose
 * factory is handed a `require`. React is a small shim with working
 * `useState`/`useEffect`, which is enough to render the console, run its data
 * effects, and assert on the tree a browser would receive.
 *
 * What this cannot cover is the DOM itself: how the tree paints, whether the
 * stylesheet looks right, and whether the browser's fetch actually reaches the
 * host. Those need a browser; everything else is checked here.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

/**
 * A React shim with just enough runtime for this component: ordered hooks, a
 * dependency check on effects, and a render loop that repeats when an effect
 * changed state.
 */
function createReact() {
  let states = []
  let effectDeps = []
  let callbackSlots = []
  let index = 0
  let dirty = false
  let pending = []

  /** Whether two dependency lists differ, treating an absent list as always-different. */
  const depsChanged = (previous, deps) =>
    previous === undefined ||
    deps === undefined ||
    previous.length !== deps.length ||
    deps.some((entry, position) => !Object.is(entry, previous[position]))

  /** Let queued microtasks and timers land, so a non-awaited async effect can setState. */
  const settle = async (ticks = 6) => {
    for (let tick = 0; tick < ticks && !dirty; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  const react = {
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }
    },
    useState(initial) {
      const slot = index++
      if (!(slot in states)) states[slot] = typeof initial === 'function' ? initial() : initial
      return [
        states[slot],
        (next) => {
          const value = typeof next === 'function' ? next(states[slot]) : next
          if (!Object.is(value, states[slot])) {
            states[slot] = value
            dirty = true
          }
        },
      ]
    },
    useCallback(fn, deps) {
      const slot = index++
      const previous = callbackSlots[slot]
      if (previous === undefined || depsChanged(previous.deps, deps)) callbackSlots[slot] = { fn, deps }
      return callbackSlots[slot].fn
    },
    useRef(initial) {
      const slot = index++
      if (!(slot in states)) states[slot] = { current: initial }
      return states[slot]
    },
    useEffect(fn, deps) {
      const slot = index++
      const previous = effectDeps[slot]
      if (depsChanged(previous, deps)) {
        effectDeps[slot] = deps
        pending.push(fn)
      }
    },
    /**
     * Render, run the effects that fired, and repeat while state moved.
     *
     * Effects are not awaited by React either, so each pass runs them and then
     * lets the microtask queue drain before deciding whether another render is
     * needed — which is what lets an effect whose arrow returns undefined still
     * deliver its fetch result.
     */
    async mount(component, props) {
      let tree
      for (let pass = 0; pass < 20; pass += 1) {
        dirty = false
        index = 0
        pending = []
        tree = component(props)
        const effects = pending
        pending = []
        for (const effect of effects) await effect()
        await settle()
        if (!dirty) break
      }
      return tree
    },
    reset() {
      states = []
      effectDeps = []
      callbackSlots = []
    },
  }
  return react
}

/** A `fetch` stand-in serving the plugin's own routes. A route may be a value
 * or a function of the full URL, for endpoints whose answer depends on the
 * cursor the client sends. */
function fetchStub(routes) {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    const path = String(url)
    calls.push({ url: path, method: options.method ?? 'GET', body: options.body })
    const route = routes[path.split('?')[0]]
    if (route === undefined) {
      return {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => JSON.stringify({ code: 'NOT_FOUND', message: `no stub for ${path}` }),
      }
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify(typeof route === 'function' ? route(path, options) : route),
    }
  }
  fetchImpl.calls = calls
  return fetchImpl
}

/** Every string in a rendered tree, flattened. */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node === 'object' && node.props !== undefined) return textOf(node.props.children)
  return ''
}

/** Every element in a rendered tree, flattened. */
function nodesOf(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const entry of node) nodesOf(entry, out)
    return out
  }
  out.push(node)
  nodesOf(node.props?.children, out)
  return out
}

/**
 * Load the shipping client file into a controlled environment.
 *
 * @param react - the React shim to hand the factory.
 * @param fetchImpl - the fetch stand-in.
 * @returns the module's exports, plus captured registration on `window`.
 */
function loadClient({ react, fetchImpl }) {
  const registered = []
  const window = {
    __ModuleLoader__: { load: (registration) => registered.push(registration) },
    confirm: () => true,
  }
  const document = {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild: () => {} },
  }
  const navigator = { clipboard: { writeText: async () => {} } }

  const factory = new Function('window', 'document', 'navigator', 'fetch', source)
  factory(window, document, navigator, fetchImpl)

  assert.equal(registered.length, 1, 'the client file must register exactly once')
  const moduleExports = registered[0].factory((id) => {
    assert.equal(id, 'react', `unexpected module request: ${id}`)
    return react
  })
  return { exports: moduleExports, registration: registered[0], window }
}

test('the client file registers one module and exposes the plugin surface', () => {
  const { exports, registration } = loadClient({ react: createReact(), fetchImpl: fetchStub({}) })
  assert.equal(registration.id, 'dsh-subscription-login')
  assert.deepEqual(exports.inject, ['slots', 'locale'])
  assert.equal(typeof exports.apply, 'function')
  assert.equal(typeof exports.LoginConsole, 'function')
})

test('apply() registers both dictionaries and one settings tab', () => {
  const { exports } = loadClient({ react: createReact(), fetchImpl: fetchStub({}) })
  const dictionaries = []
  const tabs = []
  const effects = []
  const ctx = {
    effect: (fn) => effects.push(fn()),
    locale: {
      register: (namespace, values) => dictionaries.push({ namespace, values }),
      bind: () => (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`),
    },
    slots: {
      inject: (name, run) => {
        assert.equal(name, 'settings.plugins.tab')
        run()
      },
      register: (registration, component) => tabs.push({ registration, component }),
    },
  }

  exports.apply(ctx)

  assert.equal(dictionaries.length, 1)
  assert.equal(dictionaries[0].namespace, 'subscription-login')
  assert.equal(dictionaries[0].values.zh['title'], '订阅登录台')
  assert.equal(dictionaries[0].values.en['title'], 'Subscription sign-in')
  // Both dictionaries must carry the same key set, or one language renders keys.
  assert.deepEqual(Object.keys(dictionaries[0].values.zh).sort(), Object.keys(dictionaries[0].values.en).sort())

  assert.equal(tabs.length, 1)
  assert.equal(tabs[0].registration.name, 'settings.plugins.tab')
  assert.equal(tabs[0].registration.id, 'subscription-login')
  assert.equal(tabs[0].registration.locale, 'subscription-login')
  assert.equal(typeof tabs[0].registration.label(), 'string')
})

test('pendingPrompt() finds the live question and ignores an answered one', () => {
  const { exports } = loadClient({ react: createReact(), fetchImpl: fetchStub({}) })
  assert.equal(exports.pendingPrompt([]), null)
  assert.equal(
    exports.pendingPrompt([
      { type: 'prompt', promptId: 'p1', prompt: { kind: 'text', message: 'code?' } },
      { type: 'answered', promptId: 'p1' },
    ]),
    null,
  )
  const live = exports.pendingPrompt([
    { type: 'prompt', promptId: 'p1', prompt: { kind: 'text', message: 'first' } },
    { type: 'answered', promptId: 'p1' },
    { type: 'notice', notice: { message: 'working' } },
    { type: 'prompt', promptId: 'p2', prompt: { kind: 'secret', message: 'second' } },
  ])
  assert.equal(live.promptId, 'p2')
  assert.equal(live.prompt.message, 'second')
})

test('noticesOf() collects notices in arrival order', () => {
  const { exports } = loadClient({ react: createReact(), fetchImpl: fetchStub({}) })
  assert.deepEqual(exports.noticesOf([]), [])
  assert.deepEqual(
    exports.noticesOf([
      { type: 'notice', notice: { message: 'one' } },
      { type: 'prompt', promptId: 'p1', prompt: { kind: 'text', message: 'q' } },
      { type: 'notice', notice: { message: 'two' } },
    ]),
    [{ message: 'one' }, { message: 'two' }],
  )
})

test('the console lists every flow with its state and offers the right actions', async () => {
  const react = createReact()
  const fetchImpl = fetchStub({
    '/plugins/dsh-subscription-login/flows': {
      flows: [
        {
          key: 'llm-pi-ai/openai-codex',
          id: 'openai-codex',
          scope: 'llm-pi-ai',
          label: 'OpenAI Codex',
          methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
          inFlight: false,
          record: { configured: false, kind: null, writable: true },
        },
        {
          key: 'llm-pi-ai/anthropic',
          id: 'anthropic',
          scope: 'llm-pi-ai',
          label: 'Anthropic',
          methods: [{ id: 'oauth', label: 'Sign in with Claude' }],
          inFlight: false,
          record: { configured: true, kind: 'grant', writable: true },
        },
      ],
      orphaned: [
        { key: 'llm-pi-ai/retired-provider', id: 'retired-provider', scope: 'llm-pi-ai', kind: 'grant' },
      ],
    },
  })
  const { exports } = loadClient({ react, fetchImpl })
  const t = (key, params) => (params === undefined ? key : `${key}(${JSON.stringify(params)})`)

  const tree = await react.mount(exports.LoginConsole, { t })
  const text = textOf(tree)
  const classes = nodesOf(tree).map((node) => node.props?.className).filter(Boolean)

  assert.match(text, /OpenAI Codex/)
  assert.match(text, /llm-pi-ai\/openai-codex/)
  assert.match(text, /Anthropic/)
  // Both a signed-out and a signed-in row render, and only the signed-in one
  // offers a sign-out action.
  assert.ok(classes.some((name) => name.includes('dsl_chipOff')), 'a signed-out chip should render')
  assert.ok(classes.some((name) => name.includes('dsl_chipOn')), 'a signed-in chip should render')
  assert.match(text, /signedOut/)
  assert.match(text, /signedIn/)
  assert.match(text, /kindGrant/)
  // The orphan section names the record no flow claims.
  assert.match(text, /llm-pi-ai\/retired-provider/)
  assert.match(text, /orphanTitle/)
  // The scope note is always shown once a snapshot exists.
  assert.match(text, /scopeTitle/)

  assert.deepEqual(fetchImpl.calls.map((call) => call.url), ['/plugins/dsh-subscription-login/flows'])
})

test('the console renders its empty state without inventing a control', async () => {
  const react = createReact()
  const fetchImpl = fetchStub({
    '/plugins/dsh-subscription-login/flows': { flows: [], orphaned: [] },
  })
  const { exports } = loadClient({ react, fetchImpl })
  const t = (key) => key

  const tree = await react.mount(exports.LoginConsole, { t })
  const text = textOf(tree)
  assert.match(text, /empty/)
  assert.match(text, /emptyHint/)
  assert.doesNotMatch(text, /orphanTitle/)
})

test('a host that answers with a failure surfaces the message instead of a blank page', async () => {
  const react = createReact()
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    text: async () => JSON.stringify({ code: 'UNAUTHORIZED', message: 'missing session' }),
  })
  const { exports } = loadClient({ react, fetchImpl })
  const tree = await react.mount(exports.LoginConsole, { t: (key) => key })
  const text = textOf(tree)
  assert.match(text, /missing session/)
  assert.ok(nodesOf(tree).some((node) => node.props?.className === 'dsl_err'))
})

test('key-only providers stay behind a toggle while subscriptions lead the page', async () => {
  const react = createReact()
  const row = (id, label, methodId, methodLabel) => ({
    key: `llm-pi-ai/${id}`,
    id,
    scope: 'llm-pi-ai',
    label,
    methods: [{ id: methodId, label: methodLabel }],
    inFlight: false,
    record: { configured: false, kind: null, writable: true },
  })
  const fetchImpl = fetchStub({
    '/plugins/dsh-subscription-login/flows': {
      flows: [
        row('openai-codex', 'OpenAI Codex', 'oauth', 'Sign in with ChatGPT'),
        row('groq', 'Groq', 'api-key', 'Groq API key'),
        row('mistral', 'Mistral', 'api-key', 'Mistral API key'),
      ],
      orphaned: [],
    },
  })
  const { exports } = loadClient({ react, fetchImpl })
  const t = (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`)

  let tree = await react.mount(exports.LoginConsole, { t })
  let text = textOf(tree)
  assert.match(text, /OpenAI Codex/)
  assert.doesNotMatch(text, /Mistral/)
  assert.match(text, /othersShow:\{"count":2\}/)
  assert.doesNotMatch(text, /othersNote/)

  const toggle = nodesOf(tree).find(
    (node) => node.type === 'button' && textOf(node).includes('othersShow'),
  )
  assert.ok(toggle !== undefined, 'the toggle should render once there are key-only providers')
  await toggle.props.onClick()

  tree = await react.mount(exports.LoginConsole, { t })
  text = textOf(tree)
  assert.match(text, /Groq/)
  assert.match(text, /Mistral/)
  assert.match(text, /othersHide/)
  assert.match(text, /othersNote/)
})

test('a busy flow this page never started can still be cancelled', async () => {
  const react = createReact()
  const fetchImpl = fetchStub({
    '/plugins/dsh-subscription-login/flows': {
      flows: [
        {
          key: 'llm-pi-ai/anthropic',
          id: 'anthropic',
          scope: 'llm-pi-ai',
          label: 'Anthropic',
          methods: [{ id: 'oauth', label: 'Sign in with Claude' }],
          inFlight: true,
          record: { configured: false, kind: null, writable: true },
        },
      ],
      orphaned: [],
    },
    '/plugins/dsh-subscription-login/flows/cancel': { ok: true },
  })
  const { exports } = loadClient({ react, fetchImpl })
  const t = (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`)

  const tree = await react.mount(exports.LoginConsole, { t })
  assert.match(textOf(tree), /busy/)

  const buttons = nodesOf(tree).filter((node) => node.type === 'button')
  const signIn = buttons.find((node) => String(node.props?.className ?? '').includes('dsl_btnPrimary'))
  assert.equal(signIn.props.disabled, true, 'a busy flow must not offer another sign-in')

  const cancel = buttons.find((node) => textOf(node) === 'cancel')
  assert.ok(cancel !== undefined, 'a busy row needs its own way out')
  await cancel.props.onClick()

  const posts = fetchImpl.calls.filter((call) => call.method === 'POST')
  assert.equal(posts.length, 1)
  assert.equal(posts[0].url, '/plugins/dsh-subscription-login/flows/cancel')
  assert.deepEqual(JSON.parse(posts[0].body), { key: 'llm-pi-ai/anthropic' })
})

test("a provider's refusal is printed verbatim in a diagnostic block, not as a muted note", async () => {
  const react = createReact()
  const refusal =
    '403 Forbidden: {"error_details":{"message":"No access to GitHub Copilot found. You are currently logged in as woodfood111."}}'
  const fetchImpl = fetchStub({
    '/plugins/dsh-subscription-login/flows': {
      flows: [
        {
          key: 'llm-pi-ai/github-copilot',
          id: 'github-copilot',
          scope: 'llm-pi-ai',
          label: 'GitHub Copilot',
          methods: [{ id: 'oauth', label: 'GitHub Copilot' }],
          inFlight: false,
          record: { configured: false, kind: null, writable: true },
        },
      ],
      orphaned: [],
    },
    '/plugins/dsh-subscription-login/attempts': {
      attemptId: 'a1',
      key: 'llm-pi-ai/github-copilot',
      label: 'GitHub Copilot',
      method: 'oauth',
    },
    '/plugins/dsh-subscription-login/attempts/a1': {
      attemptId: 'a1',
      events: [],
      cursor: 0,
      done: true,
      outcome: null,
      failure: refusal,
    },
  })
  const { exports } = loadClient({ react, fetchImpl })
  const t = (key, params) => (params === undefined ? key : `${key}:${params.message}`)

  const tree = await react.mount(exports.LoginConsole, { t })
  const signIn = nodesOf(tree).find((node) => String(node.props?.className ?? '').includes('dsl_btnPrimary'))
  await signIn.props.onClick()
  const after = await react.mount(exports.LoginConsole, { t })

  const block = nodesOf(after).find((node) => node.props?.className === 'dsl_failure')
  assert.ok(block !== undefined, 'a failure must render as its own block, not a note')
  assert.equal(textOf(block), `failed:${refusal}`)
  assert.equal(
    nodesOf(after).some((node) => node.props?.className === 'dsl_note' && textOf(node).includes('403')),
    false,
    'the refusal must not also appear as a muted note',
  )
})

test('clicking sign in walks the attempt and renders the question it is asked', async () => {
  const react = createReact()
  const fetchImpl = fetchStub({
    '/plugins/dsh-subscription-login/flows': {
      flows: [
        {
          key: 'llm-pi-ai/anthropic',
          id: 'anthropic',
          scope: 'llm-pi-ai',
          label: 'Anthropic',
          methods: [{ id: 'oauth', label: 'Sign in with Claude' }],
          inFlight: false,
          record: { configured: false, kind: null, writable: true },
        },
      ],
      orphaned: [],
    },
    '/plugins/dsh-subscription-login/attempts': (path, options) => {
      assert.equal(options.method, 'POST')
      return { attemptId: 'a1', key: 'llm-pi-ai/anthropic', label: 'Anthropic', method: 'oauth' }
    },
    '/plugins/dsh-subscription-login/attempts/a1': (path) =>
      path.includes('cursor=1')
        ? { attemptId: 'a1', events: [], cursor: 1, done: true, outcome: 'authorized' }
        : {
            attemptId: 'a1',
            events: [
              { type: 'notice', notice: { message: 'Continue in your browser', url: 'https://auth.example/x', code: 'AB-12' } },
              {
                type: 'prompt',
                promptId: 'p1',
                prompt: {
                  kind: 'select',
                  message: 'Which account?',
                  options: [
                    { id: 'personal', label: 'Personal', description: 'github.com' },
                    { id: 'work', label: 'Work' },
                  ],
                },
              },
            ],
            cursor: 1,
            done: false,
          },
  })
  const { exports } = loadClient({ react, fetchImpl })
  const t = (key, params) => (params === undefined ? key : `${key}(${JSON.stringify(params)})`)

  let tree = await react.mount(exports.LoginConsole, { t })
  const signIn = nodesOf(tree).find((node) => String(node.props?.className ?? '').includes('dsl_btnPrimary'))
  assert.ok(signIn !== undefined, 'a sign-in button should render')
  await signIn.props.onClick()

  tree = await react.mount(exports.LoginConsole, { t })
  const text = textOf(tree)

  // The notice, its page and its code all reached the panel. The page is a
  // link target rather than text, so assert on the anchor itself.
  assert.match(text, /Continue in your browser/)
  assert.match(text, /AB-12/)
  const link = nodesOf(tree).find((node) => node.type === 'a')
  assert.equal(link.props.href, 'https://auth.example/x')
  assert.equal(link.props.rel, 'noreferrer noopener')
  // The select question renders its options as buttons, not a text field.
  assert.match(text, /Which account\?/)
  assert.match(text, /Personal/)
  assert.match(text, /Work/)
  const optionButtons = nodesOf(tree).filter(
    (node) => node.type === 'button' && ['Personal', 'Work'].includes(textOf(node)),
  )
  assert.equal(optionButtons.length, 2)
  // The attempt finished on the next poll, so its outcome is reported.
  assert.match(text, /authorized/)

  // The panel must be reachable without scrolling past the provider list: a
  // real user clicked sign-in, saw nothing change, and asked why, because the
  // panel used to render after every row and the disclosure toggle.
  const ordered = nodesOf(tree)
  const panelIndex = ordered.findIndex((node) => String(node.props?.className ?? '').includes('dsl_panel'))
  const firstRowIndex = ordered.findIndex((node) => String(node.props?.className ?? '').includes('dsl_row'))
  assert.ok(panelIndex !== -1, 'the sign-in panel should render')
  assert.ok(firstRowIndex !== -1, 'the provider rows should render')
  assert.ok(
    panelIndex < firstRowIndex,
    'the sign-in panel must precede the provider list, not follow it',
  )

  const posts = fetchImpl.calls.filter((call) => call.method === 'POST')
  assert.equal(posts.length, 1)
  assert.equal(posts[0].url, '/plugins/dsh-subscription-login/attempts')
  assert.deepEqual(JSON.parse(posts[0].body), { key: 'llm-pi-ai/anthropic', method: 'oauth' })
})
