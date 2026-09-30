// dsh-model-stats - shared report collector.
//
// One implementation feeds both the agent-facing `model_stats` tool and the
// `GET /api/model-stats` route behind the settings panel, so the panel and the
// model can never disagree.
//
// Reads only committed history. Each session is folded once and cached; the
// cache is validated against the persistence revision and, when the collector
// was hydrated from the on-disk snapshot, served without touching the corpus at
// all. A caller that cannot wait asks for bounded phases instead of one long
// block:
//
//   statPass()      one revision probe for the whole corpus (no log reads)
//   snapshotReport() aggregate straight from the snapshot (no I/O)
//   collect()       fold only what is missing or changed
//
// Each session is read at most once per collector lifetime regardless of how
// many of those phases a caller runs.

import { aggregate, comparatorFor, foldSession, unmeasuredRow } from './fold.js'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The orders the agent's tool offers, in the order its schema lists them.
 *
 * A stable contract with the model: the text report is built around these five,
 * and widening what the model may ask for is a decision of its own, not a
 * side effect of the panel gaining columns.
 */
export const SORTS = ['steps', 'ttft', 'speed', 'errors', 'lastSeen']

/**
 * The orders the panel route accepts: the tool's five plus one for every other
 * column of its table, because a heading the user can click has to be able to
 * ask the host for the figure that heading shows.
 *
 * `liveness` is the one order the fold does not read off itself — its figure is
 * a probe's, and probes live in their own store — so the route hands the
 * aggregate a `statusOf` lookup along with the key. Everything else in this list
 * is a measurement the session log already holds.
 */
export const PANEL_SORTS = [
  ...SORTS,
  'name',
  'ttftP90',
  'tpsMax',
  'confidence',
  'llm',
  'cache',
  'retry',
  'ttftClean',
  'e2e',
  'prefill',
  'overhead',
  'errorRate',
  'modelErrors',
  'interrupted',
  'liveness',
]

/** The direction an order can be asked for; anything else means the key's own. */
export function sortDirection(value) {
  return value === 'asc' || value === 'desc' ? value : null
}

/** Current session-log format. Older generations carry a corpus-wide revision. */
const SESSION_FORMAT_VERSION = 4

/**
 * Bumped to 2 when the sample shape gained the retry fields. A snapshot taken
 * at version 1 holds samples with no `retryCount`, which the aggregate reads as
 * "never retried" — the difference between a measured zero and a missing
 * measurement, and exactly the kind of thing that must invalidate a cache
 * rather than be served from it.
 */
const SNAPSHOT_VERSION = 2
const SNAPSHOT_FILE = 'fold-snapshot.json'

/**
 * Where the folded snapshot lives.
 *
 * `DSH_MODEL_STATS_CACHE_DIR` overrides it so tests can drive the real
 * round-trip without touching the user's cache.
 */
function snapshotDir() {
  const override = process.env.DSH_MODEL_STATS_CACHE_DIR
  if (typeof override === 'string' && override !== '') return override
  return join(homedir(), '.dsh', 'cache', 'dsh-model-stats')
}

/** Cache key for one session. The legend keeps unreadable ids distinguishable. */
function keyOf(sessionId, revision) {
  return revision === null ? `${sessionId}\u0000?` : `${sessionId}\u0000${revision}`
}

/**
 * Build a collector bound to one Cordis context.
 *
 * @param ctx - plugin context exposing `sessionQuery` and `sessionPersistence`.
 * @param options.persist - false disables the on-disk snapshot (tests).
 */
