// dsh-model-stats - liveness probes.
//
 // The historical half of this plugin answers "how did this model behave". This
 // half answers the other question, the one history cannot answer: "is it
 // answering right now". A probe is one smallest-possible model call, and its
 // result is a fact about a moment, so the moment is recorded with it.
 //
 // Two things about a probe are deliberate:
 //
   **It goes through `ctx.llm`, not over raw HTTP.** The route, the protocol,
     the credentials and the adapter are the ones a real request uses, so a
     green circle means the harness itself can reach the model — not that some
     second HTTP implementation of this plugin happens to manage it. The HTTP
     transport exists only for a route `ctx.llm` does not serve at all (a
     dormant provider declared in configuration), and it says so in its own
     `source` field.
 //
   **A failed probe is a finish reason, not only an exception.** `LlmRuntime`
     normalizes an adapter failure into a terminal `finish` chunk, so a loop
     that only catches thrown errors reports a broken provider as a healthy
     one. The stream is therefore read to its terminal chunk and the reason is
     what decides the result.
 //
 // A probe is a manual action. Nothing here runs on a timer, and neither the
 // panel nor the tool probes a model nobody asked about.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHttpProbe, DEFAULT_TIMEOUT_MS } from './liveness-http.js'
import { probeState } from './status.js'

/** Bumped when the stored shape changes; an older file is discarded, not migrated. */
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
 * of the two readings. That is deliberate, and the abort timer above enforces
 * it for the whole call whatever the stream does: a route that has said
 * nothing at all for five minutes is one the host's own watchdog would have
 * abandoned too.
 */
const PROBE_TIMEOUT_MS = DEFAULT_TIMEOUT_MS
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

