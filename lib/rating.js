// dsh-model-stats - the technical rating of one exact route.
//
// Input: the folded samples of a single `(provider, model)` pair. Output: a
// 0-100 figure describing how that route delivered in this installation, or an
// explained null. It is derived entirely from committed history - no I/O, no
// clock, no DSH import, no dependency - so the same log always produces the same
// score, and the verifier can fold a log without the plugin.
//
// What it is not: intelligence, correctness, answer quality, current
// reachability, price or context capacity. Those either have their own columns or
// have no authoritative source in this release, and folding them in would make
// one number that means five different things. A failed liveness probe is
// deliberately not an input: VPN state is the user's to control, so a route that
// cannot be reached right now keeps the score its history earned.
//
// Rating v1 (`technical-v1`) is three bounded utilities multiplied:
//
//   S = V50 / (V50 + 100)      generation throughput, half credit at 100 tok/s
//   L = 1 / (1 + T50 / 5000)   typical response, half credit at 5 s
//   P = 1 / (1 + T90 / 15000)  slow response, half credit at 15 s
//   rawScore = 100 * S^0.45 * L^0.35 * P^0.20
//
// Each factor is a saturating utility in (0, 1], so a route at all three anchors
// scores exactly 50, and the product is monotonic: faster delivery with the rest
// held fixed can never lower the score. The weights (45/35/20) and the three
// scale anchors are product choices, not fitted constants - they decide what
// "good" means here, and they are versioned so a later revision is a new formula
// rather than a silent drift of this one.
//
// Throughput is the *streaming* rate, not end-to-end tokens over the whole step:
// e2e contains the first-token wait, so scoring it would count that wait twice,
// once in `T50` and again in a deflated rate. `P` is an absolute tail utility
// rather than a p90/p50 ratio because a ratio rewards slowing an already-fast
// median - the table would show a worse route above a better one.

import { isSpeedQualified } from './eligibility.js'

/**
 * The complete, immutable definition of the formula. Exported so the collector,
 * the panel, the verification tools and the documentation all quote one object
 * instead of restating the numbers, and so a reader can see every constant that
 * decides a score in one place.
 */
export const RATING_POLICY = Object.freeze({
  /** Version namespace: a changed formula publishes under a new value. */
  version: 'technical-v1',
  msPerDay: 86_400_000,
  /**
   * Recency half-life. No cutoff: a measurement 30 days older than the pair's
   * newest usable one counts half, 60 days a quarter, and older than that
   * keeps decaying instead of disappearing. Measured history showed a fixed
   * seven-day window would discard most pairs' evidence entirely, which is why
   * the guide forbids a cutoff.
   */
  halfLifeDays: 30,
  throughputAnchorTps: 100,
  ttftMedianAnchorMs: 5000,
  ttftP90AnchorMs: 15_000,
  weightThroughput: 0.45,
  weightLatency: 0.35,
  weightTail: 0.2,
  /** Below this many qualified samples no score is published. */
  minQualifiedSamples: 10,
  /** Below this effective sample count no score is published. */
  minEffectiveSamples: 10,
  /** At or below this `nEffective`, a published score is marked provisional. */
  provisionalEffectiveSamples: 30,
  /** Fewer distinct sessions than this also marks a published score provisional. */
  provisionalSessions: 3,
})

/**
 * The reason vocabulary for a null score. Data carries one of these codes; the
 * UI owns the sentence, because the same code must read in Russian and English.
 */
export const RATING_REASONS = Object.freeze([
  'no_samples',
  'no_qualified_samples',
  'insufficient_samples',
  'pair_only',
])

/**
 * The weighted quantile v1 uses: sort ascending, then return the first value
 * whose cumulative positive weight reaches `q` of the total.
 *
 * Nearest-rank, deliberately not an interpolation: averaging two adjacent
 * samples would invent a latency no request produced, and v1 must be reproducible
 * from raw doubles. Ties carry equal values, so which of them crosses the
 * threshold cannot change the answer. A weight that underflowed to zero
 * contributes nothing - it can neither raise the total nor cross the threshold.
 *
 * @param {{value: number, weight: number}[]} points unsorted is fine; sorted here.
 * @returns {number|null} null when there is no positive weight to divide.
 */
