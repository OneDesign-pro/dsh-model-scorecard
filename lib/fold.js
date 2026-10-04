// dsh-model-scorecard - metric folding core.
//
// Zero-dependency fold over the DSH durable session event log. Every figure is
// derived from events the Harness already committed, so the plugin adds no
// instrumentation to the request path: it only reads history.
//
// Timing semantics mirror the official `@deepseek-ai/dsh-session-stats`
// `sessionStats` projection:
//   ttft   = step/start.time -> first non-empty delta fragment of the step stream
//   decode = first token      -> assistant/message.time
//   llm    = step/start.time  -> assistant/message.time
//   tool   = tool/call.time   -> tool/result.time paired by callId
//
// Throughput (`tps`) is `usage.outputTokens` over the span the provider was
// actually streaming — reconstructed from the recorded delta runs
// (`time0` + accumulated `dt`), not over the `decode` interval, which also
// contains harness work. The numerator is the provider's own token count and
// never the number of delta fragments: a fragment is a transport chunk, and
// providers batch them differently, so counting fragments reports chunks per
// second under a tokens-per-second label. Measured on this history that factor
// is ~1.1 for `deepseek-official/deepseek-flash` but ~28 for
// `openrouter/stealth/space-bunny-alpha`, which streams 100-270 characters per
// delta — a 30x understatement of that model's real decode rate.

import { SPEED_QUALIFICATION } from './eligibility.js'
import { calculateRating, emptyRating } from './rating.js'

/**
 * The three floors a span must clear before it becomes a rate - 100 ms, 8
 * tokens, 4 fragments - live in `lib/eligibility.js` together with the
 * measurement that fixed them (below any of the three one packed burst divides
 * into an implausible rate). They live there and not here because the technical
 * rating reads the same floors and must be importable without the fold:
 * `lib/rating.js` imports that module, and this one re-exports the constants so
 * the tools and readers that already import `SPEED_QUALIFICATION` from the fold
 * keep working. One definition, two names for it.
 */
export { SPEED_QUALIFICATION }

/** Reconstruct the time of the first token inside one packed delta run. */
function runFirstTokenTime(run) {
  if (run.type === 'tool-call-chunks') {
    if (run.name !== undefined) return run.time0
    return firstMemberTime(run.args, run)
  }
  if (run.type === 'text-chunks' || run.type === 'reasoning-chunks') {
    return firstMemberTime(run.texts, run)
  }
  return undefined
}

/**
 * Time of the LAST member of one packed run, plus how many members it packed.
 * Used for the streaming span that throughput is measured over.
 */
function runLastMemberTime(run) {
  const fragments =
    run.type === 'tool-call-chunks'
      ? run.args
      : run.type === 'text-chunks' || run.type === 'reasoning-chunks'
        ? run.texts
        : null
  const list = Array.isArray(fragments) ? fragments : []
  const dt = Array.isArray(run.dt) ? run.dt : []
  if (list.length === 0) return { last: undefined, count: 0 }
  let time = run.time0
  for (let index = 1; index < list.length; index += 1) time += dt[index - 1] ?? 0
  return { last: time, count: list.length }
}

/** `time0` plus the packed inter-fragment delays, up to the first non-empty fragment. */
function firstMemberTime(fragments, run) {
  const list = Array.isArray(fragments) ? fragments : []
  const dt = Array.isArray(run.dt) ? run.dt : []
  let time = run.time0
  for (let index = 0; index < list.length; index += 1) {
    if (index > 0) time += dt[index - 1] ?? 0
    if (list[index] !== '') return time
  }
  return undefined
}

/**
 * Streaming span of one step's recorded stream: the first and last token times
 * plus how many delta fragments were packed between them.
 *
 * This is the only span a throughput figure can honestly use. The official
 * `decode` interval (first token -> `assistant/message`) also contains harness
 * work and can be arbitrarily long, so dividing tokens by it produces
 * meaningless spikes; the delta-run span measures provider streaming alone.
 *
 * The fragment count it returns is NOT a token count — see the header note. It
 * is kept as a diagnostic so a provider's batching behaviour stays visible.
 */
