// Verify the pure technical rating before it touches the fold or the panel.
//
// Usage: node tools/verify-rating.mjs
//
// Synthetic samples with fixed timestamps, so every expected figure below is a
// number the guide fixed during planning rather than a snapshot of today's
// history. Ten behaviours are asserted (the stage-2 slice of the acceptance
// matrix in Plans/technical-rating-implementation-guide.md):
//
//   1. A route at all three anchors (100 tok/s, 5 s, 15 s) scores 50.
//   2. Faster delivery never lowers the score: doubled throughput and either
//      lowered latency quantile each raise it.
//   3. The all-fast fixture scores 72.23415362384071 and displays as 72.2.
//   4. Weights at ages 0 / 30 / 60 days are 1 : 0.5 : 0.25, and a sample older
//      than seven days still decides a quantile - there is no cutoff.
//   5. The score does not move when nothing about the pair's own samples
//      changes: same inputs, reordered inputs, a uniformly shifted clock, and a
//      different pair's samples all give byte-identical ratings. The anchor is
//      data-relative, so no wall clock can influence it.
//   6. A newer eligible measurement does move the anchor; a newer excluded one
//      cannot.
//   7. Fields the rating is not defined over - liveness, retry codes, errors,
//      price, quota, context, cache, token detail - cannot change a score.
//   8. Retried, interrupted and retryCount-missing samples are excluded, and the
//      exclusion counts and coverage reflect the overlap honestly.
//   9. Missing or nonfinite operands, a short span, too few tokens or fragments
//      produce no score - and never a NaN or an Infinity.
//  10. Nine qualified samples are unrated; ten publish as provisional; thirty
//      effective samples across three sessions clear provisional; unequal
//      weights can push nEffective back under the threshold.
//
// The remaining checks of the acceptance matrix are asserted where the wiring
// they need exists: null ordering and provider `pair_only` in
// `tools/verify-sort-order.mjs` (stage 3), the three collector paths and
// `sinceMs` scoping in `tools/verify-rating-paths.mjs` (stage 4), old-payload and
// older-host rendering in `tools/verify-panel-state.mjs` (stage 7). What is
// asserted for `pair_only` here is only the empty shape the fold publishes.
//
// The arithmetic is checked through the production entry point, and the two
// hand-computed oracles (50 at the anchors, 72.23415362384071 for the all-fast
// fixture) come from the guide. Nothing here imports the plugin, so a broken
// collector cannot hide a broken formula.

import { calculateRating, emptyRating, weightedQuantile, RATING_POLICY, RATING_REASONS } from '../lib/rating.js'
import { SPEED_QUALIFICATION } from '../lib/eligibility.js'
import { SPEED_QUALIFICATION as FOLD_SPEED_QUALIFICATION } from '../lib/fold.js'

const DAY = 86_400_000
// One fixed instant for the whole file: a deterministic fixture cannot drift.
const T0 = 1_700_000_000_000

let sampleSeq = 0
/**
 * One folded sample. Defaults are a fully qualified fast route at 100 tok/s, so
 * a test that cares about one field can override exactly that field.
 */
function sample(overrides = {}) {
  sampleSeq += 1
  return {
    sessionId: `session-${sampleSeq}`,
    time: T0,
    provider: 'provider-a',
    model: 'model-a',
    ttftMs: 1000,
    streamMs: 4000,
    streamTokens: 400, // 400 * 1000 / 4000 = 100 tok/s
    streamFragments: 20,
    interrupted: false,
    retryCount: 0,
    ...overrides,
  }
}

function repeat(count, overrides) {
  const out = []
  for (let index = 0; index < count; index += 1) out.push(sample(overrides))
  return out
}

const failures = []
let checks = 0
function check(name, condition, detail = '') {
  checks += 1
  if (!condition) failures.push(detail === '' ? name : `${name} - ${detail}`)
}
function near(actual, expected, tolerance) {
  return typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance
}
/** Collect every number in a contract object that is not finite, for check 9. */
function nonfinitePaths(value, path = 'rating', out = []) {
  if (value === null || value === undefined) return out
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) out.push(path)
    return out
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => nonfinitePaths(entry, `${path}[${index}]`, out))
    return out
  }
  if (typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) nonfinitePaths(entry, `${path}.${key}`, out)
  }
  return out
}

