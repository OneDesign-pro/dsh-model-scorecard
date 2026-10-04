// dsh-model-scorecard - shared report collector.
//
// One implementation feeds both the agent-facing `model_stats` tool and the
// `GET /api/model-scorecard` route behind the settings panel, so the panel and the
// model can never disagree.
//
// Reads only committed history. Each session is folded once and cached; the
// cache is validated against the persistence revision and, when the collector
// was hydrated from the on-disk snapshot, served without touching the corpus at
// all. A caller that cannot wait asks for bounded phases instead of one long
// block:
//
//   statPass()      one revision probe for the whole corpus (no log reads)
//   snapshotStatus() what the snapshot covers, and which sessions disagree
//   snapshotReport() aggregate straight from the snapshot, minus what it cannot vouch for
//   collect()       fold only what is missing or changed
//
// Each session is read at most once per collector lifetime regardless of how
// many of those phases a caller runs.

import { aggregate, comparatorFor, foldSession, unmeasuredRow } from './fold.js'
import { emptyRating, RATING_POLICY } from './rating.js'
// Aliased, not imported as `cacheDir`: `createCollector` binds that name to the
// resolved directory it writes to, and a local of the same name would shadow the
// import into a temporal-dead-zone throw at the very line that resolves it.
import { cacheDir as resolveCacheDir } from './cache-dir.js'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The orders the agent's tool offers, in the order its schema lists them.
 *
 * A stable contract with the model: the text report is built around these six,
 * and widening what the model may ask for is a decision of its own, not a
 * side effect of the panel gaining columns. `rating` is the one that was widened
 * deliberately, and the tool's schema takes it from this array rather than
 * naming it a second time - so the key exists in the report, the panel and the
 * tool the moment it appears here.
 *
 * `steps` stays the default. A caller that has never heard of a rating keeps the
 * order it always got; the technical rating is opt-in, and its population is
 * narrower than every other column's (see `lib/rating.js`).
 */
export const SORTS = ['steps', 'ttft', 'speed', 'errors', 'lastSeen', 'rating']

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

// --- the selection -----------------------------------------------------------------
//
// Which models the panel is asking about, as a *rule* rather than as a list of
// pairs. The rules travel to the host on every request and the host resolves
// them against its own catalog, which is the only place that knows the whole
// set: the panel cannot name a model the configuration gained since its last
// answer, and a resolution done from a stale catalog would silently leave it out
// of a provider the user marked "all". Nothing about the selection is stored on
// the host; it is part of the question, like the sort key.
//
// Two scopes, because the archive is a scope and not a flag: a model outside the
// configuration is not the same item as one inside it, and the reader's rules
// about each are kept apart. While the archive is off its scope is not applied
// but is still carried, so turning the archive on brings the reader's marks back
// instead of resetting them.
//
// The precedence is one line long and is the whole contract: an explicit pair,
// then the provider's own rule, then the scope's base.

/**
 * The scopes a selection rule can talk about.
 *
 * `live` is the configuration the harness serves now, `archive` is everything
 * the history knows and the configuration does not.
 */
export const SELECTION_SCOPES = ['live', 'archive']

/** The three rules a scope's base can be. */
export const SELECTION_BASES = ['measured', 'all', 'none']

/**
 * The three rules one provider can be given.
 *
 * `all` and `none` are the two ends of a parent checkbox, and `measured` is the
 * third state a click on it can ask for: everything of this provider the history
 * has run. It is a rule about the provider and not a list of the pairs that happen
 * to be measured, so a model the provider gains and that is run for the first time
 * follows it — which is the whole reason a selection is a rule document (see
 * `resolveSelection`), and the reason a measured-only provider is not a provider
 * that has been partially ticked by hand.
 */
export const SELECTION_PROVIDER_RULES = ['all', 'measured', 'none']

/**
 * Bounds on a selection the route will accept.
 *
 * They exist to keep a malformed or hostile body from turning into work, not to
 * limit a reader: the catalog measured on this machine is 137 pairs over 16
 * providers, and a body past these limits is a bug rather than a large install.
 * A body past them is refused outright — a selection that was silently trimmed
 * would answer a question the reader did not ask, with rows missing and nothing
 * saying so.
 */
export const MAX_SELECTION_PROVIDERS = 512
export const MAX_SELECTION_PAIRS = 2048
export const MAX_SELECTION_NAME = 512

/**
 * `provider\u0000model`, the key every selection decision is made on.
 *
 * A displayed label is a shortened name and cannot identify a pair — two
 * providers may serve the same model id, which is the fixture the plan pins —
 * so identity is the exact pair and the separator is one no provider or model id
 * contains.
 */
export function pairKey(provider, model) {
  return `${provider}\u0000${model}`
}

/** The default rule a first-time reader opens on: measured, non-archived pairs. */
export function defaultSelectionRules() {
  return {
    live: { base: 'measured', providers: {}, pairs: {} },
    archive: { base: 'none', providers: {}, pairs: {} },
  }
}

/**
 * One scope of a selection as a rule the resolver can read.
 *
 * Absent fields mean the scope's own default, which is what makes a request that
 * names only a base a legal answer to "what is selected" — the panel's first
 * request is exactly that shape.
 */
function selectionScope(value, fallbackBase) {
  const scope = { base: fallbackBase, providers: {}, pairs: {} }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return scope
  if (SELECTION_BASES.includes(value.base)) scope.base = value.base
  if (value.providers !== null && typeof value.providers === 'object' && !Array.isArray(value.providers)) {
    for (const [provider, rule] of Object.entries(value.providers)) {
      if (!SELECTION_PROVIDER_RULES.includes(rule)) continue
      if (provider === '' || provider.length > MAX_SELECTION_NAME) continue
      scope.providers[provider] = rule
    }
  }
  if (value.pairs !== null && typeof value.pairs === 'object' && !Array.isArray(value.pairs)) {
    for (const [key, rule] of Object.entries(value.pairs)) {
      if (rule !== 'on' && rule !== 'off') continue
      if (key === '' || key.length > MAX_SELECTION_NAME * 2 + 1) continue
      scope.pairs[key] = rule
    }
  }
  return scope
}

/**
 * A selection body as the rules the resolver reads, or the reason it cannot be.
 *
 * `null` and `undefined` are not an empty selection and not an error: they are
 * the absence of a selection policy, which is the question {@link
 * toPanelPayload} has always answered — every measured row the configuration
 * serves. An empty object is the same statement spelled at greater length, and
 * it is why "nothing is selected" has to be said out loud rather than left out:
 * it is `{ live: { base: 'none' }, archive: { base: 'none' } }`, so a panel that
 * unticked everything and a panel that never had an opinion cannot be confused
 * for one another — the first must show an empty table, the second the default
 * one.
 *
 * Anything else that is not a rule is refused rather than repaired. A body the
 * host cannot read is a body whose answer would be some other question's, and
 * the panel would draw it under the reader's own marks.
 */
export function normalizeSelectionRules(value) {
  if (value === null || value === undefined) return { ok: true, rules: null }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'selection must be an object' }
  }
  const defaults = defaultSelectionRules()
  const rules = {
    live: selectionScope(value.live, defaults.live.base),
    archive: selectionScope(value.archive, defaults.archive.base),
  }
  for (const scope of SELECTION_SCOPES) {
    const entry = rules[scope]
    if (Object.keys(entry.providers).length > MAX_SELECTION_PROVIDERS) {
      return { ok: false, error: `selection.${scope}.providers is too large` }
    }
    if (Object.keys(entry.pairs).length > MAX_SELECTION_PAIRS) {
      return { ok: false, error: `selection.${scope}.pairs is too large` }
    }
  }
  return { ok: true, rules }
}

