// dsh-model-stats - liveness probes.
//
// The historical half of this plugin answers "how did this model behave". This
// half answers the other question, the one history cannot answer: "is it
// answering right now". A probe is one smallest-possible model call, and its
// result is a fact about a moment, so the moment is recorded with it.
//
// Two things about a probe are deliberate:
//
//   **It goes through `ctx.llm`, not over raw HTTP.** The route, the protocol,
//     the credentials and the adapter are the ones a real request uses, so a
//     green circle means the harness itself can reach the model — not that some
//     second HTTP implementation of this plugin happens to manage it. The HTTP
//     transport exists only for a route `ctx.llm` does not serve at all (a
//     dormant provider declared in configuration), and it says so in its own
//     `source` field.
//
//   **A failed probe is a finish reason, not only an exception.** `LlmRuntime`
//     normalizes an adapter failure into a terminal `finish` chunk, so a loop
//     that only catches thrown errors reports a broken provider as a healthy
//     one. The stream is therefore read to its terminal chunk and the reason is
//     what decides the result.
//
// A probe is a manual action. Nothing here runs on a timer, and neither the
// panel nor the tool probes a model nobody asked about.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHttpProbe, DEFAULT_TIMEOUT_MS } from './liveness-http.js'
import { probeState } from './status.js'

/**
 * Bumped when the stored shape changes; an older file is discarded, not migrated.
 *
 * `code` carries the *provider's* machine code for a failure (`RATE_LIMIT`,
 * `TIMEOUT`, `HTTP_429`) rather than the stream's `finish` kind, because
 * `lib/status.js` classifies a row by that code and `error` — a stored `error`
 * kind would classify every refusal as an unclassified `down`, and the amber
 * "out of quota" circle would never be drawn.
 */
const FILE_VERSION = 2

/**
 * The budget one probe gets when its own route declares none.
 *
 * A probe is a real request, so it should be given the patience a real request
 * gets. The harness bounds a route by the provider's own `timeoutMs`, else by
 * `streamIdleTimeoutMs` — five minutes of silence before a stream is abandoned
 * — and only a route that declares nothing is left with that default. The
 * plugin used to impose a flat 15 s instead, which is a deadline the host does
 * not have: NVIDIA's free tier answers in 20-200 s, so every one of its models
 * was recorded as a timeout while the provider was perfectly reachable. The
 * plugin's own default is therefore the host's own, and a route that declares
 * its patience is probed with exactly that.
 *
 * An idle bound is read here as a whole-probe deadline, which is the stricter
 * of the two readings. That is deliberate, and the abort timer below enforces
 * it for the whole call whatever the stream does: a route that has said
 * nothing at all for five minutes is one the host's own watchdog would have
 * abandoned too.
 */
export const PROBE_TIMEOUT_MS = DEFAULT_TIMEOUT_MS
/** A caller asking for a budget may not ask for an unbounded one. */
const MAX_REQUESTED_TIMEOUT_MS = 120000
const CONCURRENCY = 4
/**
 * A result younger than this is not probed again by a plain "check" click, so a
 * second click finishes a sweep instead of re-paying for the models the first
 * one already answered. `all: true` ignores it.
 */
const FRESH_MS = 5 * 60 * 1000
const CATALOG_TTL_MS = 60 * 1000
/**
 * How many pairs one call may name outright.
 *
 * The measured catalog on this machine is 137 pairs over 16 providers, and the
 * panel's own selection can hold all of it, so this is not a bound on what a
 * reader may ask for: it is a bound on one request. Past it the request is a
 * denial of service wearing the shape of a check, and a sweep is queued and
 * answered over minutes anyway.
 */
const MAX_NAMED_PAIRS = 1024
/** How long a finished job stays in the snapshot before it is forgotten. */
const JOB_LINGER_MS = 30000
/** The probe request: one user turn, as little generation as the route allows. */
const PROBE_PROMPT = 'ping'

/**
 * Where probe results live.
 *
 * `DSH_MODEL_STATS_CACHE_DIR` is shared with the fold snapshot so a test can
 * redirect the whole cache with one variable.
 */
function snapshotFile() {
  const override = process.env.DSH_MODEL_STATS_CACHE_DIR
  const dir =
    typeof override === 'string' && override !== ''
      ? override
      : join(homedir(), '.dsh', 'cache', 'dsh-model-stats')
  return { dir, path: join(dir, 'liveness.json') }
}