// --- Definition guards -------------------------------------------------------
// The policy is the single place a score's constants live, so it is read-only;
// the speed floors are a single definition too, owned by `lib/eligibility.js` and
// re-exported by the fold, so the check below is the one that fails if the
// re-export is ever replaced by a second copy.
try {
  RATING_POLICY.halfLifeDays = 1
} catch {
  // Frozen in module scope; a throw is fine too.
}
check('policy: halfLifeDays stays 30 when assigned', RATING_POLICY.halfLifeDays === 30)
check('policy: version is technical-v1', RATING_POLICY.version === 'technical-v1')
check(
  'policy: the fold re-exports the eligibility gates, not a second copy',
  SPEED_QUALIFICATION === FOLD_SPEED_QUALIFICATION &&
    JSON.stringify(SPEED_QUALIFICATION) === '{"minSpanMs":100,"minTokens":8,"minFragments":4}',
  `${JSON.stringify(SPEED_QUALIFICATION)} vs ${JSON.stringify(FOLD_SPEED_QUALIFICATION)}`,
)
check(
  'policy: reason codes are the published vocabulary',
  RATING_REASONS.length === 4 && RATING_REASONS.includes('pair_only'),
)

// The quantile is nearest-rank over weighted values: the answer is always one of
// the measured values, never an average of two. Interpolation would invent a
// latency no request produced.
// With three equal weights the cumulative weight crosses at 1, 2 and 3, so the
// answer is the 1st, 2nd and 3rd value respectively - an interpolating quantile
// would answer 1500 or 2100 somewhere in between.
const rankPoints = [
  { value: 1000, weight: 1 },
  { value: 2000, weight: 1 },
  { value: 3000, weight: 1 },
]
check(
  'quantile: nearest-rank, never interpolated',
  weightedQuantile(rankPoints, 0.33) === 1000 &&
    weightedQuantile(rankPoints, 0.5) === 2000 &&
    weightedQuantile(rankPoints, 1) === 3000,
  `${weightedQuantile(rankPoints, 0.33)}/${weightedQuantile(rankPoints, 0.5)}/${weightedQuantile(rankPoints, 1)}`,
)
check(
  'quantile: a zero weight contributes nothing',
  weightedQuantile(
    [
      { value: 10, weight: 0 },
      { value: 20, weight: 4 },
    ],
    0.5,
  ) === 20,
)
check('quantile: no positive weight is null, not zero', weightedQuantile([{ value: 1, weight: 0 }], 0.5) === null)

// --- 1. The scale anchors score 50 -----------------------------------------
// 17 samples at the 5 s median anchor and 3 at the 15 s tail anchor, all at the
// 100 tok/s anchor, all at the same timestamp (so all weights are equal).
const anchorSamples = [...repeat(17, { ttftMs: 5000 }), ...repeat(3, { ttftMs: 15_000 })]
const anchored = calculateRating(anchorSamples)
// 0.5^0.45 * 0.5^0.35 * 0.5^0.2 = 0.5, so the exact answer is 50; the double
// product lands 1.4e-14 above it, which the tolerance states honestly.
check('1. anchors: score is 50', near(anchored.score, 50, 1e-9), `score=${anchored.score}`)
check('1. anchors: T50 is the 5 s anchor', anchored.inputs.ttftMedianMs === 5000, `T50=${anchored.inputs.ttftMedianMs}`)
check('1. anchors: T90 is the 15 s anchor', anchored.inputs.ttftP90Ms === 15_000, `T90=${anchored.inputs.ttftP90Ms}`)
check('1. anchors: V50 is the 100 tok/s anchor', anchored.inputs.tpsMedian === 100, `V50=${anchored.inputs.tpsMedian}`)
check(
  '1. anchors: every component is exactly 0.5',
  anchored.components.throughput === 0.5 &&
    anchored.components.latency === 0.5 &&
    anchored.components.tailLatency === 0.5,
  JSON.stringify(anchored.components),
)
check('1. anchors: 20 qualified samples publish', anchored.qualifiedSamples === 20 && anchored.reason === null)
check('1. anchors: 20 effective but few sessions is provisional', anchored.provisional === true)