export function createCollector(ctx, options = {}) {
  const persist = options.persist !== false
  const cacheDir =
    typeof options.cacheDir === 'string' && options.cacheDir !== ''
      ? options.cacheDir
      : snapshotDir()
  const cache = new Map()
  // Reads in flight, keyed by id. The background warm pass and a panel request
  // overlap by design, and without this both would read the same session
  // concurrently and pay the read twice.
  const inFlight = new Map()

  /** Persistence revisions observed for the whole corpus in one listing. */
  let statsLoaded = false
  let stats = new Map()
  let statsFailed = false
  let hydrating = null
  let snapshot = null
  // The corpus-wide legacy revision the snapshot was written under, or null when
  // it holds no legacy generation. Without it a legacy entry can only be re-read.
  let snapshotFingerprint = null

  const readNowIds = new Set()
  // Folded during the pass currently running; a pass reports its own work, not
  // the lifetime total, so "read now" means what a caller just paid for.
  let passReads = 0
  let pruned = 0

  function foldOne(sessionId) {
    const existing = inFlight.get(sessionId)
    if (existing !== undefined) return existing
    const work = foldUncached(sessionId)
    inFlight.set(sessionId, work)
    return work.finally(() => {
      inFlight.delete(sessionId)
    })
  }

  /**
   * Read one session's events plus the revision they were read at.
   *
   * `observeSession` is the single-call path: it stats the stored shape and
   * hands back the log and its revision together, with its own revision-keyed
   * cache behind it. The older `stat` + `readSession` pair costs an extra
   * corpus listing per session inside `sessionQuery`, which is what made a cold
   * pass minutes long — it stays only as a fallback.
   */
  async function readSource(sessionId) {
    const query = ctx.get('sessionQuery')
    if (query === undefined) return { skipped: 'no-session-query' }

    if (typeof query.observeSession === 'function') {
      let lease
      try {
        lease = await query.observeSession(sessionId, { projectionMode: 'none' })
      } catch {
        return { skipped: 'unreadable' }
      }
      try {
        const events = Array.isArray(lease?.events) ? lease.events : [...(lease?.events ?? [])]
        const revision =
          typeof lease?.revision === 'string' && lease.revision !== '' ? lease.revision : null
        return { events, revision }
      } finally {
        try {
          lease?.[Symbol.dispose]?.()
        } catch {
          // A failed dispose only costs cache pressure, never correctness.
        }
      }
    }

    let revision = null
    const persistence = ctx.get('sessionPersistence')
    if (persistence !== undefined) {
      try {
        const snapshot = await persistence.stat(sessionId)
        revision = snapshot?.revision ?? null
      } catch {
        revision = null
      }
    }
    try {
      const read = await query.readSession(sessionId)
      const events = Array.isArray(read?.events) ? read.events : null
      if (events === null) return { skipped: 'unreadable' }
      return { events, revision }
    } catch {
      return { skipped: 'unreadable' }
    }
  }

  async function foldUncached(sessionId) {
    const current = stats.get(sessionId) ?? null
    // A snapshot may only answer for a session whose revision was actually
    // compared. A current-format revision compares one log against itself; a
    // legacy one compares the whole historical corpus, so it may only be trusted
    // when the snapshot's recorded corpus hash still matches the live one.
    const legacyHash = corpusHashOf(current)
    const comparable =
      snapshot !== null &&
      current !== null &&
      (legacyHash === null || legacyHash === snapshotFingerprint)
    if (comparable) {
      const cached = cache.get(keyOf(sessionId, current))
      if (cached !== undefined) return cached
    }

    const source = await readSource(sessionId)
    if (source.skipped !== undefined) return source
    readNowIds.add(sessionId)
    passReads += 1

    const folded = foldSession(source.events, { sessionId })
    // The entry is keyed by the corpus listing's revision whenever there is one,
    // because that is the only revision a later pass can compare it against.
    // `observeSession` reports its own spelling of the same fact (a legacy
    // generation there loses the corpus hash), and mixing the two would make a
    // session look changed the moment its own read finished.
    const key = current ?? source.revision ?? null
    const entry = {
      revision: key,
      samples: folded.samples,
      errors: folded.errors,
      retries: folded.retries,
    }
    cache.set(keyOf(sessionId, key), entry)
    return entry
  }

  /**
   * Probe the corpus for persistence revisions without reading a single log.
   *
   * One listing supplies the revision of every session, which is the difference
   * between a repeat pass that re-reads the whole store and one that reads
   * nothing. It is memoized, so a reader that needs to list the corpus anyway
   * pays for it once.
   *
   * Note the two revision spellings. A listing reports a legacy generation as
   * `<file identity>:<corpus hash>` and a current one as the bare file identity,
   * while `observeSession` reports the bare identity in both cases — so a
   * comparison only ever happens between two revisions from the same source.
   */
  async function statPass() {
    if (statsLoaded) return statsLoaded
    if (statsFailed) return null
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) {
      statsFailed = true
      return null
    }
    try {
      const listed = await persistence.list()
      const next = new Map()
      for (const entry of listed ?? []) {
        const id = entry?.header?.id
        if (typeof id !== 'string') continue
        next.set(id, typeof entry.revision === 'string' ? entry.revision : null)
      }
      stats = next
      statsLoaded = true
      return statsLoaded
    } catch {
      statsFailed = true
      return null
    }
  }

  /**
   * The corpus hash legacy generations share, or null when the corpus holds none.
   *
   * This — not any one session's revision — is what a snapshot records: every
   * legacy log spells the same hash behind its own `<file identity>` prefix, so
   * remembering one session's full revision would compare true for that session
   * alone and force the other hundreds to be re-read for no reason.
   */
  function corpusHashOfStats() {
    for (const revision of stats.values()) {
      const hash = corpusHashOf(revision)
      if (hash !== null) return hash
    }
    return null
  }

  /**
   * Fold the whole corpus and aggregate it.
   *
   * @param options.sort - one of {@link SORTS}, or — for the panel — one of
   *   {@link PANEL_SORTS}.
   * @param options.dir - `asc` or `desc`; the key's own direction when omitted.
   * @param options.sinceMs - only count steps at or after this timestamp.
   * @param options.budgetMs - return a partial answer once this deadline passes.
   * @param options.statusOf - `(provider, model, lastSeen) => rank|null`, the
   *   status rank read in the probe store. Only the `liveness` order reads it,
   *   and only the panel route has one; the tool's five orders never ask.
   */
  async function collect(options = {}) {
    const query = ctx.get('sessionQuery')
    if (query === undefined) {
      return { error: 'the sessionQuery service is not available in this composition' }
    }

    await hydrate()
    // One listing decides, for every session, whether its snapshot entry may be
    // reused instead of re-read.
    await statPass()

    // A caller that just listed the corpus (the panel does, to answer from the
    // snapshot) hands its records over instead of paying for another listing.
    let records = Array.isArray(options.records) ? options.records : null
    if (records === null) {
      try {
        records = await query.listSessions()
      } catch (error) {
        return { error: `listing sessions failed: ${String(error?.message ?? error)}` }
      }
    }

    const samples = []
    const errors = []
    const retries = []
    const seen = new Set()
    let scanned = 0
    let skipped = 0
    let pending = 0
    passReads = 0
    const sinceMs = Number.isFinite(options.sinceMs) ? options.sinceMs : null

    // Every session costs a full store read, so a cold pass over the whole
    // corpus takes tens of seconds. A deadline keeps one request bounded: the
    // newest sessions are folded first, the rest stay pending, and the warm-up
    // pass (or the next call) picks them up.
    const budgetMs = Number.isFinite(options.budgetMs) ? options.budgetMs : null
    const deadline = budgetMs === null ? null : performance.now() + budgetMs

    for (const record of records) {
      const sessionId = record?.header?.id ?? record?.id
      if (typeof sessionId !== 'string') continue
      seen.add(sessionId)

      // Awaiting a session that is already folded or already being read costs
      // nothing extra, so those are never pushed past the deadline.
      const alreadyPaid = isSettled(sessionId) || inFlight.has(sessionId)
      if (deadline !== null && !alreadyPaid && performance.now() > deadline && scanned > 0) {
        pending += 1
        continue
      }

      const folded = await foldOne(sessionId)
      if (folded.skipped !== undefined) {
        skipped += 1
        continue
      }
      scanned += 1
      for (const sample of folded.samples) {
        if (sinceMs !== null && sample.time < sinceMs) continue
        samples.push(sample)
      }
      for (const error of folded.errors) {
        if (sinceMs !== null && error.time < sinceMs) continue
        errors.push(error)
      }
      for (const failure of folded.retries) {
        if (sinceMs !== null && failure.time < sinceMs) continue
        retries.push(failure)
      }
    }

    finishPass(records.length, seen)

    const attributed = attributeErrors(errors)

    const provenance = {
      snapshotAt: snapshot === null ? null : snapshot.savedAt,
      readNow: passReads,
      reused: Math.max(0, seen.size - skipped - passReads),
      pruned,
    }

    if (samples.length === 0) {
      return {
        empty: true,
        skipped,
        pending,
        complete: pending === 0,
        provenance,
        ...progressOf(records.length, scanned, pending),
      }
    }

    return {
      report: aggregate(samples, {
        sort: options.sort ?? 'steps',
        dir: options.dir,
        errors: attributed,
        retries,
        statusOf: options.statusOf,
      }),
      skipped,
      pending,
      complete: pending === 0,
      provenance,
      ...progressOf(records.length, scanned, pending),
    }
  }

  /**
   * Answer from the snapshot alone, without reading or listing anything.
   *
   * The panel calls this first: when disk already holds a complete fold, the
   * table appears immediately and the freshness pass runs afterwards instead of
   * blocking the first paint. Returns null when the snapshot cannot cover the
   * corpus honestly.
   */
  async function snapshotReport(options = {}) {
    await hydrate()
    if (snapshot === null) return null
    await statPass()
    const query = ctx.get('sessionQuery')
    if (query === undefined) return null

    let records = []
    try {
      records = await query.listSessions()
    } catch {
      return null
    }

    const sinceMs = Number.isFinite(options.sinceMs) ? options.sinceMs : null
    const samples = []
    const errors = []
    const retries = []
    const seen = new Set()
    // Sessions whose stored log changed since the snapshot was written; the
    // follow-up fold re-reads exactly these.
    const skippedIds = []

    for (const record of records) {
      const sessionId = record?.header?.id ?? record?.id
      if (typeof sessionId !== 'string') continue

      const revision = snapshot.revisions.get(sessionId)
      const entry = revision === undefined ? undefined : cache.get(keyOf(sessionId, revision))
      if (entry === undefined) return null
      if (entry.revision !== null && entry.revision !== revision) return null

      const current = stats.get(sessionId)
      if (current !== undefined && current !== null && current !== revision) {
        // A legacy revision only moved because some other log did; the log
        // behind this entry may be byte-identical, but nothing here can prove
        // it, so it is re-read rather than trusted.
        skippedIds.push(sessionId)
        continue
      }

      seen.add(sessionId)
      for (const sample of entry.samples) {
        if (sinceMs !== null && sample.time < sinceMs) continue
        samples.push(sample)
      }
      for (const error of entry.errors) {
        if (sinceMs !== null && error.time < sinceMs) continue
        errors.push(error)
      }
      for (const failure of entry.retries ?? []) {
        if (sinceMs !== null && failure.time < sinceMs) continue
        retries.push(failure)
      }
    }

    if (seen.size === 0 && skippedIds.length === 0) return null

    const attributed = attributeErrors(errors)

    return {
      report: aggregate(samples, {
        sort: options.sort ?? 'steps',
        dir: options.dir,
        errors: attributed,
        retries,
        statusOf: options.statusOf,
      }),
      skipped: 0,
      pending: 0,
      complete: true,
      fromSnapshot: true,
      // Handed back so the caller's follow-up fold does not list the corpus again.
      records,
      skippedIds,
      provenance: {
        snapshotAt: snapshot.savedAt,
        readNow: passReads,
        reused: seen.size,
        pruned,
      },
      ...progressOf(records.length, seen.size, skippedIds.length),
    }
  }

  /**
   * Aggregate straight from memory, ignoring revisions.
   *
   * The panel's first paint uses this on a warm process: the numbers were folded
   * moments ago in this same process, and the refresh pass that follows is what
   * makes them current. It never touches the store, which is the whole point.
   */
  async function snapshotSummary(options = {}) {
    await hydrate()
    if (snapshot === null) return null
    const samples = []
    const errors = []
    const retries = []
    const seen = new Set()

    for (const [sessionId, revision] of snapshot.revisions) {
      const entry = cache.get(keyOf(sessionId, revision))
      if (entry === undefined) continue
      seen.add(sessionId)
      for (const sample of entry.samples) samples.push(sample)
      for (const error of entry.errors) errors.push(error)
      for (const failure of entry.retries ?? []) retries.push(failure)
    }
    if (seen.size === 0 || samples.length === 0) return null

    const sinceMs = Number.isFinite(options.sinceMs) ? options.sinceMs : null
    const filtered = sinceMs === null ? samples : samples.filter((sample) => sample.time >= sinceMs)
    if (filtered.length === 0) return null

    return {
      report: aggregate(filtered, {
        sort: options.sort ?? 'steps',
        dir: options.dir,
        errors,
        retries,
        statusOf: options.statusOf,
      }),
      skipped: 0,
      pending: 0,
      complete: false,
      fromSnapshot: true,
      provenance: {
        snapshotAt: snapshot.savedAt,
        readNow: 0,
        reused: seen.size,
        pruned,
      },
      scanned: seen.size,
      totalSessions: seen.size,
    }
  }

  /**
   * Make sure this pass's revisions are known, then report how much of the
   * corpus the snapshot already covers. The two calls together decide whether
   * {@link snapshotReport} may answer and whether a refresh is even needed.
   */
  async function snapshotStatus() {
    await hydrate()
    if (snapshot === null) return { available: false, fresh: false, total: 0, covered: 0 }
    await statPass()

    const query = ctx.get('sessionQuery')
    if (query === undefined) return { available: false, fresh: false, total: 0, covered: 0 }
    let records = []
    try {
      records = await query.listSessions()
    } catch {
      return { available: false, fresh: false, total: 0, covered: 0 }
    }

    let covered = 0
    let stale = 0
    for (const record of records) {
      const sessionId = record?.header?.id ?? record?.id
      if (typeof sessionId !== 'string') continue
      const stored = snapshot.revisions.get(sessionId)
      if (stored === undefined) continue
      if (cache.get(keyOf(sessionId, stored)) === undefined) continue
      const current = stats.get(sessionId)
      if (current === undefined || current === null) {
        covered += 1
        continue
      }
      const legacyHash = corpusHashOf(current)
      if (legacyHash !== null) {
        // Legacy revisions are compared by the corpus hash, never by the whole
        // string: the `<file identity>` prefix differs per log while the hash
        // behind it is one corpus-wide value.
        if (legacyHash === snapshotFingerprint) covered += 1
        else stale += 1
        continue
      }
      if (current === stored) covered += 1
      else stale += 1
    }

    return {
      available: true,
      fresh: statsLoaded !== false && stale === 0,
      total: records.length,
      covered,
      stale,
      savedAt: snapshot.savedAt,
    }
  }

  /** Load the on-disk snapshot once, tolerating any shape of damage. */
  function hydrate() {
    if (!persist) return Promise.resolve()
    if (hydrating !== null) return hydrating
    hydrating = (async () => {
      let parsed = null
      try {
        parsed = JSON.parse(await readFile(join(cacheDir, SNAPSHOT_FILE), 'utf8'))
      } catch {
        return
      }
      if (parsed === null || parsed.version !== SNAPSHOT_VERSION) return
      const revisions = new Map()
      for (const [sessionId, entry] of Object.entries(parsed.sessions ?? {})) {
        if (typeof sessionId !== 'string' || entry === null || typeof entry !== 'object') continue
        const revision = typeof entry.revision === 'string' ? entry.revision : null
        if (!Array.isArray(entry.samples)) continue
        revisions.set(sessionId, revision)
        cache.set(keyOf(sessionId, revision), {
          revision,
          samples: entry.samples,
          errors: Array.isArray(entry.errors) ? entry.errors : [],
          retries: Array.isArray(entry.retries) ? entry.retries : [],
        })
      }
      if (revisions.size === 0) return
      snapshot = {
        savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : null,
        revisions,
      }
      snapshotFingerprint =
        typeof parsed.legacyRevision === 'string' && parsed.legacyRevision !== ''
          ? parsed.legacyRevision
          : null
    })()
    return hydrating
  }

  /** Persist the fold so the next process start can answer immediately. */
  async function saveSnapshot() {
    if (!persist || snapshot === null) return false
    const directory = cacheDir
    const sessions = {}
    for (const [sessionId, revision] of snapshot.revisions) {
      const entry = cache.get(keyOf(sessionId, revision))
      if (entry === undefined) continue
      sessions[sessionId] = {
        revision,
        samples: entry.samples,
        errors: entry.errors,
        retries: entry.retries ?? [],
      }
    }
    const payload = JSON.stringify({
      version: SNAPSHOT_VERSION,
      savedAt: Date.now(),
      legacyRevision: snapshotFingerprint,
      sessions,
    })
    try {
      await mkdir(directory, { recursive: true })
      const target = join(directory, SNAPSHOT_FILE)
      const temporary = `${target}.${process.pid}.tmp`
      await writeFile(temporary, payload, 'utf8')
      // Replacing by rename keeps a reader from ever seeing half a snapshot.
      await rename(temporary, target)
      return true
    } catch (error) {
      ctx.logger?.warn?.(
        `dsh-model-stats: snapshot save failed: ${String(error?.message ?? error)}`,
      )
      return false
    }
  }

  /**
   * Fold the whole corpus into the cache without blocking a caller.
   *
   * Because one session costs a full store read by design, a cold corpus needs
   * tens of seconds. Running that pass once after activation means the panel's
   * first open is a cache hit instead of a long wait.
   *
   * @returns the number of sessions that contributed samples.
   */
  async function warm(options = {}) {
    const budgetMs = Number.isFinite(options.budgetMs) ? options.budgetMs : 10 * 60 * 1000
    const result = await collect({ budgetMs, sort: 'steps' })
    return result.error !== undefined ? 0 : result.scanned
  }

  return {
    collect,
    warm,
    statPass,
    snapshotStatus,
    snapshotReport,
    snapshotSummary,
    saveSnapshot,
    loadSnapshot: hydrate,
    clearCache: () => {
      cache.clear()
      stats = new Map()
      statsLoaded = false
      statsFailed = false
      snapshot = null
      snapshotFingerprint = null
      hydrating = null
      readNowIds.clear()
    },
    cacheSize: () => cache.size,
  }

  function isSettled(sessionId) {
    if (readNowIds.has(sessionId)) return true
    const revision = stats.get(sessionId)
    return revision !== undefined && cache.has(keyOf(sessionId, revision))
  }

  /** Apply this pass's observations to the snapshot index. */
  function finishPass(total, seen) {
    if (snapshot === null) {
      snapshot = { savedAt: Date.now(), revisions: new Map() }
    }
    for (const [sessionId, entry] of cache) {
      const separator = sessionId.lastIndexOf('\u0000')
      const id = sessionId.slice(0, separator)
      if (!seen.has(id)) continue
      snapshot.revisions.set(id, entry.revision)
    }
    // The corpus hash this pass validated legacy entries against, so a later
    // process can reuse them instead of re-reading every old log.
    snapshotFingerprint = corpusHashOfStats()
    // Sessions the store no longer lists are gone for good; dropping them keeps
    // the snapshot from growing without bound as history is rotated.
    for (const id of [...snapshot.revisions.keys()]) {
      if (seen.has(id)) continue
      const revision = snapshot.revisions.get(id)
      snapshot.revisions.delete(id)
      if (revision !== undefined) {
        cache.delete(keyOf(id, revision))
        pruned += 1
      }
    }
    if (total === 0) snapshot.savedAt = Date.now()
  }
}

