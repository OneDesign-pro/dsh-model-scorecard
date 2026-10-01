// dsh-model-scorecard - what one probe result means.
//
// The status column is the panel's one column of words, and a word is a
// classification rather than a reading: `RATE_LIMIT` is a provider refusing on
// a limit whose fix is a pause, while `TIMEOUT` is nobody answering at all
// whose fix is a different route. That classification is needed in two places
// that must never disagree — the cell the reader looks at, and the order the
// rows are sorted in — so it is written once, here on the host, and travels to
// the panel as a field. Two copies of these rules would be two verdicts, and a
// row sorted as broken under a cell drawn as working is worse than no order at
// all.
//
// One thing deliberately does not come from here: `checking`. A probe in flight
// is a fact about the request this browser has open, not about the model, and it
// is the only state that changes while the panel sits still. It stays in the
// cell, and the order ignores it — a row keeps the rank of the answer that is
// actually in the store until the sweep replaces it.
//
// Pure: no I/O, no clock, no dependencies. `lib/fold.js` imports nothing and
// this is what its one non-historical order is built from.

/**
 * The provider codes that mean "the row was refused", and what each family is
 * about.
 *
 * `dsh-llm` publishes `code` as the machine-routable failure class and its own
 * docs say to route on it and never parse the message. That rule is about
 * routing — retry and backoff decide on a code that has to be stable — and the
 * codes are what decide the *state* here too. They are just not fine enough for
 * the word: the adapters spell an exhausted allowance and a momentary throttle
 * with the same `RATE_LIMIT`, because their classifier looks for quota wording
 * it recognises and quietly falls through to the status code for the rest. A
 * probe against a free tier answers `429` with "Daily free limit reached …
 * tokens used … resets at 00:00 UTC", `dsh-llm` calls that `RATE_LIMIT`, and a
 * panel that answered "слишком часто" was contradicting the operator with the
 * operator's own words in the very next line.
 *
 * A refused row is answering. "Too many requests", "no such model" and "the
 * check timed out" were all red before, so a reader seeing red switched models
 * — the one move that cannot help in any of the first three cases. What the
 * words name is whose move it is: the account (amber), the configuration (a
 * square), or the provider (solid red).
 */
const RATE_LIMIT_CODES = new Set(['RATE_LIMIT', 'TOO_MANY_REQUESTS', 'HTTP_429'])
const QUOTA_CODES = new Set(['QUOTA', 'ACCOUNT_QUOTA', 'INSUFFICIENT_QUOTA', 'HTTP_402'])
const LIMIT_CODES = new Set([...RATE_LIMIT_CODES, ...QUOTA_CODES])
// The provider answered and would not accept the credential: the fix is a key.
const ACCESS_CODES = new Set([
  'AUTH', 'UNAUTHORIZED', 'FORBIDDEN', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL',
  'NO_KEY', 'HTTP_401', 'HTTP_403',
])
// No route was ever wired: the fix is the provider's configuration.
const ROUTE_CODES = new Set(['NO_ROUTE', 'NO_ADAPTER', 'NO_BASE_URL', 'UNSUPPORTED_API'])
// The route is there and does not know this model: the fix is the model list.
const MODEL_CODES = new Set(['UNKNOWN_MODEL', 'NOT_FOUND', 'MODEL_NOT_FOUND', 'HTTP_404'])
// A request the provider rejected without saying why — which is also how a
// `400`/`404` for a model that does not exist arrives from some providers, so
// this one family reads the message before it settles for "unavailable".
const VAGUE_CODES = new Set(['INVALID_REQUEST', 'HTTP_400'])
const CONFIG_CODES = new Set([...ACCESS_CODES, ...ROUTE_CODES, ...MODEL_CODES])