// --- 2. Monotonic: faster never scores lower --------------------------------
const fasterThroughput = calculateRating(anchorSamples.map((entry) => ({ ...entry, streamTokens: 800 })))
const lowerMedian = calculateRating(
  anchorSamples.map((entry) => (entry.ttftMs === 5000 ? { ...entry, ttftMs: 4000 } : entry)),
)
const lowerTail = calculateRating(
  anchorSamples.map((entry) => (entry.ttftMs === 15_000 ? { ...entry, ttftMs: 8000 } : entry)),
)
check(
  '2. doubled throughput raises the score',
  fasterThroughput.score > anchored.score,
  `${fasterThroughput.score} <= ${anchored.score}`,
)
check(
  '2. lowered T50 raises the score',
  lowerMedian.score > anchored.score && lowerMedian.inputs.ttftMedianMs === 4000,
  `${lowerMedian.score} <= ${anchored.score}`,
)
check(
  '2. lowered T90 raises the score',
  lowerTail.score > anchored.score && lowerTail.inputs.ttftP90Ms === 8000,
  `${lowerTail.score} <= ${anchored.score}`,
)

// --- 3. The planning fixture ------------------------------------------------
// 200 tok/s (800 tokens over 4 s), 2000 ms ttft, 20 samples, equal timestamps.
const allFast = repeat(20, { ttftMs: 2000, streamMs: 4000, streamTokens: 800 })
const fastRating = calculateRating(allFast)
check(
  '3. all-fast fixture score is 72.23415362384071',
  near(fastRating.score, 72.23415362384071, 1e-10),
  `score=${fastRating.score}`,
)
check(
  '3. all-fast fixture displays as 72.2',
  Math.round(fastRating.score * 10) / 10 === 72.2,
  `${Math.round(fastRating.score * 10) / 10}`,
)
check('3. equal timestamps are 20 effective samples', fastRating.effectiveSamples === 20, `${fastRating.effectiveSamples}`)

// --- 4. Recency weighting, and no seven-day cutoff --------------------------
// Three samples at ages 0 / 30 / 60 days: weights 1 : 0.5 : 0.25. nEffective is
// the observable that proves the ratio: (1+0.5+0.25)^2 / (1+0.25+0.0625) = 7/3.
const ageRatio = calculateRating([
  sample({ time: T0 }),
  sample({ time: T0 - 30 * DAY }),
  sample({ time: T0 - 60 * DAY }),
])
check(
  '4. ages 0/30/60 give weights 1 : 0.5 : 0.25',
  near(ageRatio.effectiveSamples, 7 / 3, 1e-12),
  `nEffective=${ageRatio.effectiveSamples}`,
)
check('4. the anchor is the newest usable sample', ageRatio.anchor === T0, `anchor=${ageRatio.anchor}`)
// Now a distribution where the 90th percentile lands on a 30-day-old sample: ten
// fresh samples at 1000 ms carry weight 10, then two at 2000 ms aged 30 days
// (0.5 each) and one at 3000 ms aged 60 days (0.25). Total 11.25, and the 0.9
// threshold is 10.125, past the ten fresh samples (10.0). A seven-day cutoff
// would drop the old samples and report T90 = 1000.
const tailFromOld = calculateRating([
  ...repeat(10, { ttftMs: 1000 }),
  sample({ time: T0 - 30 * DAY, ttftMs: 2000 }),
  sample({ time: T0 - 30 * DAY, ttftMs: 2000 }),
  sample({ time: T0 - 60 * DAY, ttftMs: 3000 }),
])
check(
  '4. a 30-day-old sample still decides T90',
  tailFromOld.inputs.ttftP90Ms === 2000,
  `T90=${tailFromOld.inputs.ttftP90Ms}`,
)
check(
  '4. that row still publishes (13 qualified, nEffective 11.98)',
  tailFromOld.qualifiedSamples === 13 &&
    near(tailFromOld.effectiveSamples, 11.982248520710058, 1e-12) &&
    tailFromOld.score !== null,
  `qualified=${tailFromOld.qualifiedSamples} nEff=${tailFromOld.effectiveSamples} score=${tailFromOld.score}`,
)

// --- 5. Invariance to everything but the pair's own samples -----------------
const ten = repeat(10)
const tenRating = calculateRating(ten)
check(
  '5. the same samples give a byte-identical rating',
  JSON.stringify(calculateRating(ten)) === JSON.stringify(tenRating),
)
check(
  '5. sample order does not change the rating',
  JSON.stringify(calculateRating([...ten].reverse())) === JSON.stringify(tenRating),
)
// A uniformly shifted clock moves the anchor with the data, so a display-clock
// change cannot move the score. (The function has no clock at all; this is what
// proves the anchor is relative rather than "now".) The anchor itself is a
// timestamp and does shift; every other field must not.
const shifted = ten.map((entry) => ({ ...entry, time: entry.time + 90 * DAY }))
const shiftedRating = calculateRating(shifted)
const withoutAnchor = (rating) => {
  const { anchor: _anchor, ...rest } = rating
  return rest
}
check(
  '5. shifting every timestamp equally does not change the rating',
  JSON.stringify(withoutAnchor(shiftedRating)) === JSON.stringify(withoutAnchor(tenRating)) &&
    shiftedRating.anchor === tenRating.anchor + 90 * DAY,
  `anchor=${shiftedRating.anchor}`,
)
check(
  '5. another pair is rated independently',
  JSON.stringify(
    calculateRating([
      sample({ provider: 'provider-b', model: 'model-b', ttftMs: 5000, streamTokens: 100 }),
    ]),
  ) !== JSON.stringify(tenRating) && JSON.stringify(calculateRating(ten)) === JSON.stringify(tenRating),
)

