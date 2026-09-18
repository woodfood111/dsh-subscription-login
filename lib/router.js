/**
 * dsh-subscription-login — wire router (host half).
 *
 * A pure function of `(registry, request)` returning a response shape, so the
 * whole HTTP surface is exercised in tests without a socket. `lib/index.js`
 * owns the two things this module deliberately does not know about: the
 * connection trust fence and the Node request/response objects.
 *
 * Routes, all under `BASE_PATH`:
 *
 *   GET  flows                  what can be signed into, and what is stored
 *   POST attempts               start one sign-in, answer with its id
 *   GET  attempts/<id>          long-poll for events past `cursor`
 *   POST attempts/<id>/answers  answer the question the attempt is parked on
 *   POST attempts/<id>/cancel   withdraw the attempt
 *   POST logout                 forget one stored login on this machine
 */

import { LoginError, DEFAULT_WAIT_TIMEOUT_MS } from './registry.js'

/**
 * The prefix registered with the host web server.
 *
 * Deliberately WITHOUT a trailing slash. `dsh-host-webserver` matches a prefix
 * route with `pathname === prefix || pathname.startsWith(`${prefix}/`)`, so a
 * registered `/x/` only ever matches the bare `/x/` and never `/x/flows` — the
 * matcher would be looking for `//`. Registering `/x` and keeping the trailing
 * slash in {@link BASE_PATH}, which is what route matching and the browser's
 * fetch base both want, is the only combination that works.
 */
export const ROUTE_PREFIX = '/plugins/dsh-subscription-login'

/** Every route this plugin owns hangs off this prefix. */
export const BASE_PATH = `${ROUTE_PREFIX}/`

/** The longest a single long-poll request parks, whatever the client asks for. */
const MAX_WAIT_TIMEOUT_MS = 60_000

/**
 * Build the request handler for one registry.
 *
 * @param registry - the attempt registry this plugin owns.
 * @param options - optional base-path override, used by tests.
 * @returns an async `(request) => response` function.
 */
export function createRouter(registry, { basePath = BASE_PATH } = {}) {
  /**
   * @param request - `{ method, path, body }`; `path` is the full pathname and
   *   `body` is already-parsed JSON (or undefined).
   * @returns `{ status, body }`.
   */
  return async function handle(request) {
    let route
    try {
      route = match(String(request.path ?? ''), basePath)
    } catch (error) {
      return failure(error)
    }
    if (route === undefined) {
      return { status: 404, body: { code: 'NOT_FOUND', message: `no route for ${request.path}` } }
    }

    try {
      return await dispatch(registry, route, request)
    } catch (error) {
      return failure(error)
    }
  }
}

/** Split a pathname into the route name and its trailing segments. */
function match(pathname, basePath) {
  if (!pathname.startsWith(basePath)) return undefined
  const rest = pathname.slice(basePath.length).replace(/\/+$/, '')
  return { segments: rest === '' ? [] : rest.split('/') }
}

/** Answer one matched route. */
async function dispatch(registry, route, request) {
  const [head, ...tail] = route.segments
  const method = String(request.method ?? 'GET').toUpperCase()

  if (head === 'flows' && tail.length === 0) {
    if (method !== 'GET') return methodNotAllowed('GET')
    return { status: 200, body: await registry.list() }
  }

  if (head === 'attempts' && tail.length === 0) {
    if (method !== 'POST') return methodNotAllowed('POST')
    const key = requireString(request.body, 'key')
    const chosen = request.body?.method
    return {
      status: 201,
      body: await registry.begin(key, typeof chosen === 'string' ? chosen : undefined),
    }
  }

  if (head === 'attempts' && tail.length === 1) {
    if (method !== 'GET') return methodNotAllowed('GET')
    const cursor = Number(request.query?.cursor ?? 0)
    const asked = Number(request.query?.timeout ?? DEFAULT_WAIT_TIMEOUT_MS)
    const timeout = Number.isFinite(asked) ? Math.min(Math.max(asked, 0), MAX_WAIT_TIMEOUT_MS) : DEFAULT_WAIT_TIMEOUT_MS
    return { status: 200, body: await registry.wait(tail[0], cursor, timeout) }
  }

  if (head === 'attempts' && tail.length === 2 && tail[1] === 'answers') {
    if (method !== 'POST') return methodNotAllowed('POST')
    return {
      status: 200,
      body: registry.answer(tail[0], requireString(request.body, 'promptId'), request.body?.value),
    }
  }

  if (head === 'attempts' && tail.length === 2 && tail[1] === 'cancel') {
    if (method !== 'POST') return methodNotAllowed('POST')
    return { status: 200, body: registry.cancel(tail[0]) }
  }

  if (head === 'logout' && tail.length === 0) {
    if (method !== 'POST') return methodNotAllowed('POST')
    return { status: 200, body: await registry.logout(requireString(request.body, 'key')) }
  }

  return { status: 404, body: { code: 'NOT_FOUND', message: `no route for ${route.segments.join('/')}` } }
}

/** A required string field, or a coded 400. */
function requireString(body, field) {
  const value = body?.[field]
  if (typeof value !== 'string' || value === '') {
    throw new LoginError(400, 'BAD_REQUEST', `"${field}" must be a non-empty string`)
  }
  return value
}

/** A 405 carrying the method that would have worked. */
function methodNotAllowed(allowed) {
  return {
    status: 405,
    headers: { allow: allowed },
    body: { code: 'METHOD_NOT_ALLOWED', message: `use ${allowed}` },
  }
}

/**
 * Map a thrown value to a response. A `LoginError` is a reported outcome; any
 * other throw is this plugin's own bug and is answered as such rather than
 * being disguised as a flow failure.
 */
function failure(error) {
  if (error instanceof LoginError) {
    return { status: error.status, body: { code: error.code, message: error.message } }
  }
  return {
    status: 500,
    body: { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) },
  }
}
