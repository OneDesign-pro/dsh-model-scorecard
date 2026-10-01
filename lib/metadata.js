// Exact-route reference metadata for the panel's rows.
//
// The rating answers "how fast has this pair been". A reader deciding what to
// run next also wants what a route *declares* about itself: context window,
// default output cap, input modalities and reasoning choices. The adapter owns
// that declaration, and DSH exposes exactly one call that reads it:
//
//   ctx.llm.resolveModelInfo(provider, model, signal)
//
// which validates and detaches the adapter's answer before returning it.
//
// This module is deliberately separate from `liveness.js`. The liveness layer
// enumerates pairs out of the same `ctx.llm` (`listProviders`/`listModels`) and
// probes them with real requests; metadata is a configuration read with no
// request behind it. Folding the two together would make a lookup out of a probe
// or a probe out of a lookup, so `pairsOf`/`configured` stay identity-only and
// this module never calls them. It is also not part of scoring: the rating is
// computed before the rows are cut, the caller enriches after, and a route whose
// metadata is unknown still has a score.
//
// Measured on the installed runtime (2026-09-30, profile `web`, 75 configured
// pairs, ~0 ms per call, no network): `context` 75/75, `inputModalities` 75/75,
// `defaultMaxTokens` 36/75, `reasoning` 31/75, `name` 75/75, `description` 0/75,
// and four distinct key shapes — the optional half is the common case, so a
// reader must see a missing field as unknown rather than as a zero. The failures
// are thrown `LlmError`s and not `null`s: code `NO_ADAPTER` for an unregistered
// provider, `UNKNOWN_MODEL` for an id the adapter does not serve.
//
// Measured in the same run: a pre-aborted `AbortSignal` still resolved. Passing
// the signal asks the adapter to cancel; it does not promise that it will, so
// the per-lookup timeout below is a local race and the signal is a courtesy.

/**
 * The bounds every lookup in this module obeys.
 *
 * The numbers are one decision each, and they are here rather than inline so a
 * test can drive the same rules with smaller values instead of a copy:
 *
 * - `positiveTtlMs` 1 h — a context window is a property of the adapter's
 *   configuration, which changes when the user edits settings, not per request.
 * - `negativeTtlMs` 5 min — a failure is usually a route this install does not
 *   serve at all, and retrying that on every panel refresh is wasted work; five
 *   minutes still lets a provider that came back be seen within one sitting.
 * - `lookupTimeoutMs` 1 s and `enrichBudgetMs` 1 s — the panel's own fold budget
 *   is 2.5 s and metadata is decoration, so it may never be what a reader waits
 *   for. A local read is ~0 ms; the timeout only bounds an adapter that is slow
 *   or wedged.
 * - `concurrency` 4 — enough that a page of rows fills in one pass, few enough
 *   that a slow adapter cannot open a burst of calls.
 * - `maxNewPerEnrich` 64 — an answer enriches at most this many *new* pairs.
 *   Rows past the cap are not forgotten: the pairs already asked for are cached,
 *   so the next ordinary refresh moves the window forward and a page wider than
 *   64 fills over successive refreshes rather than enqueueing an unbounded sweep
 *   on one request.
 */
export const METADATA_POLICY = Object.freeze({
  source: 'dsh-adapter',
  positiveTtlMs: 3_600_000,
  negativeTtlMs: 300_000,
  lookupTimeoutMs: 1_000,
  enrichBudgetMs: 1_000,
  concurrency: 4,
  maxNewPerEnrich: 64,
})

/**
 * The unknown value, and the only shape a caller has to test for.
 *
 * A route with no owning live adapter, an adapter that threw, a lookup that ran
 * out of budget: all of them are "DSH did not tell us", and none of them may be
 * a zero — a context window of 0 is not a small window, it is not a window.
 */
const UNKNOWN = null

/** One epoch-ms clock, injectable so a TTL is tested by moving time, not by waiting. */
const defaultNow = () => Date.now()