/**
 * The same rules in a canonical shape: sorted keys, one spelling per document.
 *
 * Tolerant about what it is handed, and for a reason: this is what the panel's
 * cache key is built from and what an answer echoes, so a document that reached it
 * through a path that did not normalize it — a hand-written request body, a store
 * written by another build, a caller of this module — must still produce a shape
 * rather than an exception. A missing map is an empty one and a missing scope is the
 * default scope, which is the same reading {@link resolveSelection} gives them, so
 * the two cannot disagree about a document they were both handed.
 */
export function canonicalSelectionRules(rules) {
  if (rules === null) return null
  const defaults = defaultSelectionRules()
  const source = typeof rules === 'object' ? rules : {}
  const out = {}
  for (const scope of SELECTION_SCOPES) {
    const value = source[scope]
    const entry = value !== null && typeof value === 'object' ? value : {}
    const providers = {}
    for (const key of Object.keys(entry.providers ?? {}).sort()) providers[key] = entry.providers[key]
    const pairs = {}
    for (const key of Object.keys(entry.pairs ?? {}).sort()) pairs[key] = entry.pairs[key]
    out[scope] = {
      base: SELECTION_BASES.includes(entry.base) ? entry.base : defaults[scope].base,
      providers,
      pairs,
    }
  }
  return out
}

/**
 * The tree the panel draws, out of the full report and the configuration.
 *
 * One entry per model in the current scope, with what a checkbox needs to know
 * about it: whether it is outside the configuration (`archived`, `null` when the
 * host could not read one), whether it has any history at all (`noStats`), and
 * how many steps it has (`steps`).
 *
 * It is built from the *unfiltered* report and the whole configuration on
 * purpose. A catalog read off the rows being sent would name exactly the models
 * already selected, which is the one set a selection tree must be able to grow
 * beyond — and it would lose the archive, which is the other half of the tree.
 */
export function selectionCatalog(fullReport, config, includeArchived) {
  const entries = new Map()
  const add = (provider, model, archived, steps) => {
    if (provider === '' || model === '' || model === null) return
    const key = pairKey(provider, model)
    const existing = entries.get(key)
    if (existing !== undefined) {
      existing.steps += steps
      return
    }
    entries.set(key, { provider, model, archived, steps })
  }

  // The history first: a pair the history knows is measured, whatever the
  // configuration says about it.
  for (const row of fullReport === null ? [] : fullReport.byModel ?? []) {
    add(row.provider, row.model, archivedOf(config, row), row.steps ?? 0)
  }
  // Then the configuration, for the pairs the history has never seen. A pair
  // already added above keeps its measured steps and does not become `noStats`.
  if (config !== null) {
    for (const pair of config.list) {
      const key = pairKey(pair.provider, pair.model)
      if (entries.has(key)) continue
      add(pair.provider, pair.model, false, 0)
    }
  }

  const providers = new Map()
  for (const entry of entries.values()) {
    if (includeArchived !== true && entry.archived === true) continue
    let group = providers.get(entry.provider)
    if (group === undefined) {
      group = { provider: entry.provider, models: [] }
      providers.set(entry.provider, group)
    }
    group.models.push({ model: entry.model, archived: entry.archived, noStats: entry.steps === 0, steps: entry.steps })
  }
  for (const group of providers.values()) {
    group.models.sort((a, b) => a.model.localeCompare(b.model))
  }
  return [...providers.values()].sort((a, b) => a.provider.localeCompare(b.provider))
}

/**
 * The catalog as the pairs the rules select, and the per-provider counts.
 *
 * The one rule, in one place, for the three readers that need it: the route
 * resolves a request, the panel resolves its stored rules to draw the tree, and
 * `tools/verify-selection.mjs` asserts both agree. So the precedence — an
 * explicit pair, then the provider's rule, then the scope's base — is written
 * once and read by all three.
 *
 * `measured` is "the history has a step for it": a configured pair nothing has
 * run is not measured, which is what makes the first-open default the set the
 * reader can actually compare.
 */
export function resolveSelection(rules, catalog) {
  const selected = new Set()
  const providers = []
  // The scope's own defaults, for a rule document that names only a base — which
  // is a legal request and is exactly the shape the panel's first one has. A
  // missing `providers` or `pairs` map means "no rule of that kind", never a
  // crash in the middle of a table.
  const scopeOf = (name, fallback) => {
    const value = rules === null ? null : rules[name]
    if (value === null || typeof value !== 'object') return null
    return {
      base: SELECTION_BASES.includes(value.base) ? value.base : fallback,
      providers: value.providers ?? {},
      pairs: value.pairs ?? {},
    }
  }
  const live = scopeOf('live', 'measured')
  const archive = scopeOf('archive', 'none')
  for (const group of catalog) {
    let count = 0
    for (const entry of group.models) {
      const rule = entry.archived === true ? archive : live
      let on
      if (rule === null) {
        on = entry.archived !== true && entry.noStats !== true
      } else {
        const key = pairKey(group.provider, entry.model)
        const exception = rule.pairs[key]
        if (exception === 'on') on = true
        else if (exception === 'off') on = false
        else {
          const provider = rule.providers[group.provider]
          if (provider === 'all') on = true
          else if (provider === 'none') on = false
          else if (provider === 'measured') on = entry.noStats !== true
          else if (rule.base === 'all') on = true
          else if (rule.base === 'none') on = false
          else on = entry.noStats !== true
        }
      }
      if (!on) continue
      selected.add(pairKey(group.provider, entry.model))
      count += 1
    }
    providers.push({ provider: group.provider, selected: count, total: group.models.length })
  }
  return { pairs: selected, providers }
}

/**
 * Narrow a pass's records to the pairs a selection names, before any aggregate.
 *
 * This is the difference between a provider row that is the provider's own
 * measurements and one that is an average of other rows' medians: the aggregate
 * buckets, medians and counts whatever it is handed, so the selection has to be
 * a filter on the raw records and not a filter on the table.
 *
 * The one asymmetry is a record with no model. A step whose retries never
 * produced a message is attributed to a provider alone, and the aggregate already
 * counts it on the provider row and on no model row; dropping it whenever a
 * selection is on would make the provider's retry figures depend on which of its
 * models the reader marked, which is not a fact about the provider. So it
 * follows the provider: it is kept while any pair of that provider is selected.
 * An error the history could not attribute at all carries the `unknown` pair and
 * is kept only if that pair is selected — the selection cannot invent an
 * attribution the log does not have.
 */
function selectRecords(samples, errors, retries, selection) {
  const providers = new Set()
  for (const key of selection) {
    const separator = key.indexOf('\u0000')
    if (separator > 0) providers.add(key.slice(0, separator))
  }
  const keepPair = (provider, model) =>
    model === null || model === undefined
      ? providers.has(provider)
      : selection.has(pairKey(provider, model))
  return {
    samples: samples.filter((sample) => keepPair(sample.provider, sample.model)),
    errors: errors.filter((error) => keepPair(error.provider, error.model)),
    retries: retries.filter((failure) => keepPair(failure.provider, failure.model ?? null)),
  }
}

/**
 * The records one aggregate is built from, and the selection applied to them.
 *
 * The resolution happens *here* and not in the route, and that is the whole
 * reason this function exists: a selection rule can only be resolved against the
 * full catalog — the archive scope needs to know which pairs the configuration
 * dropped, and "all of a provider" needs the provider's models — and the catalog
 * is a product of the fold. Resolving in the route would mean folding the corpus
 * twice or resolving against a stale catalog, and a stale catalog is exactly the
 * case with a wrong answer: a model the configuration gained since the last
 * answer would be missing from a provider the reader marked "all".
 *
 * So one pass resolves the rules, then filters the raw records and aggregates
 * again. Both aggregates are returned: `report` is what the reader asked about,
 * `fullReport` is the history they are comparing against, and the totals and the
 * tree are read from the second because a total that moved with the selection
 * would no longer be a total. Without rules there is only ever one aggregate and
 * the two are the same object.
 */
