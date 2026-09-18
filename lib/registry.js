/**
 * dsh-subscription-login — attempt registry.
 *
 * Pure lifecycle logic over two harness seams, both injected rather than
 * imported: `authorization` (`ctx.authorization`) runs the sign-in flows, and
 * `credentials` (`ctx.credentials`) stores what they commit. Everything the
 * plugin does to a login attempt happens here, which is why this module takes
 * its collaborators as plain arguments and can be driven by a stub in tests —
 * the real seams are only needed at composition time.
 *
 * Deliberately import-free: a plugin that lives outside the harness repository
 * cannot rely on resolving `@deepseek-ai/*` specifiers from its own install
 * location, and it does not need to. The credential key that names one login is
 * a branded `<scope>/<id>` string; the branded instance is always obtained from
 * `authorization.list()` or `credentials.listRecords()`, never rebuilt here.
 */

/**
 * The credential scope this plugin manages. `dsh-llm-pi-ai` addresses every
 * provider login as `llm-pi-ai/<provider id>`, so scoping the console to this
 * one prefix keeps it from offering to delete records it does not understand.
 */
export const RECORD_SCOPE = 'llm-pi-ai'

/** An attempt left untouched for this long is abandoned and cancelled. */
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 15 * 60 * 1000

/** Finished attempts stay readable for this long so a polling client sees the outcome. */
export const DEFAULT_RETENTION_MS = 5 * 60 * 1000

/** How long one `wait()` call parks before answering "nothing yet". */
export const DEFAULT_WAIT_TIMEOUT_MS = 25_000

/** The id segment of a `<scope>/<id>` credential key. */
export function keyId(key) {
  const text = String(key)
  const slash = text.indexOf('/')
  return slash < 0 ? text : text.slice(slash + 1)
}

/** The scope segment of a `<scope>/<id>` credential key. */
export function keyScope(key) {
  const text = String(key)
  const slash = text.indexOf('/')
  return slash < 0 ? '' : text.slice(0, slash)
}

/**
 * A failure with an HTTP status and a stable machine code.
 *
 * The router turns these into responses; anything else reaching it is a bug in
 * this plugin and is reported as `500 internal` rather than being dressed up as
 * a flow outcome.
 */
export class LoginError extends Error {
  /**
   * @param status - HTTP status the router should answer with.
   * @param code - stable machine-readable discriminator.
   * @param message - human diagnostic, safe to show.
   */
  constructor(status, code, message) {
    super(message)
    this.name = 'LoginError'
    this.status = status
    this.code = code
  }
}

/** Keep only the three non-secret fields a notice is allowed to carry. */
function projectNotice(notice) {
  const out = { message: typeof notice?.message === 'string' ? notice.message : '' }
  if (typeof notice?.url === 'string' && notice.url !== '') out.url = notice.url
  if (typeof notice?.code === 'string' && notice.code !== '') out.code = notice.code
  return out
}

/** Project a prompt down to what a surface must render. */
function projectPrompt(prompt) {
  const out = {
    kind: prompt.kind,
    message: typeof prompt.message === 'string' ? prompt.message : '',
  }
  if (typeof prompt.placeholder === 'string' && prompt.placeholder !== '') out.placeholder = prompt.placeholder
  if (prompt.kind === 'select') {
    out.options = (prompt.options ?? []).map((option) => ({
      id: String(option.id),
      label: typeof option.label === 'string' ? option.label : String(option.id),
      ...(typeof option.description === 'string' && option.description !== ''
        ? { description: option.description }
        : {}),
    }))
  }
  return out
}