function progressOf(total, scanned, pending) {
  return {
    scanned,
    pending,
    totalSessions: total,
  }
}

/**
 * Name the model each error belongs to.
 *
 * `foldSession` does this itself: a tool error carries the model that had just
 * spoken, which is the only model that could have raised it, and a request error
 * carries its own provider. There used to be a fallback here that looked the
 * error up under the *most recent model of that provider anywhere in the pass* —
 * a guess about the corpus standing in for a fact about the error, and one that
 * silently dropped all 783 tool errors in this history anyway, because they
 * carry `provider: null` and the lookup key was the empty string.
 *
 * So there is no fallback now. An error that arrives with no model keeps its
 * `null`, the aggregate has no bucket for it, and the count it reports is
 * therefore "errors that reached a row" — which is a number a reader can trust
 * instead of a number that silently mixes the two. `tools/verify-retry.mjs`
 * asserts over the real corpus that no tool error is left unattributed.
 *
 * The record is passed through whole apart from the two names, and that matters:
 * an earlier version rebuilt `{ provider, model, kind }` and silently dropped
 * `code` and `name` on the way, which classified every error as `other` and
 * reported every model as blameless.
 */
function attributeErrors(errors) {
  return errors.map((error) => ({
    ...error,
    provider: error.provider ?? 'unknown',
    model: error.model ?? 'unknown',
  }))
}