function keyOf(provider, model) {
  return `${provider}\u0000${model}`
}

/** A result that never reached the provider, or reached a provider that refused. */
function failure(provider, model, code, error, latencyMs, httpStatus = null, source = 'llm') {
  return {
    provider,
    model,
    status: 'fail',
    code,
    error: String(error ?? code).slice(0, 300),
    httpStatus,
    latencyMs,
    source,
    checkedAt: Date.now(),
  }
}

/** A provider whose model ids are read out of either shape the service offers. */
function modelIdOf(entry) {
  if (typeof entry === 'string') return entry
  return typeof entry?.id === 'string' ? entry.id : null
}

/**
 * The pairs a caller named outright, or null when it named none.
 *
 * A named list is a question about exactly those models, so it is read as written
 * and never filtered against the catalog: the catalog is what the host serves, and
 * a pair the reader ticked is a pair they asked about whether or not an adapter
 * has since been mounted. A probe of a route nobody serves answers `NO_ROUTE`,
 * which is the fact the reader needs; dropping the pair instead would answer a
 * question nobody asked and look like a green row.
 *
 * Anything that is not a `{ provider, model }` pair is skipped rather than
 * thrown: one bad entry in a list of a hundred is not a reason to refuse the other
 * ninety-nine. The cap is the exception — a sweep that long is a mistake, and
 * spending a hundred real requests on it silently is the one outcome worse than
 * saying no.
 */
function namedPairs(value) {
  if (!Array.isArray(value)) return null
  const seen = new Set()
  const pairs = []
  for (const entry of value) {
    const provider = typeof entry?.provider === 'string' && entry.provider !== '' ? entry.provider : null
    // `model`, not `modelIdOf`: a catalog entry names its model `id`, and this is
    // the pair shape the panel sends and the probe store records. Reading the
    // wrong one here silenced every named check — the list resolved to zero
    // targets, and a sweep of nothing answers "already checked" for models nobody
    // asked about.
    const model = typeof entry?.model === 'string' && entry.model !== '' ? entry.model : null
    if (provider === null || model === null) continue
    const key = keyOf(provider, model)
    // A repeated pair is one probe: the panel sends the selection, and a pair can
    // reach it twice only through a host that names it in two places.
    if (seen.has(key)) continue
    seen.add(key)
    pairs.push({ provider, model })
  }
  if (pairs.length > MAX_NAMED_PAIRS) {
    throw new Error(`pairs names ${pairs.length} models; a check takes at most ${MAX_NAMED_PAIRS}`)
  }
  return pairs
}

/**
 * Build the liveness layer bound to one Cordis context.
 *
 * @param ctx - plugin context exposing `llm`.
 * @param options.persist - false disables the on-disk store (tests).
 * @param options.http - an HTTP probe to reuse, so a test can drive the dormant
 *   route without reading the profile's own configuration.
 */
