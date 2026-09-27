// dsh-model-stats - metric folding core.
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

/**
 * A streaming span must carry at least this much time and this many tokens
 * before it counts as a throughput sample. Below it, one packed burst would
 * divide into an implausible rate (a single tool-call run can "stream" at
 * thousands of tokens per second and would poison the model's average).
 */
const MIN_SPEED_SPAN_MS = 100
const MIN_SPEED_TOKENS = 8

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
 */
function streamTokenSpan(stream) {
  if (!Array.isArray(stream)) return { first: undefined, last: undefined, tokens: 0 }
  let first
  let last
  let tokens = 0
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
      tokens += 1
      continue
    }
    const run = runFirstTokenTime(record)
    const end = runLastMemberTime(record)
    if (run !== undefined && first === undefined) first = run
    if (end.last !== undefined) last = end.last
    tokens += end.count
  }
  return { first, last, tokens }
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
 * Fold one session's committed events.
 *
 * @returns `{ samples, errors, turns, steps }` where each sample is one
 * assembled assistant message carrying its provider/model attribution.
 */
export function foldSession(events, options = {}) {
  const sessionId = options.sessionId ?? null
  const samples = []
  const errors = []

  let openStep = null
  let firstTokenTime = null
  const pendingCalls = new Map()
  let lastTurn = null
  let turns = 0
  let steps = 0

  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    const data = event.data
    if (data === null || typeof data !== 'object') continue

    switch (event.type) {
      case 'step/start':
        openStep = { turn: data.turn, step: data.step, startTime: event.time }
        firstTokenTime = null
        break

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

        samples.push({
          sessionId,
          time: event.time,
          provider: typeof source.provider === 'string' ? source.provider : 'unknown',
          model: typeof source.model === 'string' ? source.model : 'unknown',
          llmMs: Math.max(0, event.time - openStep.startTime),
          ttftMs: first === null ? null : Math.max(0, first - openStep.startTime),
          decodeMs:
            first === null || outputTokens === null ? null : Math.max(0, event.time - first),
          // Provider-only streaming span: the honest basis for tokens/second.
          streamMs:
            span.first === undefined || span.last === undefined || span.last <= span.first
              ? null
              : span.last - span.first,
          streamTokens: span.tokens > 0 ? span.tokens : null,
          outputTokens,
          inputTokens: usage === null ? null : numOrNull(usage.inputTokens),
          cacheReadTokens: usage === null ? null : numOrNull(usage.cacheReadTokens),
          cacheWriteTokens: usage === null ? null : numOrNull(usage.cacheWriteTokens),
          reasoningTokens: usage === null ? null : numOrNull(usage.reasoningTokens),
          interrupted: data.interrupted === true,
        })

        openStep = null
        firstTokenTime = null
        break
      }

      case 'tool/call':
        if (typeof data.callId === 'string') pendingCalls.set(data.callId, event.time)
        break

      case 'tool/result': {
        const callId = data.message?.source?.callId
        if (typeof callId === 'string') pendingCalls.delete(callId)
        // A failed tool is a stability signal for the model that raised it.
        if (data.error !== null && data.error !== undefined) {
          errors.push({
            provider: null,
            model: null,
            time: event.time,
            kind: 'tool',
            code: typeof data.error.code === 'string' ? data.error.code : 'tool-error',
            name: typeof data.error.name === 'string' ? data.error.name : null,
          })
        }
        break
      }

      case 'step/end':
        turns = lastTurn === data.turn ? turns : turns + 1
        lastTurn = data.turn
        steps += 1
        openStep = null
        firstTokenTime = null
        break

      case 'turn/end':
        pendingCalls.clear()
        break

      default:
        break
    }
  }

  return { samples, errors, turns, steps }
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
    ttft: [],
    speed: [],
    llm: [],
    decodeMsSum: 0,
    decodeTokensSum: 0,
    streamMsSum: 0,
    streamTokensSum: 0,
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
    sessions: new Set(),
    firstSeen: null,
    lastSeen: null,
    maxContext: 0,
  }
}

/**
 * Turn per-step samples plus attributed errors into the aggregated report.
 *
 * @param samples - step samples from {@link foldSession}.
 * @param options.errors - `{ provider, model, kind }` records.
 * @param options.sort - `steps` | `ttft` | `speed` | `errors` | `lastSeen`.
 */
