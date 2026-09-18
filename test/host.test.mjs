/**
 * Host-half integration tests: `apply()` wired to a stub Cordis context, driven
 * through the route handler it registers.
 *
 * Two claims matter most here and neither is provable from the pure modules:
 * that the plugin registers exactly one route and no more, and that every
 * request is put through the composition's trust fence *before* anything else
 * happens. The second is the whole reason this plugin uses an HTTP route at
 * all, so it is asserted from both directions — a rejected request must not
 * reach the registry, and an accepted one must.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, inject, name } from '../lib/index.js'
import { BASE_PATH, ROUTE_PREFIX } from '../lib/router.js'

/** A response double recording what the handler wrote. */
function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    chunks: [],
    writableEnded: false,
    destroyed: false,
    setHeader(key, value) {
      this.headers[String(key).toLowerCase()] = value
    },
    end(chunk) {
      this.writableEnded = true
      if (chunk !== undefined) this.chunks.push(chunk)
    },
    /** The parsed JSON body the handler sent. */
    json() {
      return JSON.parse(this.chunks.join(''))
    },
  }
}

/** A request double that delivers its body once listeners exist. */
function fakeRequest({ method = 'GET', url = '/', body, headers = {} } = {}) {
  const listeners = new Map()
  const request = {
    method,
    url,
    headers,
    destroyed: false,
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(listener)
      return request
    },
    destroy() {
      request.destroyed = true
    },
  }
  setTimeout(() => {
    if (body !== undefined) {
      for (const listener of listeners.get('data') ?? []) listener(Buffer.from(body, 'utf8'))
    }
    for (const listener of listeners.get('end') ?? []) listener()
  }, 0)
  return request
}

/**
 * Mount the plugin over stubs and return everything a test needs to poke it.
 *
 * @param options - the fence's answer, and a record the two seams should report.
 */
function mount({ rejection, flows = [], records = {} } = {}) {
  const routes = []
  const cleanups = []
  const calls = []

  const authorization = {
    list: () => flows,
    describe: (key) => flows.find((flow) => String(flow.key) === String(key)),
    cancel: (key) => calls.push(['cancel', String(key)]),
    // Parks like the real seam does: a sign-in runs until the human finishes it
    // or the caller withdraws, which is what makes the attempt live long enough
    // for the unmount path to have something to clean up.
    begin: ({ signal }) => {
      calls.push(['begin'])
      return new Promise((resolve) => {
        if (signal.aborted) {
          resolve({ status: 'cancelled' })
          return
        }
        signal.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true })
      })
    },
  }
  const credentials = {
    listRecords: async () => Object.entries(records).map(([key, kind]) => ({ key, kind })),
    describeRecord: async (key) =>
      String(key) in records
        ? { configured: true, kind: records[String(key)], writable: true }
        : { configured: false, writable: true },
    deleteRecord: async (key) => {
      calls.push(['deleteRecord', String(key)])
    },
  }

  const ctx = {
    authorization,
    credentials,
    connection: { requestRejection: () => rejection },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    effect(fn) {
      cleanups.push(fn())
    },
  }

  apply(ctx, {})

  return {
    routes,
    calls,
    /** Run one request through the registered route. */
    async dispatch(request) {
      assert.equal(routes.length, 1, 'exactly one route should be registered')
      const response = fakeResponse()
      await routes[0].handler(request, response)
      return response
    },
    /** Run every disposer the plugin registered, as an unmount would. */
    dispose() {
      for (const cleanup of cleanups.reverse()) {
        if (typeof cleanup === 'function') cleanup()
      }
    },
  }
}

test('the plugin declares its name and the four services it needs', () => {
  assert.equal(name, 'subscription-login')
  assert.deepEqual(inject, ['webServer', 'connection', 'authorization', 'credentials'])
})

test('apply() registers one prefix route at the plugin base path and nothing else', () => {
  const { routes } = mount()
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, ROUTE_PREFIX)
  assert.equal(typeof routes[0].handler, 'function')
})

test('the registered prefix carries no trailing slash', () => {
  // `dsh-host-webserver` matches a prefix route with
  // `pathname === prefix || pathname.startsWith(`${prefix}/`)`. Registering a
  // prefix that already ends in `/` makes the second test look for `//`, so the
  // route would only ever match its bare path and every real endpoint would fall
  // through to the SPA fallback as a 404. That is exactly what a live probe
  // caught, so it is pinned here.
  assert.equal(ROUTE_PREFIX.endsWith('/'), false)
  assert.equal(BASE_PATH, `${ROUTE_PREFIX}/`)

  const prefix = ROUTE_PREFIX
  const matched = (pathname) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  assert.equal(matched(BASE_PATH + 'flows'), true)
  assert.equal(matched(BASE_PATH + 'attempts/a1'), true)
  assert.equal(matched(prefix), true)
  assert.equal(matched('/plugins/dsh-subscription-login-other/flows'), false)
})