function streamTokenSpan(stream) {
  if (!Array.isArray(stream)) return { first: undefined, last: undefined, fragments: 0 }
  let first
  let last
  let fragments = 0
  for (const record of stream) {
    if (record === null || typeof record !== 'object') continue
    if (record.type === 'chunk') {
      const chunk = record.chunk
      if (chunk === null || typeof chunk !== 'object') continue
      const tokenDelta =
        (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && chunk.text !== ''
      const toolDelta =
        chunk.type === 'tool-call-delta' &&
        (chunk.argumentsDelta !== '' || chunk.name !== undefined)
      if (!tokenDelta && !toolDelta) continue
      if (first === undefined) first = record.time
      last = record.time
      fragments += 1
      continue
    }
    const run = runFirstTokenTime(record)
    const end = runLastMemberTime(record)
    if (run !== undefined && first === undefined) first = run
    if (end.last !== undefined) last = end.last
    fragments += end.count
  }
  return { first, last, fragments }
}

/** Earliest token time across one step's recorded stream, or undefined. */
function streamFirstTokenTime(stream) {
  if (!Array.isArray(stream)) return undefined
  for (const record of stream) {
    if (record === null || typeof record !== 'object') continue
    if (record.type !== 'chunk') {
      const packed = runFirstTokenTime(record)
      if (packed !== undefined) return packed
      continue
    }
    const chunk = record.chunk
    if (chunk === null || typeof chunk !== 'object') continue
    const tokenDelta =
      (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && chunk.text !== ''
    const toolDelta =
      chunk.type === 'tool-call-delta' &&
      (chunk.argumentsDelta !== '' || chunk.name !== undefined)
    if (tokenDelta || toolDelta) return record.time
  }
  return undefined
}

function numOrNull(value) {
  return Number.isFinite(value) ? value : null
}

/**
 * `turn:step`, the key the log's own tool events use to name the step they belong
 * to — or `null` when the log does not say.
 *
 * It is the event's key rather than an identity this file assigns: the fold has
 * no session-wide step counter, and a tool call is only attributable to a model
 * if the step that raised it is known exactly.
 *
 * The two fields are *validated* rather than interpolated, because this is the
 * one place where a log shape change would corrupt a figure instead of emptying
 * it. Every `tool/call` and every `assistant/message` in this corpus carries both
 * as integers, so the check never fires here — but a Harness that dropped them
 * would put every call in a session under the key `undefined:undefined`, and the
 * first sample to claim that key would inherit the whole session's tool time. A
 * null returns no key at all, which costs one unmeasured step and nothing else.
 */
function stepKey(turn, step) {
  if (!Number.isInteger(turn) || !Number.isInteger(step)) return null
  return `${turn}:${step}`
}

/**
 * The retry state of one open step.
 *
 * `backoffMs` is what the policy declared (`delayMs`); `deadMs` is what the step
 * actually paid. They are not the same number and the difference is not small:
 * over this history Σ`delayMs` on retried steps is 634 s while the wall time
 * those steps burned is 11 201 s, because `delayMs` covers only the sleep and
 * not the failed request that triggered it. Reporting the sleep as "retry cost"
 * would understate the real thing by ~18x.
 *
 * So the dead time is a difference of two log timestamps instead:
 *
 *   deadMs = time(last `llm/retry-started`) - time(first `llm/retry`)
 *
 * Everything from the first recorded failure until the moment the winning
 * request actually left is dead by construction — the failed attempts plus
 * every backoff sleep — and the winning request is excluded, which is what
 * makes `ttft - deadMs` a real time-to-first-token rather than a subtraction of
 * unrelated quantities. Measured on this history the result is never negative
 * (0 of 437 recovered retried steps), which is the check that the identity is
 * sound; `tools/verify-retry.mjs` re-asserts it over the whole corpus.
 *
 * A step whose retries never produce an `assistant/message` emits no sample at
 * all, so its dead time is reported separately as `retryFailedSteps` rather
 * than silently dropped from every denominator.
 */
function newRetryState() {
  return {
    count: 0,
    backoffMs: 0,
    firstTime: null,
    lastStartedTime: null,
    codes: null,
    // The only attribution `llm/retry` carries itself.
    provider: null,
  }
}

/**
 * Merge one step's retry accounting into a bucket.
 *
 * Takes plain values rather than the internal state, because the aggregate half
 * reads a step that has already been through {@link foldSession} and out again.
 */
function foldRetryInto(bucket, entry) {
  bucket.retrySteps += 1
  bucket.retryEvents += entry.count
  bucket.retryBackoffMs += entry.backoffMs
  bucket.retryDeadMsSum += entry.deadMs
  bucket.retryDead.push(entry.deadMs)
  for (const code of entry.codes ?? []) {
    bucket.retryCodes.set(code, (bucket.retryCodes.get(code) ?? 0) + 1)
  }
}

function retryDeadMs(state) {
  if (state.count === 0) return 0
  if (state.lastStartedTime !== null && state.firstTime !== null) {
    return Math.max(0, state.lastStartedTime - state.firstTime)
  }
  // No `llm/retry-started` was recorded (an older log, or a step whose retry
  // was cut off). The declared sleep is then the best available figure, and it
  // is an undercount rather than a wrong one.
  return Math.max(0, state.backoffMs)
}

/**
 * Fold one session's committed events.
 *
 * @returns `{ samples, errors, retries, turnEnds, turns, steps }` where each sample is
 * one assembled assistant message carrying its provider/model attribution and
 * the tool calls its own step raised, each retry record is one step whose retries
 * never produced a message, and each turn record is one turn that reached a model
 * and how it ended. `turns` and `steps` stay counters: how many of each this
 * session contained, including the ones that produced no record at all.
 */
export function foldSession(events, options = {}) {
  const sessionId = options.sessionId ?? null
  const samples = []
  const errors = []
  const retries = []
  // How each turn ended, one record per turn that reached a model. It is an
  // array rather than a field on a sample because a turn spans many steps: the
  // outcome belongs to the conversation, not to the last message in it.
  const turnEnds = []

  let openStep = null
  let firstTokenTime = null
  // Tool calls in flight, keyed by `callId`. The value is the whole call record
  // and not a bare timestamp, because the duration is only half the answer: the
  // call also has to say which step raised it, since that step is what makes the
  // wall time attributable to a model at all.
  const pendingCalls = new Map()
  // The step each sample answers, and the tool spans waiting to be joined to it.
  //
  // The join happens after the walk, not during it, because the log puts a tool
  // call *after* the message that raised it: `assistant/message`, then
  // `tool/call`, then `tool/result`, then `step/end`. So at the moment the sample
  // is pushed its own tool work has not happened yet, and a sample stamped there
  // would always read zero. Doing it afterwards also makes the result independent
  // of that order: a log that recorded the call before the message would join the
  // same way.
  const samplesByStep = new Map()
  const toolSpansByStep = new Map()
  // Answered tool calls whose step the log did not name. It is zero on every
  // corpus this tool has seen, and it exists so that a log which stops naming
  // steps says so on the row instead of quietly reporting no tools at all.
  let unattributedCalls = 0
  let lastTurn = null
  let turns = 0
  let steps = 0
  // The model that most recently spoke in this session, per provider. A tool
  // error and a step whose retries never recovered both need an attribution
  // they do not carry themselves, and the answer is the same in both cases: a
  // tool call is made by the model that just spoke, and a retried step is served
  // by the route that was in force when it started.
  //
  // Keyed by provider because the two attributions must not cross: pairing a
  // retry's provider with another provider's last model would invent a row that
  // never existed.
  let lastSpoken = null
  const lastSpokenByProvider = new Map()
  // Who spoke in the turn currently open, and nothing wider. `lastSpoken` is
  // session-wide on purpose — a tool error and a step whose retries never
  // recovered are both records that can outlive the message before them — but a
  // turn is exactly the window that produced a model answer, and carrying the
  // previous turn's speaker into a turn that had none is how a row ends up with a
  // turn nobody in it said anything on. 111 of the 941 turns on this history
  // ended without a model in them, so the two differ on one turn in nine.
  let turnSpeaker = null

  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    const data = event.data
    if (data === null || typeof data !== 'object') continue

    switch (event.type) {
      case 'step/start':
        openStep = { turn: data.turn, step: data.step, startTime: event.time, retry: newRetryState() }
        firstTokenTime = null
        break

      case 'llm/retry': {
        if (openStep === null) break
        if (openStep.turn !== data.turn || openStep.step !== data.step) break
        const state = openStep.retry
        if (state.firstTime === null) state.firstTime = event.time
        state.count += 1
        state.backoffMs += Number.isFinite(data.delayMs) ? data.delayMs : 0
        if (state.provider === null && typeof data.provider === 'string') {
          state.provider = data.provider
        }
        const code = data.failure?.code
        if (state.codes === null) state.codes = []
        state.codes.push(typeof code === 'string' ? code : 'UNKNOWN')
        break
      }

      // The retry actually starting, after the backoff sleep. This timestamp is
      // the end of the dead span; without it only the declared sleep is known.
      case 'llm/retry-started': {
        if (openStep === null) break
        if (openStep.turn !== data.turn || openStep.step !== data.step) break
        openStep.retry.lastStartedTime = event.time
        break
      }

      case 'assistant/attempt': {
        if (openStep === null) break
        if (openStep.turn !== data.turn || openStep.step !== data.step) break
        if (firstTokenTime !== null) break
        firstTokenTime = streamFirstTokenTime(data.stream) ?? null
        break
      }

      case 'assistant/message': {
        if (openStep === null) break
        if (openStep.turn !== data.turn || openStep.step !== data.step) break
        const message = data.message ?? {}
        const source = message.source ?? {}
        const usage = data.usage ?? null
        const first = firstTokenTime ?? streamFirstTokenTime(data.stream) ?? null
        const span = streamTokenSpan(data.stream)
        const outputTokens = usage === null ? null : numOrNull(usage.outputTokens)
        const ttftMs = first === null ? null : Math.max(0, first - openStep.startTime)
        const state = openStep.retry
        const dead = retryDeadMs(state)
        const provider = typeof source.provider === 'string' ? source.provider : 'unknown'
        const model = typeof source.model === 'string' ? source.model : 'unknown'
        lastSpoken = { provider, model }
        lastSpokenByProvider.set(provider, model)
        turnSpeaker = lastSpoken

        const sample = {
          sessionId,
          time: event.time,
          provider,
          model,
          llmMs: Math.max(0, event.time - openStep.startTime),
          ttftMs,
          decodeMs:
            first === null || outputTokens === null ? null : Math.max(0, event.time - first),
          // Provider-only streaming span: the honest basis for tokens/second.
          streamMs:
            span.first === undefined || span.last === undefined || span.last <= span.first
              ? null
              : span.last - span.first,
          // Numerator for that rate. Provider-reported output tokens, which
          // cover every streamed block of the message (text, reasoning and tool
          // arguments alike); null when the provider reported no usage, and then
          // this step simply has no speed sample rather than a guessed one.
          streamTokens: outputTokens !== null && outputTokens > 0 ? outputTokens : null,
          // Diagnostic only: how many delta fragments carried those tokens.
          streamFragments: span.fragments > 0 ? span.fragments : null,
          outputTokens,
          inputTokens: usage === null ? null : numOrNull(usage.inputTokens),
          cacheReadTokens: usage === null ? null : numOrNull(usage.cacheReadTokens),
          cacheWriteTokens: usage === null ? null : numOrNull(usage.cacheWriteTokens),
          reasoningTokens: usage === null ? null : numOrNull(usage.reasoningTokens),
          interrupted: data.interrupted === true,
          // Retry accounting. Absent (null / 0) rather than guessed for a step
          // that went through first time, so "never retried" and "retried with
          // no measurable cost" stay distinguishable in the snapshot.
          retryCount: state.count,
          retryBackoffMs: state.count === 0 ? null : state.backoffMs,
          retryDeadMs: state.count === 0 ? null : dead,
          retryCodes: state.codes,
          // What the first token would have cost had the first attempt worked.
          // Null for a step that never retried, because there is nothing to
          // subtract and the measured `ttftMs` already is that number.
          ttftCleanMs: ttftMs === null || state.count === 0 ? null : Math.max(0, ttftMs - dead),
          // The tool calls this step raised, each with the wall time from the
          // `tool/call` that raised it to the `tool/result` that answered it.
          // Filled in after the walk, because those events come after this one.
          // An empty array is a measurement - this step called no tool - and not
          // a missing one, so the row can count calls over *all* steps while
          // still summarising the time over the steps that had any.
          toolSpans: [],
        }
        samples.push(sample)
        const key = stepKey(data.turn, data.step)
        if (key !== null) samplesByStep.set(key, sample)

        openStep = null
        firstTokenTime = null
        break
      }

      case 'tool/call':
        if (typeof data.callId === 'string') {
          pendingCalls.set(data.callId, {
            time: event.time,
            // The step this call belongs to, as the event itself names it. The
            // pairing is by `callId` and the attribution is by step, and both
            // come from the log: a guess at either one would be a guess.
            turn: data.turn,
            step: data.step,
            name: typeof data.name === 'string' ? data.name : 'unnamed',
          })
        }
        break

      case 'tool/result': {
        // One call identity under two spellings, both present on every result in this
        // corpus (7 630 of 7 630 in the 80 logs sampled): `source.callId` beside
        // the rest of the tool message's provenance, and the flat `toolCallId`
        // beside its content. The official projection reads the first, so it goes
        // first; the second is the same identity and costs one optional access.
        // Reading only one of them makes a Harness that drops that field zero out
        // the whole tool column silently rather than loudly.
        const callId = data.message?.source?.callId ?? data.message?.toolCallId
        // The official `tool` projection: `tool/call.time -> tool/result.time`,
        // paired by `callId`. A result with no call recorded carries no duration
        // — 454 of 32 534 results on this history, from calls the log did not
        // commit — so it is counted here and drops out of every timing figure
        // rather than being given a duration of zero.
        if (typeof callId === 'string') {
          const call = pendingCalls.get(callId)
          if (call !== undefined) {
            pendingCalls.delete(callId)
            const key = stepKey(call.turn, call.step)
            // A call the log will not name a step for cannot be filed on a model:
            // the duration is measurable, but the step that asked for it is not,
            // and this fold does not attribute a tool call to whoever spoke last.
            // It is counted and left out, and the session's samples say so below
            // rather than reporting a clean zero.
            if (key === null) {
              unattributedCalls += 1
            } else {
              const spans = toolSpansByStep.get(key) ?? []
              // Clamped, and the clamp has never fired: 0 negative durations in
              // 32 080 paired calls on this history. It stays because a machine
              // whose clock steps backwards should shorten one call's span, not
              // subtract a negative one from the row.
              spans.push({ name: call.name, ms: Math.max(0, event.time - call.time) })
              toolSpansByStep.set(key, spans)
            }
          }
        }
        // A failed tool is a stability signal for the model that raised it.
        if (data.error !== null && data.error !== undefined) {
          errors.push({
            // The speaking model, which is the only attribution this event
            // cannot supply itself. `llm/retry`-sourced errors carry their own
            // provider; a tool error has none, and guessing across the whole
            // corpus (which is what the collector used to do) attributes it to
            // whichever model of that provider happened to answer last anywhere.
            provider: lastSpoken?.provider ?? null,
            model: lastSpoken?.model ?? null,
            time: event.time,
            kind: 'tool',
            code: typeof data.error.code === 'string' ? data.error.code : 'tool-error',
            name: typeof data.error.name === 'string' ? data.error.name : null,
          })
        }
        break
      }

      case 'step/end':
        // Retries that ran out before any message arrived. These steps produce
        // no sample, so counting them here is the only way the recovery rate
        // has a denominator — otherwise "94% of retries recovered" is computed
        // against the retries that were already known to have worked.
        if (openStep !== null && openStep.retry.count > 0) {
          const state = openStep.retry
          const provider =
            state.provider ?? lastSpoken?.provider ?? null
          // The model is taken from the same provider's last message, never
          // from the session's last message of any provider — and it stays null
          // when that provider never spoke, in which case the step counts on
          // the provider row (where the attribution is exact) and nowhere
          // else. A guessed model row is worse than an absent one.
          const model = provider === null ? null : (lastSpokenByProvider.get(provider) ?? null)
          retries.push({
            sessionId,
            time: event.time,
            provider,
            model,
            retryCount: state.count,
            backoffMs: state.backoffMs,
            deadMs: retryDeadMs(state),
            codes: state.codes ?? [],
          })
        }
        turns = lastTurn === data.turn ? turns : turns + 1
        lastTurn = data.turn
        steps += 1
        openStep = null
        firstTokenTime = null
        break

      case 'turn/end':
        // Why the turn stopped, which is the only thing this event says beyond
        // its timestamp. Measured on this history the vocabulary is five kinds,
        // not the four the debt note guessed: `completed` 729, `error` 129,
        // `aborted` 73, `max-tokens` 8, `interrupted` 2 — so the kind is carried
        // through as a name and never as a flag, because a log that grew a sixth
        // would otherwise have to be classified here to stay countable.
        //
        // The turn is attributed to the model that last spoke in it, which is
        // the one whose answer the turn ended on. A turn that ended before any
        // model spoke keeps no record at all, the same rule a tool error follows
        // when it has no speaker: 111 of 941 on this history, and an invented row
        // would be worse than an absent one.
        if (turnSpeaker !== null) {
          turnEnds.push({
            sessionId,
            time: event.time,
            provider: turnSpeaker.provider,
            model: turnSpeaker.model,
            kind: typeof data.reason?.kind === 'string' ? data.reason.kind : 'unknown',
          })
        }
        turnSpeaker = null
        // A call still open when the turn ends is one that never came back, and
        // it has no end time to measure against. Nothing counts it: on this
        // history 0 of 32 080 calls are in that state, so a field for it would be
        // a zero on every corpus this tool has ever seen.
        pendingCalls.clear()
        break

      default:
        break
    }
  }

  // Join each step's tool spans to the sample that step produced. A span whose
  // step never produced a sample - a step whose retries gave out before any
  // message - is dropped here, exactly like the retries that step contributes to
  // the model rows: it has no row to be counted on, and inventing one would mean
  // attributing it to whatever spoke next. Measured on this history that is 0 of
  // 32 080, so nothing is being lost by the rule.
  for (const [key, spans] of toolSpansByStep) {
    const sample = samplesByStep.get(key)
    if (sample !== undefined) sample.toolSpans = spans
  }
  if (unattributedCalls > 0) {
    // Every sample of this session goes to `null` rather than staying `[]`,
    // because the ambiguity is the session's: one call the log would not place
    // means no step here can claim it called nothing. `[]` stays the meaning of
    // "this step raised no tool call", and the aggregate counts the difference
    // as `toolStepsUnknown` rather than folding it in.
    for (const sample of samples) sample.toolSpans = null
  }

  return { samples, errors, retries, turnEnds, turns, steps }
}

/** Percentile of an ascending array. */
function percentile(sorted, fraction) {
  if (sorted.length === 0) return null
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))
  return sorted[index]
}