export function weightedQuantile(points, quantile) {
  const list = Array.isArray(points) ? points : []
  if (list.length === 0) return null
  if (!Number.isFinite(quantile) || quantile <= 0 || quantile > 1) return null
  const sorted = list
    .filter(
      (point) =>
        point !== null &&
        typeof point === 'object' &&
        typeof point.value === 'number' &&
        Number.isFinite(point.value) &&
        typeof point.weight === 'number' &&
        Number.isFinite(point.weight) &&
        point.weight > 0,
    )
    .sort((a, b) => a.value - b.value)
  if (sorted.length === 0) return null
  let total = 0
  for (const point of sorted) total += point.weight
  if (!(total > 0) || !Number.isFinite(total)) return null
  const threshold = quantile * total
  let cumulative = 0
  for (const point of sorted) {
    cumulative += point.weight
    if (cumulative >= threshold) return point.value
  }
  // Only reachable if float accumulation left the last step a hair below the
  // threshold (e.g. `q = 1`); the largest value is then the honest answer.
  return sorted[sorted.length - 1].value
}

/**
 * The rating of one pair, from that pair's folded samples.
 *
 * Callers bucket samples by exact `(provider, model)` once and call this per
 * pair - not once per row over the whole corpus - so cost stays O(N log N)
 * rather than O(models x N).
 *
 * @param {object[]} samples folded samples of a single pair.
 * @returns the `rating` contract object (see README).
 */