test('the trust fence runs first: a rejected request never reaches the seams', async () => {
  const { dispatch } = mount({ rejection: 401, flows: [{ key: 'llm-pi-ai/anthropic', label: 'Anthropic', methods: [] }] })
  const response = await dispatch(fakeRequest({ url: BASE_PATH + 'flows' }))
  assert.equal(response.statusCode, 401)
  assert.deepEqual(response.chunks, [], 'a rejected request gets no body')
})

test('a forbidden request is answered 403 and still gets no body', async () => {
  const { dispatch } = mount({ rejection: 403 })
  const response = await dispatch(fakeRequest({ url: BASE_PATH + 'flows' }))
  assert.equal(response.statusCode, 403)
  assert.deepEqual(response.chunks, [])
})

test('an accepted GET flows answers with the seam listing as JSON', async () => {
  const flow = {
    key: 'llm-pi-ai/openai-codex',
    label: 'OpenAI Codex',
    methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
    inFlight: false,
  }
  const { dispatch } = mount({ flows: [flow] })
  const response = await dispatch(fakeRequest({ url: BASE_PATH + 'flows' }))

  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(response.headers['cache-control'], 'no-store')
  const body = response.json()
  assert.equal(body.flows.length, 1)
  assert.deepEqual(body.flows[0].methods, flow.methods)
  assert.deepEqual(body.orphaned, [])
  assert.equal(body.flows[0].record.configured, false)
})

test('a record the seam reports shows up as configured on its flow', async () => {
  const { dispatch } = mount({
    flows: [{ key: 'llm-pi-ai/anthropic', label: 'Anthropic', methods: [], inFlight: false }],
    records: { 'llm-pi-ai/anthropic': 'grant', 'llm-pi-ai/retired': 'grant' },
  })
  const body = (await dispatch(fakeRequest({ url: BASE_PATH + 'flows' }))).json()
  assert.deepEqual(body.flows[0].record, { configured: true, kind: 'grant', writable: true })
  assert.deepEqual(body.orphaned, [{ key: 'llm-pi-ai/retired', id: 'retired', scope: 'llm-pi-ai', kind: 'grant' }])
})

test('a JSON body reaches the router and its result is written back', async () => {
  const { dispatch, calls } = mount({
    records: { 'llm-pi-ai/anthropic': 'grant' },
    flows: [{ key: 'llm-pi-ai/anthropic', label: 'Anthropic', methods: [], inFlight: false }],
  })
  const response = await dispatch(
    fakeRequest({
      method: 'POST',
      url: BASE_PATH + 'logout',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'llm-pi-ai/anthropic' }),
    }),
  )
  assert.equal(response.statusCode, 200)
  assert.deepEqual(calls, [['deleteRecord', 'llm-pi-ai/anthropic']])
})

test('a malformed JSON body is a coded 400 rather than a crash', async () => {
  const { dispatch } = mount()
  const response = await dispatch(
    fakeRequest({ method: 'POST', url: BASE_PATH + 'attempts', body: '{not json' }),
  )
  assert.equal(response.statusCode, 400)
  assert.equal(response.json().code, 'BAD_REQUEST')
})

test('an oversized body is refused with 413 before it is parsed', async () => {
  const { dispatch } = mount()
  const response = await dispatch(
    fakeRequest({ method: 'POST', url: BASE_PATH + 'attempts', body: 'x'.repeat(70 * 1024) }),
  )
  assert.equal(response.statusCode, 413)
  assert.equal(response.json().code, 'PAYLOAD_TOO_LARGE')
})

test('a route outside this plugin is not answered by it', async () => {
  const { dispatch } = mount()
  const response = await dispatch(fakeRequest({ url: '/dsh-market/installed' }))
  assert.equal(response.statusCode, 404)
  assert.equal(response.json().code, 'NOT_FOUND')
})

test('unmount cancels a sign-in the plugin started', async () => {
  const { dispatch, calls, dispose } = mount({
    flows: [
      {
        key: 'llm-pi-ai/openai-codex',
        label: 'OpenAI Codex',
        methods: [{ id: 'oauth', label: 'OAuth' }],
        inFlight: false,
      },
    ],
  })
  const started = await dispatch(
    fakeRequest({
      method: 'POST',
      url: BASE_PATH + 'attempts',
      body: JSON.stringify({ key: 'llm-pi-ai/openai-codex' }),
    }),
  )
  assert.equal(started.statusCode, 201)

  dispose()
  assert.ok(
    calls.some(([kind, key]) => kind === 'cancel' && key === 'llm-pi-ai/openai-codex'),
    'unmount must withdraw the attempt it started',
  )
})