/**
 * True when a revision is a legacy corpus hash rather than one log's fingerprint.
 *
 * The JSONL backend spells a current per-log revision as a comma-joined tuple of
 * file identity fields and a legacy one as `<file identity>:<64-hex hash>`; a
 * revision prefixed with anything else is treated as per-log, because assuming
 * the opposite (a legacy revision that is really per-log) would only cost an
 * extra read, while assuming the reverse would serve stale numbers.
 */
function isLegacyRevision(revision) {
  return corpusHashOf(revision) !== null
}

/** The corpus hash inside a legacy revision, or null when there is none. */
function corpusHashOf(revision) {
  if (typeof revision !== 'string') return null
  const separator = revision.lastIndexOf(':')
  if (separator === -1) return null
  const suffix = revision.slice(separator + 1)
  return /^[0-9a-f]{64}$/.test(suffix) ? suffix : null
}

/**
 * The provider filter of one report, as a list of exact provider names.
 *
 * A filter can name more than one provider, and every caller spells it its own
 * way: the panel sends a comma-separated query value, the tool may send a JSON
 * string or an array. All three reduce to the same list here, so the panel and
 * the tool cannot drift apart on what "provider" means. An empty result means
 * "no filter", which is also what an unknown or blank name produces — a filter
 * that matches nothing is a mistake worth showing the whole table over, not a
 * second empty state.
 */
export function providerFilter(value) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const names = []
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    for (const part of entry.split(',')) {
      const name = part.trim()
      if (name !== '' && !names.includes(name)) names.push(name)
    }
  }
  return names
}

/**
 * Every provider the report knows, busiest first.
 *
 * The panel needs the list to draw its filter, and it cannot get it from the
 * rows it was sent: those are sorted, cut to the limit and already filtered, so
 * they name a handful of providers out of the whole history — and exactly the
 * ones a filter is there to compare are the ones missing. This walks the full
 * provider report, which is one row per provider by construction.
 */
export function providerIndex(report) {
  if (report === null || report === undefined) return []
  const models = new Map()
  for (const row of report.byModel ?? []) {
    const entry = models.get(row.provider)
    if (entry === undefined) models.set(row.provider, 1)
    else models.set(row.provider, entry + 1)
  }
  return [...(report.byProvider ?? [])]
    .map((row) => ({
      provider: row.provider,
      models: models.get(row.provider) ?? 0,
      steps: row.steps,
      errors: row.errors,
      lastSeen: row.lastSeen ?? null,
    }))
    .sort((a, b) => b.steps - a.steps || a.provider.localeCompare(b.provider))
}

/**
 * The configuration a row is graded against, or `null` when it cannot be told.
 *
 * A pair the live `ctx.llm` serves and a pair the configuration files declare are
 * the same answer to the reader's question — "is this a model I can run" — so
 * both halves of the catalog count. What does *not* count is a catalog whose live
 * half never answered (`live: false`), and the flag is worth the whole function:
 * measured on this machine the files alone declare 113 pairs over 10 providers,
 * while `ctx.llm` additionally serves `deepseek-official`, `codex`,
 * `limitdeckai`, `anxb`, `dsh-provider-qoder` and `local-uns`. Grading history by
 * the files alone marks 28 of 64 model rows and 15932 of 26600 steps — 60% of the
 * history, `deepseek-official/deepseek-flash` (10617 steps) among them, which is
 * this harness's own default model and is served by `dsh-llm-deepseek` without
 * any provider block listing it. A partial catalog is not evidence that a model
 * is gone, so it grades nothing and the table shows what it always showed.
 *
 * The same instinct covers the empty case: an index with no pair at all is not a
 * configuration that serves nothing, it is one nothing is known about.
 *
 * `pairs` is the grading key of that catalog and `list` is the same set in the
 * order the catalog declared it — the two are one answer read two ways: the
 * first is what a row is tested against, the second is what a row is built from
 * when the history holds nothing for it (see `unmeasuredRows`).
 */
export function configuredIndex(catalog) {
  if (catalog === null || catalog === undefined) return null
  if (catalog.live !== true) return null
  const pairs = new Set()
  const providers = new Set()
  const list = []
  for (const pair of catalog.pairs ?? []) {
    if (typeof pair?.provider !== 'string' || pair.provider === '') continue
    providers.add(pair.provider)
    if (typeof pair.model === 'string' && pair.model !== '') {
      const key = `${pair.provider}\u0000${pair.model}`
      if (!pairs.has(key)) list.push({ provider: pair.provider, model: pair.model })
      pairs.add(key)
    }
  }
  return pairs.size === 0 ? null : { pairs, providers, list }
}

/**
 * Whether one row is outside the current configuration: `true`, `false`, or
 * `null` when the configuration is not known.
 *
 * `null` rather than `false` for the unknown case, and for the reason every
 * unmeasured figure in this plugin is `null`: "it is in the configuration" is a
 * claim about the harness, and a host that could not read the catalog has no
 * standing to make it in either direction.
 *
 * A provider row (the provider view has no model of its own) is graded on the
 * provider: it is in the configuration while the configuration serves any model
 * of it. Dropping the whole row because one of its models was retired would hide
 * a provider that is very much configured, and one configured model is all a row
 * of provider totals needs to be reachable.
 */