export function calculateRating(samples) {
  const list = Array.isArray(samples) ? samples : []
  let answeredSamples = 0
  let excludedRetried = 0
  let excludedInterrupted = 0
  const qualified = []

  for (const sample of list) {
    if (sample === null || typeof sample !== 'object') continue
    // Counted before any exclusion so the exclusions stay readable against the
    // denominator they are drawn from. They may overlap (a step can be retried
    // and interrupted), so they are counts, never a partition.
    answeredSamples += 1
    if (sample.interrupted === true) excludedInterrupted += 1
    if (typeof sample.retryCount === 'number' && sample.retryCount > 0) excludedRetried += 1
    if (!isSpeedQualified(sample)) continue
    // A sample with no usable timestamp cannot be weighted - it has no age - so
    // it cannot enter the quantiles. Defensive: the fold always writes one.
    const time = sample.time
    if (typeof time !== 'number' || !Number.isFinite(time)) continue
    // The rate is defined here, once, so every consumer divides the same way:
    // v = tokens * 1000 / span. `isSpeedQualified` guarantees a finite positive
    // span and finite tokens, but the quotient can still overflow; an infinite
    // rate is not a rate, so the sample leaves the qualified set rather than
    // poisoning a quantile with Infinity.
    const tps = (sample.streamTokens * 1000) / sample.streamMs
    if (!Number.isFinite(tps)) continue
    qualified.push({
      time,
      ttftMs: sample.ttftMs,
      tps,
      sessionId: sample.sessionId,
    })
  }

  if (answeredSamples === 0) return emptyRating('no_samples')
  if (qualified.length === 0) {
    return {
      ...emptyRating('no_qualified_samples'),
      answeredSamples,
      excludedRetried,
      excludedInterrupted,
      // A real zero: nothing qualified out of everything answered. `null` is
      // reserved for "there was nothing to divide".
      coverage: 0,
    }
  }

  // The anchor is this pair's newest usable sample, not the corpus maximum and
  // never the wall clock: that is what keeps a score invariant when another
  // model is used, a selection changes, or time passes without new evidence.
  let anchor = qualified[0].time
  for (const item of qualified) if (item.time > anchor) anchor = item.time

  const points = []
  let totalWeight = 0
  let sumSquares = 0
  const sessions = new Set()
  for (const item of qualified) {
    const ageDays = Math.max(0, anchor - item.time) / RATING_POLICY.msPerDay
    const weight = 2 ** (-ageDays / RATING_POLICY.halfLifeDays)
    // Zero (underflow), negative or nonfinite weight contributes nothing and
    // must not create a session count for evidence it does not carry.
    if (!(weight > 0) || !Number.isFinite(weight)) continue
    points.push({ tps: item.tps, ttftMs: item.ttftMs, weight })
    totalWeight += weight
    sumSquares += weight * weight
    if (typeof item.sessionId === 'string' && item.sessionId !== '') sessions.add(item.sessionId)
  }

  // Kish effective sample size: how many equally-weighted observations the
  // weighted set is worth. It corrects weight concentration, not correlation -
  // steps inside one session are not independent - which is why sessions are
  // published beside it instead of being folded into it. `null` when there is no
  // positive weight left to divide (every weight underflowed, or no sample).
  const kish = sumSquares > 0 ? (totalWeight * totalWeight) / sumSquares : Number.NaN
  const effectiveSamples = Number.isFinite(kish) ? kish : null

  const inputs = { tpsMedian: null, ttftMedianMs: null, ttftP90Ms: null }
  const components = { throughput: null, latency: null, tailLatency: null }
  if (points.length > 0 && effectiveSamples !== null) {
    const tpsMedian = weightedQuantile(
      points.map((point) => ({ value: point.tps, weight: point.weight })),
      0.5,
    )
    const ttftMedianMs = weightedQuantile(
      points.map((point) => ({ value: point.ttftMs, weight: point.weight })),
      0.5,
    )
    const ttftP90Ms = weightedQuantile(
      points.map((point) => ({ value: point.ttftMs, weight: point.weight })),
      0.9,
    )
    if (tpsMedian !== null && ttftMedianMs !== null && ttftP90Ms !== null) {
      inputs.tpsMedian = tpsMedian
      inputs.ttftMedianMs = ttftMedianMs
      inputs.ttftP90Ms = ttftP90Ms
      components.throughput = tpsMedian / (tpsMedian + RATING_POLICY.throughputAnchorTps)
      components.latency = 1 / (1 + ttftMedianMs / RATING_POLICY.ttftMedianAnchorMs)
      components.tailLatency = 1 / (1 + ttftP90Ms / RATING_POLICY.ttftP90AnchorMs)
    }
  }

  // The quantiles above are published even when the counts below withhold the
  // score: they are what the row did measure, and a reader asking why a route is
  // unrated deserves to see it was nine samples of a good median rather than
  // silence.
  const rawScore =
    components.throughput !== null &&
    components.latency !== null &&
    components.tailLatency !== null
      ? 100 *
        components.throughput ** RATING_POLICY.weightThroughput *
        components.latency ** RATING_POLICY.weightLatency *
        components.tailLatency ** RATING_POLICY.weightTail
      : null

  // Counted as the gate-passing population, not the positive-weight one: a
  // sample that passed every gate is qualified evidence even in the astronomically
  // old case where its weight underflowed to zero and it could not enter a
  // quantile. `effectiveSamples` is what exposes concentration either way.
  const qualifiedSamples = qualified.length
  let score = null
  let reason = null
  let provisional = false
  if (
    rawScore === null ||
    !Number.isFinite(rawScore) ||
    qualifiedSamples < RATING_POLICY.minQualifiedSamples ||
    effectiveSamples === null ||
    effectiveSamples < RATING_POLICY.minEffectiveSamples
  ) {
    // Too little evidence to publish. The count threshold and the effective
    // threshold are separate on purpose: ten samples concentrated in one pair of
    // hours are worth less than ten spread out, and nEffective is what says so.
    reason = 'insufficient_samples'
  } else {
    score = rawScore
    provisional =
      effectiveSamples < RATING_POLICY.provisionalEffectiveSamples ||
      sessions.size < RATING_POLICY.provisionalSessions
  }

  return {
    version: RATING_POLICY.version,
    score,
    reason,
    provisional,
    anchor,
    qualifiedSamples,
    answeredSamples,
    excludedRetried,
    excludedInterrupted,
    effectiveSamples,
    sessions: sessions.size,
    coverage: qualifiedSamples / answeredSamples,
    inputs,
    components,
  }
}

/**
 * The rating of a row that has none, in the exact shape {@link calculateRating}
 * returns so one projection can render both.
 *
 * `no_samples` is the honest default for a pair the configuration serves and the
 * history never saw; `pair_only` is for a provider row, which has no single pair
 * to rate. An unrecognized code degrades to `no_samples` rather than travelling
 * as a string no dictionary can explain.
 */
export function emptyRating(reason = 'no_samples') {
  return {
    version: RATING_POLICY.version,
    score: null,
    reason: RATING_REASONS.includes(reason) ? reason : 'no_samples',
    provisional: false,
    anchor: null,
    qualifiedSamples: 0,
    answeredSamples: 0,
    excludedRetried: 0,
    excludedInterrupted: 0,
    effectiveSamples: null,
    sessions: 0,
    coverage: null,
    inputs: { tpsMedian: null, ttftMedianMs: null, ttftP90Ms: null },
    components: { throughput: null, latency: null, tailLatency: null },
  }
}