// --- 6. A newer measurement moves the anchor only when it qualifies ----------
const newerEligible = calculateRating([...ten, sample({ time: T0 + 30 * DAY, ttftMs: 3000 })])
check(
  '6. a newer eligible sample advances the anchor',
  newerEligible.anchor === T0 + 30 * DAY,
  `anchor=${newerEligible.anchor}`,
)
check(
  '6. a newer eligible sample changes the weights and the score',
  newerEligible.effectiveSamples !== tenRating.effectiveSamples &&
    newerEligible.score !== tenRating.score,
  `nEff=${newerEligible.effectiveSamples} score=${newerEligible.score}`,
)
for (const [label, overrides] of [
  ['retried', { retryCount: 1 }],
  ['interrupted', { interrupted: true }],
  ['retryCount missing', { retryCount: undefined }],
]) {
  const withExcludedNewer = calculateRating([...ten, sample({ time: T0 + 30 * DAY, ttftMs: 3000, ...overrides })])
  check(
    `6. a newer ${label} sample cannot move the anchor`,
    withExcludedNewer.anchor === tenRating.anchor && withExcludedNewer.score === tenRating.score,
    `anchor=${withExcludedNewer.anchor} score=${withExcludedNewer.score}`,
  )
  check(
    `6. a newer ${label} sample is not qualified`,
    withExcludedNewer.qualifiedSamples === tenRating.qualifiedSamples &&
      withExcludedNewer.answeredSamples === tenRating.answeredSamples + 1,
  )
}

// --- 7. Non-rating fields cannot change a score -----------------------------
const foreignFields = {
  livenessRank: 0,
  liveStatus: 'ok',
  retryCodes: ['RATE_LIMIT', 'TIMEOUT'],
  retryBackoffMs: 9000,
  retryDeadMs: 9000,
  retryFailedSteps: 3,
  errorCount: 17,
  toolErrors: 5,
  modelErrors: 2,
  priceUsdPerMTok: 0.28,
  quotaRemaining: 1234,
  contextWindow: 1_000_000,
  cacheReadTokens: 999,
  cacheWriteTokens: 42,
  inputTokens: 5000,
  outputTokens: 9999,
  reasoningTokens: 512,
  llmMs: 12_345,
  decodeMs: 6789,
  e2eTps: 44.4,
  speedConfidence: 0.13,
  taskProfile: 'coding',
}
const withForeign = calculateRating(ten.map((entry) => ({ ...entry, ...foreignFields })))
check(
  '7. liveness, errors, price, quota, context and cache cannot change a score',
  JSON.stringify(withForeign) === JSON.stringify(tenRating),
)
const renamed = calculateRating(ten.map((entry) => ({ ...entry, provider: 'z', model: 'y' })))
check('7. identity labels are not rating inputs', JSON.stringify(renamed) === JSON.stringify(tenRating))

// --- 8. Exclusions and coverage ---------------------------------------------
const mixed = [
  ...repeat(10),
  sample({ retryCount: 2 }),
  sample({ interrupted: true }),
  sample({ retryCount: 3, interrupted: true }),
  sample({ retryCount: undefined }),
  sample({ streamMs: 99 }),
]
const mixedRating = calculateRating(mixed)
check(
  '8. ten of fifteen samples qualify',
  mixedRating.qualifiedSamples === 10 && mixedRating.answeredSamples === 15,
  `qualified=${mixedRating.qualifiedSamples} answered=${mixedRating.answeredSamples}`,
)
check(
  '8. the exclusion counts overlap rather than partition',
  mixedRating.excludedRetried === 2 && mixedRating.excludedInterrupted === 2,
  `retried=${mixedRating.excludedRetried} interrupted=${mixedRating.excludedInterrupted}`,
)
check(
  '8. coverage is qualified over answered',
  near(mixedRating.coverage, 10 / 15, 1e-15),
  `coverage=${mixedRating.coverage}`,
)
// A missing retryCount is excluded but is not a *retry*: the count stays zero.
const missingRetryOnly = calculateRating([...repeat(9), sample({ retryCount: undefined })])
check(
  '8. a missing retryCount is excluded, not counted as retried',
  missingRetryOnly.qualifiedSamples === 9 &&
    missingRetryOnly.excludedRetried === 0 &&
    missingRetryOnly.excludedInterrupted === 0 &&
    missingRetryOnly.score === null &&
    missingRetryOnly.reason === 'insufficient_samples',
  JSON.stringify({
    qualified: missingRetryOnly.qualifiedSamples,
    retried: missingRetryOnly.excludedRetried,
    reason: missingRetryOnly.reason,
  }),
)