function archivedOf(config, row) {
  if (config === null) return null
  if (row.model === null || row.model === undefined) {
    return config.providers.has(row.provider) === false
  }
  return config.pairs.has(`${row.provider}\u0000${row.model}`) === false
}

/**
 * Grade a row set against the configuration and split it: what stays on screen
 * and what the archive holds.
 *
 * The archive is a filter, so it is applied where the provider filter is — over
 * the whole filtered set and before the limit, never over the page the limit cut
 * off. `shown` has to be counted here and not after the cut for the same reason a
 * provider filter is: the footer prints it beside whole-history totals, and a
 * number that changed when `limit` did would make the two incomparable.
 *
 * `archive` is `null` when there is no configuration to grade against, which is
 * how the panel knows not to offer the control at all rather than to offer one
 * that can only ever read zero.
 */
function gradeRows(rows, config, includeArchived) {
  const graded = rows.map((row) => ({ row, archived: archivedOf(config, row) }))
  const outside = graded.filter((entry) => entry.archived === true)
  return {
    kept: includeArchived ? graded : graded.filter((entry) => entry.archived !== true),
    archive:
      config === null
        ? null
        : {
            rows: outside.length,
            steps: outside.reduce((sum, entry) => sum + (entry.row.steps ?? 0), 0),
            shown: includeArchived,
          },
  }
}

/**
 * The rows a configuration serves and a history does not.
 *
 * The table answers two questions at once, and the second one is why the status
 * column exists: "how does what I have run behave" and "what else is configured
 * that I could run". A model no session has ever used is exactly the model whose
 * liveness nobody has seen, and it is the one a reader opens this table to try —
 * so a configured pair with no steps is a row, not an omission: `steps: 0` (a
 * measurement: no step was ever recorded for it) with every other figure
 * unmeasured, and a status circle that can be clicked, because the panel's
 * liveness join looks a pair up by name and does not care where its row came
 * from.
 *
 * It stays a *row of the configuration*, never a guess. `config` is `null` when
 * the host could not read the live catalog, and then nothing is invented — the
 * rule the archive follows, for the same reason. The two are one statement about
 * one row: in the configuration and unseen by the history (here), or seen by the
 * history and absent from the configuration (the archive).
 *
 * Measured on this machine the two halves are comparable in size: the history
 * holds 64 model rows over 16 providers, the probe store — the catalog past
 * sweeps were given — names 137 pairs, and the route driven against that catalog
 * answers 141 rows, 81 of them with no history at all (`ollama` alone is 22 pairs
 * and not one row of history). Those are the rows a reader cannot otherwise
 * reach: a plain fold cannot invent a row it has no sample for, and the archive
 * is the opposite set.
 *
 * `present` is the key set the caller already put in the table — the filtered,
 * graded history rows — so a pair the history knows is never doubled, and
 * `wanted` is the provider filter, which a configured row obeys exactly as a
 * history row does.
 */
function unmeasuredRows(config, byProvider, present, wanted, statusOf) {
  if (config === null) return []
  const rows = []
  if (byProvider) {
    for (const provider of config.providers) {
      if (present.has(provider)) continue
      if (wanted !== null && !wanted.has(provider)) continue
      rows.push(unmeasuredRow(provider, null))
    }
  } else {
    for (const pair of config.list) {
      if (present.has(`${pair.provider}\u0000${pair.model}`)) continue
      if (wanted !== null && !wanted.has(pair.provider)) continue
      rows.push(unmeasuredRow(pair.provider, pair.model))
    }
  }
  // The status column orders rows by a rank no fold can compute, so a row with
  // no history still needs its own — the catalog is what a probe sweeps, so these
  // are exactly the rows a store is most likely to know. Without this the status
  // order would leave every row this change adds unranked, at the bottom of the
  // one order a reader uses to ask what is broken right now.
  if (typeof statusOf === 'function') {
    for (const row of rows) row.livenessRank = statusOf(row.provider, row.model, row.lastSeen)
  }
  // Declaration order is a fact about a run, not about the configuration, and
  // two rows a key cannot separate fall back to the order they were built in.
  // The name is the only figure here that does not change under the reader, so
  // it is what the order is built on.
  rows.sort(
    (a, b) =>
      a.provider.localeCompare(b.provider) ||
      `${a.model ?? ''}`.localeCompare(`${b.model ?? ''}`),
  )
  return rows
}

/**
 * One table out of two sets of rows, in the order the caller asked for.
 *
 * The measured rows arrive already ordered (the fold ordered them by the
 * requested key); the unmeasured ones have no figure for that key to read.
 * Splicing them — "measured first, then the rest" — would be a second order: by
 * `steps` ascending, or by name, an unmeasured row belongs *between* two
 * measured ones (`ollama/x` sorts before `openrouter/glm` under `name`), and a
 * table whose order contradicts its own heading is worse than one that leaves
 * rows out. So the union is sorted with the fold's own comparator, which keeps
 * one rule for both kinds of row and already knows what to do with a missing
 * figure: it holds it at the bottom in both directions.
 *
 * The sort runs even when there is nothing to merge, and that is not waste: the
 * order the payload echoes is the order of the rows it returns, and a fold asked
 * for one key while the payload is asked for another is exactly the case where
 * re-sorting is the difference between an arrow and a lie. On an already ordered
 * set it is a no-op — the comparator is the one the fold sorted with.
 */
function mergeRows(measured, extra, options) {
  const compare = comparatorFor(options.sort, options.dir)
  return [...measured, ...extra].sort((a, b) => compare(a.row, b.row))
}

/**
 * The provider list the panel's filter draws, with the providers the history has
 * never seen added to it.
 *
 * The list promises to name every provider a row could come from, because a
 * filter that cannot name a provider cannot reach its rows — and `providerIndex`
 * reads the history, so a provider whose every model is configured and unused
 * (`ollama` on this machine: 22 pairs, no history at all) would be missing from
 * the filter by exactly the amount the table now shows it. Each one carries its
 * configured model count and zero steps, which is the truth about the history
 * and the reason it belongs at the end of a list that is sent busiest first.
 */
function configuredProviders(index, config) {
  if (config === null) return index
  const known = new Set(index.map((entry) => entry.provider))
  const models = new Map()
  for (const pair of config.list) models.set(pair.provider, (models.get(pair.provider) ?? 0) + 1)
  const extra = []
  for (const [provider, count] of models) {
    if (known.has(provider)) continue
    extra.push({ provider, models: count, steps: 0, errors: 0, lastSeen: null })
  }
  return extra.length === 0
    ? index
    : [...index, ...extra.sort((a, b) => a.provider.localeCompare(b.provider))]
}

