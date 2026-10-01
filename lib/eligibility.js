// dsh-model-scorecard - the population gate the technical rating counts.
//
// The rating deliberately reads a narrower population than the headline table.
// A retried step measures the retry policy and the network as much as the route;
// an interrupted step never delivered a whole answer; and a span flushed as one
// packet measures log packing rather than decoding. Every one of those is still
// reported by the existing columns - the rating simply refuses to fold them into
// a figure it would then present as the route's own delivery speed.
//
// The three floors below are the single definition of what a rate may be built
// from; `lib/fold.js` imports and re-exports this object, so the tools that read
// `SPEED_QUALIFICATION` from the fold and the rating that reads it here can never
// disagree about the population.
//
// Below any of the three one packed burst divides into an implausible rate (a
// single tool-call run can "stream" at thousands of tokens per second and would
// poison the route's figure). The fragment floor in particular is a condition on
// the stream's *shape*, never on the numerator: a span whose tokens arrived in one
// or two chunks was flushed as a packet, so dividing them by the span measures log
// packing rather than decoding. A low floor is deliberate — a provider that
// batches 30 tokens into one fragment still spreads a long answer over dozens of
// fragments, and it must not be penalised for that. Measured on this history the
// floor costs 10% of an openrouter/stealth/space-bunny-alpha step's samples and 0%
// of a deepseek-flash step's, while dropping the impossible 900-6 000 tok/s maxima.
export const SPEED_QUALIFICATION = Object.freeze({
  minSpanMs: 100,
  minTokens: 8,
  minFragments: 4,
})

/**
 * True for a sample the rating may read at all: a completed, non-interrupted
 * step that answered on its first attempt and carries a first-token time.
 *
 * A sample only exists for an answered step, so `interrupted` is the whole
 * completion signal available on one.
 *
 * `retryCount === 0` is an exact test on purpose. A sample without the field
 * predates retry tracking, and reading the absence as zero would silently
 * promote a retried step to a first-attempt success - the rating would then be
 * measuring the retry policy it advertises as excluded. Unknown is not zero here
 * either (AGENTS.md rule 4): it is a rejection.
 */
export function isRatingEligible(sample) {
  if (sample === null || typeof sample !== 'object') return false
  if (sample.interrupted === true) return false
  if (sample.retryCount !== 0) return false
  const ttftMs = sample.ttftMs
  if (typeof ttftMs !== 'number' || !Number.isFinite(ttftMs) || ttftMs < 0) return false
  return true
}

/**
 * True for a sample that additionally carries a span a rate can be divided out
 * of. Every operand is checked for finiteness, because one nonfinite token count
 * would otherwise travel through the median and turn the whole score into NaN.
 *
 * The rating uses a single qualified set for all three of its components, so a
 * step that cannot produce a rate is not used for its ttft either. That is what
 * keeps latency and throughput describing the same population; the alternative -
 * a latency-only fallback when usage is absent - would compare a fast route's
 * ttft against a slow route's under a shared score.
 */
export function isSpeedQualified(sample) {
  if (!isRatingEligible(sample)) return false
  const streamMs = sample.streamMs
  const streamTokens = sample.streamTokens
  const streamFragments = sample.streamFragments
  if (typeof streamMs !== 'number' || !Number.isFinite(streamMs)) return false
  if (typeof streamTokens !== 'number' || !Number.isFinite(streamTokens)) return false
  if (typeof streamFragments !== 'number' || !Number.isFinite(streamFragments)) return false
  if (streamMs < SPEED_QUALIFICATION.minSpanMs) return false
  if (streamTokens < SPEED_QUALIFICATION.minTokens) return false
  if (streamFragments < SPEED_QUALIFICATION.minFragments) return false
  return true
}