export function createLiveness(ctx, options = {}) {
  const persist = options.persist !== false
  const file = snapshotFile()

  /** One entry per (provider, model): the last result of a probe. */
  const entries = new Map()
  /** Keys with a probe in flight, so the panel can draw "checking" without guessing. */
  const checking = new Set()

  let loaded = false
  let loading = null
  let catalogCache = { at: 0, pairs: [] }
  let job = null
  let saveChain = Promise.resolve()

  const http = options.http ?? createHttpProbe({})

  /** `ctx.get` rather than `ctx.llm`: a missing service must not throw on read. */
  function llm() {
    try {
      return typeof ctx.get === 'function' ? ctx.get('llm') : ctx.llm
    } catch {
      // A plugin that never declared `llm` among its injected services throws
      // here; an absent service is "no route", not a crash on the report route.
      return undefined
    }
  }

  /**
   * How long one probe of this route may take.
   *
   * An explicit `timeoutMs` from the caller still wins — that is the tool's and
   * the panel's escape hatch — clamped so a caller cannot ask for forever.
   * Otherwise the route speaks for itself through its own configuration, and
   * only a route that declares nothing falls back to {@link PROBE_TIMEOUT_MS}.
   * The lookup is a read of the same configuration the host composes, so a
   * provider with a slow free tier and a provider with a tight self-imposed
   * deadline are each probed the way a real request to them would be.
   */
  function budgetFor(provider, requested) {
    if (Number.isFinite(requested) && requested > 0) {
      return Math.min(MAX_REQUESTED_TIMEOUT_MS, requested)
    }
    const declared = http.timeoutFor(provider)
    return Number.isFinite(declared) && declared > 0 ? declared : PROBE_TIMEOUT_MS
  }

  /**
   * Read the stored results once.
   */
  async function load() {
    if (loaded) return
    if (loading !== null) {
      await loading
      return
    }
    // `persist: false` disables the store, and a store this process may not write
    // is one it has no business reading: it used to skip the write and read the file
    // anyway, so `persist: false` answered with whatever the machine had probed
    // last. That is the worst kind of test seam — a stub asserting against live
    // state — and it hid a real defect in the named-pair sweep by burying the one
    // result that was being asked about among a hundred and forty-six stale ones.
    if (!persist) {
      loaded = true
      return
    }
    loading = (async () => {
      try {
        await mkdir(file.dir, { recursive: true })
        const data = await readFile(file.path, 'utf8')
        const parsed = JSON.parse(data)
        if (parsed.version === FILE_VERSION) {
          for (const entry of parsed.results ?? []) {
            if (typeof entry?.provider !== 'string' || typeof entry?.model !== 'string') continue
            entries.set(keyOf(entry.provider, entry.model), entry)
          }
        }
      } catch {
        // A missing or corrupt file is "nothing was ever probed", not an error:
        // the first write replaces it.
      } finally {
        loaded = true
        loading = null
      }
    })()
    await loading
  }

  /**
   * Save the stored results.
   *
   * Writes are serialized because two workers finish probes at the same time;
   * a failed write must not poison the chain for every later save, so the
   * chain is reset to a resolved promise on error.
   */
  async function save() {
    if (!persist) return
    await saveChain.catch(() => {})
    saveChain = (async () => {
      await mkdir(file.dir, { recursive: true })
      const data = JSON.stringify({
        version: FILE_VERSION,
        results: [...entries.values()],
      })
      await writeFile(file.path, data)
    })()
    await saveChain.catch(() => {})
  }

  /**
   * Which pairs a request is about.
   *
   * A named model is that one pair and nothing else — a check of one model must
   * never quietly sweep the catalog because a provider was not named. A named list
   * is the same question asked of many models at once, so it is answered the same
   * way: those pairs, in the order they were named. Everything else is the catalog
   * narrowed by provider, then by freshness: a plain click skips what a recent
   * answer already covers, and `all: true` skips nothing.
   */
  async function selectTargets(raw) {
    const model = typeof raw.model === 'string' && raw.model !== '' ? raw.model : null
    if (model !== null) {
      const provider = typeof raw.provider === 'string' && raw.provider !== '' ? raw.provider : null
      if (provider === null) throw new Error('provider is required together with model')
      return [{ provider, model }]
    }

    // The freshness rule below belongs to the catalog sweep, and it is not applied
    // to a named list: the freshness question was the confusing half of the panel's
    // probe controls, and a reader who names the models wants those models checked.
    const named = namedPairs(raw.pairs)
    if (named !== null) return named.filter((pair) => !checking.has(keyOf(pair.provider, pair.model)))

    const wanted = new Set()
    for (const value of [raw.provider].flat()) {
      if (typeof value !== 'string') continue
      for (const name of value.split(',')) {
        const trimmed = name.trim()
        if (trimmed !== '') wanted.add(trimmed)
      }
    }

    const all = raw.all === true
    const fresh = Date.now() - FRESH_MS

    let pairs = await catalog()
    if (wanted.size > 0) pairs = pairs.filter((pair) => wanted.has(pair.provider))
    return pairs.filter((pair) => {
      const key = keyOf(pair.provider, pair.model)
      // A model already in flight is not queued a second time; the answer
      // coming for it is the answer this click is asking for.
      if (checking.has(key)) return false
      if (all) return true
      const previous = entries.get(key)
      // A missing entry is always worth a probe.
      if (previous === undefined) return true
      // An old file version, a hand-edited entry or a partially written one:
      // anything without a usable moment is unresolved, so it is re-probed.
      if (typeof previous.status !== 'string') return true
      if (!Number.isFinite(previous.checkedAt) || previous.checkedAt < fresh) return true
      // Fresh answer: a plain click keeps it, `all: true` was already handled
      // above. `staleOnly` names the same intent explicitly and changes nothing
      // here, which is what the tool's own description promises.
      return false
    })
  }

  /**
   * Start a check and answer immediately.
   *
   * "Check every model" is a sweep over a hundred-odd routes and cannot be one
   * HTTP response — the browser would time out on a request the host is still
   * working through. The caller gets the state now and follows `pending` down to
   * zero over the ordinary GET route.
   */
  async function start(raw = {}) {
    await load()
    // The caller's own budget, when it names one: it is passed down to every
    // probe of this sweep, and each route's declared patience is the fallback.
    const requested =
      Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0 ? raw.timeoutMs : null
    const targets = await selectTargets(raw)
    if (targets.length === 0) {
      // Nothing fresh to add. A sweep that is still moving is left alone and
      // answered as it is: a click on a provider whose pairs are all already in
      // flight must not answer `running: false` for a sweep that is visibly
      // still working — the panel polls on that flag, and it would stop
      // following a sweep that had not finished. A finished job is dropped
      // rather than reported, because repainting the *last* sweep's `done` over
      // a click that spent no request would print "checked 1 of 1" for nothing.
      if (job !== null && job.complete && job.timer !== null) clearTimeout(job.timer)
      if (job !== null && job.complete) job = null
      return snapshot()
    }

    if (job !== null && !job.complete) {
      // Append to the queue of a sweep that is already moving. The workers see
      // the appended targets the way they see the first batch — the queue is
      // the only work list — and `total` grows with it, because the panel's
      // "checked X of Y" is about this sweep, not about the first click.
      for (const pair of targets) {
        job.queue.push(pair)
        checking.add(keyOf(pair.provider, pair.model))
      }
      job.total += targets.length
      if (job.requested === null && requested !== null) job.requested = requested
      ensureCapacity(job)
      return snapshot()
    }

    if (job !== null && job.timer !== null) clearTimeout(job.timer)
    job = {
      queue: [...targets],
      completed: 0,
      total: targets.length,
      startedAt: Date.now(),
      finishedAt: null,
      requested,
      complete: false,
      runningWorkers: 0,
      promise: Promise.resolve(),
      timer: null,
    }
    for (const pair of targets) checking.add(keyOf(pair.provider, pair.model))
    ensureCapacity(job)
    return snapshot()
  }

  /**
   * Run a check and wait for it, within a budget.
   *
   * The agent's tool has no second request to follow progress with, so it waits
   * — but not forever: a sweep past the budget answers with what it has and a
   * pending count, which is the same contract the panel's own route keeps.
   */
  async function check(raw = {}, waitMs = 20000) {
    await start(raw)
    const deadline = Date.now() + waitMs
    while (job !== null && !job.complete && Date.now() < deadline) {
      await Promise.race([
        job.promise,
        new Promise((resolve) => setTimeout(resolve, 250)),
      ])
    }
    return snapshot()
  }

  async function get() {
    await load()
    return snapshot()
  }

  async function forRow(provider, model) {
    await load()
    return entries.get(keyOf(provider, model)) ?? null
  }

  /**
   * The pairs the host serves right now: live `ctx.llm` routes first, then the
   * routes only the profile's configuration declares.
   *
   * Both halves matter and they are read from the same services the host itself
   * uses. A refusal to read is not a list of zero pairs — the caller is told
   * that instead, because "the provider serves nothing" is a claim about the
   * harness and a failed lookup has no standing to make it.
   */
  function providerIds() {
    const llmServ = llm()
    if (typeof llmServ?.listProviders !== 'function') {
      return { live: false, ids: [] }
    }
    try {
      // Sync on the host (`listProviders(): LlmProviderInfo[]`) and async
      // across the remote proxy a client-side namespace gets, so both are
      // accepted: `await` on a non-thenable is the value itself.
      const listed = Promise.resolve(llmServ.listProviders())
      return listed.then((resolved) => ({ live: true, ids: idsOf(resolved) }))
    } catch {
      // `listProviders` should not throw; if it does, the live half is unread,
      // which is not the same as an empty live half.
      return { live: false, ids: [] }
    }
  }

  /**
   * The route keys out of `LlmProviderInfo[]`, which is `{ id, name }` — the id
   * is what `GenerateOptions.provider` takes and the name is for a human. A
   * bare string is accepted too, because a stub or a future shape may hand one.
   */
  function idsOf(listed) {
    const ids = []
    for (const entry of Array.isArray(listed) ? listed : []) {
      const id = typeof entry === 'string' ? entry : entry?.id
      if (typeof id === 'string' && id !== '') ids.push(id)
    }
    return ids
  }

  /**
   * Enumerate one provider's models through `ctx.llm`, as pairs.
   *
   * `listModels` is async and answers with `{ provider, id, name }` records.
   * A provider that fails to answer its own list is skipped rather than
   * aborting the catalog: one broken route must not hide the other ninety.
   */
  async function pairsOf(provider) {
    const llmServ = llm()
    if (typeof llmServ?.listModels !== 'function') return []
    let models
    try {
      models = await llmServ.listModels(provider)
    } catch {
      return []
    }
    if (!Array.isArray(models)) return []
    const pairs = []
    const seen = new Set()
    for (const model of models) {
      const id = modelIdOf(model)
      if (id === null || seen.has(id)) continue
      seen.add(id)
      pairs.push({ provider, model: id })
    }
    return pairs
  }

  /** Every pair a probe may be aimed at, cached for one minute. */
  async function catalog() {
    if (catalogCache.at + CATALOG_TTL_MS > Date.now()) {
      return catalogCache.pairs
    }
    // `livePairs()` answers with both halves of one enumeration; the sweep only
    // wants the list, and the `live` flag belongs to the archive rule that
    // `configured()` feeds.
    const { pairs } = await livePairs()
    catalogCache = { at: Date.now(), pairs }
    return pairs
  }

  /**
   * `configured()` for the archive rule and the tool's own options, uncached.
   *
   * The area it is asked from is a request or a tool call, not a loop, so the
   * cost of one enumeration is paid where it is asked for; caching it here is
   * what would make the panel archive a model that was just added.
   */
  async function configured() {
    const pairs = await livePairs()
    return { live: pairs.live, pairs: pairs.pairs }
  }

  /**
   * The live half and the configured half of the catalog, as one enumeration.
   *
   * The live half is `ctx.llm.listProviders()`, and a provider that answers it
   * is asked for its models. The configured half is `http.catalog()`, which
   * reads the profile's own patch: a dormant provider — declared in
   * configuration, not mounted by any adapter — has no `ctx.llm` route at all,
   * and it is exactly the route the HTTP transport exists for.
   */
  async function livePairs() {
    const live = await providerIds()
    const pairs = []
    for (const provider of live.ids) {
      pairs.push(...(await pairsOf(provider)))
    }

    let dormant = []
    try {
      dormant = await http.catalog()
    } catch {
      dormant = []
    }
    const known = new Set(pairs.map((pair) => keyOf(pair.provider, pair.model)))
    for (const entry of Array.isArray(dormant) ? dormant : []) {
      const provider = typeof entry?.provider === 'string' ? entry.provider : null
      const model = modelIdOf(entry)
      if (provider === null || model === null) continue
      // A route the live half already serves is not listed twice, and a dormant
      // entry is not evidence that the live half answered anything.
      if (live.ids.includes(provider)) continue
      const key = keyOf(provider, model)
      if (known.has(key)) continue
      known.add(key)
      pairs.push({ provider, model })
    }

    return { live: live.live, pairs }
  }

  /**
   * Probe one model and return the raw result.
   *
   * The route decides the transport, and the two are not interchangeable. A
   * provider `ctx.llm` serves is probed through it — the real route, protocol,
   * credentials and adapter — so a green circle means the harness can reach the
   * model. A provider no adapter mounted (a dormant declaration) has no
   * `ctx.llm` route to exercise, and only then is the configuration's own
   * endpoint used, with `source: 'http'` recording the weaker claim.
   */
  async function probe(provider, model, requested) {
    const live = await providerIds()
    const routable = live.ids.includes(provider)
    if (routable || !http.has(provider)) {
      return probeThroughLlm(provider, model, requested, routable ? 'llm' : 'no-route')
    }
    return probeThroughHttp(provider, model, requested)
  }

  /**
   * The one probe that goes through `ctx.llm`.
   *
   * The stream is read to its terminal `finish` chunk: the runtime normalizes
   * an adapter failure into `{ kind: 'error' | 'aborted', failure }` rather than
   * throwing, so a loop that only catches exceptions reports a broken provider
   * as a healthy one. The failure's own machine code is what travels into the
   * store, because `lib/status.js` classifies the row by it and the panel's
   * amber "out of quota" circle is drawn from that code.
   */
  async function probeThroughLlm(provider, model, requested, why) {
    const llmServ = llm()
    if (typeof llmServ?.stream !== 'function') {
      // No stream means no route to exercise, and `NO_ADAPTER` is the code the
      // status vocabulary already reads as "the fix is the configuration".
      return failure(provider, model, 'NO_ADAPTER', `no ctx.llm route serves ${provider} (${why})`, 0, null, 'llm')
    }

    const timeoutMs = budgetFor(provider, requested)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let startTime = Date.now()
    try {
      // Exactly what a real request sends and nothing more: `maxTokens` and
      // `temperature` were parameters of this plugin's own invention, and a
      // present `maxTokens` makes the codex adapter send `max_output_tokens`,
      // which that backend refuses with a 400 — every codex model was recorded
      // as a broken route while the fold showed it answering real steps. The
      // probe asks for one short turn and lets the route decide how it caps.
      //
      // `content` is the block array a real message carries, not a bare string:
      // adapters project the blocks, and one that receives a string fails with
      // `content.some is not a function` in zero milliseconds — a red circle
      // for a route nothing was actually asked.
      const stream = llmServ.stream({
        provider,
        model,
        messages: [{ role: 'user', content: [{ type: 'text', text: PROBE_PROMPT }] }],
        signal: controller.signal,
      })
      let finish = null
      for await (const chunk of stream) {
        if (chunk?.type === 'finish') {
          finish = chunk
          break
        }
      }
      const latencyMs = Date.now() - startTime
      if (finish === null) {
        // A stream that ends without a terminal chunk is not an answer; the
        // contract says one always arrives, so this is a broken exchange rather
        // than a healthy model.
        return failure(provider, model, 'NO_FINISH', 'the stream ended without a terminal chunk', latencyMs)
      }
      const reason = finish.reason ?? { kind: 'stop' }
      if (reason.kind === 'error') {
        const code = reason.failure?.code ?? 'UNKNOWN'
        const status = Number.isFinite(reason.failure?.status) ? reason.failure.status : null
        return failure(provider, model, code, reason.failure?.message ?? 'unknown error', latencyMs, status)
      }
      if (reason.kind === 'aborted') {
        // Intentional aborts and watchdog aborts are the same event here: the
        // probe stopped waiting. The provider's own abort code, when it named
        // one, says more than `TIMEOUT` does.
        const code = reason.failure?.code ?? 'TIMEOUT'
        const status = Number.isFinite(reason.failure?.status) ? reason.failure.status : null
        const error = controller.signal.aborted
          ? `no answer within ${timeoutMs} ms`
          : (reason.failure?.message ?? 'the request was aborted')
        return failure(provider, model, code === 'ABORTED' ? 'TIMEOUT' : code, error, latencyMs, status)
      }
      // `stop`, `max-tokens`, `tool-calls` and any adapter-specific reason all
      // mean the provider answered — a probe asked for one turn, and a model
      // that filled the allowance answered it.
      return {
        provider,
        model,
        status: 'ok',
        code: 'OK',
        error: null,
        httpStatus: null,
        latencyMs,
        source: 'llm',
        checkedAt: Date.now(),
      }
    } catch (error) {
      // A middleware or consumer failure stays thrown by design, and an
      // unregistered route may arrive as a throw rather than a chunk; both are
      // facts about the route, not a crash of the sweep.
      const latencyMs = Date.now() - startTime
      const code = controller.signal.aborted ? 'TIMEOUT' : (error?.code ?? 'UNKNOWN')
      const message = controller.signal.aborted
        ? `no answer within ${timeoutMs} ms`
        : (error?.message ?? String(error))
      return failure(provider, model, code, message, latencyMs)
    } finally {
      clearTimeout(timer)
      // The stream is left open on the `break` above; closing it is what releases
      // the socket instead of waiting for the host's own watchdog.
      controller.abort()
    }
  }

  /**
   * The one probe that cannot go through `ctx.llm`: a route declared in the
   * profile's configuration that no mounted adapter serves.
   */
  async function probeThroughHttp(provider, model, requested) {
    const timeoutMs = budgetFor(provider, requested)
    const startTime = Date.now()
    try {
      const result = await http.probe({ provider, model, timeoutMs })
      const latencyMs = Number.isFinite(result?.latencyMs) ? result.latencyMs : Date.now() - startTime
      if (result?.ok === true) {
        return {
          provider,
          model,
          status: 'ok',
          code: 'OK',
          error: null,
          httpStatus: Number.isFinite(result.status) ? result.status : null,
          latencyMs,
          source: 'http',
          checkedAt: Date.now(),
        }
      }
      return failure(
        provider,
        model,
        result?.code ?? 'HTTP_FAIL',
        result?.error ?? 'the endpoint refused the probe',
        latencyMs,
        Number.isFinite(result?.status) ? result.status : null,
        'http',
      )
    } catch (error) {
      // `http.probe` promises never to throw; if it still does, the probe is a
      // failed one rather than a failed sweep.
      return failure(provider, model, 'HTTP_FAIL', error?.message ?? String(error), Date.now() - startTime, null, 'http')
    }
  }

  /**
   * Everything a caller needs to draw the table now, including work still moving.
   */
  function snapshot() {
    return {
      // Every result leaves here with the state it means — `up`, `limited`,
      // `missing`, `denied`, `down` — so the panel's cell, the row order and the
      // tool's own table are three readings of one classification. The store on
      // disk keeps the raw answer; the classification is derived on the way out,
      // because it is a rule about codes and messages, not a fact to be cached.
      results: [...entries.values()].map((entry) => ({ ...entry, state: probeState(entry) })),
      checking: [...checking],
      running: job !== null && !job.complete,
      total: job?.total ?? 0,
      done: job?.completed ?? 0,
      pending: job?.queue.length ?? 0,
      startedAt: job?.startedAt ?? null,
      finishedAt: job?.finishedAt ?? null,
    }
  }

  /**
   * Keep as many workers alive as there is work and capacity for.
   *
   * The queue is the only work list and `completed`/`checking` are the only
   * progress facts, so a worker loop is nothing but "take the next target,
   * probe it, record it". `total` is what the panel reports against and it is
   * not re-derived from the queue, because the queue shrinks as it is drained.
   */
  function ensureCapacity(current) {
    const capacity = Math.min(CONCURRENCY, current.total - current.completed)
    if (current.runningWorkers >= capacity) return
    // Every worker in this round is chained off the *same* promise. Chaining
    // each one off the previous worker's chain was the bug that made the pool
    // sequential: four workers were spawned, and the second of them began only
    // when the first had finished, because its `.then` sat behind that worker's
    // own promise. A stable base is what makes the pool a pool — measured on
    // six targets answering in 150 ms each: 911 ms before, ~300 ms after.
    const base = current.promise
    const round = []
    while (current.runningWorkers < capacity) {
      current.runningWorkers += 1
      round.push(
        base
          .then(() => worker(current))
          .finally(() => {
            if (!current.complete) ensureCapacity(current)
          }),
      )
    }
    current.promise = Promise.all(round).catch(() => {})
  }

  /**
   * One worker: drain the queue until it is empty, then finish the job.
   */
  async function worker(current) {
    try {
      while (current.queue.length > 0) {
        const pair = current.queue.shift()
        const key = keyOf(pair.provider, pair.model)
        checking.add(key)
        try {
          const result = await probe(pair.provider, pair.model, current.requested)
          entries.set(key, result)
        } catch (error) {
          // `probe` normalizes its own failures; one that escapes is still one
          // row's bad answer, not a reason to abandon the rest of the sweep.
          entries.set(key, failure(pair.provider, pair.model, 'UNKNOWN', error?.message ?? String(error), 0))
        } finally {
          checking.delete(key)
        }
        current.completed += 1
        await save()
      }
    } finally {
      current.runningWorkers -= 1
      // The last worker to leave closes the job, so `running` stays true while
      // any probe is still in flight and no poll can read a half-drained queue
      // as a finished sweep.
      if (current.runningWorkers === 0 && current.queue.length === 0) {
        current.complete = true
        current.finishedAt = Date.now()
        if (current.timer === null) {
          current.timer = setTimeout(() => {
            if (job === current) job = null
          }, JOB_LINGER_MS)
          current.timer.unref?.()
        }
      }
    }
  }

  return { start, check, get, forRow, catalog, configured, probe }
}