/** Compact JSON payload for the settings panel: no per-step samples, only rows. */
export function toPanelPayload(result, options = {}) {
  if (result.error !== undefined) return { ok: false, error: result.error }
  const provenance = result.provenance ?? { snapshotAt: null, readNow: 0, reused: 0, pruned: 0 }
  const progress = {
    scanned: result.scanned ?? 0,
    skipped: result.skipped ?? 0,
    pending: result.pending ?? 0,
    complete: result.complete !== false,
    snapshotAt: provenance.snapshotAt,
    readNow: provenance.readNow,
    reused: provenance.reused,
    generatedAt: Date.now(),
  }
  // An empty history is not an empty table while the configuration serves
  // something: a configured model nobody has run yet is a row of its own (see
  // `unmeasuredRows`), and on a fresh install those rows are the whole table. So
  // the two cases share one assembly instead of each having its own, and the
  // payload below is the same shape either way.
  const report = result.empty === true ? null : result.report
  // Two names for one choice, and they are not interchangeable: `byProvider` is
  // the report key the rows are read from, `view` is the word the payload and the
  // panel use. A branch that asks the wrong one of the two — `view === 'provider'
  // ? … : …` on a value that is always `byProvider` or `byModel` — takes the
  // model path in the provider view and builds model rows into a provider table.
  const byProvider = options.view === 'provider'
  const view = byProvider ? 'byProvider' : 'byModel'
  const providers = providerFilter(options.provider)
  const wanted = providers.length === 0 ? null : new Set(providers)
  const config = configuredIndex(options.configured)
  const includeArchived = options.includeArchived === true
  const statusOf = typeof options.statusOf === 'function' ? options.statusOf : null
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(200, options.limit) : 50

  let rows = report === null ? [] : report[view]
  if (wanted !== null) rows = rows.filter((row) => wanted.has(row.provider))
  // What the filter kept, counted over the filtered rows and not over the page
  // the limit cut off: the panel shows it beside the whole-history totals, whose
  // meaning must not change when a filter is on. The archive is part of the
  // filter — a row the archive holds is not in the table — so `shown` counts the
  // rows the grade kept, and `archive` says what that cost.
  const { kept, archive } = gradeRows(rows, config, includeArchived)
  const present = new Set(
    kept.map(({ row }) =>
      byProvider ? row.provider : `${row.provider}\u0000${row.model}`,
    ),
  )
  const extra = unmeasuredRows(config, byProvider, present, wanted, statusOf).map((row) => ({
    row,
    // A row the configuration serves is not in the archive by construction: the
    // archive *is* the set of rows the configuration does not know.
    archived: false,
    noStats: true,
  }))
  const ordered = mergeRows(kept, extra, options)
  const shown = {
    models: ordered.length,
    steps: ordered.reduce((sum, entry) => sum + (entry.row.steps ?? 0), 0),
    errors: ordered.reduce((sum, entry) => sum + (entry.row.errors ?? 0), 0),
    retries: ordered.reduce((sum, entry) => sum + (entry.row.retryEvents ?? 0), 0),
  }
  rows = ordered.slice(0, limit)

  return {
    ok: true,
    empty: rows.length === 0,
    ...progress,
    fromSnapshot: result.fromSnapshot === true,
    // The whole history, and only the history: the rows below are what the
    // filter and the configuration left, and the footer prints these next to
    // them. `null` when there is no report at all — an empty history has nothing
    // to total, and zeros beside a table of configured models would read as a
    // history that was counted rather than one that was not.
    totals:
      report === null
        ? null
        : {
            steps: report.steps,
            errors: report.errors,
            retries: report.retries ?? 0,
            retryFailedSteps: report.retryFailedSteps ?? 0,
            models: report.models,
            providers: report.providers,
          },
    sort: options.sort ?? 'steps',
    // The direction the rows were actually ordered in, next to the key they were
    // ordered by. The panel asks for one of the two on every request, so this is
    // the one field that can contradict what the user asked for — and a panel
    // that renders an arrow needs to know which way the rows really went.
    dir: sortDirection(options.dir),
    view: options.view === 'provider' ? 'provider' : 'model',
    // Echoed back so the panel can tell what the host actually applied — a
    // filter it did not send is the one thing a "showing previous answer"
    // notice must never hide.
    providers,
    providerList: configuredProviders(report === null ? [] : providerIndex(report), config),
    // What the archive holds under this filter, and whether it is on screen.
    // `null` means the host could not read the configuration at all — a claim it
    // is not entitled to make, as opposed to an archive that happens to be
    // empty — and the panel reads that as "do not offer the control".
    archive,
    // How many rows of this answer's filtered set come from the configuration
    // with no history behind them. `null` is the same statement `archive: null`
    // makes: a host that could not read the configuration cannot say how many
    // rows it holds that the history never saw, and the panel then says nothing
    // about them rather than saying zero.
    noStats: config === null ? null : { rows: extra.length },
    shown,
    rows: rows.map(({ row, archived, noStats }) => ({
      provider: row.provider,
      model: row.model,
      // Whether this row is outside the current configuration: `true`, `false`,
      // or `null` when the host has no configuration to grade against.
      archived,
      // Whether the row exists because the configuration serves the pair and the
      // history does not — the one kind of row the fold cannot produce, and the
      // one whose every figure but `steps` is unmeasured.
      noStats: noStats === true,
      steps: row.steps,
      sessions: row.sessions,
      errors: row.errors,
      toolErrors: row.toolErrors,
      errorRate: row.errorRate ?? null,
      modelErrors: row.modelErrors ?? 0,
      modelErrorRate: row.modelErrorRate ?? null,
      errorCodes: row.errorCodes ?? [],
      errorCategories: row.errorCategories ?? [],
      interrupted: row.interrupted ?? 0,
      ttftMean: row.ttft.mean,
      ttftMedian: row.ttft.median,
      ttftMin: row.ttft.min,
      ttftMax: row.ttft.max,
      ttftP90: row.ttft.p90,
      ttftCount: row.ttft.count,
      tpsMean: row.speedTps.mean,
      tpsMedian: row.speedTps.median,
      tpsMin: row.speedTps.min,
      tpsMax: row.speedTps.max,
      tpsCount: row.speedTps.count,
      e2eTpsMedian: row.e2eTps?.median ?? null,
      e2eTpsP90: row.e2eTps?.p90 ?? null,
      e2eTpsCount: row.e2eTps?.count ?? 0,
      prefillShareMedian: row.prefillShare?.median ?? null,
      overheadMsMedian: row.overheadMs?.median ?? null,
      overheadMsP90: row.overheadMs?.p90 ?? null,
      speedConfidence: row.speedConfidence,
      ttftCleanMedian: row.ttftClean?.median ?? null,
      ttftCleanP90: row.ttftClean?.p90 ?? null,
      ttftCleanCount: row.ttftClean?.count ?? 0,
      retrySteps: row.retrySteps,
      retryEvents: row.retryEvents,
      retryRate: row.retryRate,
      retryFailedSteps: row.retryFailedSteps,
      retryRecovery: row.retryRecovery,
      retryBackoffMs: row.retryBackoffMs,
      retryDeadMsMedian: row.retryDeadMs?.median ?? null,
      retryDeadMsP90: row.retryDeadMs?.p90 ?? null,
      retryCodes: row.retryCodes ?? [],
      llmMeanMs: row.llmMs.mean,
      outputTokens: row.outputTokens,
      cacheHitRate: row.cacheHitRate,
      maxContextTokens: row.maxContextTokens,
      lastSeen: row.lastSeen,
    })),
  }
}