function median(sorted) {
  const n = sorted.length
  if (n === 0) return null
  const mid = n >> 1
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function summarize(sorted, mean) {
  if (sorted.length === 0) {
    return { count: 0, mean: null, median: null, min: null, max: null, p90: null }
  }
  return {
    count: sorted.length,
    mean,
    median: median(sorted),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p90: percentile(sorted, 0.9),
  }
}

function newBucket(provider, model) {
  return {
    provider,
    model,
    steps: 0,
    // The sample references the technical rating reads, kept per pair so the
    // calculator runs once per row over that row's own evidence instead of
    // rescanning the corpus for every model in the report. A provider bucket
    // never fills this: a provider row is `pair_only` and has nothing to rate.
    ratingSamples: [],
    ttft: [],
    speed: [],
    e2eSpeed: [],
    prefillShare: [],
    overhead: [],
    llm: [],
    ttftClean: [],
    decodeMsSum: 0,
    decodeTokensSum: 0,
    streamMsSum: 0,
    streamTokensSum: 0,
    streamFragmentsSum: 0,
    speedSamples: 0,
    spanSamples: 0,
    llmMsSum: 0,
    outputTokens: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    errors: 0,
    toolErrors: 0,
    interrupted: 0,
    // Tool work, and it is deliberately *not* inside `llmMs`: the log closes a
    // step's LLM span at `assistant/message` and answers the tool calls at
    // `tool/result` afterwards, so this is the time an agent loop spends between
    // two model calls rather than inside either of them.
    toolCalls: 0,
    toolMsSum: 0,
    toolMs: [],
    // Steps whose tool time could not be established because the log stopped
    // naming the step a call belonged to. Zero on every corpus seen so far; when
    // it is not zero the two figures above are measured over part of the
    // evidence, and this is what says so.
    toolStepsUnknown: 0,
    // Tool name -> calls and wall time, so a row that looks slow in `toolMs` can
    // say which tools it spent the time on. Published like `errorCodes`: a name
    // this table has never seen is still counted and still names itself.
    toolByName: new Map(),
    // The raw code behind every error, and the coarse category it falls in.
    // Both are kept because they answer different questions: the code is what
    // a reader greps for, the category is what a reader decides on.
    errorCodes: new Map(),
    errorCategories: new Map(),
    // Errors whose cause is the model's own output. The one number that ranks
    // models by tool-call quality rather than by how busy their sessions were.
    modelErrors: 0,
    // Retry accounting. `retrySteps` counts steps that produced an answer after
    // at least one retry; `retryFailedSteps` counts those whose retries never
    // did, and the two together are the denominator of `retryRecovery`.
    retrySteps: 0,
    retryEvents: 0,
    retryFailedSteps: 0,
    retryBackoffMs: 0,
    retryDeadMsSum: 0,
    retryDead: [],
    retryCodes: new Map(),
    // How the turns that reached this row's models ended, by kind. Kept raw for
    // the same reason the error code is: a kind this table has never seen must
    // still be counted and still name itself. The one figure derived from them
    // is `turnsUnclean` — everything that is not `completed` — because "did the
    // loop finish" is the question a reader has, and the split into causes is
    // the breakdown they ask next.
    turnEnds: 0,
    turnEndKinds: new Map(),
    sessions: new Set(),
    firstSeen: null,
    lastSeen: null,
    maxContext: 0,
  }
}

/**
 * Which failure a tool error actually is, as far as the log can tell.
 *
 * A single error count is not a usable figure, and this is why. The two largest
 * codes in this history are `FS_EDIT_NOT_FOUND` (239) and `INVALID_ARGS` (233) —
 * the same order of magnitude — and they are not remotely the same thing. One is
 * the harness finding the file changed under it; the other is the model emitting
 * arguments its own schema rejects. Only the second says anything about the
 * model, and only the second is fixed by choosing a different model.
 *
 * Measured on this history, the two orderings do not agree on the size of the
 * gap. `deepseek-flash` has 160 tool errors to `limitdeckai2/deepseek-v4-flash`'s
 * 321, so the raw count puts the second model twice as bad. On
 * model-attributable errors alone it is 19 against 189: the first model is ten
 * times better at calling tools, and the raw count shows a factor of two.
 *
 * Corpus-wide 282 of 783 errors (36%) are model-attributable; the rest are
 * filesystem state races (467), provider faults and harness bookkeeping.
 *
 * The categories are therefore coarse on purpose — seven names, chosen for what
 * a reader can do about them — and the raw code is always kept alongside, so a
 * code this table has never seen is still counted and still names itself.
 */
const ERROR_CATEGORIES = new Set([
  'bad_call',
  'code_failed',
  'state_race',
  'denied',
  'provider',
  'harness',
  'other',
])

/**
 * The complete category vocabulary, exported so the panel can colour a category
 * it has never seen without guessing, and so the verification tool can assert
 * that {@link errorCategory} never returns a name outside it.
 */
export const ERROR_CATEGORY_NAMES = Object.freeze([...ERROR_CATEGORIES])

/**
 * The category of one tool error, from its code and its error class name.
 *
 * Matches on a prefix rather than an exact list, so a new code inside a known
 * family is classified without touching this function — which is the only way
 * the table stays right as the Harness adds codes.
 */
export function errorCategory(code, name) {
  // Denial first, because it beats the family prefixes: `FS_SANDBOX_DENIED`
  // carries the `FS_` prefix of a filesystem state race and is nothing of the
  // sort — it is the sandbox refusing, which is the environment's answer, not a
  // file that moved. Checking `FS_` first put every denial in `state_race` and
  // left the `denied` category unused in this history, which is how the mistake
  // was found.
  if (/DENIED|FORBIDDEN|PERMISSION|UNAUTHORIZED|POLICY/.test(code ?? '')) return 'denied'
  if (/^FS_/.test(code ?? '')) return 'state_race'
  if (/(^|_)INVALID(_|$)/.test(code ?? '') || /ARGS?ERROR|TOOLARGS/i.test(name)) return 'bad_call'
  if (/^UNKNOWN_TOOL$|TOOL_NOT_FOUND|^NO_SUCH_TOOL/.test(code ?? '')) return 'bad_call'
  if (/RUN_FAILED|EXEC_FAILED/.test(code ?? '')) return 'code_failed'
  if (/PROVIDER|^NO_ADAPTER|_UPSTREAM|SEARCH_FAILED/.test(code ?? '')) return 'provider'
  if (/^TEAM_|^GOAL_|^HARNESS/.test(code ?? '')) return 'harness'
  return 'other'
}

/** Categories whose cause is the model's own output rather than its surroundings. */
const MODEL_CATEGORIES = new Set(['bad_call', 'code_failed'])

/**
 * One entry per order the report can be read in: the figure of a row the order
 * reads, and the direction it is offered in.
 *
 * `dir` is the direction that puts the rows worth reading on top — the fastest
 * response first, the busiest model first, the least stable one first — so the
 * panel and the tool both open on it. The other direction is this order turned
 * around rather than a second rule: one comparison per key, never two.
 *
 * `tie` is a tie-break, not a second key, so it keeps its own direction when the
 * key is reversed: among rows that failed equally often, the fastest one stays
 * first either way.
 *
 * Every column of the panel's table has an entry here, because a heading the
 * user can click has to be able to ask the host for what that column shows. The
 * orders the agent's tool offers are the `SORTS` subset of these - see
 * `collect.js` — and `rating` is in both, because a rating the user can sort by
 * is a rating the model must be able to sort by too.
 */
const SORT_KEYS = {
  steps: { dir: 'desc', value: (row) => row.steps },
  ttft: { dir: 'asc', value: (row) => row.ttft.median },
  speed: { dir: 'desc', value: (row) => row.speedTps.median },
  errors: { dir: 'desc', value: (row) => row.errors, tie: (a, b) => asc(a.ttft.median, b.ttft.median) },
  lastSeen: { dir: 'desc', value: (row) => row.lastSeen },
  // The name column: a model row sorts by model, a provider row by provider, so
  // one key serves both views. A file path sorts by its path, which is the only
  // figure a reader has to tell two local models apart.
  name: { dir: 'asc', text: (row) => `${row.model ?? row.provider}` },
  ttftP90: { dir: 'asc', value: (row) => row.ttft.p90 },
  tpsMax: { dir: 'desc', value: (row) => row.speedTps.max },
  confidence: { dir: 'desc', value: (row) => row.speedConfidence },
  llm: { dir: 'asc', value: (row) => row.llmMs.mean },
  cache: { dir: 'desc', value: (row) => row.cacheHitRate },
  // Retry columns. `retry` reads the rate (steps that needed a retry over steps
  // that answered), and `ttftClean` the first token with the retry dead time
  // subtracted, so the two can be read together: a high rate and a high clean
  // ttft means the route is slow, a high rate and a low clean ttft means the
  // route is flaky and the model is not.
  retry: { dir: 'desc', value: (row) => row.retryRate },
  ttftClean: { dir: 'asc', value: (row) => row.ttftClean.median },
  // The three figures that decompose a step into the parts a reader can act on.
  // `e2e` is the useful decode rate (faster first), `prefill` is how much of the
  // wait is spent before the first token rather than generating (worst first),
  // and `overhead` is the part this host is responsible for (least first).
  e2e: { dir: 'desc', value: (row) => row.e2eTps.median },
  prefill: { dir: 'desc', value: (row) => row.prefillShare.median },
  overhead: { dir: 'asc', value: (row) => row.overheadMs.median },
  // Tool work, the last piece of the same decomposition: what the model's steps
  // reached for, and what that cost. Neither is a virtue, and the directions say
  // so — `tools` is busiest-first like `steps`, because more calls is more loop
  // rather than better or worse, while `toolTime` is least-first like
  // `overhead`, because that column's reader wants the cheapest one on top. A
  // row whose steps never called a tool has no `toolMs` median at all, and the
  // comparator holds an unmeasured figure at the bottom in both directions.
  tools: { dir: 'desc', value: (row) => row.toolCallsPerStep },
  toolTime: { dir: 'asc', value: (row) => row.toolMs?.median },
  // Errors per 100 steps, not per session: a raw count ranks the model whose
  // sessions happened to be long, not the model that fails. `modelErrors` is the
  // subset a different model would have avoided.
  errorRate: {
    dir: 'desc',
    value: (row) => row.errorRate,
    tie: (a, b) => asc(a.ttft.median, b.ttft.median),
  },
  modelErrors: {
    dir: 'desc',
    value: (row) => row.modelErrors,
    tie: (a, b) => asc(a.ttft.median, b.ttft.median),
  },
  interrupted: { dir: 'desc', value: (row) => row.interrupted },
  // The technical rating. Descending, because a reader who ordered by rating is
  // looking for the best route first. A row without a published score reads
  // `undefined` through the optional chain - a `null` score, a row from a fold
  // that predates the column - and the comparator holds an unmeasured figure at
  // the bottom in both directions, so "not enough evidence" is never promoted to
  // "worst" by reversing the order.
  //
  // The tie-break is pair identity rather than a second figure, and it has to be
  // one: equal weights are the normal case in a small history, so equal scores
  // are too, and the order between two equally-rated pairs must not be whatever
  // order the fold happened to insert them in.
  rating: {
    dir: 'desc',
    value: (row) => row.rating?.score,
    tie: (a, b) => pairIdentity(a).localeCompare(pairIdentity(b)),
  },
  // The status column, the one order the report cannot read off itself: a probe
  // result is not in the session log, so the caller hands in the rank it read in
  // the probe store (`options.statusOf`) and the fold only compares what it is
  // given. Descending, because the rank counts how loudly a state shouts and a
  // reader who ordered by status is looking for what is broken.
  //
  // A row no probe ever answered for has no rank at all, and the comparator holds
  // an unmeasured figure at the bottom in both directions — so "not checked" is
  // neither the worst status nor a promoted absence when the order is reversed.
  liveness: { dir: 'desc', value: (row) => row.livenessRank, tie: busiest },
}

/**
 * Every order's natural direction as a flat map, for the one consumer that
 * cannot import the fold.
 *
 * The panel draws a heading's arrow before the first answer arrives, so it has
 * to know which way each order opens without asking the host, and `client.js` is
 * a browser bundle with no module resolution into `lib/` — so it restates this
 * as its own `SORT_DIRS`. A hand copy of one fact is how eight orders (`retry`
 * through `interrupted`) came to be missing from the panel's map and open
 * ascending on their first click while the host opened them descending, which is
 * the opposite of what every other column does. The two maps cannot import each
 * other, so they are pinned instead: `tools/verify-panel-state.mjs` compares them
 * key for key and direction by direction against the copy the bundle declares.
 */
export const SORT_DIRECTIONS = Object.freeze(
  Object.fromEntries(Object.entries(SORT_KEYS).map(([key, entry]) => [key, entry.dir])),
)

/**
 * The tie-break for the one order where a tie is the normal case rather than the
 * exception: every available model shares a rank, so without a second key a
 * whole green column would come out in the order the fold happened to build it
 * in. Busiest first, then by name, which makes the order total — the property
 * the numeric keys get for free from a figure no two rows share.
 */
function busiest(a, b) {
  const bySteps = (b.steps ?? 0) - (a.steps ?? 0)
  if (bySteps !== 0) return bySteps
  return `${a.model ?? a.provider}`.localeCompare(`${b.model ?? b.provider}`)
}

/**
 * One row's identity as a single string, for the tie-breaks that must be total
 * without reading a figure: `busiest` needs a name after the step count when two
 * rows are equally busy too, but a tie there is broken by the model the reader
 * sees. The NUL separator is the same one the pair keys use everywhere else, so
 * a provider row (`model: null`) cannot collide with a model named "".
 */
function pairIdentity(row) {
  return `${row.provider}\u0000${row.model ?? ''}`
}

/** A figure that was never measured, as opposed to one that measured zero. */
function measured(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * The comparator for one key in one direction.
 *
 * A key nobody asked for falls back to `steps`, and so does a direction that is
 * not one of the two: a host answering an order it does not know with the order
 * the caller gets by default is the only safe reading of a bad parameter.
 *
 * A row with no measurement stays at the bottom in both directions. Reversing an
 * order reverses the comparison between measured values, not the meaning of a
 * missing one — a provider that recorded no cache share has not the worst cache
 * share, and promoting every such row to the top would make the reversed table a
 * list of missing data.
 *
 * Exported because a report can hold a row the fold never built: a model the
 * configuration serves and the history never saw ({@link unmeasuredRow}). Merging
 * such a row into an already ordered table has to use the *same* comparison the
 * table was ordered by, or the page would be two orders spliced together — a row
 * with no median above one with a median, under a heading claiming otherwise.
 */
export function comparatorFor(sort, dir) {
  const spec = SORT_KEYS[sort] ?? SORT_KEYS.steps
  const reversed = dir === 'asc' || dir === 'desc' ? dir !== spec.dir : false

  if (spec.text !== undefined) {
    const byText = (a, b) => spec.text(a).localeCompare(spec.text(b))
    return (a, b) => {
      const order = byText(a, b)
      return order === 0 && spec.tie !== undefined ? spec.tie(a, b) : (reversed ? -order : order)
    }
  }

  return (a, b) => {
    const left = spec.value(a)
    const right = spec.value(b)
    if (!measured(left) || !measured(right)) {
      if (!measured(left) && !measured(right)) return spec.tie === undefined ? 0 : spec.tie(a, b)
      return measured(left) ? -1 : 1
    }
    const order = spec.dir === 'asc' ? left - right : right - left
    if (order === 0 && spec.tie !== undefined) return spec.tie(a, b)
    return reversed ? -order : order
  }
}

/**
 * Turn per-step samples plus attributed errors into the aggregated report.
 *
 * @param samples - step samples from {@link foldSession}.
 * @param options.errors - `{ provider, model, kind }` records.
 * @param options.retries - steps whose retries never produced a message.
 * @param options.sort - one of {@link SORT_KEYS}.
 * @param options.dir - `asc` or `desc`; the key's own direction when omitted.
 * @param options.statusOf - `(provider, model, lastSeen) => rank|null`, for the
 *   `liveness` order; omitted, every row is unranked and that order degrades to
 *   the busiest first.
 */
export function aggregate(samples, options = {}) {
  const byModel = new Map()
  const byProvider = new Map()
  const sessions = new Set()
  const errors = Array.isArray(options.errors) ? options.errors : []

  const modelKey = (provider, model) => `${provider}\u0000${model}`

  // The two views bucket differently, and the difference is the whole point of
  // the provider view: one row per model, and one row per provider with all of
  // its models folded together. Keying both maps by (provider, model) — as this
  // did — made `byProvider` a copy of `byModel`, so a provider with two models
  // showed up as two rows, `report.providers` counted models, and a provider
  // filter would have kept every one of them.
  const bucketFor = (map, key, provider, model) => {
    let bucket = map.get(key)
    if (bucket === undefined) {
      bucket = newBucket(provider, model)
      map.set(key, bucket)
    }
    return bucket
  }

  for (const sample of samples) {
    if (sample === null || sample === undefined) continue
    if (typeof sample.sessionId === 'string') sessions.add(sample.sessionId)

    for (const map of [byModel, byProvider]) {
      const providerLevel = map === byProvider
      const key = providerLevel ? sample.provider : modelKey(sample.provider, sample.model)
      const bucket = bucketFor(map, key, sample.provider, providerLevel ? null : sample.model)
      bucket.steps += 1
      bucket.sessions.add(sample.sessionId)
      if (!providerLevel) bucket.ratingSamples.push(sample)
      bucket.llmMsSum += sample.llmMs ?? 0
      bucket.llm.push(sample.llmMs ?? 0)
      bucket.outputTokens += sample.outputTokens ?? 0
      bucket.inputTokens += sample.inputTokens ?? 0
      bucket.cacheReadTokens += sample.cacheReadTokens ?? 0
      bucket.cacheWriteTokens += sample.cacheWriteTokens ?? 0
      bucket.reasoningTokens += sample.reasoningTokens ?? 0
      if (sample.interrupted === true) bucket.interrupted += 1

      // The step's own tool calls, already attributed: `foldSession` joined them
      // to this sample by the (turn, step) the log itself carries, so nothing
      // here has to guess which model a call belonged to.
      //
      // The count is folded over *every* step, because "how many tools does this
      // model reach for" has to be answered against the steps it took as well —
      // a step that called nothing is a measurement, and a rate that divided by
      // only the steps that did call something would flatter a model whose steps
      // need no help. The time is summarised over the steps that *did* call
      // something, for the same reason `retryBackoffMs` and `ttftCleanMs` keep a
      // null for the steps they do not cover: a median over mostly-zero steps is
      // not what a reader is asking for, and `-` is honest where `0 ms` is not.
      if (sample.toolSpans === null) bucket.toolStepsUnknown += 1
      if (Array.isArray(sample.toolSpans) && sample.toolSpans.length > 0) {
        let stepMs = 0
        for (const span of sample.toolSpans) {
          stepMs += span.ms
          const byName = bucket.toolByName.get(span.name) ?? { calls: 0, ms: 0 }
          byName.calls += 1
          byName.ms += span.ms
          bucket.toolByName.set(span.name, byName)
        }
        bucket.toolCalls += sample.toolSpans.length
        bucket.toolMsSum += stepMs
        bucket.toolMs.push(stepMs)
      }

      const context =
        (sample.inputTokens ?? 0) + (sample.cacheReadTokens ?? 0) + (sample.cacheWriteTokens ?? 0)
      if (context > bucket.maxContext) bucket.maxContext = context

      if (sample.ttftMs !== null && sample.ttftMs !== undefined) {
        bucket.ttft.push(sample.ttftMs)
      }
      // A step that never retried has no clean figure of its own, but it does
      // have one: the measured first token *is* the clean first token. Folding
      // the untouched steps in is what makes this column comparable with
      // `ttft` rather than a rate over a small, self-selected subset.
      if (sample.ttftCleanMs !== null && sample.ttftCleanMs !== undefined) {
        bucket.ttftClean.push(sample.ttftCleanMs)
      } else if (sample.ttftMs !== null && sample.ttftMs !== undefined) {
        bucket.ttftClean.push(sample.ttftMs)
      }
      if ((sample.retryCount ?? 0) > 0) {
        foldRetryInto(bucket, {
          count: sample.retryCount,
          backoffMs: sample.retryBackoffMs ?? 0,
          deadMs: sample.retryDeadMs ?? 0,
          codes: sample.retryCodes ?? [],
        })
      }
      if (
        sample.decodeMs !== null &&
        sample.decodeMs !== undefined &&
        sample.outputTokens !== null &&
        sample.outputTokens !== undefined
      ) {
        bucket.decodeMsSum += sample.decodeMs
        bucket.decodeTokensSum += sample.outputTokens
      }
      // Throughput uses the streaming span, never the decode interval: the
      // latter also contains harness work and would produce impossible rates.
      // A span is only accepted when it is long enough to be a rate rather than
      // a burst, so short tool-call runs do not inflate the figure.
      //
      // The rate needs both halves: a recorded span and a provider token count.
      // A step the provider streamed without reporting usage contributes
      // nothing to `speed` and nothing to the confidence denominator, so a model
      // that never reports usage shows no rate at all instead of a guessed one.
      const hasSpan =
        sample.streamMs !== null &&
        sample.streamMs !== undefined &&
        sample.streamFragments !== null &&
        sample.streamFragments !== undefined
      const hasTokens = sample.streamTokens !== null && sample.streamTokens !== undefined
      if (hasSpan && hasTokens && sample.streamMs > 0) {
        bucket.streamMsSum += sample.streamMs
        bucket.streamTokensSum += sample.streamTokens
        bucket.streamFragmentsSum += sample.streamFragments
        bucket.spanSamples += 1
        if (
          sample.streamMs >= SPEED_QUALIFICATION.minSpanMs &&
          sample.streamTokens >= SPEED_QUALIFICATION.minTokens &&
          sample.streamFragments >= SPEED_QUALIFICATION.minFragments
        ) {
          bucket.speed.push((sample.streamTokens * 1000) / sample.streamMs)
          bucket.speedSamples += 1
          // The end-to-end rate is the same measurement over the same qualified
          // steps with the wait for the first token added to the denominator.
          // The qualification is deliberately not repeated on the wider span: a
          // prefill can only make the denominator larger, and the failure this
          // guard exists to prevent is an implausibly *high* rate, which a longer
          // span cannot produce.
          const firstToken = sample.ttftMs
          if (firstToken !== null && firstToken !== undefined) {
            const answerMs = firstToken + sample.streamMs
            if (answerMs > 0) {
              bucket.e2eSpeed.push((sample.streamTokens * 1000) / answerMs)
              // The same ratio read as a share of the wait, which is the form a
              // reader can compare across models: 0.3 is a model that answers
              // fast, 0.85 is one that spends almost all of it before the first
              // token. Computed per step and then summarised, never as a ratio
              // of two medians — those describe different sample sets.
              bucket.prefillShare.push(firstToken / answerMs)
            }
          }
        }
      }
      // What the host is responsible for: the step's own wall time minus the
      // wait for the first token minus the span the provider streamed, i.e. the
      // gap between the last recorded delta and the `assistant/message` that
      // closed the step. Left unclamped: measured over 16 037 corpus steps it is
      // never negative, and a log that broke that assumption should show a
      // negative number rather than have it quietly hidden.
      if (sample.ttftMs !== null && sample.ttftMs !== undefined && sample.streamMs !== null) {
        bucket.overhead.push(sample.llmMs - sample.ttftMs - sample.streamMs)
      }
      if (bucket.firstSeen === null || sample.time < bucket.firstSeen) bucket.firstSeen = sample.time
      if (bucket.lastSeen === null || sample.time > bucket.lastSeen) bucket.lastSeen = sample.time
    }
  }

  // Tool errors are attributed to the model raising them; request errors carry
  // their own provider attribution from the caller.
  for (const error of errors) {
    if (error === null || error === undefined) continue
    const provider = typeof error.provider === 'string' ? error.provider : 'unknown'
    const model = typeof error.model === 'string' ? error.model : 'unknown'
    const code = typeof error.code === 'string' ? error.code : 'tool-error'
    const category = errorCategory(code, error.name)
    for (const map of [byModel, byProvider]) {
      const key = map === byProvider ? provider : modelKey(provider, model)
      const bucket = map.get(key)
      if (bucket === undefined) continue
      bucket.errors += 1
      if (error.kind === 'tool') bucket.toolErrors += 1
      bucket.errorCodes.set(code, (bucket.errorCodes.get(code) ?? 0) + 1)
      bucket.errorCategories.set(category, (bucket.errorCategories.get(category) ?? 0) + 1)
      if (MODEL_CATEGORIES.has(category)) bucket.modelErrors += 1
    }
  }

  // Steps whose retries never produced a message. They contribute no sample, so
  // without this pass `retryRecovery` would divide recovered steps by recovered
  // steps and report 100% for every row that had any failure at all.
  const failedRetries = Array.isArray(options.retries) ? options.retries : []
  for (const failure of failedRetries) {
    if (failure === null || failure === undefined) continue
    const provider = typeof failure.provider === 'string' ? failure.provider : 'unknown'
    const model = typeof failure.model === 'string' ? failure.model : 'unknown'
    for (const map of [byModel, byProvider]) {
      const key = map === byProvider ? provider : modelKey(provider, model)
      // A bucket only exists if the model answered something at some point, and
      // a step that never produced an answer is not that bucket's business.
      const bucket = map.get(key)
      if (bucket === undefined) continue
      bucket.retryFailedSteps += 1
      bucket.retryEvents += failure.retryCount ?? 0
      bucket.retryBackoffMs += failure.backoffMs ?? 0
      bucket.retryDeadMsSum += failure.deadMs ?? 0
      for (const code of failure.codes ?? []) {
        bucket.retryCodes.set(code, (bucket.retryCodes.get(code) ?? 0) + 1)
      }
    }
  }

  // How each turn ended. Like the retries above, these contribute no sample: a
  // turn that ended on an error still produced answered steps, and the steps are
  // what every other figure counts. This is the conversation's own outcome, and
  // the only place it is recorded.
  const failedTurns = Array.isArray(options.turnEnds) ? options.turnEnds : []
  for (const turn of failedTurns) {
    if (turn === null || turn === undefined) continue
    const provider = typeof turn.provider === 'string' ? turn.provider : 'unknown'
    const model = typeof turn.model === 'string' ? turn.model : 'unknown'
    const kind = typeof turn.kind === 'string' ? turn.kind : 'unknown'
    for (const map of [byModel, byProvider]) {
      const key = map === byProvider ? provider : modelKey(provider, model)
      // A turn belongs to a pair that answered something at some point; a turn
      // that reached no model never gets here at all, and one from a model the
      // history otherwise never served has no bucket to join.
      const bucket = map.get(key)
      if (bucket === undefined) continue
      bucket.turnEnds += 1
      bucket.turnEndKinds.set(kind, (bucket.turnEndKinds.get(kind) ?? 0) + 1)
    }
  }

  // The rating is attached before the sort, because the sort can read it: one
  // call per pair over that pair's own samples, so the cost is O(N log N) for
  // the whole report rather than a corpus scan per row.
  const byModels = [...byModel.values()].map((bucket) =>
    finalizeBucket(bucket, calculateRating(bucket.ratingSamples)),
  )
  // A provider row is a roll-up and not a route: it has no single pair to rate,
  // so it carries `pair_only` rather than a score. Recomputing one over the
  // provider's mixed samples, or averaging its models' scores, would publish a
  // figure that belongs to no route the user can actually choose.
  const byProviders = [...byProvider.values()].map((bucket) =>
    finalizeBucket(bucket, emptyRating('pair_only')),
  )

  // The status rank, for the one order that is not the report's own. The caller
  // passes the lookup because a probe result lives in its own store: the panel
  // reads it there (`lib/status.js`) and hands the rank in, and a row the lookup
  // does not know is left unranked rather than guessed at.
  if (typeof options.statusOf === 'function') {
    for (const row of byModels) {
      row.livenessRank = options.statusOf(row.provider, row.model, row.lastSeen)
    }
    // A provider row has no model of its own, and that is the whole difference
    // between the two views: `null` asks the lookup for the roll-up.
    for (const row of byProviders) {
      row.livenessRank = options.statusOf(row.provider, null, row.lastSeen)
    }
  }

  // Order by the same figure the report puts in front of the reader: the median
  // for ttft and tok/s, which README already prefers for these skewed
  // distributions. Ordering by the mean made the table look unsorted next to a
  // median column — a single stalled step could push the model with the best
  // median to the bottom of the list.
  //
  // Both views are ordered by the same comparator, so a provider row and a model
  // row can never disagree about which is faster.
  const comparator = comparatorFor(options.sort, options.dir)
  byModels.sort(comparator)
  byProviders.sort(comparator)

  return {
    sessionsScanned: sessions.size,
    steps: byModels.reduce((sum, entry) => sum + entry.steps, 0),
    errors: byModels.reduce((sum, entry) => sum + entry.errors, 0),
    retries: byModels.reduce((sum, entry) => sum + entry.retryEvents, 0),
    retryFailedSteps: byModels.reduce((sum, entry) => sum + entry.retryFailedSteps, 0),
    providers: byProviders.length,
    models: byModels.length,
    byModel: byModels,
    byProvider: byProviders,
  }
}

/**
 * One bucket as the row the report publishes.
 *
 * `rating` is passed in rather than computed here because the two views rate
 * differently: a model row is rated from its own samples, a provider row is
 * `pair_only`. Passing it keeps one projection for both - and for the row built
 * without a bucket - which is what makes {@link unmeasuredRow} and a measured
 * row the same shape.
 *
 * A module-level function rather than a closure inside {@link aggregate}
 * because a row can exist without a sample behind it: {@link unmeasuredRow}
 * builds the row of a pair the configuration serves and the history never saw,
 * and it has to be the *same* row — the same fields, the same nulls — or the
 * panel would hold two kinds of row that read differently under one heading.
 */
function finalizeBucket(bucket, rating) {
  const ttftSorted = bucket.ttft.slice().sort((a, b) => a - b)
  const speedSorted = bucket.speed.slice().sort((a, b) => a - b)
  const e2eSorted = bucket.e2eSpeed.slice().sort((a, b) => a - b)
  const prefillSorted = bucket.prefillShare.slice().sort((a, b) => a - b)
  const overheadSorted = bucket.overhead.slice().sort((a, b) => a - b)
  const llmSorted = bucket.llm.slice().sort((a, b) => a - b)
  const cleanSorted = bucket.ttftClean.slice().sort((a, b) => a - b)
  const retryDeadSorted = bucket.retryDead.slice().sort((a, b) => a - b)
  const toolMsSorted = bucket.toolMs.slice().sort((a, b) => a - b)
  const cacheInput = bucket.inputTokens + bucket.cacheReadTokens
  const retried = bucket.retrySteps + bucket.retryFailedSteps
  // Every way a turn can stop is a way of not stopping, and the fold carries the
  // kind as a name rather than a flag precisely so this is one subtraction and
  // not a per-kind decision.
  let uncleanTurns = 0
  for (const [kind, count] of bucket.turnEndKinds) {
    if (kind !== 'completed') uncleanTurns += count
  }
  return {
    provider: bucket.provider,
    model: bucket.model,
    // The one figure on this row that is not a summary of a measurement set but
    // a published verdict about the route, with its own population, its own
    // reason vocabulary and its own null. Present on every row, measured or not.
    rating,
    steps: bucket.steps,
    sessions: bucket.sessions.size,
    errors: bucket.errors,
    toolErrors: bucket.toolErrors,
    interrupted: bucket.interrupted,
    // Failures per 100 steps. A rate, because a count ranks session length.
    errorRate: bucket.steps > 0 ? (bucket.errors / bucket.steps) * 100 : null,
    modelErrorRate: bucket.steps > 0 ? (bucket.modelErrors / bucket.steps) * 100 : null,
    // The subset a different model would have avoided: a malformed tool call
    // or code that failed to run. Filesystem races and provider faults are
    // excluded on purpose — they are the surroundings, not the model.
    modelErrors: bucket.modelErrors,
    errorCodes: [...bucket.errorCodes]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    errorCategories: [...bucket.errorCategories]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category)),
    ttft: summarize(ttftSorted, average(ttftSorted)),
    speedTps: summarize(speedSorted, average(speedSorted)),
    // The same token count over the whole wait for the answer rather than
    // over the streaming half of it. `speedTps` says how fast a model emits;
    // this says how fast a caller gets tokens, which is the question behind
    // "which model should I use". The gap is the ranking: a model that decodes
    // at 400 tok/s while taking 8 s to start is 2.5x slower in use than a
    // model decoding at 200 tok/s that starts in 0.4 s.
    //
    // Retry dead time is still inside `ttftMs` here, so a flaky route looks
    // slow in this figure too — `ttftClean` is what decomposes that part out.
    e2eTps: summarize(e2eSorted, average(e2eSorted)),
    // Share of the wait spent before the first token, per step then median.
    prefillShare: summarize(prefillSorted, average(prefillSorted)),
    // Time in the step that is neither the wait for the first token nor the
    // provider streaming: what this host is responsible for. Corpus-wide it
    // is 2% of model time, but it is concentrated, and it is the only column
    // whose fix is on this side.
    overheadMs: summarize(overheadSorted, average(overheadSorted)),
    // Tool work, and the two halves of it separately because they answer
    // different questions. `toolCallsPerStep` is how much loop this model's steps
    // involve — a rate over every step, because a model whose steps need no tools
    // should read as zero and not as missing. `toolMs` is what that work cost,
    // summarised over the steps that had any, and it is the tool's time and not
    // the model's: `bash` at 2.7 s a call on this history is the sandbox's
    // running a command, and `ask_user_question` at 519 s a call is a person
    // thinking. `toolCallsTop` is what makes the column readable, because those
    // two are in every row's total and neither is the model's doing.
    toolCalls: bucket.toolCalls,
    toolCallsPerStep: bucket.steps > 0 ? bucket.toolCalls / bucket.steps : null,
    toolStepsUnknown: bucket.toolStepsUnknown,
    toolMs: summarize(toolMsSorted, average(toolMsSorted)),
    toolSeconds: bucket.toolMsSum / 1000,
    toolCallsTop: [...bucket.toolByName]
      .map(([name, entry]) => ({ name, calls: entry.calls, ms: entry.ms }))
      .sort((a, b) => b.ms - a.ms || a.name.localeCompare(b.name)),
    llmMs: summarize(llmSorted, bucket.steps > 0 ? bucket.llmMsSum / bucket.steps : null),
    // First token with the retry dead time subtracted, over the same steps
    // `ttft` covers. Comparing the two medians is how a flaky route is told
    // apart from a slow model.
    ttftClean: summarize(cleanSorted, average(cleanSorted)),
    retrySteps: bucket.retrySteps,
    retryEvents: bucket.retryEvents,
    // Share of the steps that answered which needed a retry to do it. The
    // denominator is the steps that produced a message, not all steps, so a
    // model whose steps usually fail outright is not flattered here.
    retryRate: bucket.steps > 0 ? bucket.retrySteps / bucket.steps : null,
    retryFailedSteps: bucket.retryFailedSteps,
    // null when the row never retried: a row with no retries has no recovery
    // rate, and 1 would read as "everything recovered".
    retryRecovery: retried > 0 ? bucket.retrySteps / retried : null,
    retryBackoffMs: bucket.retryBackoffMs,
    retryDeadMs: summarize(retryDeadSorted, average(retryDeadSorted)),
    retryDeadMsSum: bucket.retryDeadMsSum,
    // Code -> count, descending, so the panel can name the dominant failure
    // without knowing the vocabulary in advance.
    retryCodes: [...bucket.retryCodes]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    // Turn outcomes. `turnsUncleanRate` is over the turns that reached this row,
    // not over its steps, because the two counts answer different questions: a
    // model that takes twenty steps to finish a turn has not failed twenty times.
    // Null when no turn of this row is on record, which is a measurement the row
    // cannot make rather than a rate of zero.
    turns: bucket.turnEnds,
    turnsUnclean: uncleanTurns,
    turnsUncleanRate: bucket.turnEnds > 0 ? uncleanTurns / bucket.turnEnds : null,
    turnEndKinds: [...bucket.turnEndKinds]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
    decodeSeconds: bucket.decodeMsSum / 1000,
    decodeTokens: bucket.decodeTokensSum,
    streamSeconds: bucket.streamMsSum / 1000,
    streamTokens: bucket.streamTokensSum,
    // How many provider-reported tokens one recorded delta fragment carried.
    // ~1 means the provider streams token by token; 30 means it batches, which
    // is why the rate must never be built from fragment counts.
    tokensPerFragment:
      bucket.streamFragmentsSum > 0 ? bucket.streamTokensSum / bucket.streamFragmentsSum : null,
    speedConfidence:
      bucket.spanSamples > 0 ? bucket.speedSamples / bucket.spanSamples : null,
    outputTokens: bucket.outputTokens,
    inputTokens: bucket.inputTokens,
    cacheReadTokens: bucket.cacheReadTokens,
    cacheWriteTokens: bucket.cacheWriteTokens,
    reasoningTokens: bucket.reasoningTokens,
    cacheHitRate: cacheInput > 0 ? bucket.cacheReadTokens / cacheInput : null,
    maxContextTokens: bucket.maxContext,
    firstSeen: bucket.firstSeen,
    lastSeen: bucket.lastSeen,
  }
}