/**
 * The provider's own words, for the questions the code cannot answer: is this
 * refusal momentary or has the allowance run out, and is this rejected request
 * about a model that is simply not there?
 *
 * Read as evidence and never as an instruction, and only ever to choose between
 * words — a miss costs nothing but a coarser label, because every branch falls
 * back to the code. `dsh-llm` ships the same idea as `isQuotaExceededError`,
 * with its own list of wordings; these are supersets of the phrasings seen in
 * the wild, because a label that contradicts the message next to it is worse
 * than a coarse one.
 *
 * The message is truncated to 300 characters on the way into the store, and
 * every signal below sits near the front, where the code, type and message are.
 */
// A promise of a retry in seconds, or a per-minute budget: momentary, whatever
// else the message says.
const SHORT_RETRY =
  /retry[\s_-]*after|try[\s_-]+again[\s_-]+(?:in|after)[\s_-]+\d+(?:[.,]\d+)?[\s_-]*(?:ms|s\b|sec|seconds|min|minutes|hour)|per[\s_-]+(?:min(?:ute)?s?\b|sec(?:ond)?s?\b|hour)/i
// An allowance that is gone: `limit reached`, `quota exceeded`, `tokens used`,
// `remaining: 0`, `insufficient balance`. A day or a month long, so it is the
// one an impatient reader cannot wait out.
const SPENT_ALLOWANCE =
  /insufficient[\s_-]+(?:quota|balance|credits?)|(?:quota|limit|allowance|budget)[\s_-]+(?:exceeded|exhausted|reached|used)|tokens?[\s_-]+used|remaining["'\s:=]*0|credits?[\s_-]+(?:exhausted|depleted|used)|out[\s_-]+of[\s_-]+(?:credits?|budget)/i
// An account that has to be paid before it answers again, arriving as the same
// `429` a momentary throttle does: "free models are for active keys … the last
// top-up on this key was 2026-09-21, which is more than 7 days ago. Top it up
// to use free models again". Waiting is not the fix the provider named, so it
// belongs with the spent allowance rather than the throttle. A dormant or
// expired key is here for the same reason — it is a fact about the account that
// came back under a limit's code, and the code is what keeps the circle amber;
// only the word is being chosen here.
const TOP_UP =
  /\btop[\s_-]*(?:it[\s_-]*)?(?:up|ped)|recharge|(?:add|buy|purchase)[\s_-]+(?:credits?|funds?|balance)|(?:credit|balance)[\s_-]+(?:is[\s_-]+(?:too[\s_-]+low|empty|exhausted|expired)|too[\s_-]+low)|(?:expired|inactive|dormant)[\s_-]+(?:key|account|subscription)|key[\s_-]+(?:is[\s_-]+)?(?:expired|inactive|dormant)|for[\s_-]+active[\s_-]+keys?/i
// The provider saying the model is not there at all: `model_not_found`, "does
// not exist", "has no configured model", "is not available". Deliberately not
// "temporarily unavailable", which is a provider having a bad day.
const NO_SUCH_MODEL =
  /model[\s_-]+not[\s_-]+found|does[\s_-]+not[\s_-]+exist|no[\s_-]+such[\s_-]+model|has[\s_-]+no[\s_-]+configured[\s_-]+model|is[\s_-]+not[\s_-]+available|unknown[\s_-]+model/i

/**
 * What a failed probe was refused for, as a state and the limit it names, or
 * `null` when it failed for a reason that is not a refusal at all.
 *
 * The gate is that *every* code the row recorded belongs to the family: a
 * provider roll-up whose models failed for different reasons is down, not
 * misconfigured, and only a row that is entirely about one thing may wear that
 * thing's circle. Order matters twice over — amber needs the whole row to be a
 * limit, so a limit mixed with anything else is not painted as an account
 * problem; and when a configuration mixture happens anyway, the route outranks
 * the model, because a missing route makes the model question moot.
 *
 * The word is then: an explicit quota code, or failing that the provider's own
 * prose, with a top-up outranking a short retry and the short retry outranking
 * the rest — "try again in 1.2s" is a throttle even when the sentence also says
 * "limit reached", and "top it up" is neither, because no pause ends it.
 * Nothing said, and a bare `RATE_LIMIT` stays the throttle it is named after.
 */
export function refusalOf(probe) {
  const codes = Array.isArray(probe?.codes)
    ? probe.codes
    : typeof probe?.code === 'string'
      ? [probe.code]
      : []
  if (codes.length === 0) return null
  const named = codes.map((code) => String(code).toUpperCase())
  const every = (set) => named.every((code) => set.has(code))
  const some = (set) => named.some((code) => set.has(code))
  const words = typeof probe?.error === 'string' ? probe.error : ''

  if (every(LIMIT_CODES)) {
    if (some(QUOTA_CODES)) return { state: 'limited', limit: 'quota' }
    if (TOP_UP.test(words)) return { state: 'limited', limit: 'quota' }
    if (SHORT_RETRY.test(words)) return { state: 'limited', limit: 'rate' }
    return { state: 'limited', limit: SPENT_ALLOWANCE.test(words) ? 'quota' : 'rate' }
  }
  if (every(VAGUE_CODES) && NO_SUCH_MODEL.test(words)) {
    return { state: 'missing', limit: null }
  }
  if (!every(CONFIG_CODES)) return null
  if (some(ROUTE_CODES)) return { state: 'missing', limit: null }
  if (some(MODEL_CODES)) return { state: 'missing', limit: null }
  return { state: 'denied', limit: null }
}

/**
 * What one probe said, as the panel's own state vocabulary.
 *
 * `unknown` is not a verdict but an absence — no probe has ever answered for
 * this pair — and it is deliberately not a rank, because "never checked" is not
 * the worst thing that can be true of a row.
 */
export function probeState(probe) {
  const status = typeof probe?.status === 'string' ? probe.status : null
  if (status === null) return 'unknown'
  if (status === 'ok') return 'up'
  const refusal = refusalOf(probe)
  return refusal === null ? 'down' : refusal.state
}

/**
 * The state the row *reads* as, which is the probe's state overruled by history
 * when history is the newer of the two.
 *
 * A failed probe is a fact about a moment, and a model that answered after that
 * moment is not down: the check is older than the evidence. This covers a limit
 * as much as a timeout — a model that answered after a 429 is throttled no
 * longer — and it is the one rule that makes a sorted status column safe to
 * read: a green "from history" row and a red one are the same kind of claim, so
 * they have to sort as the cell draws them.
 */
export function rowState(probe, lastSeen) {
  const state = probeState(probe)
  if (state === 'up' || state === 'unknown') return state
  const checkedAt = Number.isFinite(probe?.checkedAt) ? probe.checkedAt : null
  if (checkedAt === null || !Number.isFinite(lastSeen) || lastSeen <= checkedAt) return state
  return 'up'
}

/**
 * How loudly each state shouts, which is the order rows are put in.
 *
 * Higher is worse, and the default direction is descending, so the table opens
 * on what is broken: the square first (a row that cannot be run at all, and
 * cannot be made to run by waiting — a key and a route stay wrong until someone
 * edits a file), then a provider that did not answer, then an account that is
 * out of allowance, and available models at the bottom where the eye leaves
 * them. It is the same hierarchy the column draws: a filled red square is more
 * ink than the filled circle, and amber is a warning rather than a failure.
 *
 * `denied` and `missing` share a rank on purpose — they are drawn as the same
 * square, the same alarm, and the same fix on this side of the wire. The rows
 * behind them are separated by the tie-break, not by a severity the column
 * itself never claimed.
 */
export const STATUS_RANK = { up: 0, limited: 1, down: 2, missing: 3, denied: 3 }

/**
 * The rank of one row, or `null` when no probe has ever answered for it.
 *
 * `null` rather than a number is what keeps an unchecked row out of the ranking
 * entirely: the comparator holds an unmeasured figure at the bottom in *both*
 * directions, so reversing the order still ends with "not checked" instead of
 * promoting the absence to "worst".
 */
export function statusRank(probe, lastSeen) {
  const rank = STATUS_RANK[rowState(probe, lastSeen)]
  return rank === undefined ? null : rank
}

/**
 * One provider's status, as the panel shows a provider row: a roll-up, not a
 * join, because a provider row has no model of its own.
 *
 * `ok` wins over `fail` — one live model makes the provider reachable, and that
 * is the fact a reader acts on — and a provider with nothing probed is unknown
 * rather than broken. The failure codes travel so a reader can tell "the
 * provider is broken" from "the account was refused", and the fastest answering
 * model is the provider's own latency, because "which provider should I use" is
 * answered by the best route it offers, not by an average of one that works and
 * three that do not.
 */
export function rollUp(results, provider) {
  const mine = results.filter((entry) => entry.provider === provider)
  if (mine.length === 0) return null
  const ok = mine.filter((entry) => entry.status === 'ok')
  const failed = mine.filter((entry) => entry.status !== 'ok')
  const fastest = ok.reduce(
    (best, entry) =>
      Number.isFinite(entry.latencyMs) && (best === null || entry.latencyMs < best)
        ? entry.latencyMs
        : best,
    null,
  )
  const newest = mine.reduce(
    (latest, entry) => (Number.isFinite(entry.checkedAt) && entry.checkedAt > latest ? entry.checkedAt : latest),
    0,
  )
  // The most recent failure's own words, so a roll-up chooses between "out of
  // quota" and "throttled" from the same sentence its models were read from and
  // cannot word itself differently from the rows it summarises.
  const lastWord = failed.reduce(
    (latest, entry) => (latest === null || (entry.checkedAt ?? 0) >= (latest.checkedAt ?? 0) ? entry : latest),
    null,
  )
  const probe = {
    provider,
    model: null,
    status: ok.length > 0 ? 'ok' : 'fail',
    counts: { ok: ok.length, fail: failed.length, total: mine.length },
    // The failure classes, so a reader can tell "the provider is broken" from
    // "the account was refused": a roll-up has one word for a whole provider,
    // and for a provider whose every model hit the same quota that word is not
    // "unavailable". What the codes mean for the circle is the caller's.
    codes: [...new Set(failed.map((entry) => entry.code).filter((code) => typeof code === 'string'))],
    error: typeof lastWord?.error === 'string' ? lastWord.error : null,
    latencyMs: fastest,
    checkedAt: newest > 0 ? newest : null,
    source: ok.length > 0 ? ok[0].source : failed[0].source,
    rolledUp: true,
  }
  // The same field every other published result carries, so a provider row is
  // read by one rule rather than two.
  return { ...probe, state: probeState(probe) }
}

/**
 * The rank lookup the fold orders by, built once per panel request.
 *
 * A model row is looked up by `(provider, model)` and a provider row by its
 * provider alone, because that is the difference between the two views: one row
 * is one model's probe, the other is a roll-up of all of them. A pair the store
 * has never heard of is not in the map, and comes back `null` — the same answer
 * a row nobody ever checked gets.
 */
export function statusRanker(probeSnapshot) {
  const results = Array.isArray(probeSnapshot?.results) ? probeSnapshot.results : []
  const byKey = new Map(
    results.map((entry) => [`${entry.provider}\u0000${entry.model}`, entry]),
  )
  // One roll-up per provider, and only for providers that have something probed:
  // a provider whose whole catalog is unchecked has no roll-up to classify.
  const rollUps = new Map()
  for (const entry of results) {
    if (rollUps.has(entry.provider)) continue
    rollUps.set(entry.provider, rollUp(results, entry.provider))
  }
  return (provider, model, lastSeen) => {
    const probe =
      model === null || model === undefined
        ? rollUps.get(provider) ?? null
        : byKey.get(`${provider}\u0000${model}`) ?? null
    return probe === null ? null : statusRank(probe, lastSeen)
  }
}