/**
 * A bounded, de-duplicated metadata reader bound to the injected `llm` service.
 *
 * `enrich(payload)` is the only entry point the plugin needs: it takes a panel
 * payload and answers it with `routeMetadata` on every row. It never rejects and
 * never blocks past the budget — a host that cannot answer, an adapter that
 * throws and an adapter that ignores cancellation all end as `null` on the row
 * and nothing else changes.
 */
export function createMetadata(ctx, options = {}) {
  const policy = { ...METADATA_POLICY, ...(options.policy ?? {}) }
  const now = typeof options.now === 'function' ? options.now : defaultNow

  /** key -> `{ value, expiresAt }`, value `null` for a negative entry. */
  const cache = new Map()
  /** key -> promise of the lookup in flight, so two rows share one call. */
  const inflight = new Map()
  /** key -> token of the newest attempt, so a late answer cannot overwrite a newer one. */
  const attempts = new Map()
  /** Jobs waiting for a free slot, and how many slots are taken. */
  const queue = []
  let active = 0
  /** Controllers and their timers, owned so disposal can cancel both. */
  const pending = new Set()
  let tokenSeq = 0
  let disposed = false

  /**
   * `ctx.get` rather than `ctx.llm`: a service the host does not mount must read
   * as "no metadata" and not throw on the read. Feature detection is the second
   * half of the same guard — an older runtime has no `resolveModelInfo`, and the
   * difference between that host and a route with no adapter is invisible to the
   * panel, which shows the same unknown either way.
   */
  function service() {
    const llm = typeof ctx.get === 'function' ? ctx.get('llm') : ctx?.llm
    return typeof llm?.resolveModelInfo === 'function' ? llm : null
  }

  function cached(key) {
    const entry = cache.get(key)
    if (entry === undefined) return { hit: false }
    if (entry.expiresAt <= now()) {
      cache.delete(key)
      return { hit: false }
    }
    return { hit: true, value: entry.value }
  }

  /**
   * A positive answer is cached for an hour and a negative one for five minutes.
   * A resolved route that declares nothing is *positive*: the route exists, the
   * adapter simply has no context to report, and asking again in five minutes
   * would learn the same nothing.
   */
  function store(key, value) {
    const ttl = value === UNKNOWN ? policy.negativeTtlMs : policy.positiveTtlMs
    cache.set(key, { value, expiresAt: now() + ttl })
  }

  /**
   * A safe positive integer, or unknown.
   *
   * The runtime accepts any positive integer for a context window and a safe
   * integer for the output cap; both are held to a safe integer here, because a
   * window past 2^53 is not a declaration any adapter can mean and forwarding one
   * would put a made-up number in front of a reader.
   */
  const positiveInteger = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null)

  const stringList = (value) =>
    Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string')
      ? [...value]
      : null

  /**
   * Whitelist the adapter's answer down to the fields the panel may show.
   *
   * The runtime has already validated identity and shapes — `normalizeModelInfo`
   * throws `INVALID_MODEL_INFO`, `INVALID_MODEL_CONTEXT` and
   * `INVALID_MODEL_MAX_TOKENS` — but that guarantee belongs to one version of one
   * host. The identity check below is repeated because a context window is only
   * meaningful for the route it was declared for, and a mismatch must not place
   * another model's window on this row. Everything else not named here —
   * `name`, `description`, and whatever an adapter keeps beside them — is dropped
   * at the boundary: this object is serialized to a browser, and only the display
   * fields belong in it.
   */
  function normalize(provider, model, info) {
    if (info === null || typeof info !== 'object') return UNKNOWN
    if (info.provider !== provider || info.id !== model) return UNKNOWN
    const efforts = (Array.isArray(info.reasoning?.efforts) ? info.reasoning.efforts : [])
      .filter(
        (effort) =>
          effort !== null &&
          typeof effort === 'object' &&
          typeof effort.id === 'string' &&
          effort.id !== '' &&
          typeof effort.name === 'string' &&
          effort.name !== '',
      )
      .map((effort) => ({ id: effort.id, name: effort.name }))
    const defaultEffort = info.reasoning?.defaultEffort
    return {
      source: policy.source,
      checkedAt: now(),
      contextWindow: positiveInteger(info.context?.contextWindow),
      // A *default*, never a maximum: this is the output cap the adapter
      // materializes when a request names none, and it says nothing about what
      // the model can emit under an explicit cap. The field name carries that
      // distinction to every consumer of the payload.
      defaultMaxTokens: positiveInteger(info.defaultMaxTokens),
      inputModalities: stringList(info.inputModalities),
      reasoningEfforts: efforts.length > 0 ? efforts : null,
      defaultReasoningEffort:
        typeof defaultEffort === 'string' && efforts.some((effort) => effort.id === defaultEffort)
          ? defaultEffort
          : null,
    }
  }

  /**
   * One exact pair, never rejecting.
   *
   * The call is wrapped so that a rejection after the race — the case an adapter
   * that ignores the signal produces — is a value and not an unhandled rejection
   * that would take the process down later, long after this row was drawn.
   *
   * A lookup that loses the race is not abandoned. We store the unknown now, so
   * the answer this request is building does not wait, and let the call finish in
   * the background: an adapter that ignored the abort (measured on the installed
   * runtime) still produces a real answer a second later, and the next ordinary
   * refresh should serve it rather than wait out a five-minute negative entry.
   */
  async function lookupOnce(key, provider, model, token) {
    const llm = service()
    if (llm === null || disposed) return
    const controller = new AbortController()
    const owner = { controller, timer: null }
    let settle
    const expired = new Promise((resolve) => {
      settle = resolve
    })
    owner.timer = setTimeout(() => {
      controller.abort()
      settle()
    }, policy.lookupTimeoutMs)
    pending.add(owner)
    let value = UNKNOWN
    let late = null
    try {
      const call = Promise.resolve()
        .then(() => llm.resolveModelInfo(provider, model, controller.signal))
        .then(
          (info) => ({ ok: true, info }),
          (error) => ({ ok: false, error }),
        )
      const outcome = await Promise.race([call, expired])
      // `expired` resolves with nothing, so an undefined outcome is the timeout
      // and an object is the adapter's own answer, refusal included.
      if (outcome === undefined) late = call
      else if (outcome.ok === true) value = normalize(provider, model, outcome.info)
    } catch {
      // `normalize` is guarded against anything an adapter can return; a throw
      // here is still only an unknown route, never a failed panel.
      value = UNKNOWN
    } finally {
      clearTimeout(owner.timer)
      pending.delete(owner)
    }
    // An answer from an attempt a newer one has superseded is dropped: the cache
    // has to describe the newest question asked of this route, and a slow answer
    // to the previous one must not replace it.
    if (disposed || attempts.get(key) !== token) return
    store(key, value)
    if (late !== null) {
      void late.then((answer) => {
        if (answer?.ok !== true || disposed || attempts.get(key) !== token) return
        store(key, normalize(provider, model, answer.info))
      })
    }
  }

  /** Fill free slots from the queue, in the order the rows asked. */
  function pump() {
    while (!disposed && active < policy.concurrency && queue.length > 0) {
      const job = queue.shift()
      active += 1
      job().finally(() => {
        active -= 1
        pump()
      })
    }
  }

  /**
   * Start one pair's lookup behind the concurrency gate.
   *
   * The returned promise is what de-duplicates: a row repeated in one answer and
   * a row repeated by the next request both find this promise in `inflight` and
   * await the same call instead of opening a second one.
   */
  function start(key, provider, model) {
    const token = (tokenSeq += 1)
    attempts.set(key, token)
    const task = new Promise((resolve) => {
      queue.push(() => lookupOnce(key, provider, model, token).then(resolve, resolve))
    })
    inflight.set(key, task)
    void task.then(() => {
      if (inflight.get(key) === task) inflight.delete(key)
    })
    pump()
    return task
  }

  /**
   * Wait for the started lookups, but no longer than the budget.
   *
   * Whatever has not finished is not cancelled: the lookup keeps running and
   * writes its entry when it lands, so the next ordinary refresh serves it from
   * cache. That is the whole point of the budget — the answer a reader waits for
   * is never held behind a slow adapter, and the work is not thrown away either.
   */
  async function withinBudget(tasks) {
    if (tasks.length === 0) return
    let settle
    const expired = new Promise((resolve) => {
      settle = resolve
    })
    const timer = setTimeout(settle, policy.enrichBudgetMs)
    try {
      await Promise.race([Promise.all(tasks), expired])
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Attach `routeMetadata` to every row of a panel payload.
   *
   * Called after the rows are selected and cut to the limit, so a lookup is only
   * ever spent on a row that reached the answer. Unknown is `null` on every row
   * that has no route of its own — a provider roll-up above all, which must not
   * borrow one of its models' windows.
   */
  async function enrich(payload) {
    if (payload === null || typeof payload !== 'object' || !Array.isArray(payload.rows)) return payload
    try {
      const waiting = new Set()
      const missing = new Map()
      for (const row of payload.rows) {
        if (typeof row?.provider !== 'string' || typeof row?.model !== 'string' || row.model === '') continue
        const key = `${row.provider}\u0000${row.model}`
        // A lookup another request (or an earlier row) already started is not a
        // second question: this answer waits for that one rather than opening a
        // rival call whose answer would race the first into the same cache key.
        const running = inflight.get(key)
        if (running !== undefined) {
          waiting.add(running)
          continue
        }
        if (missing.has(key) || cached(key).hit) continue
        // Past the cap, later rows are skipped rather than scanned into a stop:
        // an in-flight pair further down the page still deserves its wait.
        if (missing.size >= policy.maxNewPerEnrich) continue
        missing.set(key, { provider: row.provider, model: row.model })
      }
      // A host without the call, or a disposed service, is not a reason to ask:
      // every row then answers unknown, and no queue is filled for nothing.
      const available = service() !== null && !disposed
      const started = available ? [...missing].map(([key, pair]) => start(key, pair.provider, pair.model)) : []
      if (available) await withinBudget([...waiting, ...started])
      return {
        ...payload,
        rows: payload.rows.map((row) => {
          // A provider roll-up has no single route: copying one of its models'
          // context onto it would be an invention, so the row says unknown.
          if (typeof row?.provider !== 'string' || typeof row?.model !== 'string' || row.model === '') {
            return { ...row, routeMetadata: UNKNOWN }
          }
          const found = cached(`${row.provider}\u0000${row.model}`)
          // A clone per row: the cached object is shared by every later answer,
          // and a consumer that edits its row must not edit the cache.
          return { ...row, routeMetadata: found.hit && found.value !== UNKNOWN ? { ...found.value } : UNKNOWN }
        }),
      }
    } catch {
      // Decoration may never fail the table. An answer already assembled is
      // returned as-is rather than as an error, and its rows simply say unknown.
      return payload
    }
  }

  /**
   * Drop everything this service owns: cache, in-flight calls and their timers.
   *
   * Called from the plugin's effect disposer, so a reloaded plugin cannot leave a
   * lookup writing into a cache nobody reads, and a late answer from the old
   * instance is dropped rather than mixed into the new one's rows.
   */
  function dispose() {
    disposed = true
    for (const owner of pending) {
      clearTimeout(owner.timer)
      try {
        owner.controller.abort()
      } catch {
        // An adapter that throws on abort is exactly the adapter the race exists
        // for; there is nothing left to do with the failure here.
      }
    }
    pending.clear()
    queue.length = 0
    inflight.clear()
    attempts.clear()
    cache.clear()
  }

  return { enrich, dispose }
}