/** One-line description of a thrown value, for the attempt's failure event. */
function describeFailure(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Lives for one plugin mount: it tracks running sign-ins, parks long-poll
 * readers, and reports what the two seams currently hold.
 */
export class AttemptRegistry {
  #authorization
  #credentials
  #attempts = new Map()
  #sequence = 0
  #promptSequence = 0
  #now
  #attemptTimeoutMs
  #retentionMs

  /**
   * @param options - the two seams plus the clock and the two deadlines.
   * @param options.authorization - service answering `list`/`describe`/`begin`/`cancel`.
   * @param options.credentials - service answering `listRecords`/`describeRecord`/`deleteRecord`.
   * @param options.now - clock, injectable so tests never wait on wall time.
   * @param options.attemptTimeoutMs - absolute deadline for one sign-in.
   * @param options.retentionMs - how long a finished attempt stays readable.
   */
  constructor({
    authorization,
    credentials,
    now = () => Date.now(),
    attemptTimeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS,
    retentionMs = DEFAULT_RETENTION_MS,
  }) {
    this.#authorization = authorization
    this.#credentials = credentials
    this.#now = now
    this.#attemptTimeoutMs = attemptTimeoutMs
    this.#retentionMs = retentionMs
  }

  /**
   * Every sign-in this deployment can offer, each with the current state of the
   * record it writes, plus the records in this scope that no flow claims.
   *
   * The flow list is read from the seam rather than hardcoded: `dsh-llm-pi-ai`
   * registers one flow per installed pi-ai provider that ships a login, so a
   * provider added upstream appears here with no change to this plugin.
   *
   * @returns flows in registration order, and orphaned records in this scope.
   */
  async list() {
    const flows = this.#authorization.list()
    const records = await this.#credentials.listRecords()
    const claimed = new Set(flows.map((flow) => String(flow.key)))

    const entries = []
    for (const flow of flows) {
      entries.push({
        key: String(flow.key),
        id: keyId(flow.key),
        scope: keyScope(flow.key),
        label: flow.label,
        methods: flow.methods.map((method) => ({ id: method.id, label: method.label })),
        inFlight: flow.inFlight,
        record: await this.#recordState(flow.key),
      })
    }

    const orphaned = records
      .filter((record) => keyScope(record.key) === RECORD_SCOPE && !claimed.has(String(record.key)))
      .map((record) => ({
        key: String(record.key),
        id: keyId(record.key),
        scope: keyScope(record.key),
        kind: record.kind,
      }))

    return { flows: entries, orphaned }
  }

  /** Presence facts for one record; never the value. */
  async #recordState(key) {
    const info = await this.#credentials.describeRecord(key)
    return {
      configured: info.configured === true,
      kind: info.kind ?? null,
      writable: info.writable === true,
    }
  }

  /**
   * Resolve a key that arrived as a bare string back to the branded key the
   * seams expect, without importing the branding helper.
   *
   * @param raw - the key as it crossed the wire.
   * @returns the branded key, or undefined when nothing in this scope matches.
   */
  async #brand(raw) {
    const wanted = String(raw)
    for (const flow of this.#authorization.list()) {
      if (String(flow.key) === wanted) return flow.key
    }
    for (const record of await this.#credentials.listRecords()) {
      if (String(record.key) === wanted && keyScope(record.key) === RECORD_SCOPE) return record.key
    }
    return undefined
  }

  /**
   * Start one sign-in attempt and return immediately.
   *
   * The flow itself runs for as long as the human takes, so its promise is
   * parked here rather than awaited by the request that started it: the caller
   * gets an attempt id and follows the attempt through `wait()`.
   *
   * Preconditions are checked against `describe()` before `begin()` so the
   * caller receives a specific status instead of racing the seam's own
   * rejection. A race that still slips through arrives as the attempt's
   * `failure` event.
   *
   * @param rawKey - the flow's credential key as it crossed the wire.
   * @param method - the method id to run; the flow's first when omitted.
   * @returns the attempt's identity and the method actually started.
   * @throws {LoginError} when no flow claims the key, one is already running,
   *   or the named method is not one the flow offers.
   */
  async begin(rawKey, method) {
    const key = await this.#brand(rawKey)
    if (key === undefined) {
      throw new LoginError(404, 'NO_FLOW', `no sign-in flow claims "${rawKey}"`)
    }
    const entry = this.#authorization.describe(key)
    if (entry === undefined) {
      throw new LoginError(404, 'NO_FLOW', `no sign-in flow claims "${rawKey}"`)
    }
    if (entry.inFlight) {
      throw new LoginError(409, 'ALREADY_IN_FLIGHT', `a sign-in is already running for "${rawKey}"`)
    }
    const offered = entry.methods.map((candidate) => candidate.id)
    const chosen = method === undefined ? offered[0] : method
    if (!offered.includes(chosen)) {
      throw new LoginError(400, 'UNKNOWN_METHOD', `flow "${rawKey}" offers ${offered.join(', ')}`)
    }

    const id = `a${++this.#sequence}`
    const controller = new AbortController()
    const attempt = {
      id,
      key,
      keyText: String(key),
      label: entry.label,
      method: chosen,
      startedAt: this.#now(),
      events: [],
      prompts: new Map(),
      waiters: new Set(),
      done: false,
      outcome: undefined,
      failure: undefined,
      controller,
      timer: undefined,
    }
    this.#attempts.set(id, attempt)

    attempt.timer = setTimeout(() => {
      this.#push(attempt, { type: 'notice', notice: { message: 'sign-in timed out' } })
      this.cancel(id)
    }, this.#attemptTimeoutMs)
    attempt.timer.unref?.()

    const service = this.#authorization
    service
      .begin({
        key,
        method: chosen,
        signal: controller.signal,
        interaction: {
          notify: (notice) => this.#push(attempt, { type: 'notice', notice: projectNotice(notice) }),
          prompt: (prompt) => this.#ask(attempt, prompt),
        },
      })
      .then(
        (result) => this.#finish(id, { outcome: result?.status === 'authorized' ? 'authorized' : 'cancelled' }),
        (error) => this.#finish(id, { failure: describeFailure(error) }),
      )

    return { attemptId: id, key: String(key), label: entry.label, method: chosen }
  }

  /** Park one question until `answer()` supplies it, or its own signal retires it. */
  #ask(attempt, prompt) {
    const promptId = `p${++this.#promptSequence}`
    return new Promise((resolve, reject) => {
      attempt.prompts.set(promptId, { resolve, reject })
      if (prompt.signal !== undefined) {
        prompt.signal.addEventListener(
          'abort',
          () => {
            // The flow withdrew this question on its own (the losing half of a
            // race), which is not the human declining: the seam is explicit that
            // this must reject with something other than a decline.
            if (attempt.prompts.delete(promptId)) reject(new Error('prompt withdrawn by the flow'))
          },
          { once: true },
        )
      }
      this.#push(attempt, { type: 'prompt', promptId, prompt: projectPrompt(prompt) })
    })
  }

  /**
   * Answer the question an attempt is parked on.
   *
   * @param attemptId - the attempt holding the question.
   * @param promptId - the question's id from its `prompt` event.
   * @param value - the typed text, or the chosen option's id.
   * @throws {LoginError} `404 NO_ATTEMPT`/`NO_PROMPT` when either is unknown.
   */
  answer(attemptId, promptId, value) {
    const attempt = this.#require(attemptId)
    const pending = attempt.prompts.get(promptId)
    if (pending === undefined) {
      throw new LoginError(404, 'NO_PROMPT', `attempt "${attemptId}" is not waiting on "${promptId}"`)
    }
    attempt.prompts.delete(promptId)
    this.#push(attempt, { type: 'answered', promptId })
    pending.resolve(typeof value === 'string' ? value : String(value ?? ''))
    return { ok: true }
  }

  /**
   * Withdraw one attempt. The human's "no" is a result, not a fault: cancelling
   * settles the attempt as `cancelled`, which is what the seam reports when the
   * caller withdraws the request signal.
   *
   * @param attemptId - the attempt to stop.
   * @throws {LoginError} `404 NO_ATTEMPT` when the id is unknown.
   */
  cancel(attemptId) {
    const attempt = this.#require(attemptId)
    this.#authorization.cancel(attempt.key)
    attempt.controller.abort(new Error('cancelled by the user'))
    // A flow that never observes its signal would leave the attempt parked; the
    // seam releases the key on its own terms, so only the local view is settled
    // here, and the flow's own outcome overwrites it if it arrives.
    for (const [, pending] of attempt.prompts) pending.reject(new Error('cancelled by the user'))
    attempt.prompts.clear()
    if (!attempt.done) this.#finish(attemptId, { outcome: 'cancelled' })
    return { ok: true }
  }

  /**
   * Withdraw whatever attempt is running for a key, without knowing its id.
   *
   * A surface can lose track of an attempt it started — the page was reloaded,
   * or a second sign-in was begun before the first finished — while the flow
   * keeps waiting on the host. Such an attempt reports `inFlight` on every
   * listing but has no id any control holds, so without this it is reachable
   * only by waiting out its deadline. A user found exactly that: four rows
   * marked "in progress", four buttons disabled, nothing able to stop them.
   *
   * @param rawKey - the credential key whose attempt should stop.
   * @throws {LoginError} `404 NO_ATTEMPT` when nothing is running for it.
   */
  cancelKey(rawKey) {
    const wanted = String(rawKey)
    for (const attempt of this.#attempts.values()) {
      if (attempt.done || attempt.keyText !== wanted) continue
      return this.cancel(attempt.id)
    }
    throw new LoginError(404, 'NO_ATTEMPT', `no sign-in is running for "${wanted}"`)
  }

  /**
   * Park until the attempt produces an event past `cursor`, or the wait times
   * out. Long-polling rather than a stream keeps every outcome a normal
   * request/response, which is what makes the whole lifecycle testable offline.
   *
   * @param attemptId - the attempt to follow.
   * @param cursor - how many events the caller has already seen.
   * @param timeoutMs - how long to park before answering "nothing yet".
   * @returns the new events, the next cursor, and whether the attempt is over.
   * @throws {LoginError} `404 NO_ATTEMPT` when the id is unknown.
   */
  async wait(attemptId, cursor, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS) {
    const attempt = this.#require(attemptId)
    const from = Number.isFinite(cursor) && cursor > 0 ? Math.floor(cursor) : 0
    if (attempt.events.length > from || attempt.done) {
      return this.#snapshot(attempt, from)
    }
    return new Promise((resolve) => {
      const waiter = {
        fire: () => {
          clearTimeout(waiter.timer)
          attempt.waiters.delete(waiter)
          resolve(this.#snapshot(attempt, from))
        },
      }
      // Deliberately not unref'd: a parked long-poll is what holds the answer
      // open, so the timer keeping the loop alive for its own bounded wait is
      // the point rather than an oversight.
      waiter.timer = setTimeout(waiter.fire, timeoutMs)
      attempt.waiters.add(waiter)
    })
  }

  /** The wire view of an attempt from one reader's cursor onward. */
  #snapshot(attempt, from) {
    return {
      attemptId: attempt.id,
      key: attempt.keyText,
      label: attempt.label,
      method: attempt.method,
      events: attempt.events.slice(from),
      cursor: attempt.events.length,
      done: attempt.done,
      outcome: attempt.outcome,
      failure: attempt.failure,
    }
  }

  /**
   * Forget one stored login locally.
   *
   * Scoped on purpose: only a `llm-pi-ai` record is deletable here, and only
   * one the seams currently report. The seam has no revocation channel, so this
   * forgets the record on this machine and tells the issuer nothing — the
   * README says so in as many words rather than implying a server-side logout.
   *
   * @param rawKey - the record to remove, as it crossed the wire.
   * @throws {LoginError} `404 NO_RECORD` when this scope holds no such record.
   */
  async logout(rawKey) {
    const key = await this.#brand(rawKey)
    if (key === undefined) {
      throw new LoginError(404, 'NO_RECORD', `no record named "${rawKey}" in scope "${RECORD_SCOPE}"`)
    }
    if (keyScope(key) !== RECORD_SCOPE) {
      throw new LoginError(403, 'FOREIGN_SCOPE', `record "${rawKey}" is outside scope "${RECORD_SCOPE}"`)
    }
    await this.#credentials.deleteRecord(key)
    return { ok: true }
  }

  /** The live attempt, or a coded 404. */
  #require(attemptId) {
    const attempt = this.#attempts.get(String(attemptId))
    if (attempt === undefined) {
      throw new LoginError(404, 'NO_ATTEMPT', `unknown attempt "${attemptId}"`)
    }
    return attempt
  }

  /** Record one event, wake every reader parked on this attempt. */
  #push(attempt, event) {
    attempt.events.push({ seq: attempt.events.length + 1, at: this.#now(), ...event })
    for (const waiter of [...attempt.waiters]) waiter.fire()
  }

  /** Close an attempt: publish its outcome, release readers, schedule retention. */
  #finish(attemptId, { outcome, failure }) {
    const attempt = this.#attempts.get(attemptId)
    if (attempt === undefined || attempt.done) return
    attempt.done = true
    attempt.outcome = failure === undefined ? outcome : undefined
    attempt.failure = failure
    clearTimeout(attempt.timer)
    for (const [, pending] of attempt.prompts) pending.reject(new Error('attempt finished'))
    attempt.prompts.clear()
    this.#push(attempt, {
      type: 'settled',
      outcome: attempt.outcome,
      ...(failure === undefined ? {} : { failure }),
    })
    const timer = setTimeout(() => this.#attempts.delete(attemptId), this.#retentionMs)
    timer.unref?.()
  }

  /** Cancel every running attempt; the plugin calls this on unmount. */
  dispose() {
    for (const attempt of [...this.#attempts.values()]) {
      if (!attempt.done) {
        try {
          this.#authorization.cancel(attempt.key)
        } catch {
          // A seam that refuses to cancel an attempt it already released is not
          // a reason to leave the rest running.
        }
        attempt.controller.abort(new Error('plugin unmounted'))
        for (const [, pending] of attempt.prompts) pending.reject(new Error('plugin unmounted'))
        attempt.prompts.clear()
        clearTimeout(attempt.timer)
      }
    }
    this.#attempts.clear()
  }
}