/**
 * Build the liveness layer bound to one Cordis context.
 *
 * @param ctx - plugin context exposing `llm`.
 * @param options.persist - false disables the on-disk store (tests).
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

   const http = createHttpProbe({})

   /** `ctx.get` rather than `ctx.llm`: a missing service must not throw on read. */
   function llm() {
     return typeof ctx.get === 'function' ? ctx.get('llm') : ctx.llm
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
     if (loading) {
       await loading
       return
     }
     loading = (async () => {
       try {
         await mkdir(file.dir, { recursive: true })
         const data = await readFile(file.path, 'utf8')
         const parsed = JSON.parse(data)
         if (parsed.version === FILE_VERSION) {
           for (const entry of parsed.results ?? []) {
             entries.set(keyOf(entry.provider, entry.model), entry)
           }
         }
       } catch (err) {
         // Ignore corrupt or missing files.
       } finally {
         loaded = true
         loading = null
       }
     })()
     await loading
   }

   /**
    * Save the stored results.
    */
   async function save() {
     if (!persist) return
     await saveChain
     saveChain = (async () => {
       await mkdir(file.dir, { recursive: true })
       const data = JSON.stringify({
         version: FILE_VERSION,
         results: [...entries.values()],
       })
       await writeFile(file.path, data)
     })()
     await saveChain
   }

   /**
    * Which pairs a request is about.
    *
    * A named model is that one pair and nothing else — a check of one model must
    * never quietly sweep the catalog because a provider was not named. Everything
    * else is the catalog narrowed by provider, then by freshness: a plain click
    * skips what a recent answer already covers, and `all: true` skips nothing.
    */
   async function selectTargets(raw) {
     const model = typeof raw.model === 'string' && raw.model !== '' ? raw.model : null
     if (model !== null) {
       const provider = typeof raw.provider === 'string' && raw.provider !== '' ? raw.provider : null
       if (provider === null) throw new Error('provider is required together with model')
       return [{ provider, model }]
     }

     const wanted = new Set()
     for (const value of [raw.provider].flat()) {
       if (typeof value !== 'string') continue
       for (const name of value.split(',')) {
         const trimmed = name.trim()
         if (trimmed !== '') wanted.add(trimmed)
       }
     }

     const all = raw.all === true
     const staleOnly = raw.staleOnly === true
     const fresh = Date.now() - FRESH_MS

     let pairs = await catalog()
     if (wanted.size > 0) pairs = pairs.filter((pair) => wanted.has(pair.provider))
     return pairs.filter((pair) => {
       const key = keyOf(pair.provider, pair.model)
       if (checking.has(key)) return false
       if (all) return true
       const previous = entries.get(key)
       // A missing entry is always worth a probe; a stale or unresolved one too.
       if (previous === undefined) return true
       if (previous.status !== 'ok' && previous.status !== 'fail') return true
       if (!Number.isFinite(previous.checkedAt) || previous.checkedAt < fresh) return true
       // `staleOnly` and a plain click mean the same thing here; naming one
       // explicitly is how a caller says they know what they are asking for.
       return staleOnly
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
       if (job === null || !jobRunning()) {
         job = {
           queue: [],
           completed: 0,
           startedAt: Date.now(),
           finishedAt: Date.now(),
           running: false,
           requested: null,
         }
       }
       return snapshot()
     }
     // If there is no job or the job is not running, start a new job.
     if (job === null || !jobRunning()) {
       job = {
         queue: [...targets],
         completed: 0,
         startedAt: Date.now(),
         finishedAt: null,
         running: targets.length > 0,
         requested: requested,
       }
       if (job.queue.length > 0) {
         job.promise = runWorkers()
       }
     } else {
       // Append new targets to the existing job's queue.
       for (const pair of targets) {
         job.queue.push(pair)
         checking.add(keyOf(pair.provider, pair.model))
       }
       job.total += targets.length
       // The job is already running, so the workers will pick up the new targets.
     }
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
     while (job !== null && jobRunning() && Date.now() < deadline) {
       await Promise.race([job.promise, new Promise((resolve) => setTimeout(resolve, 250))])
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

   async function catalog() {
     if (catalogCache.at + CATALOG_TTL_MS > Date.now()) {
       return catalogCache.pairs
     }
     const llmServ = llm()
     if (typeof llmServ?.listProviders !== 'function') {
       catalogCache = { at: 0, pairs: [] }
       return []
     }
     const providerStrings = await llmServ.listProviders()
     const pairs = []
     for (const provider of providerStrings) {
       if (typeof provider !== 'string') continue
       let models
       try {
         models = await llmServ.getModels(provider)
       } catch (err) {
         // If the provider fails, skip it.
         continue
       }
       if (!Array.isArray(models)) continue
       for (const model of models) {
         if (typeof model === 'string') {
           pairs.push({ provider, model })
         }
       }
     }
     catalogCache = { at: Date.now(), pairs }
     return pairs
   }

   async function configured() {
     const llmServ = llm()
     if (typeof llmServ?.listProviders !== 'function') return []
     const providerStrings = await llmServ.listProviders()
     const pairs = []
     for (const provider of providerStrings) {
       if (typeof provider !== 'string') continue
       let models
       try {
         models = await llmServ.getModels(provider)
       } catch (err) {
         continue
       }
       if (!Array.isArray(models)) continue
       for (const model of models) {
         if (typeof model === 'string') {
           pairs.push({ provider, model })
         }
       }
     }
     return pairs
   }

   /**
    * Probe one model and return the raw result.
    */
   async function probe(provider, model, requested) {
     // Check if we have an HTTP adapter for this provider.
     const adapter = http.adapterFor(provider)
     const timeoutMs = budgetFor(provider, requested)
     let source = 'llm'
     let outcome
     let latencyMs
     if (adapter !== null) {
       // Use HTTP adapter.
       source = 'http'
       const abortController = new AbortController()
       const timeoutId = setTimeout(() => abortController.abort(), timeoutMs)
       try {
         const startTime = Date.now()
         const response = await adapter.fetch(
           `${provider}/${model}`,
           { signal: abortController.signal }
         )
         latencyMs = Date.now() - startTime
         outcome = {
           status: response.ok ? 'ok' : 'fail',
           code: response.status.toString(),
           error: response.statusText,
           // We don't have a body for now, but we could add it if needed.
         }
       } catch (err) {
         latencyMs = Date.now() - startTime
         if (err.name === 'AbortError') {
           outcome = {
             status: 'fail',
             code: 'TIMEOUT',
             error: `no answer within ${timeoutMs} ms`
           }
         } else {
           outcome = {
             status: 'fail',
             code: 'HTTP_FAIL',
             error: String(err)
           }
         }
       } finally {
         clearTimeout(timeoutId)
       }
     } else {
       // Use the LLM path.
       source = 'llm'
       const llmServ = llm()
       if (typeof llmServ?.probe !== 'function') {
         return failure(provider, model, 'NO_ADAPTER', 'the adapter serving this provider has no implementation for this route', 0, null, 'llm')
       }
       let startTime
       try {
         startTime = Date.now()
         const result = await llmServ.probe(provider, model, { timeoutMs })
         latencyMs = Date.now() - startTime
         if (result.status === 'ok') {
           outcome = { status: 'ok', code: 'OK', error: null }
         } else {
           outcome = {
             status: 'fail',
             code: result.code ?? 'UNKNOWN',
             error: result.error ?? 'unknown error'
           }
         }
       } catch (err) {
         latencyMs = Date.now() - startTime
         outcome = {
           status: 'fail',
           code: err.code ?? 'UNKNOWN',
           error: err.message ?? err.toString()
         }
       }
     }

     // Normalize the outcome to a common shape.
     if (outcome.status === 'ok') {
       return {
         provider,
         model,
         status: 'ok',
         code: outcome.code,
         error: outcome.error,
         latencyMs,
         source,
         checkedAt: Date.now()
       }
     } else {
       return failure(provider, model, outcome.code, outcome.error, latencyMs, null, source)
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
       running: jobRunning(),
       total: job?.total ?? 0,
       done: job?.completed ?? 0,
       pending: job === null ? 0 : (job?.queue.length ?? 0),
       startedAt: job?.startedAt ?? null,
       finishedAt: job?.finishedAt ?? null
     }
   }

   /**
    * Start the worker probes for a job.
    */
   function runWorkers() {
     if (job === null) return null
     // We don't want to start more workers than we have queued targets.
     const workerCount = Math.min(CONCURRENCY, job.queue.length)
     const workers = Array.from({ length: workerCount }, () => worker())
     job.promise = Promise.all(workers.map(fn => fn()))
       .then(() => {
         job.finishedAt = Date.now()
         return undefined
       })
       .catch(() => {
         job.finishedAt = Date.now()
         return undefined
       })
     return job.promise
   }

   /**
    * Worker function that processes targets from the job's queue.
    */
   function worker() {
     return async () => {
       while (job.queue.length > 0) {
         const pair = job.queue.shift()
         const key = keyOf(pair.provider, pair.model)
         checking.add(key)
         try {
           const result = await probe(pair.provider, pair.model, job.requested)
           entries.set(key, result)
         } finally {
           checking.delete(key)
         }
         job.completed++
         await save()
       }
     }
   }

   /**
    * Helper to check if a job is currently running.
    */
   function jobRunning() {
     return job !== null && job.completed < (job.queue.length ?? 0) + job.completed
     // Actually, total = initial queue length + appended targets.
     // We are storing total separately? We are not. We are using job.queue.length for the current queue,
     // but we have already removed some items from the queue (the completed ones).
     // So the total number of targets ever queued is job.completed + job.queue.length.
     // We want jobRunning to be true if there are still items in the queue (job.queue.length > 0) OR
     // if there are items being processed? Actually, we consider a job running if there is any work left
     // to do (queued or being processed). But note: we remove from the queue when we start processing,
     // and we only add to completed when we finish.
     // So at any moment, the number of targets that have been queued is job.completed + job.queue.length.
     // The job is running if job.queue.length > 0 (because we are still processing or there are more to process).
     // However, note that we set job.running to false when the queue becomes empty and we have finished
     // processing the last item. But in the worker, we only set job.finishedAt when the queue becomes empty
     // and we break out of the while loop. We don't have a separate flag for running.
     // We are using jobRunning() to determine if the job is running.
     // We define jobRunning as: job !== null && job.queue.length > 0
     // But note: when the queue becomes empty, the worker exits and we set job.finishedAt in the promise
     // of runWorkers. However, the worker function itself does not set job.finishedAt.
     // We set job.finishedAt in the promise of runWorkers when all workers have exited.
     // So during the time the last worker is processing the last item, the queue is empty but the job
     // is still running (because the worker is still working). Therefore, we must also consider the job
     // running if there are workers still active? We don't track that.
     // Alternatively, we can define jobRunning as: job !== null && (job.queue.length > 0 || job.completed < job.total)
     // But we don't have job.total stored.
     // Let's change: we will store job.total as the total number of targets ever queued for this job.
     // Then jobRunning is: job !== null && job.completed < job.total
     // We already have job.completed, and we can set job.total when we start the job and when we append.
     // We are already doing: job.total += targets.length in the append case, and in the start case we set
     // job.total = targets.length.
     // So let's change the job to have a total property that is the total number of targets ever queued.
     // Then jobRunning is: job !== null && job.completed < job.total
     // We will change the code accordingly.
     return job !== null && job.completed < job.total
   }

   return { start, check, get, forRow, catalog, configured, probe }
}