function aggregateSelection(samples, errors, retries, options) {
  const rules = options.selectionRules ?? null
  const order = {
    sort: options.sort ?? 'steps',
    dir: options.dir,
    errors,
    retries,
    statusOf: options.statusOf,
  }
  if (rules === null) {
    const report = samples.length === 0 ? null : aggregate(samples, order)
    return { report, fullReport: report, catalog: null, selection: null, selectionRules: null }
  }

  const fullReport = samples.length === 0 ? null : aggregate(samples, order)
  const catalog = selectionCatalog(
    fullReport,
    configuredIndex(options.configured),
    options.includeArchived === true,
  )
  const resolved = resolveSelection(rules, catalog)
  const chosen = selectRecords(samples, errors, retries, resolved.pairs)
  return {
    // The selected set is asked for by name, so an empty answer to it is an empty
    // table and not an empty history.
    report: aggregate(chosen.samples, { ...order, errors: chosen.errors, retries: chosen.retries }),
    fullReport,
    catalog,
    selection: resolved.pairs,
    selectionRules: rules,
  }
}

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
 * How many disagreeing sessions {@link snapshotStatus} names.
 *
 * A cold store has hundreds of them and every one carries two revision strings,
 * so the list is capped rather than complete; `mismatchesOmitted` says how many
 * it did not name, which is the number that would otherwise look like a short
 * list rather than a truncated one.
 */
const STATUS_MISMATCH_LIMIT = 8

/** What a status looks like when there is no snapshot to report on. */
const UNAVAILABLE_SNAPSHOT = Object.freeze({
  available: false,
  fresh: false,
  total: 0,
  covered: 0,
  stale: 0,
  uncovered: 0,
  mismatches: Object.freeze([]),
  mismatchesOmitted: 0,
})

/**
 * Where the folded snapshot lives.
 *
 * `DSH_MODEL_SCORE_CARD_CACHE_DIR` overrides it so tests can drive the real
 * round-trip without touching the user's cache; the resolution itself, the
 * variable's previous name and the one-time move of the old directory are in
 * `cache-dir.js`, shared with the probe store that sits beside this file.
 */
