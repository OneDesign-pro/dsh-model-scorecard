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

import { aggregate, foldSession } from './fold.js'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const SORTS = ['steps', 'ttft', 'speed', 'errors', 'lastSeen']

/** Current session-log format. Older generations carry a corpus-wide revision. */
const SESSION_FORMAT_VERSION = 4

const SNAPSHOT_VERSION = 1
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
   * @param options.sort - one of {@link SORTS}.
   * @param options.sinceMs - only count steps at or after this timestamp.
   * @param options.budgetMs - return a partial answer once this deadline passes.
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
    const providerLastModel = new Map()
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
        // Track the latest model seen per provider so a provider-level tool
        // failure can be attributed to a real model.
        const previous = providerLastModel.get(sample.provider)
        if (previous === undefined || sample.time > previous.time) {
          providerLastModel.set(sample.provider, sample)
        }
      }
      for (const error of folded.errors) {
        if (sinceMs !== null && error.time < sinceMs) continue
        errors.push(error)
      }
    }

    finishPass(records.length, seen)

    const attributed = errors.map((error) => {
      const latest = providerLastModel.get(error.provider ?? '')
      return {
        provider: error.provider ?? latest?.provider ?? 'unknown',
        model: error.model ?? latest?.model ?? 'unknown',
        kind: error.kind,
      }
    })

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
      report: aggregate(samples, { sort: options.sort ?? 'steps', errors: attributed }),
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
    const providerLastModel = new Map()
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
        const previous = providerLastModel.get(sample.provider)
        if (previous === undefined || sample.time > previous.time) {
          providerLastModel.set(sample.provider, sample)
        }
      }
      for (const error of entry.errors) {
        if (sinceMs !== null && error.time < sinceMs) continue
        errors.push(error)
      }
    }

    if (seen.size === 0 && skippedIds.length === 0) return null

    const attributed = errors.map((error) => {
      const latest = providerLastModel.get(error.provider ?? '')
      return {
        provider: error.provider ?? latest?.provider ?? 'unknown',
        model: error.model ?? latest?.model ?? 'unknown',
        kind: error.kind,
      }
    })

    return {
      report: aggregate(samples, { sort: options.sort ?? 'steps', errors: attributed }),
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
    const seen = new Set()

    for (const [sessionId, revision] of snapshot.revisions) {
      const entry = cache.get(keyOf(sessionId, revision))
      if (entry === undefined) continue
      seen.add(sessionId)
      for (const sample of entry.samples) samples.push(sample)
      for (const error of entry.errors) errors.push(error)
    }
    if (seen.size === 0 || samples.length === 0) return null

    const sinceMs = Number.isFinite(options.sinceMs) ? options.sinceMs : null
    const filtered = sinceMs === null ? samples : samples.filter((sample) => sample.time >= sinceMs)
    if (filtered.length === 0) return null

    return {
      report: aggregate(filtered, { sort: options.sort ?? 'steps', errors }),
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
      sessions[sessionId] = { revision, samples: entry.samples, errors: entry.errors }
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
  if (result.empty === true) {
    return { ok: true, empty: true, ...progress, rows: [] }
  }

  const report = result.report
  const view = options.view === 'provider' ? 'byProvider' : 'byModel'
  const provider = typeof options.provider === 'string' && options.provider !== '' ? options.provider : null
  let rows = report[view]
  if (provider !== null) rows = rows.filter((row) => row.provider === provider)
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(200, options.limit) : 50
  rows = rows.slice(0, limit)

  return {
    ok: true,
    empty: rows.length === 0,
    ...progress,
    fromSnapshot: result.fromSnapshot === true,
    totals: {
      steps: report.steps,
      errors: report.errors,
      models: report.models,
      providers: report.providers,
    },
    sort: options.sort ?? 'steps',
    view: options.view === 'provider' ? 'provider' : 'model',
    rows: rows.map((row) => ({
      provider: row.provider,
      model: row.model,
      steps: row.steps,
      sessions: row.sessions,
      errors: row.errors,
      toolErrors: row.toolErrors,
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
      speedConfidence: row.speedConfidence,
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
  const provider = typeof options.provider === 'string' && options.provider !== '' ? options.provider : null
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(50, options.limit) : 15

  const provenance = result.provenance ?? { snapshotAt: null, readNow: 0, reused: 0 }
  const lines = [provenanceLine(result, report, provenance)]

  if (result.empty === true) {
    return [
      provenanceLine(result, report, provenance),
      `no timings found in ${result.scanned} readable session(s), ${result.skipped} skipped.`,
    ].join('\n')
  }

  let rows = view === 'provider' ? report.byProvider : report.byModel
  if (provider !== null) rows = rows.filter((row) => row.provider === provider)
  rows = rows.slice(0, limit)

  const head = [
    view === 'model' ? 'provider/model' : 'provider',
    'steps',
    'sess',
    'ttft_mean',
    'ttft_med',
    'ttft_min',
    'ttft_max',
    'ttft_p90',
    'tps_med',
    'tps_mean',
    'tps_min',
    'tps_max',
    'tps_n',
    'speed_conf',
    'llm_mean',
    'out_tok',
    'cache%',
    'err',
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
    dec(row.speedTps.median),
    dec(row.speedTps.mean),
    dec(row.speedTps.min),
    dec(row.speedTps.max),
    String(row.speedTps.count),
    row.speedConfidence === null ? '-' : `${Math.round(row.speedConfidence * 100)}%`,
    int(row.llmMs.mean),
    String(row.outputTokens),
    row.cacheHitRate === null ? '-' : (row.cacheHitRate * 100).toFixed(1),
    String(row.errors),
  ])

  const columns = head.map((_, index) =>
    Math.max(head[index].length, ...table.map((line) => line[index].length)),
  )
  const pad = (value, index) =>
    index === 0 ? value.padEnd(columns[index]) : value.padStart(columns[index])

  lines.push(head.map(pad).join('  '))
  for (const line of table) lines.push(line.map(pad).join('  '))

  const fastest = pick(report.byModel, (row) => row.ttft.median, (a, b) => a < b)
  const slowest = pick(report.byModel, (row) => row.ttft.median, (a, b) => a > b)
  const fastestSpeed = pick(report.byModel, (row) => row.speedTps.median, (a, b) => a > b)
  const failing = report.byModel.filter((row) => row.errors > 0)

  lines.push('')
  lines.push(
    `view=${view}, sorted by ${options.sort ?? 'steps'}, ${rows.length} row(s). ttft/llm in ms; ` +
      'tok/s measured over the token streaming span.',
  )
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
  if (failing.length === 0) {
    lines.push('no errors attributed to any model.')
  } else {
    lines.push(`errors: ${failing.map((row) => `${labelOf(row, 'model')}=${row.errors}`).join(', ')}`)
  }
  lines.push(
    'Note: ttft is step/start -> first token, and tps is measured over the provider token-streaming ' +
      'span only, so both reflect real provider behaviour. speed_conf is the share of streamed steps ' +
      'long enough to be a reliable rate; a low value means the model mostly emitted very short bursts.',
  )

  return lines.join('\n')
}

/** One line naming where the numbers came from, so staleness is never invisible. */
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