// --- 9. Nothing to rate, and never a NaN ------------------------------------
const unusable = [
  sample({ streamTokens: null }),
  sample({ streamTokens: NaN }),
  sample({ streamMs: Infinity }),
  sample({ streamMs: 99 }),
  sample({ streamTokens: 7 }),
  sample({ streamFragments: 3 }),
  sample({ ttftMs: null }),
  sample({ ttftMs: -1 }),
  sample({ ttftMs: Infinity }),
  sample({ interrupted: true }),
  sample({ retryCount: 1 }),
  sample({ retryCount: undefined }),
  // A finite token count whose rate overflows to Infinity: the quotient, not the
  // operand, is what makes this unusable.
  sample({ streamTokens: 1e306, streamMs: 100 }),
]
const unusableRating = calculateRating(unusable)
check(
  '9. answered but nothing qualified is no_qualified_samples',
  unusableRating.reason === 'no_qualified_samples' &&
    unusableRating.score === null &&
    unusableRating.qualifiedSamples === 0 &&
    unusableRating.answeredSamples === 13 &&
    unusableRating.coverage === 0,
  JSON.stringify({
    reason: unusableRating.reason,
    qualified: unusableRating.qualifiedSamples,
    coverage: unusableRating.coverage,
  }),
)
check(
  '9. no qualified sample means no latency-only fallback',
  unusableRating.inputs.ttftMedianMs === null &&
    unusableRating.inputs.ttftP90Ms === null &&
    unusableRating.inputs.tpsMedian === null &&
    unusableRating.components.throughput === null &&
    unusableRating.components.latency === null,
)
const noSamples = calculateRating([])
check(
  '9. no samples at all is no_samples',
  noSamples.reason === 'no_samples' && noSamples.answeredSamples === 0 && noSamples.coverage === null,
)
check('9. a non-array input is no_samples', calculateRating(null).reason === 'no_samples')
check(
  '9. usage missing everywhere cannot produce a score',
  calculateRating(repeat(12, { streamTokens: null })).score === null,
)
const noNonfinite = [
  nonfinitePaths(anchored),
  nonfinitePaths(fastRating),
  nonfinitePaths(ageRatio),
  nonfinitePaths(mixedRating),
  nonfinitePaths(unusableRating),
  nonfinitePaths(noSamples),
].flat()
check('9. no rating carries a nonfinite number', noNonfinite.length === 0, noNonfinite.join(', '))
check(
  '9. serialized ratings contain no NaN or Infinity',
  ![anchored, fastRating, ageRatio, mixedRating, unusableRating, noSamples].some((rating) =>
    /NaN|Infinity/.test(JSON.stringify(rating)),
  ),
)