/**
 * The row of one `(provider, model)` pair the history holds nothing for.
 *
 * Every figure comes out unmeasured (`null`, or a zero where the count itself
 * is the measurement), which is what the panel renders as `-`: a model the
 * configuration serves and nobody has run yet is not a model that measured
 * zero, and the two must never read as the same thing. `steps: 0` stays a real
 * zero, because "no step was ever recorded for this pair" is exactly what the
 * fold found — the row is empty of history, not of meaning.
 */
export function unmeasuredRow(provider, model) {
  // A row with no model is a provider roll-up - the provider view's unmeasured
  // row - and has no pair to rate, exactly like a measured provider row. A
  // configured pair the history never served is `no_samples` instead: the pair
  // is real, there is simply nothing behind it yet.
  return finalizeBucket(
    newBucket(provider, model),
    emptyRating(model === null ? 'pair_only' : 'no_samples'),
  )
}

function average(sorted) {
  if (sorted.length === 0) return null
  let sum = 0
  for (const value of sorted) sum += value
  return sum / sorted.length
}

// The tie-break between rows that compare equal: the fastest one first, and a
// row that was never measured last — the same two rules the numbers above
// follow, so a tie cannot put an unmeasured row ahead of a measured one.
function asc(a, b) {
  return (a ?? Infinity) - (b ?? Infinity)
}
