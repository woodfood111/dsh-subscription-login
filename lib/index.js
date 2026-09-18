/**
 * dsh-subscription-login — host half.
 *
 * One HTTP surface, behind the composition's own trust fence, over the
 * harness authorization seam (`ctx.authorization`) and the credential-record
 * seam (`ctx.credentials`).
 *
 * Why an HTTP route rather than a Typert Remote: the Remote plane requires a
 * strict invocation descriptor carrying zod schemas, which only the in-repo
 * Typert generator produces. A plugin published outside the harness repository
 * can hand-author one, but the descriptor is a generated artifact with no
 * stability promise, so this plugin uses the mechanism the harness documents for
 * route-owning plugins instead. Security is not traded away for that: every
 * request is put through `ctx.connection.requestRejection()` first, which is
 * the same Host/Origin fence and browser-authentication gate the shipped
 * `dsh-host-open-in-app` route owner uses. A naked request from another local
 * process gets 401 without a session cookie.
 *
 * Nothing here reads a credential value. The plugin reports whether a record
 * exists and what kind it is; `describeRecord()` has no field a secret could
 * ride in, and the login flows themselves run inside `dsh-llm-pi-ai`, which is
 * the only writer of the records.
 */

import { AttemptRegistry } from './registry.js'
import { ROUTE_PREFIX, createRouter } from './router.js'

/** Loader row id. */
export const name = 'subscription-login'

/**
 * The route carrier, its trust fence, and the two seams the console reads.
 *
 * All four are required rather than optional: a deployment without the
 * connection fence would leave these routes unauthenticated, which is exactly
 * what this plugin must not do silently.
 */
export const inject = ['webServer', 'connection', 'authorization', 'credentials']

/** Largest request body accepted, in bytes. Every body here is a small JSON object. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * Mount the console's host half.
 *
 * @param ctx - host plugin context carrying the four injected services.
 * @param config - optional tuning; unknown fields are ignored by design.
 */
export function apply(ctx, config) {
  const registry = new AttemptRegistry({
    authorization: ctx.authorization,
    credentials: ctx.credentials,
    ...(Number.isFinite(config?.attemptTimeoutMs) ? { attemptTimeoutMs: config.attemptTimeoutMs } : {}),
  })
  const handle = createRouter(registry)

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) => serve(ctx, handle, req, res),
      }),
    `subscription-login: ${ROUTE_PREFIX}`,
  )

  // A sign-in parked on a human must not outlive the plugin that started it.
  ctx.effect(() => () => registry.dispose(), 'subscription-login: attempts')
}

/**
 * One request, from the trust fence to the wire.
 *
 * @param ctx - host plugin context, read for the connection service.
 * @param handle - the pure router built in `apply`.
 * @param req - Node request.
 * @param res - Node response.
 */
async function serve(ctx, handle, req, res) {
  const rejection = ctx.connection.requestRejection(req)
  if (rejection !== undefined) {
    res.statusCode = rejection
    res.end()
    return
  }

  let url
  try {
    url = new URL(String(req.url), 'http://localhost')
  } catch {
    send(res, { status: 400, body: { code: 'BAD_REQUEST', message: 'unparseable request target' } })
    return
  }

  let body
  try {
    body = await readJsonBody(req)
  } catch (error) {
    send(res, { status: error.status ?? 400, body: { code: error.code ?? 'BAD_REQUEST', message: error.message } })
    return
  }

  const response = await handle({
    method: req.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    body,
  })
  send(res, response)
}

/**
 * Read and parse a bounded JSON body. An absent body is `undefined` rather than
 * an error, so a POST with nothing to say still reaches its route.
 *
 * @param req - Node request.
 * @returns the parsed body, or undefined when there was none.
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        const error = new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`)
        error.status = 413
        error.code = 'PAYLOAD_TOO_LARGE'
        reject(error)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        const error = new Error('request body is not valid JSON')
        error.status = 400
        error.code = 'BAD_REQUEST'
        reject(error)
      }
    })
  })
}

/**
 * Write one router response. A response whose client already went away is
 * dropped rather than thrown: a cancelled long-poll is a normal event here, not
 * a failure to report.
 *
 * @param res - Node response.
 * @param response - `{ status, headers?, body }` from the router.
 */
function send(res, response) {
  if (res.writableEnded === true || res.destroyed === true) return
  res.statusCode = response.status
  for (const [header, value] of Object.entries(response.headers ?? {})) {
    res.setHeader(header, value)
  }
  const payload = JSON.stringify(response.body ?? {})
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(payload)
}