export function aggregate(samples, options = {}) {
  const byModel = new Map()
  const byProvider = new Map()
  const sessions = new Set()
  const errors = Array.isArray(options.errors) ? options.errors : []

  const bucketFor = (map, provider, model) => {
    const key = `${provider}\u0000${model}`
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
      const bucket = bucketFor(map, sample.provider, sample.model)
      bucket.steps += 1
      bucket.sessions.add(sample.sessionId)
      bucket.llmMsSum += sample.llmMs ?? 0
      bucket.llm.push(sample.llmMs ?? 0)
      bucket.outputTokens += sample.outputTokens ?? 0
      bucket.inputTokens += sample.inputTokens ?? 0
      bucket.cacheReadTokens += sample.cacheReadTokens ?? 0
      bucket.cacheWriteTokens += sample.cacheWriteTokens ?? 0
      bucket.reasoningTokens += sample.reasoningTokens ?? 0
      if (sample.interrupted === true) bucket.interrupted += 1

      const context =
        (sample.inputTokens ?? 0) + (sample.cacheReadTokens ?? 0) + (sample.cacheWriteTokens ?? 0)
      if (context > bucket.maxContext) bucket.maxContext = context

      if (sample.ttftMs !== null && sample.ttftMs !== undefined) {
        bucket.ttft.push(sample.ttftMs)
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
      const hasSpan =
        sample.streamMs !== null &&
        sample.streamMs !== undefined &&
        sample.streamTokens !== null &&
        sample.streamTokens !== undefined
      if (hasSpan && sample.streamMs > 0 && sample.streamTokens > 1) {
        bucket.streamMsSum += sample.streamMs
        bucket.streamTokensSum += sample.streamTokens
        if (sample.streamMs >= MIN_SPEED_SPAN_MS && sample.streamTokens >= MIN_SPEED_TOKENS) {
          bucket.speed.push((sample.streamTokens * 1000) / sample.streamMs)
          bucket.speedSamples += 1
        }
      }
      if (hasSpan) bucket.spanSamples += 1
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
    for (const map of [byModel, byProvider]) {
      const bucket = map.get(`${provider}\u0000${model}`)
      if (bucket === undefined) continue
      bucket.errors += 1
      if (error.kind === 'tool') bucket.toolErrors += 1
    }
  }

  const finalize = (bucket) => {
    const ttftSorted = bucket.ttft.slice().sort((a, b) => a - b)
    const speedSorted = bucket.speed.slice().sort((a, b) => a - b)
    const llmSorted = bucket.llm.slice().sort((a, b) => a - b)
    const cacheInput = bucket.inputTokens + bucket.cacheReadTokens
    return {
      provider: bucket.provider,
      model: bucket.model,
      steps: bucket.steps,
      sessions: bucket.sessions.size,
      errors: bucket.errors,
      toolErrors: bucket.toolErrors,
      interrupted: bucket.interrupted,
      ttft: summarize(ttftSorted, average(ttftSorted)),
      speedTps: summarize(speedSorted, average(speedSorted)),
      llmMs: summarize(llmSorted, bucket.steps > 0 ? bucket.llmMsSum / bucket.steps : null),
      decodeSeconds: bucket.decodeMsSum / 1000,
      decodeTokens: bucket.decodeTokensSum,
      streamSeconds: bucket.streamMsSum / 1000,
      streamTokens: bucket.streamTokensSum,
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

  const byModels = [...byModel.values()].map(finalize)
  const byProviders = [...byProvider.values()].map(finalize)

  const comparators = {
    steps: (a, b) => b.steps - a.steps,
    ttft: (a, b) => asc(a.ttft.mean, b.ttft.mean),
    speed: (a, b) => desc(a.speedTps.mean, b.speedTps.mean),
    errors: (a, b) => b.errors - a.errors || desc(a.ttft.mean, b.ttft.mean),
    lastSeen: (a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0),
  }
  const comparator = comparators[options.sort] ?? comparators.steps
  byModels.sort(comparator)
  byProviders.sort(comparator)

  return {
    sessionsScanned: sessions.size,
    steps: byModels.reduce((sum, entry) => sum + entry.steps, 0),
    errors: byModels.reduce((sum, entry) => sum + entry.errors, 0),
    providers: byProviders.length,
    models: byModels.length,
    byModel: byModels,
    byProvider: byProviders,
  }
}

function average(sorted) {
  if (sorted.length === 0) return null
  let sum = 0
  for (const value of sorted) sum += value
  return sum / sorted.length
}

function asc(a, b) {
  return (a ?? Infinity) - (b ?? Infinity)
}

function desc(a, b) {
  return (b ?? -Infinity) - (a ?? -Infinity)
}