/** The human-readable table, shared so the tool's text and the panel agree. */
export function renderReportText(result, options = {}) {
  if (result.error !== undefined) return `model_stats error: ${result.error}`

  const report = result.report
  const view = options.view === 'provider' ? 'provider' : 'model'
  const providers = providerFilter(options.provider)
  const wanted = providers.length === 0 ? null : new Set(providers)
  const config = configuredIndex(options.configured)
  const includeArchived = options.includeArchived === true
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(50, options.limit) : 15

  const provenance = result.provenance ?? { snapshotAt: null, readNow: 0, reused: 0 }
  // A filter can legitimately leave nothing to report — a `sinceMs` past the
  // newest step, or a provider that never answered. The provenance line is
  // printed above the "no timings" line, so it must survive a missing report
  // instead of being built from it.
  const provenanceText = provenanceLine(result, report ?? NO_REPORT, provenance)
  if (result.empty === true || report === undefined || report === null) {
    return [
      provenanceText,
      `no timings found in ${result.scanned} readable session(s), ${result.skipped} skipped.`,
    ].join('\n')
  }

  const lines = [provenanceText]
  let rows = view === 'provider' ? report.byProvider : report.byModel
  if (wanted !== null) rows = rows.filter((row) => wanted.has(row.provider))
  // The archive is a filter like the provider one, and it is applied in the same
  // place for the same reason: over the whole filtered set and before the limit,
  // so a page of fifteen rows is fifteen rows the reader can use and not ten of
  // them plus five retired ones.
  const { kept, archive } = gradeRows(rows, config, includeArchived)
  rows = kept.slice(0, limit).map((entry) => entry.row)

  const head = [
    view === 'model' ? 'provider/model' : 'provider',
    'steps',
    'sess',
    'ttft_mean',
    'ttft_med',
    'ttft_min',
    'ttft_max',
    'ttft_p90',
    'ttft_clean',
    'tps_med',
    'e2e_med',
    'prefill',
    'overhead',
    'tps_mean',
    'tps_min',
    'tps_max',
    'tps_n',
    'speed_conf',
    'llm_mean',
    'out_tok',
    'cache%',
    'err',
    'err/100',
    'err_model',
    'retry%',
    'interrupt',
  ]

  const table = rows.map((row) => [
    labelOf(row, view),
    String(row.steps),
    String(row.sessions),
    int(row.ttft.mean),
    int(row.ttft.median),
    int(row.ttft.min),
    int(row.ttft.max),
    int(row.ttft.p90),
    int(row.ttftClean?.median),
    dec(row.speedTps.median),
    dec(row.e2eTps?.median),
    row.prefillShare?.median === null || row.prefillShare?.median === undefined
      ? '-'
      : row.prefillShare.median.toFixed(2),
    int(row.overheadMs?.median),
    dec(row.speedTps.mean),
    dec(row.speedTps.min),
    dec(row.speedTps.max),
    String(row.speedTps.count),
    row.speedConfidence === null ? '-' : `${Math.round(row.speedConfidence * 100)}%`,
    int(row.llmMs.mean),
    String(row.outputTokens),
    row.cacheHitRate === null ? '-' : (row.cacheHitRate * 100).toFixed(1),
    String(row.errors),
    row.errorRate === null || row.errorRate === undefined ? '-' : row.errorRate.toFixed(1),
    String(row.modelErrors ?? 0),
    row.retryRate === null || row.retryRate === undefined
      ? '-'
      : (row.retryRate * 100).toFixed(1),
    String(row.interrupted ?? 0),
  ])

  const columns = head.map((_, index) =>
    Math.max(head[index].length, ...table.map((line) => line[index].length)),
  )
  const pad = (value, index) =>
    index === 0 ? value.padEnd(columns[index]) : value.padStart(columns[index])

  lines.push(head.map(pad).join('  '))
  for (const line of table) lines.push(line.map(pad).join('  '))
  // A filter that matches nothing is a question with an answer, not a table
  // with a header and no rows: say which names were asked for.
  if (table.length === 0 && providers.length > 0) {
    lines.push(`no rows for provider=${providers.join('+')}; the history has ${report.providers} provider(s).`)
  }

  // The summary lines answer about the same rows the table shows, so a filter
  // reaches them: a two-row table of one provider followed by "fastest first
  // token: <a model of another provider>" is the drift this report is built to
  // avoid. The whole filtered set counts, not the page the limit cut off —
  // otherwise raising `limit` would change which model is the fastest. The
  // archive is part of that filter for the same reason: "fastest model" must not
  // be a model the table just refused to show.
  let summaryRows =
    wanted === null ? report.byModel : report.byModel.filter((row) => wanted.has(row.provider))
  if (!includeArchived && config !== null) {
    summaryRows = summaryRows.filter((row) => archivedOf(config, row) !== true)
  }
  const fastest = pick(summaryRows, (row) => row.ttft.median, (a, b) => a < b)
  const slowest = pick(summaryRows, (row) => row.ttft.median, (a, b) => a > b)
  const fastestSpeed = pick(summaryRows, (row) => row.speedTps.median, (a, b) => a > b)
  const failing = summaryRows.filter((row) => row.errors > 0)

  lines.push('')
  lines.push(
    `view=${view}, sorted by ${options.sort ?? 'steps'}, ${rows.length} row(s)` +
      (providers.length > 0 ? `, provider=${providers.join('+')}` : '') +
      '. ttft/llm in ms; tok/s = provider-reported output tokens over the provider streaming span.',
  )
  // A hidden row is the one thing this table can leave out without the reader
  // being able to tell, so it is said out loud — with the number and with the
  // argument that brings it back. `null` is not "nothing is archived": it is a
  // host that could not read the configuration, and then nothing was graded at
  // all, which is worth one line precisely because it is invisible.
  if (archive === null) {
    lines.push('archive: unknown — no live ctx.llm catalog; no row was graded against the configuration.')
  } else if (archive.rows > 0) {
    lines.push(
      includeArchived
        ? `archive: ${archive.rows} row(s) / ${archive.steps} step(s) outside the current configuration are included above.`
        : `archive: ${archive.rows} row(s) / ${archive.steps} step(s) outside the current configuration are hidden; pass archived: true to include them.`,
    )
  }
  if (fastest !== null) {
    lines.push(`fastest first token: ${labelOf(fastest, 'model')} (${int(fastest.ttft.median)} ms)`)
  }
  if (slowest !== null && slowest !== fastest) {
    lines.push(`slowest first token: ${labelOf(slowest, 'model')} (${int(slowest.ttft.median)} ms)`)
  }
  if (fastestSpeed !== null) {
    lines.push(
      `fastest median decode: ${labelOf(fastestSpeed, 'model')} (${dec(fastestSpeed.speedTps.median)} tok/s)`,
    )
  }
  // The stream rate and the end-to-end rate disagree often enough to be worth a
  // line of their own: a model that decodes fast but starts late looks good in
  // the first column and is not the fastest to use. Naming the row that loses
  // the most is the shortest way to say so.
  //
  // A floor of 20 end-to-end samples, because a share computed from one or two
  // steps is a coin toss with a confident-looking number attached — the same
  // reason the retry block is ordered by count rather than by rate.
  const MIN_RATE_SAMPLES = 20
  const withE2e = summaryRows.filter(
    (row) =>
      row.e2eTps?.median !== null &&
      row.e2eTps?.median !== undefined &&
      (row.e2eTps.count ?? 0) >= MIN_RATE_SAMPLES,
  )
  if (withE2e.length > 1) {
    const fastestE2e = pick(withE2e, (row) => row.e2eTps.median, (a, b) => a > b)
    const worstGap = withE2e.reduce((worst, row) => {
      const share = row.e2eTps.median / row.speedTps.median
      return worst === null || share < worst.share ? { row, share } : worst
    }, null)
    lines.push(
      `fastest end to end: ${labelOf(fastestE2e, 'model')} (${dec(fastestE2e.e2eTps.median)} tok/s over the whole first answer). ` +
        (worstGap !== null && worstGap.row !== fastestE2e
          ? `most of the wait before the first token: ${labelOf(worstGap.row, 'model')} — ` +
            `${(worstGap.share * 100).toFixed(0)}% of its stream rate survives the prefill.`
          : ''),
    )
  }
  if (failing.length === 0) {
    lines.push('no errors attributed to any model.')
  } else {
    lines.push(`errors: ${failing.map((row) => `${labelOf(row, 'model')}=${row.errors}`).join(', ')}`)
  }
  // The breakdown, because the total is not a decision. A raw count says how
  // busy a model's sessions were as much as how well it calls tools: on this
  // history `deepseek-flash` shows 160 errors against `limitdeckai2/
  // deepseek-v4-flash`'s 321, and on the errors a different model would have
  // avoided it is 9 against 190 — the opposite ranking. Both numbers are
  // printed for that reason.
  const byCode = failing
    .filter((row) => (row.errors ?? 0) > 0)
    .sort((a, b) => b.errors - a.errors)
    .slice(0, 5)
  if (byCode.length > 0) {
    lines.push(
      `error breakdown (model-attributable / total): ${byCode
        .map(
          (row) =>
            `${labelOf(row, 'model')} ${row.modelErrors ?? 0}/${row.errors}` +
            ((row.errorCategories ?? []).length > 0
              ? ` (${row.errorCategories
                  .slice(0, 3)
                  .map((entry) => `${entry.category}x${entry.count}`)
                  .join(' ')})`
              : ''),
        )
        .join('; ')}.`,
    )
    lines.push(
      'note: a filesystem state race (FS_*) is the tool finding the file changed under it, ' +
        'not the model; bad_call is the model naming a tool or arguments its own schema rejects. ' +
        'Only the model-attributable count is about which model to pick.',
    )
  }

  // The retry block, and only when something actually retried: a table of rows
  // with nothing in these columns is noise, and "no retries at all" is itself
  // worth one line rather than a paragraph.
  //
  // Ordered by how many retries a route cost rather than by its rate, because a
  // five-step model with two of them is a 40% column and no evidence of
  // anything. The rate is printed next to the count, so the small-sample case
  // is still visible — it just does not open the list.
  const retried = summaryRows
    .filter((row) => (row.retrySteps ?? 0) + (row.retryFailedSteps ?? 0) > 0)
    .sort((a, b) => b.retryEvents - a.retryEvents || (a.ttft.median ?? Infinity) - (b.ttft.median ?? Infinity))
  if (retried.length === 0) {
    lines.push('no provider retried a failed request in this history.')
  } else {
    const shownRetries = retried.slice(0, 6)
    lines.push(
      `retries: ${shownRetries
        .map((row) => {
          const recovery =
            row.retryRecovery === null
              ? ''
              : `, ${Math.round(row.retryRecovery * 100)}% recovered`
          const lost = (row.retryFailedSteps ?? 0) > 0 ? `, ${row.retryFailedSteps} gave up` : ''
          const codes = (row.retryCodes ?? [])
            .slice(0, 3)
            .map((entry) => `${entry.code}x${entry.count}`)
            .join('+')
          return `${labelOf(row, 'model')}=${row.retryEvents} on ${pct(row.retryRate)}% of steps${recovery}${lost}` +
            (codes === '' ? '' : ` (${codes})`)
        })
        .join('; ')}.` +
        (retried.length > shownRetries.length
          ? ` ${retried.length - shownRetries.length} more row(s) retried.`
          : ''),
    )
    // The two medians side by side are the whole point of the block: a wide gap
    // means the route is flaky, a narrow one means the model is genuinely slow.
    const moved = retried
      .map((row) => ({
        row,
        delta: (row.ttft.median ?? 0) - (row.ttftClean?.median ?? row.ttft.median ?? 0),
      }))
      .filter((entry) => entry.delta > 1)
      .sort((a, b) => b.delta - a.delta)
    if (moved.length > 0) {
      lines.push(
        `retry dead time moves median first token most on ` +
          moved
            .slice(0, 3)
            .map(
              (entry) =>
                `${labelOf(entry.row, 'model')} ${int(entry.row.ttft.median)}→${int(entry.row.ttftClean.median)} ms`,
            )
            .join(', ') +
          '.',
      )
    }
  }
  lines.push(
    'Note: ttft is step/start -> first token, and tps counts the tokens the provider itself reported, ' +
      'over the span it was streaming them rather than over the whole step, so both reflect real ' +
      'provider behaviour. speed_conf is the share of streamed steps long enough to be a reliable ' +
      'rate; a low value means the model mostly emitted very short bursts. ttft_clean is the same ' +
      'median with the time a step spent on failed attempts and backoff removed, over the same steps, ' +
      'so a wide gap between it and ttft_med is provider flakiness rather than a slow model. ' +
      'tps_med is the streaming rate and e2e_med the same tokens over the whole wait for the first ' +
      'answer; prefill is the share of that wait spent before the first token, and overhead is the ' +
      'part of the step this host is responsible for.',
  )
  // A provider that batches deltas looks slow to any tool that counts stream
  // fragments, so name the batching explicitly when it is large enough to have
  // changed a figure the reader is looking at.
  const batching = rows
    .map((row) => ({ row, ratio: row.tokensPerFragment }))
    .filter((entry) => entry.ratio !== null && entry.ratio !== undefined && entry.ratio > 8)
    .sort((a, b) => b.ratio - a.ratio)
  if (batching.length > 0) {
    lines.push(
      `note: ${batching.length} of ${rows.length} row(s) receive deltas in batches, up to ` +
        `${dec(batching[0].ratio)} tokens per fragment (${batching
          .slice(0, 3)
          .map((entry) => `${labelOf(entry.row, view)}=${dec(entry.ratio)}`)
          .join(', ')}); their tok/s is a token count, not a fragment count.`,
    )
  }

  return lines.join('\n')
}