// --- 10. Publication thresholds ---------------------------------------------
const nine = calculateRating(repeat(9))
check(
  '10. nine qualified samples are unrated',
  nine.qualifiedSamples === 9 && nine.score === null && nine.reason === 'insufficient_samples',
  `score=${nine.score} reason=${nine.reason}`,
)
const tenAgain = calculateRating(repeat(10))
check(
  '10. ten equal-weight samples publish',
  near(tenAgain.score, 67.7980684519145, 1e-10) && tenAgain.reason === null,
  `score=${tenAgain.score}`,
)
// `repeat` gives every sample its own session by default; one shared session is
// what puts the session count at 1 here.
const oneSession = calculateRating(repeat(10, { sessionId: 'session-one' }))
check(
  '10. ten effective samples across one session are provisional',
  oneSession.effectiveSamples === 10 && oneSession.sessions === 1 && oneSession.provisional === true,
  `nEff=${oneSession.effectiveSamples} sessions=${oneSession.sessions}`,
)
const spread = []
for (let index = 0; index < 30; index += 1) spread.push(sample({ sessionId: `session-${index % 3}` }))
const cleared = calculateRating(spread)
check(
  '10. 30 effective samples across three sessions clear provisional',
  cleared.effectiveSamples === 30 && cleared.sessions === 3 && cleared.provisional === false,
  `nEff=${cleared.effectiveSamples} sessions=${cleared.sessions} provisional=${cleared.provisional}`,
)
const twoSessions = []
for (let index = 0; index < 30; index += 1) twoSessions.push(sample({ sessionId: `session-${index % 2}` }))
check(
  '10. two sessions keep a published score provisional',
  calculateRating(twoSessions).provisional === true,
)
const concentrated = [...repeat(9), sample({ time: T0 - 90 * DAY })]
const concentratedRating = calculateRating(concentrated)
check(
  '10. unequal weights push nEffective below the threshold',
  concentratedRating.qualifiedSamples === 10 &&
    near(concentratedRating.effectiveSamples, 9.235701906412478, 1e-12) &&
    concentratedRating.score === null &&
    concentratedRating.reason === 'insufficient_samples',
  `nEff=${concentratedRating.effectiveSamples} score=${concentratedRating.score}`,
)

// --- Empty-shaped rows ------------------------------------------------------
const pairOnly = emptyRating('pair_only')
check(
  'empty: a provider row is pair_only with dashes',
  pairOnly.reason === 'pair_only' &&
    pairOnly.score === null &&
    pairOnly.answeredSamples === 0 &&
    pairOnly.coverage === null &&
    pairOnly.effectiveSamples === null &&
    pairOnly.anchor === null &&
    pairOnly.inputs.tpsMedian === null &&
    pairOnly.components.tailLatency === null,
  JSON.stringify(pairOnly),
)
check('empty: the default reason is no_samples', emptyRating().reason === 'no_samples')
check('empty: an unknown code degrades to no_samples', emptyRating('nonsense').reason === 'no_samples')
check(
  'empty: the shape matches a calculated rating',
  JSON.stringify(Object.keys(emptyRating()).sort()) === JSON.stringify(Object.keys(tenRating).sort()) &&
    JSON.stringify(Object.keys(emptyRating().inputs).sort()) ===
      JSON.stringify(Object.keys(tenRating.inputs).sort()),
)
check(
  'empty: every reason used in this file is in the vocabulary',
  [
    anchored.reason,
    fastRating.reason,
    mixedRating.reason,
    unusableRating.reason,
    noSamples.reason,
    nine.reason,
    pairOnly.reason,
    emptyRating().reason,
  ].every((reason) => reason === null || RATING_REASONS.includes(reason)),
)

// --- Report -----------------------------------------------------------------
const summaryRow = (label, rating) => [
  label,
  rating.score,
  rating.inputs.tpsMedian,
  rating.inputs.ttftMedianMs,
  rating.inputs.ttftP90Ms,
  rating.effectiveSamples,
  rating.reason,
]
const summary = [
  summaryRow('anchors (20 samples)', anchored),
  summaryRow('all-fast (20 samples)', fastRating),
  summaryRow('ages 0/30/60 (3)', ageRatio),
  summaryRow('old tail (13)', tailFromOld),
  summaryRow('mixed exclusions (15)', mixedRating),
  summaryRow('ten qualified (10)', tenAgain),
  summaryRow('nine qualified (9)', nine),
  summaryRow('concentrated (10)', concentratedRating),
]
const show = (value, digits = 1) => (typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '-')
const padShow = (value, width, digits = 1) => show(value, digits).padStart(width)
console.log('rating case                 score    V50  T50ms  T90ms   nEff  reason')
for (const row of summary) {
  console.log(
    `${String(row[0]).padEnd(26)}${padShow(row[1], 7)}${padShow(row[2], 6)}` +
      `${padShow(row[3], 7, 0)}${padShow(row[4], 7, 0)}${padShow(row[5], 7)}  ${row[6] ?? '-'}`,
  )
}

console.log('')
if (failures.length === 0) {
  console.log(`OK: ${checks} assertions - anchors score 50, the planning fixture is 72.23415362384071,`)
  console.log('    old evidence still weighs in, and no unusable sample can produce a score or a NaN.')
} else {
  for (const failure of failures) console.log(`FAIL: ${failure}`)
  console.log('')
  console.log(`${failures.length} of ${checks} assertions failed.`)
  process.exitCode = 1
}