function snapshotDir() {
  return resolveCacheDir()
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

  const readNowIds = new Set()
  // Sessions this process has folded itself: the ones it read, and the ones it
  // accepted from a hydrated snapshot after comparing their revision against its
  // own listing. The in-memory phase answers from these and only these. "Read
  // now" is the wrong set and was the wrong answer — see {@link foldUncached}.
  const foldedHere = new Set()
  // Set once a pass has walked every listed session without leaving one behind,
  // which is the only state in which this process can vouch for the whole corpus
  // from memory. A pass cut short by its deadline, or one asked for named ids,
  // says nothing about the sessions it never reached.
  let foldedWholeCorpus = false
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
    // compared. One listing supplies it for the whole corpus, and both the
    // listing and `observeSession` report it as the same file identity (see
    // `fileRevisionOf`), so a cache hit here is "this session was already folded
    // at the revision the store reports now" - which is the whole reuse contract,
    // with nothing left to qualify by corpus generation.
    if (current !== null) {
      const cached = cache.get(keyOf(sessionId, current))
      if (cached !== undefined) {
        // A cache hit here is the reuse contract being kept, not work skipped:
        // `current` is the revision this process's own listing reports, so
        // accepting the entry is exactly the comparison the on-disk phase makes.
        // It counts as folded here for the same reason a fresh read does, and
        // leaving it out is what made `foldedHere` mean "read now" instead of
        // "folded here": a host that restarts onto a complete snapshot reads
        // only the logs that moved since it — measured on this machine's store
        // on 2026-10-02, 7 of 499 — so the in-memory phase answered 1 217 steps
        // over 4 models where the phase chain had just answered 36 096 over 71
        // and the tool reported 16 providers.
        foldedHere.add(sessionId)
        return cached
      }
    }

    const source = await readSource(sessionId)
    if (source.skipped !== undefined) return source
    readNowIds.add(sessionId)
    foldedHere.add(sessionId)
    passReads += 1

    const folded = foldSession(source.events, { sessionId })
    // The entry is keyed by the file identity whichever source reported it, so the
    // two spellings the backend uses can never make a session look changed the
    // moment its own read finished.
    const key = current ?? fileRevisionOf(source.revision)
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
   * Every revision is normalized to its file identity on the way in, so the two
   * spellings the backend uses (see {@link fileRevisionOf}) become one string and
   * every later comparison is a plain `===` against a cache key.
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
        next.set(id, fileRevisionOf(entry.revision))
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
   * @param options.onlyIds - fold these sessions and report on those, while still
   *   counting every listed session as seen. The panel's follow-up pass names the
   *   ids {@link snapshotReport} could not vouch for; without the filter it would
   *   re-decide which sessions those were by walking the whole corpus again.
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

    const wanted =
      Array.isArray(options.onlyIds) && options.onlyIds.length > 0
        ? new Set(options.onlyIds.filter((id) => typeof id === 'string'))
        : null

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
      // Every listed session counts as seen even when this pass was not asked to
      // fold it: `finishPass` prunes the snapshot index by what the store stopped
      // listing, and a pass over a handful of ids would otherwise read as "the
      // other four hundred are gone".
      seen.add(sessionId)
      if (wanted !== null && !wanted.has(sessionId)) continue

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
      gather(folded)
    }

    // A pass asked for named ids read those and only those, but its answer is the
    // whole corpus: the other sessions are already folded and cached, and the
    // caller is replacing an answer it computed from exactly this cache. Without
    // this the follow-up would report the two sessions it read as if they were the
    // history.
    if (wanted !== null) {
      samples.length = 0
      errors.length = 0
      retries.length = 0
      for (const sessionId of seen) {
        const revision = stats.get(sessionId) ?? null
        const entry = revision === null ? undefined : cache.get(keyOf(sessionId, revision))
        if (entry !== undefined) gather(entry)
      }
    }

    function gather(entry) {
      for (const sample of entry.samples) {
        if (sinceMs !== null && sample.time < sinceMs) continue
        samples.push(sample)
      }
      for (const error of entry.errors) {
        if (sinceMs !== null && error.time < sinceMs) continue
        errors.push(error)
      }
      for (const failure of entry.retries) {
        if (sinceMs !== null && failure.time < sinceMs) continue
        retries.push(failure)
      }
    }

    // A pass that reached every record it listed — no deadline left one behind,
    // and no `onlyIds` narrowed it — is the one fact the in-memory phase needs:
    // this process now holds the whole corpus it was told about, and may answer
    // for it without a listing. The pass's own report decides it, not the size
    // of the cache, because a cache full of hydrated entries is not a fold.
    if (wanted === null && pending === 0) foldedWholeCorpus = true

    finishPass(records.length, seen)

    const attributed = attributeErrors(errors)

    const provenance = {
      snapshotAt: snapshot === null ? null : snapshot.savedAt,
      readNow: passReads,
      reused: Math.max(0, seen.size - skipped - passReads),
      pruned,
    }

    // A pass asked for named ids reports against those ids: `8 of 483` would say
    // the other 475 were still to be read when this pass had deliberately not
    // been asked to read them.
    const target = wanted === null ? records.length : wanted.size

    const aggregated = aggregateSelection(samples, attributed, retries, options)

    if (samples.length === 0) {
      // An empty history is not an empty question: the selection still has to be
      // resolved, because the table it answers with is the *selected* configured
      // pairs and not every one of them. Resolving here rather than skipping to a
      // bare `empty` is what keeps a fresh install showing the reader's marks
      // instead of the whole catalog.
      return {
        empty: true,
        ...aggregated,
        skipped,
        pending,
        complete: pending === 0,
        provenance,
        ...progressOf(target, scanned, pending),
      }
    }

    return {
      ...aggregated,
      skipped,
      pending,
      complete: pending === 0,
      provenance,
      ...progressOf(target, scanned, pending),
    }
  }

  /**
   * Answer from the snapshot alone, without reading or listing anything.
   *
   * The panel calls this first: when disk already holds a fold of most of the
   * corpus, the table appears immediately and the freshness pass afterwards
   * reads only what this phase could not vouch for, instead of blocking the
   * first paint. Returns null only when the snapshot can answer for nothing at
   * all; otherwise the answer says which sessions it left out and hands their
   * ids back.
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
    // The sessions the snapshot could not vouch for, split by why: one the
    // snapshot has never seen, and one whose own log has moved since. The
    // follow-up fold re-reads exactly these two lists together.
    const uncoveredIds = []
    const changedIds = []

    for (const record of records) {
      const sessionId = record?.header?.id ?? record?.id
      if (typeof sessionId !== 'string') continue

      const revision = snapshot.revisions.get(sessionId)
      const entry = revision === undefined ? undefined : cache.get(keyOf(sessionId, revision))
      if (entry === undefined) {
        // A session started since the snapshot was written is the normal case, not
        // the exceptional one, and it used to void the entire snapshot: one new log
        // anywhere on the machine meant the panel fell through to a full fold of
        // every other session too. It is now one more session for the follow-up to
        // read, and the answer says so instead of pretending to be complete.
        uncoveredIds.push(sessionId)
        continue
      }

      const current = stats.get(sessionId)
      if (current !== undefined && current !== null && current !== revision) {
        // Only this log's own file identity can differ here. The corpus-wide hash a
        // legacy generation also carries is stripped on the way in (see
        // `fileRevisionOf`), so a session is re-read when its own log changed and
        // for no other reason.
        changedIds.push(sessionId)
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

    const skippedIds = [...uncoveredIds, ...changedIds]
    if (seen.size === 0) return null

    const attributed = attributeErrors(errors)
    const aggregated = aggregateSelection(samples, attributed, retries, options)

    return {
      // Spread for the same reason as `snapshotSummary`: the selection and its
      // catalog are part of the answer, not a detail of it.
      ...aggregated,
      skipped: 0,
      pending: skippedIds.length,
      // False exactly when the caller's follow-up fold has work left, which is what
      // makes this phase usable at all: it used to answer only when it could answer
      // for every session, or not at all.
      complete: skippedIds.length === 0,
      fromSnapshot: true,
      // Handed back so the caller's follow-up fold does not list the corpus again,
      // and so it can fold these ids alone instead of re-deciding which they were.
      records,
      skippedIds,
      uncovered: uncoveredIds.length,
      changed: changedIds.length,
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
   * Aggregate this process's own fold, without touching the store.
   *
   * The panel's first paint uses this on a warm process: the numbers were folded
   * moments ago in this same process, and the refresh pass that follows is what
   * makes them current. It never touches the store, which is the whole point.
   *
   * "This process's own fold" is the whole condition, and it is not a detail. This
   * used to walk every entry in the cache, which after {@link hydrate} holds the
   * entire on-disk snapshot — so in a freshly started host the cheapest phase
   * answered from the snapshot *without comparing one revision*, returned
   * `complete: false` with a pending count of zero to say nothing at all, and the
   * panel never reached the phase that does compare. A table missing every
   * session written since the last fold was served as the fast answer, and the
   * only record that anything was missing was a flag no reader sees.
   *
   * Answering for the corpus or not at all is the second half of that contract,
   * and it is what `foldedWholeCorpus` decides: a fold of the sessions this
   * process happened to read is a delta, not a table. Measured on this machine's
   * store on 2026-10-02, a host restarted onto a complete snapshot read 7 of 499
   * logs during its warm pass, so this phase answered 1 217 steps over 4 models
   * and 4 providers where the tool, folding the same cache, answered 36 096
   * steps over 71 models and 16 providers — with `pending: 0` and
   * `complete: false`, the pair that says "nothing more is coming" while most of
   * the history is absent. A host that has not finished such a pass declines and
   * the on-disk phase serves it, which is where a partial table belongs.
   */
  async function snapshotSummary(options = {}) {
    await hydrate()
    if (snapshot === null) return null
    if (!foldedWholeCorpus) return null
    const samples = []
    const errors = []
    const retries = []
    const seen = new Set()

    for (const sessionId of foldedHere) {
      const revision = snapshot.revisions.get(sessionId)
      const entry = revision === undefined ? undefined : cache.get(keyOf(sessionId, revision))
      if (entry === undefined) continue
      seen.add(sessionId)
      for (const sample of entry.samples) samples.push(sample)
      for (const error of entry.errors) errors.push(error)
      for (const failure of entry.retries ?? []) retries.push(failure)
    }
    if (seen.size === 0 || samples.length === 0) return null

    const sinceMs = Number.isFinite(options.sinceMs) ? options.sinceMs : null
    // The same timestamp predicate the two other paths apply, applied to all
    // three of their collections. This path used to scope `samples` only and hand
    // the unfiltered errors and retries to `aggregateSelection`, so a scoped
    // panel opened from memory reported error counts and retry rates from
    // outside the scope it was asked about while the cold and snapshot-report
    // paths reported them inside it - one question, two answers, and the memory
    // answer is the one the panel shows first.
    const inScope = (record) => sinceMs === null || record.time >= sinceMs
    const filtered = samples.filter(inScope)
    if (filtered.length === 0) return null

    const aggregated = aggregateSelection(filtered, errors.filter(inScope), retries.filter(inScope), options)

    return {
      // Spread, not a list of fields: the selection and the tree catalog are what
      // `aggregateSelection` decided, and a phase that re-listed the two it knew
      // about would drop the very fields the panel's tree is drawn from — which is
      // exactly how this phase answered a selected question with the full table.
      ...aggregated,
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
   *
   * The counts used to be all this said, and they were not enough to act on: a
   * status of `covered: 281, stale: 196` tells a reader that the snapshot cannot
   * be trusted and nothing about which session to look at, and the module keeps
   * the index private, so the ids could not be named from outside it. They are
   * named here, with both revision strings and which of the three reasons
   * applied, capped because a cold store has hundreds of them and a status
   * payload is not a log.
   */
  async function snapshotStatus() {
    await hydrate()
    if (snapshot === null) return UNAVAILABLE_SNAPSHOT
    await statPass()

    const query = ctx.get('sessionQuery')
    if (query === undefined) return UNAVAILABLE_SNAPSHOT
    let records = []
    try {
      records = await query.listSessions()
    } catch {
      return UNAVAILABLE_SNAPSHOT
    }

    let covered = 0
    let stale = 0
    let uncovered = 0
    const mismatches = []
    const note = (sessionId, reason, stored, current) => {
      if (mismatches.length >= STATUS_MISMATCH_LIMIT) return
      mismatches.push({ id: sessionId, reason, stored: stored ?? null, current: current ?? null })
    }

    for (const record of records) {
      const sessionId = record?.header?.id ?? record?.id
      if (typeof sessionId !== 'string') continue
      const current = stats.get(sessionId) ?? null
      const stored = snapshot.revisions.get(sessionId)
      if (stored === undefined || stored === null) {
        // The store lists a session the snapshot has never seen. This is the
        // ordinary case after any conversation, and it is counted separately
        // rather than folded into `stale` because it is not a disagreement
        // between two observations of one log - there is only one observation.
        uncovered += 1
        note(sessionId, 'uncovered', null, current)
        continue
      }
      if (cache.get(keyOf(sessionId, stored)) === undefined) {
        stale += 1
        note(sessionId, 'no-entry', stored, current)
        continue
      }
      if (current === null || current === stored) {
        covered += 1
        continue
      }
      stale += 1
      note(sessionId, 'changed', stored, current)
    }

    return {
      available: true,
      // Fresh means the snapshot answers for the corpus as it stands now, which
      // includes the sessions it has never seen: a status that ignored them
      // reported a clean bill of health for a fold that was missing logs.
      fresh: statsLoaded !== false && stale === 0 && uncovered === 0,
      total: records.length,
      covered,
      stale,
      uncovered,
      savedAt: snapshot.savedAt,
      mismatches,
      mismatchesOmitted: stale + uncovered - mismatches.length,
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
        // Normalized on the way in, so a snapshot written before this comparison
        // existed - and therefore holding whole legacy revisions with the corpus
        // hash still attached - hydrates into exactly the same keys a current one
        // does. That is why the sample shape, and with it `SNAPSHOT_VERSION`, does
        // not have to move: what changed is which part of the revision is read,
        // not what a sample holds.
        const revision = fileRevisionOf(entry.revision)
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
      // No corpus-wide fingerprint: a snapshot records one file identity per
      // session and nothing else. A `legacyRevision` written by an older build is
      // ignored on the way back in, so this field simply stops appearing.
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
        `dsh-model-scorecard: snapshot save failed: ${String(error?.message ?? error)}`,
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
      hydrating = null
      readNowIds.clear()
      foldedHere.clear()
      foldedWholeCorpus = false
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
 * The part of a revision that identifies one log.
 *
 * The JSONL backend spells a current revision as the file identity
 * `<dev>:<ino>:<size>:<mtimeNs>:<ctimeNs>`, and a legacy one as that same tuple
 * with a corpus-wide hash appended: `<file identity>:<64-hex>`. That hash is a
 * digest over *every* old-format log on the machine, so it moves as soon as any
 * of them is written - one new legacy session invalidates every other legacy
 * entry at the same instant. Measured on this machine's store on 2026-10-01, that
 * single fact made 195 of 483 sessions read as changed while not one of their own
 * logs had been touched, and the hash moved again between two measurements taken
 * minutes apart because sessions were being written the whole time.
 *
 * The file identity is the part that answers "has *this* log changed", and it is
 * also the only part two sources agree on: `observeSession` reports the bare
 * identity while a listing appends the hash, which is why the same fact used to
 * have two spellings that had to be reconciled. Stripping the hash therefore
 * fixes both halves at once - the comparison stops condemning untouched logs, and
 * a revision read from either source compares equal to the other.
 *
 * @returns the file identity, or null when there is no usable revision.
 */
function fileRevisionOf(revision) {
  if (typeof revision !== 'string' || revision === '') return null
  const separator = revision.lastIndexOf(':')
  // Only a trailing 64-hex field is the corpus hash. The identity itself is
  // colon-separated, so the field has to be recognised rather than assumed.
  if (separator !== -1 && /^[0-9a-f]{64}$/.test(revision.slice(separator + 1))) {
    return revision.slice(0, separator)
  }
  return revision
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
 * The split is applied over the whole filtered set and before the limit, never
 * over the page the limit cut off. `shown` has to be counted here and not after
 * the cut for the same reason a provider filter is: the footer prints it beside
 * whole-history totals, and a number that changed when `limit` did would make the
 * two incomparable.
 *
 * `archive` is `null` when there is no configuration to grade against, which is
 * how the panel knows not to offer the control at all rather than to offer one
 * that can only ever read zero.
 */
function gradeRows(rows, config, includeArchived) {
  const graded = rows.map((row) => ({ row, archived: archivedOf(config, row) }))
  return {
    kept: includeArchived ? graded : graded.filter((entry) => entry.archived !== true),
    archive: archiveBlock(rows, config, includeArchived),
  }
}

/**
 * What the archive holds, counted over rows the *selection* did not narrow.
 *
 * This is a count about the configuration and the history, not about the table,
 * and the difference is the whole point of printing it. The number sits beside the
 * archive switch and is the reader's only way to learn that turning that switch on
 * would show something at all — a selection is `live: measured, archive: none` on
 * a first open, so an archive counted off the selected rows reads zero forever,
 * including with the archive switched on and its models sitting in the tree
 * unticked. A control that can only read zero is a promise the panel cannot keep.
 *
 * `shown` is the half that does follow the table: whether these rows are on
 * screen right now.
 */
function archiveBlock(rows, config, includeArchived) {
  if (config === null) return null
  const outside = rows.filter((row) => archivedOf(config, row) === true)
  return {
    rows: outside.length,
    steps: outside.reduce((sum, row) => sum + (row.steps ?? 0), 0),
    shown: includeArchived,
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
 *
 * `allowed` is the selection, when one is on: a configured pair is a row while
 * the reader selected it. A configured model nobody has run is not a row the
 * history earned, so with a selection in force it is a row the *reader* asked
 * for — which is what makes "tick a model with no statistics and see its empty
 * row" work without a separate button, and what keeps an unselected one out.
 */
function unmeasuredRows(config, byProvider, present, wanted, statusOf, allowed = null) {
  if (config === null) return []
  // Which providers a selection reaches at all: a provider row exists while one
  // of its pairs is selected, and a model row while that pair is. `null` means no
  // selection is on and every configured pair is reachable, which is the table
  // this route answered before a selection existed.
  let allowedProviders = null
  if (allowed !== null) {
    allowedProviders = new Set()
    for (const key of allowed) {
      const separator = key.indexOf('\u0000')
      if (separator > 0) allowedProviders.add(key.slice(0, separator))
    }
  }
  const rows = []
  if (byProvider) {
    for (const provider of config.providers) {
      if (present.has(provider)) continue
      if (wanted !== null && !wanted.has(provider)) continue
      if (allowedProviders !== null && !allowedProviders.has(provider)) continue
      rows.push(unmeasuredRow(provider, null))
    }
  } else {
    for (const pair of config.list) {
      if (present.has(`${pair.provider}\u0000${pair.model}`)) continue
      if (wanted !== null && !wanted.has(pair.provider)) continue
      if (allowed !== null && !allowed.has(pairKey(pair.provider, pair.model))) continue
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
 * The largest page one panel answer can carry.
 *
 * One number, in one place, because both halves of the route need it: the panel
 * checks the page it asks for against it, and the payload clamps the page it
 * serves to it. The default page is 200 — a ranked shortlist, which is what the
 * table is for — and the ceiling is what the panel raises the page to when a
 * selection is larger than a page and the reader asks for the whole of it
 * (`models.showAll` in the panel).
 *
 * 2000 is above every catalog measured here, in any direction: the probe store
 * names 137 pairs over 16 providers and the whole of it is 183 KB of JSON. A
 * selection past even this answers with `truncated` set, and the panel says so
 * rather than passing a page off as the whole question.
 */
export const MAX_PANEL_ROWS = 2000

/** Compact JSON payload for the settings panel: no per-step samples, only rows. */
export function toPanelPayload(result, options = {}) {
  if (result.error !== undefined) return { ok: false, error: result.error }
  const provenance = result.provenance ?? { snapshotAt: null, readNow: 0, reused: 0, pruned: 0 }
  // The progress triple the panel footer counts out of — `pending` is the one a
  // host that could not finish everything answers with: it says so in the footer
  // instead of passing the page off as the whole question. `complete` and the
  // wall-clock `generatedAt` used to travel here too; neither has a reader, and a
  // reader of `pending` never needs to know whether the fold finished at the
  // millisecond the payload was assembled.
  const progress = {
    scanned: result.scanned ?? 0,
    skipped: result.skipped ?? 0,
    pending: result.pending ?? 0,
    snapshotAt: provenance.snapshotAt,
    readNow: provenance.readNow,
    reused: provenance.reused,
  }
  // An empty history is not an empty table while the configuration serves
  // something: a configured model nobody has run yet is a row of its own (see
  // `unmeasuredRows`), and on a fresh install those rows are the whole table. So
  // the two cases share one assembly instead of each having its own, and the
  // payload below is the same shape either way.
  //
  // What an empty history does *not* clear is the selection: the pair set the
  // collector resolved is a fact about the question, not about the corpus, and it
  // is what tells the rows below which configured pairs the reader asked for. A
  // payload that dropped it here would answer a fresh install with the whole
  // catalog instead of the reader's marks.
  const report = result.empty === true ? null : result.report
  // The whole-history report the totals, the provider list and the tree catalog
  // are read from. It is the same object as `report` while no selection is on,
  // and the unfiltered aggregate when one is: a total that moved with the
  // selection would no longer be a total, and a catalog read off the selected
  // rows could not offer the models the reader has not selected yet.
  const fullReport = result.empty === true ? null : (result.fullReport ?? result.report)
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
  const limit =
    Number.isInteger(options.limit) && options.limit > 0 ? Math.min(MAX_PANEL_ROWS, options.limit) : 50
  // The pairs the question selected, resolved by {@link aggregateSelection}
  // against the catalog it built from the whole fold — `options.selection` is the
  // seam a test or another surface drives directly, and it is a `Set` of pair keys
  // either way.
  const selection =
    result.selection instanceof Set
      ? result.selection
      : options.selection instanceof Set
        ? options.selection
        : null

  let rows = report === null ? [] : report[view]
  if (wanted !== null) rows = rows.filter((row) => wanted.has(row.provider))
  // What the filter kept, counted over the filtered rows and not over the page
  // the limit cut off: the panel shows it beside the whole-history totals, whose
  // meaning must not change when a filter is on. `shown` counts the rows the
  // grade kept.
  const { kept } = gradeRows(rows, config, includeArchived)
  // The archive is counted over the whole history and not over this answer's
  // selection — see {@link archiveBlock} for why that is the only count the
  // panel can print. The provider filter still applies, because that is a
  // question about the history; the selection is not, it is a question about
  // the table.
  const fullRows = fullReport === null ? [] : fullReport[view]
  const archive = archiveBlock(
    wanted === null ? fullRows : fullRows.filter((row) => wanted.has(row.provider)),
    config,
    includeArchived,
  )
  const present = new Set(
    kept.map(({ row }) =>
      byProvider ? row.provider : `${row.provider}\u0000${row.model}`,
    ),
  )
  const extra = unmeasuredRows(config, byProvider, present, wanted, statusOf, selection).map((row) => ({
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

  // The tree, and what each provider's selected share of it is. The catalog the
  // collector resolved against is the one to send — it is the same object the
  // rules were resolved from, so the checkboxes and the rows cannot disagree —
  // and a caller that drove the payload without a collector gets one built here
  // from the unfiltered report and the whole configuration: it names the models
  // the reader has not marked as well as the ones they have, which is the only
  // shape a selection tree can be drawn from.
  const catalog =
    Array.isArray(result.catalog) ? result.catalog : selectionCatalog(fullReport, config, includeArchived)
  // The provider view prints "N of M models" beside a provider, and the two
  // numbers are read off one thing: `M` is the provider's models in the current
  // scope and `N` is how many of them the selection holds. Counted from the
  // resolved pairs rather than from the rules, so the number beside a provider
  // row cannot disagree with the rows under it.
  const coverage =
    selection === null
      ? null
      : catalog.map((group) => ({
          provider: group.provider,
          selected: group.models.filter((entry) => selection.has(pairKey(group.provider, entry.model))).length,
          total: group.models.length,
        }))

  return {
    ok: true,
    // There was no `empty` here. It read `rows.length === 0` — a field whose only
    // content was the length of the array beside it — and the panel never asked
    // for it: it counts the rows it was given. `tools/verify-payload-consumers.mjs`
    // is what noticed, and the fact that it took a tool to notice is the reason
    // the tool exists: a redundant field is not wrong, it is invisible.
    ...progress,
    // The whole history, and only the history: the rows below are what the
    // filter and the configuration left, and the footer prints these next to
    // them. `null` when there is no report at all — an empty history has nothing
    // to total, and zeros beside a table of configured models would read as a
    // history that was counted rather than one that was not. `fromSnapshot` used
    // to ride on the answer the same way; the one reader of that fact is
    // `provenance`, and the panel reads `snapshotAt` off it.
    totals:
      fullReport === null
        ? null
        : {
            steps: fullReport.steps,
            errors: fullReport.errors,
            retries: fullReport.retries ?? 0,
            retryFailedSteps: fullReport.retryFailedSteps ?? 0,
            models: fullReport.models,
            providers: fullReport.providers,
          },
    sort: options.sort ?? 'steps',
    // The direction the rows were actually ordered in, next to the key they were
    // ordered by. The panel asks for one of the two on every request, so this is
    // the one field that can contradict what the user asked for — and a panel
    // that renders an arrow needs to know which way the rows really went.
    dir: sortDirection(options.dir),
    // The scope every figure above was folded over, echoed for the same reason
    // `sort` and `dir` are: a scoped number that does not say it is scoped reads
    // as a whole-history number. `null` is all history — the default, and the
    // only thing a caller that never sends `sinceMs` can mean. The rating is
    // affected twice over by a scope, since it both drops out-of-scope samples
    // and re-anchors on the newest one that remains.
    sinceMs: Number.isFinite(options.sinceMs) ? options.sinceMs : null,
    view: options.view === 'provider' ? 'provider' : 'model',
    // Echoed back so the panel can tell what the host actually applied — a
    // filter it did not send is the one thing a "showing previous answer"
    // notice must never hide. `providerList` — the same providers with the
    // archive grading applied — used to ride on the answer the same way, for a
    // filter control the panel stopped reading from it in `8294d31`: the tree is
    // drawn from `catalog` and the per-provider count from `coverage`, so the
    // list was carrying the same information the panel was already counting.
    providers,
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
    // The tree, the per-provider share of it, and whether the limit cut the
    // selected set. A selection is a question about a set of models, so an
    // answer that dropped one of them silently would be an answer to a smaller
    // question — `truncated` is what lets the panel say so instead of claiming
    // the table is the whole selection.
    selection:
      selection === null
        ? null
        : canonicalSelectionRules(result.selectionRules ?? options.selectionRules ?? null),
    catalog,
    coverage,
    truncated: ordered.length > rows.length,
    rows: rows.map(({ row, archived, noStats }) => ({
      provider: row.provider,
      model: row.model,
      // The whole rating object, never a bare score: the panel needs the reason
      // to explain a dash, the counts to say how much evidence stands behind a
      // number, and `provisional` to mark a published score as thin. Every row
      // carries it - a configured model with no history is `no_samples`, a
      // provider roll-up is `pair_only` - so a caller never has to test for the
      // field, and a row that somehow arrived without one still gets the honest
      // empty shape rather than `undefined`.
      rating: row.rating ?? emptyRating(),
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
  // The clock the rating's stale marker is measured against, taken from the caller
  // so a test can freeze it: "over 30 days old" is a statement about today, and a
  // test that read the wall clock would answer differently on the day a fixture
  // crosses the threshold — the flake this repository keeps re-learning. Absent, it
  // is the wall clock, which is what the tool wants.
  const now = Number.isFinite(options.now) ? options.now : Date.now()

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
    // The rating sits next to the identity, because it is a verdict about the
    // route the label names rather than one more way to decompose a step.
    'rating',
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
    ratingCell(row, now),
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
  const failing = summaryRows.filter((row) => row.errors > 0)

  lines.push('')
  lines.push(
    `view=${view}, sorted by ${options.sort ?? 'steps'}, ${rows.length} row(s)` +
      (providers.length > 0 ? `, provider=${providers.join('+')}` : '') +
      '. ttft/llm in ms; tok/s = provider-reported output tokens over the provider streaming span.',
  )
  // The rating is the one column whose cell cannot be read off the table alone:
  // a dash means "not enough evidence", a `~` means "thin evidence", a `*` means
  // "the evidence is old", and all three are statements about a population or a
  // date the other columns deliberately do not share.
  // The block below is the smallest one that makes the column readable - the
  // scale, the exclusions, and which shown rows have no score - built from
  // `RATING_POLICY` rather than restating its numbers here.
  //
  // It is printed with the exact scope the report was folded over, because a
  // scoped rating is not the rating of the pair: the anchor moves to the newest
  // step that is still in scope, so dropping old evidence changes the answer
  // rather than just trimming the input.
  const sinceMs = Number.isFinite(options.sinceMs) ? options.sinceMs : null
  if (sinceMs !== null) {
    lines.push(
      `scope: steps at or after ${new Date(sinceMs).toISOString()}; every figure above, ` +
        'the rating included, uses that scope only.',
    )
  }
  if (rows.length > 0) lines.push(ratingLine(rows, view, now))
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
  // Every line that names a winner comes out of one place, so none of them can
  // be written without its denominator: see `WINNER_LINES` for the four labels,
  // the figure each one reads and the floor they share.
  lines.push(...winnerLines(summaryRows))
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

/**
 * The rating cell: one decimal, `~` when the score is provisional, `*` when the
 * evidence it rests on has aged out, `-` when there is no score.
 *
 * The marker is a single character on purpose. Which rows are thin is spelled
 * out once in the block below the table, and repeating a word in fifteen cells
 * would push the figures a reader compares out of alignment for a fact that is
 * identical across them. The reason a row has no score is never in the cell: a
 * dash is a dash, and `ratingLine` counts the reasons.
 *
 * The marks lead the figure, which is that same alignment argument taken one
 * step further: this column is padded from the left (`padStart`), so a glyph
 * printed after the number shifts the digits of exactly the rows that carry one —
 * and those are the rows a reader is comparing against the unmarked ones. In
 * front, the digits end in the same column on every row, and the `~` reads as a
 * prefix to the score it qualifies. The panel prints the same order for the same
 * reason (`client.js`, the rating cell), so one score is not shown two ways.
 *
 * `now` comes from the caller rather than from `Date.now()` here, so a test can
 * freeze the clock the `*` is measured against; see `anchorIsStale`.
 */
function ratingCell(row, now = Date.now()) {
  const rating = row.rating
  if (rating === null || rating === undefined) return '-'
  if (typeof rating.score !== 'number' || !Number.isFinite(rating.score)) return '-'
  return `${rating.provisional === true ? '~' : ''}${anchorIsStale(rating, now) ? '*' : ''}${rating.score.toFixed(1)}`
}

/**
 * How old a published score's newest usable measurement may be before both
 * surfaces call it stale.
 *
 * The half-life *is* the threshold rather than a second policy: §4.2 of the guide
 * says a dormant pair keeps its historical rating and receives a stale-data note
 * when its newest rated measurement is older than 30 days, and 30 days is exactly
 * `RATING_POLICY.halfLifeDays`. Taking it from the policy means a formula version
 * that changes the half-life moves the note with it instead of leaving a literal
 * behind; the panel restates the same number because it cannot import this module
 * (`RATING_STALE_MS` in `client.js`), and both surfaces mark the same row.
 */
const RATING_STALE_MS = RATING_POLICY.halfLifeDays * RATING_POLICY.msPerDay

/**
 * Whether one row's rating stands on evidence older than {@link RATING_STALE_MS}.
 *
 * Age is not a correction: no freshness multiplier touches the score (the weight
 * already decays it against the pair's own anchor), so this decides a *mark* and
 * nothing else. A rating with no finite `anchor` — no score, or a fold from
 * before the field existed — is not stale, because there is no age to claim.
 *
 * The comparison is strict: exactly 30 days old is not yet over 30 days, which is
 * the same boundary the panel draws, so the two surfaces cannot disagree about
 * the row that sits on it.
 */
function anchorIsStale(rating, now) {
  return Number.isFinite(rating?.anchor) && now - rating.anchor > RATING_STALE_MS
}

/**
 * One bounded line explaining the rating column for the rows actually shown.
 *
 * Bounded because the reader is a model and the report is a table: the reasons
 * are counted, not narrated, and provisional names are capped with a count of
 * the rest. The scale itself comes from `RATING_POLICY`, so a formula version
 * that changes a weight changes this sentence with it.
 */
function ratingLine(rows, view, now = Date.now()) {
  const rated = rows.filter((row) => typeof row.rating?.score === 'number')
  const provisional = rated.filter((row) => row.rating.provisional === true)
  // The one thing the tables cannot say by themselves: two rows can print the
  // same `72.2` while one was measured an hour ago and the other a year ago, and
  // the score is historical in both cases — the age is a caveat on the answer, not
  // a re-reading of it. Named, capped and counted like the provisional rows, for
  // the same reason: the reader is a model and the report is a table.
  const stale = rated.filter((row) => anchorIsStale(row.rating, now))
  const reasons = new Map()
  for (const row of rows) {
    if (typeof row.rating?.score === 'number') continue
    const reason = row.rating?.reason ?? 'no_samples'
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
  }
  const parts = [
    `rating ${RATING_POLICY.version} (0-100): ` +
      `${Math.round(RATING_POLICY.weightThroughput * 100)}% streaming throughput, ` +
      `${Math.round(RATING_POLICY.weightLatency * 100)}% median first token, ` +
      `${Math.round(RATING_POLICY.weightTail * 100)}% slow (p90) first token; ` +
      `weights halve every ${RATING_POLICY.halfLifeDays} days from the pair's newest usable step, ` +
      `retried and interrupted steps are excluded, and a score needs ` +
      `${RATING_POLICY.minQualifiedSamples} qualified and ` +
      `${RATING_POLICY.minEffectiveSamples} effective samples. ` +
      `${rated.length} of ${rows.length} shown row(s) rated; no score: ` +
      (reasons.size === 0
        ? 'none'
        : [...reasons]
            .map(([reason, count]) => `${reason} ${count}`)
            .join(', ')) +
      '.',
  ]
  if (provisional.length > 0) {
    const shown = provisional.slice(0, 6).map((row) => labelOf(row, view))
    const thin =
      `fewer than ${RATING_POLICY.provisionalEffectiveSamples} effective samples ` +
      `or fewer than ${RATING_POLICY.provisionalSessions} sessions`
    parts.push(
      `provisional (${provisional.length}, marked ~: ${thin}): ${shown.join(', ')}` +
        (provisional.length > shown.length ? `, +${provisional.length - shown.length} more.` : '.'),
    )
  }
  if (stale.length > 0) {
    const shown = stale.slice(0, 6).map((row) => labelOf(row, view))
    parts.push(
      `stale (${stale.length}, marked *: the pair's newest usable measurement is over ` +
        `${RATING_POLICY.halfLifeDays} days old, so the score is historical and not ` +
        `recomputed from its age): ${shown.join(', ')}` +
        (stale.length > shown.length ? `, +${stale.length - shown.length} more.` : '.'),
    )
  }
  return parts.join(' ')
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

/**
 * The floor a winner line may be picked on without a caveat, and the one
 * helper through which all four winner lines are picked.
 *
 * A median from one or two steps is a coin toss wearing a confident number.
 * The `fastest end to end` line learned this the hard way — a one-step model
 * topped it — and gated on 20 samples, but the same reasoning applies to every
 * line that names a winner, and `fastest first token` and `fastest median
 * decode` did not apply it: a line could name a model with one step, and
 * nothing on the line said the pick rested on one step. The floor is defined
 * once, here, next to the helper that enforces it, because an ad hoc gate
 * applied in one place and remembered in none is how the next winner line gets
 * born unguarded.
 *
 * The value is 20 because that is the gate the e2e line already shipped with,
 * chosen after the failure that put it there: a one-step model topped it. The
 * retry block is not a second precedent — it orders by `retryEvents` and prints
 * the rate beside the count, and sets no sample floor; its comment argues the
 * other way, that a rate taken from five steps is not evidence of anything.
 * Exported so a test asserts the wording against the number rather than
 * hardcoding it.
 */
export const MIN_WINNER_SAMPLES = 20

/**
 * Pick the winner of a summary line over the rows carrying at least
 * `MIN_WINNER_SAMPLES` samples of the line's own figure.
 *
 * The gate is per figure, not per row: a row with 25 first-token samples is
 * still unqualified for the decode line if only three of those steps cleared
 * the speed floors, so `stat` is the `summarize()` field the line reads —
 * `'ttft'`, `'speedTps'`, `'e2eTps'` — and that statistic's own `count`
 * decides. The lines share the floor but not the qualified set.
 *
 * When no row reaches the floor the pick still happens, over every candidate:
 * the history the reader asked about is the history they get, and the honest
 * statement is not "no answer" but "this answer rests on fewer samples than
 * the floor". The e2e line used to go silent in exactly that case — a
 * suppression the reader could not tell apart from a model that simply was
 * not the fastest. The result carries the count it decided on, the rows that
 * cleared the floor and how many candidates there were, and `winnerNote()`
 * puts all of it on the line — a claim that hides its denominator invites the
 * reader to treat a two-step median as a settled one.
 */
function pickWinner(rows, stat, better) {
  const medianOf = (row) => row[stat]?.median
  const qualified = rows.filter(
    (row) => medianOf(row) != null && (row[stat]?.count ?? 0) >= MIN_WINNER_SAMPLES,
  )
  const meetsFloor = qualified.length > 0
  const winner = pick(meetsFloor ? qualified : rows, medianOf, better)
  if (winner === null) return null
  return {
    row: winner,
    qualified,
    meetsFloor,
    candidates: rows.length,
    samples: winner[stat]?.count ?? 0,
  }
}

/**
 * The denominator every winner line carries: the samples the pick decided on,
 * plus the caveat when it had to go under the floor or was alone above it.
 * "Fastest" of one trustworthy row among twelve candidates is a different
 * claim from "fastest" of twelve candidates, and the line is allowed to say
 * which one it is making.
 */
function winnerNote(win) {
  const caveat = !win.meetsFloor
    ? `, under the ${MIN_WINNER_SAMPLES}-sample floor`
    : win.qualified.length === 1 && win.candidates > 1
      ? ', the only row above the floor'
      : ''
  return ` — over ${win.samples} sample(s)${caveat}`
}

/**
 * The winner lines, declared once, and the only place one can be written.
 *
 * There are four of them and a fifth would be added here. Each was once its own
 * block of `if (win !== null) lines.push(label + figure + winnerNote(win))`, and
 * four blocks that cannot see each other is how the next line gets born without
 * its denominator: there was nowhere to *write* a winner line except the four
 * blocks, but nothing in them made the denominator part of the shape, so
 * dropping it looked like ordinary editing. As data the shape is the entry —
 * `figure` is handed the winning median and nothing else, so a line cannot reach
 * for a field its own gate did not qualify, and every entry is printed by the one
 * loop in `winnerLines()` below.
 *
 * `stat` is the `summarize()` field the line reads, and that statistic's own
 * count gates the pick (see `pickWinner`): the lines share a floor, not a
 * qualified set. `skipIfSameRowAs` is the one condition a line may carry — a
 * one-row history has one answer, and naming it as both the fastest and the
 * slowest first token says nothing twice. `tail` is everything printed after the
 * denominator, and only the e2e line has any: it ends its sentence and then
 * compares itself against the row that loses the most to prefill.
 */
export const WINNER_LINES = [
  {
    label: 'fastest first token',
    stat: 'ttft',
    better: (a, b) => a < b,
    figure: (median) => `${int(median)} ms`,
  },
  {
    label: 'slowest first token',
    stat: 'ttft',
    better: (a, b) => a > b,
    figure: (median) => `${int(median)} ms`,
    skipIfSameRowAs: 'fastest first token',
  },
  {
    label: 'fastest median decode',
    stat: 'speedTps',
    better: (a, b) => a > b,
    figure: (median) => `${dec(median)} tok/s`,
  },
  {
    label: 'fastest end to end',
    stat: 'e2eTps',
    better: (a, b) => a > b,
    figure: (median) => `${dec(median)} tok/s over the whole first answer`,
    tail: (win, ctx) => `.${prefillGap(win, ctx)}`,
  },
]

/**
 * Every winner line for this row set, in report order.
 *
 * The picks are made for the whole table before the first line is formatted, so
 * `skipIfSameRowAs` and the prefill clause can look at what the other lines
 * chose. `pickWinner` is pure and order-independent, which is what makes that
 * safe.
 */
function winnerLines(rows) {
  const picks = new Map(
    WINNER_LINES.map((line) => [line.label, pickWinner(rows, line.stat, line.better)]),
  )
  const out = []
  for (const line of WINNER_LINES) {
    const win = picks.get(line.label)
    if (win === null) continue
    if (line.skipIfSameRowAs !== undefined && win.row === picks.get(line.skipIfSameRowAs)?.row) continue
    out.push(
      `${line.label}: ${labelOf(win.row, 'model')} (${line.figure(win.row[line.stat]?.median)})` +
        winnerNote(win) +
        (line.tail === undefined ? '' : line.tail(win, { rows })),
    )
  }
  return out
}

/**
 * The `Most of the wait` clause of the e2e line: the row that keeps the smallest
 * share of its own streaming rate once the wait for the first token is counted
 * in. The stream rate and the end-to-end rate disagree often enough to be worth a
 * line of their own — a model that decodes fast but starts late looks good in
 * the first column and is not the fastest to use.
 *
 * What is specific to this line is the denominator of the *share*. The
 * comparison divides one median by another, so it may only compare rows from the
 * pool the winner was picked over: picking a winner under the floor while
 * comparing shares over the qualified ones (or the other way round) would name a
 * model that is not in its own denominator.
 */
function prefillGap(win, { rows }) {
  const pool = win.meetsFloor ? win.qualified : rows
  const worst = pool.reduce((worstGap, row) => {
    const stream = row.speedTps?.median
    if (!(stream > 0) || row.e2eTps?.median == null) return worstGap
    const share = row.e2eTps.median / stream
    return worstGap === null || share < worstGap.share ? { row, share } : worstGap
  }, null)
  return worst !== null && worst.row !== win.row
    ? ` Most of the wait before the first token: ${labelOf(worst.row, 'model')} — ` +
      `${(worst.share * 100).toFixed(0)}% of its stream rate survives the prefill.`
    : ''
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