/** One line naming where the numbers came from, so staleness is never invisible. */
const NO_REPORT = { steps: 0, models: 0, providers: 0 }

function provenanceLine(result, report, provenance) {
  const parts = [
    `model_stats - folded from ${result.scanned} session(s)`,
    `${report.steps} timed step(s)`,
    `${report.models} model(s)`,
    `${report.providers} provider(s)`,
  ]
  const tail = []
  if (result.skipped > 0) tail.push(`${result.skipped} skipped`)
  if (result.pending > 0) tail.push(`${result.pending} pending`)
  if (provenance.snapshotAt !== null && provenance.snapshotAt !== undefined) {
    tail.push(`snapshot ${Math.round((Date.now() - provenance.snapshotAt) / 1000)} s old`)
  }
  if (provenance.readNow > 0) tail.push(`${provenance.readNow} read now`)
  if (provenance.reused > 0) tail.push(`${provenance.reused} from cache`)
  const suffix = tail.length === 0 ? '' : ` (${tail.join(', ')})`
  return `${parts.join('; ')}${suffix}.`
}

function labelOf(row, view) {
  return view === 'model' ? `${row.provider}/${row.model}` : row.provider
}

function pick(rows, selector, better) {
  let winner = null
  for (const row of rows) {
    const value = selector(row)
    if (value === null || value === undefined || !Number.isFinite(value)) continue
    if (winner === null || better(value, selector(winner))) winner = row
  }
  return winner
}

function int(value) {
  return value === null || value === undefined ? '-' : String(Math.round(value))
}

function dec(value) {
  return value === null || value === undefined ? '-' : value.toFixed(1)
}

/** A share as a percentage, or `-` when there is no denominator to share. */
function pct(value) {
  return value === null || value === undefined ? '-' : (value * 100).toFixed(1)
}
