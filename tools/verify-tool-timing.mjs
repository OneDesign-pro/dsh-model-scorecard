// Verify the tool-timing figures folded from the real session corpus.
//
// Usage: node tools/verify-tool-timing.mjs [corpus-dir]
//
// Plan item 6: tool duration is the time between two LLM calls, and it was
// sitting in `pendingCalls` as a map nobody read. Folding it is easy; folding
// it *correctly* is not, and the ways it can be wrong are invisible in the
// output — a duration that silently includes the step's own model time still
// prints a plausible millisecond figure. So the identities are asserted here,
// over the real history, and the table is printed after them.
//
//   1. A tool result lands *after* the `assistant/message` that closed its
//      step. This is what makes the two figures disjoint: `llmMs` and
//      `overheadMs` cover the step's LLM span, and tool time covers what the
//      loop does once that span has ended. If a result ever landed before it,
//      `overhead` would be counting tool time under another name and this tool
//      would be publishing a second copy of it.
//   2. Every answerable call is counted exactly once: the number of spans the
//      fold produced equals the number of (call, result) pairs the raw walk
//      pairs by `callId`, whose step produced a sample.
//   3. No span is negative, and every span names a tool.
//   4. The row's arithmetic holds: calls per step is calls over steps, the time
//      summary is over at most `steps` samples, the seconds total is the sum of
//      the spans, and the per-tool breakdown adds back up to the call count.
//   5. The provider view is the roll-up of its models, as it is for every other
//      figure.
//   6. A log that stops naming steps, or that drops one spelling of the call
//      id, degrades to *unmeasured* rather than to a zero.
//   7. A result that pairs with no open call is explained by `compaction/prune`,
//      session by session, and is never a call the log forgot to commit — which is
//      the claim the pairing comment in `lib/fold.js` makes, and the only thing
//      that keeps it from rotting into a plausible sentence about dropped work.
//   8. The wait is a part of the span and the split is a subtraction: every
//      span's `waitMs` is inside its own `ms`, every row's work plus its wait is
//      the wall time it reports, the per-tool breakdown carries the same wait,
//      and the two columns are over the same steps. The corpus has both halves,
//      so a fold that finds none — the identities in `lib/fold.js`, an approval
//      naming its call and the harness's answer envelope — fails here instead of
//      quietly reporting that nobody ever waited.
//
// A directory of session logs, one JSON event per line, is the input — the
// same corpus `tools/verify-retry.mjs` reads.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { foldSession, aggregate } from '../lib/fold.js'

const CORPUS = process.argv[2] ?? '/tmp/dshcorpus'
if (!existsSync(CORPUS)) {
  console.error(`no corpus at ${CORPUS}`)
  console.error('usage: node tools/verify-tool-timing.mjs [corpus-dir]')
  process.exit(1)
}

const files = readdirSync(CORPUS).filter((name) => name.endsWith('.jsonl'))
if (files.length === 0) {
  // An empty directory used to read as a pass: the fold produced nothing, every
  // assertion below held vacuously, and the tool printed OK. `verify-official`
  // already refuses to pass on a corpus with no completed step for the same
  // reason, and this is the same lie in a second file.
  console.error(`no session logs at ${CORPUS} (${files.length} .jsonl file(s))`)
  console.error('an empty corpus asserts nothing; extract the logs first')
  process.exit(1)
}

const samples = []
const errors = []
const retries = []

// What the raw log says, counted independently of the fold: pairs by `callId`,
// whether each one landed after its step's message, and whether that step
// produced a sample at all.
let callsInLog = 0
let resultsInLog = 0
let resultsWithoutCall = 0
// The three ways a result can pair with no open call, counted apart because they
// mean opposite things: a re-commit is a figure that is *right* (the call was
// already timed), an out-of-order answer or a call the log never recorded is a
// duration that was silently dropped.
let reCommitResults = 0
let outOfOrderResults = 0
let orphanResults = 0
let errorsOnReCommits = 0
let pruneEvents = 0
const pruneMismatches = []
let pairs = 0
let pairsBeforeMessage = 0
let negativeInLog = 0
let pairsOnAnsweredStep = 0
let callsOnUnansweredStep = 0

for (const name of files) {
  const sessionId = name.replace(/\.jsonl$/, '')
  const events = []
  for (const line of readFileSync(join(CORPUS, name), 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      /* torn tail */
    }
  }

  // Every call this log holds, at any position: the walk below is single-pass and
  // in order, so without this set an answer that arrived before its call would be
  // counted as a call that was never made — the two have opposite consequences.
  const recordedCalls = new Set()
  for (const event of events) {
    if (event?.type === 'tool/call' && typeof event.data?.callId === 'string') {
      recordedCalls.add(event.data.callId)
    }
  }

  const open = new Map() // callId -> { time, turn, step }
  const messageAt = new Map() // "turn:step" -> assistant/message time
  const answered = new Set() // callIds this walk has already paired
  let filePrunes = 0
  let fileReCommits = 0
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    const data = event.data
    if (data === null || typeof data !== 'object') continue

    if (event.type === 'tool/call') {
      callsInLog += 1
      if (typeof data.callId === 'string') {
        open.set(data.callId, { time: event.time, turn: data.turn, step: data.step })
      }
      continue
    }
    if (event.type === 'assistant/message') {
      messageAt.set(`${data.turn}:${data.step}`, event.time)
      continue
    }
    if (event.type === 'compaction/prune') {
      pruneEvents += 1
      filePrunes += 1
      continue
    }
    if (event.type !== 'tool/result') continue

    resultsInLog += 1
    const callId = data.message?.source?.callId
    const call = typeof callId === 'string' ? open.get(callId) : undefined
    if (call === undefined) {
      resultsWithoutCall += 1
      if (typeof callId === 'string' && answered.has(callId)) {
        reCommitResults += 1
        fileReCommits += 1
        // The fold counts a failed tool from the *result*, not from the pair, so a
        // re-commit that carried an error would book one failure twice in `err`.
        // None does on this history, which is the difference between a caveat and a
        // defect — and the only way it stays a caveat is by being asserted.
        if (data.error !== null && data.error !== undefined) errorsOnReCommits += 1
      } else if (typeof callId === 'string' && recordedCalls.has(callId)) {
        outOfOrderResults += 1
      } else {
        orphanResults += 1
      }
      continue
    }
    open.delete(callId)
    answered.add(callId)
    pairs += 1
    if (event.time - call.time < 0) negativeInLog += 1
    const closed = messageAt.get(`${call.turn}:${call.step}`)
    if (closed !== undefined && event.time < closed) pairsBeforeMessage += 1
    // A span whose step never answered has no row to land on, so it is
    // deliberately dropped by the fold; a pair on an answered step must be there.
    if (closed !== undefined) pairsOnAnsweredStep += 1
    else callsOnUnansweredStep += 1
  }

  // Session by session and not only in total: a surplus of prunes in one log
  // hidden by a surplus of repeats in another would leave the claim untested.
  if (filePrunes !== fileReCommits) {
    pruneMismatches.push({ name, filePrunes, fileReCommits })
  }

  const folded = foldSession(events, { sessionId })
  for (const sample of folded.samples) samples.push(sample)
  for (const error of folded.errors) errors.push(error)
  for (const failure of folded.retries) retries.push(failure)
}

const report = aggregate(samples, { sort: 'toolTime', errors, retries })
const failures = []

// 7. Every result that pairs with no open call is a re-commit, and the prune events
//    of the same session account for it one for one. Without this the pairing
//    comment in `lib/fold.js` is a story about 647 results; with it, a host that
//    begins answering calls it never recorded — or a prune that stops rewriting a
//    result the fold already timed — fails here instead of shortening a published
//    median quietly, which is the failure mode this whole tool exists for.
if (orphanResults !== 0) {
  failures.push(
    `${orphanResults} result(s) answer a call the log never recorded: those durations are gone, not re-counted`,
  )
}
if (outOfOrderResults !== 0) {
  failures.push(
    `${outOfOrderResults} result(s) arrive before the call they answer: the fold cannot pair them`,
  )
}
if (errorsOnReCommits !== 0) {
  failures.push(
    `${errorsOnReCommits} re-commit(s) carry an error the first answer already booked: one failure counted twice in the err column`,
  )
}
for (const mismatch of pruneMismatches) {
  failures.push(
    `${mismatch.name}: ${mismatch.filePrunes} compaction/prune event(s) against ${mismatch.fileReCommits} re-committed result(s) — pruning is no longer the explanation`,
  )
}

// 3. A span is a number and a name, or it is a defect.
let spans = 0
for (const sample of samples) {
  if (!Array.isArray(sample.toolSpans)) {
    failures.push(`sample ${sample.time} has no toolSpans array`)
    continue
  }
  for (const span of sample.toolSpans) {
    spans += 1
    if (typeof span.name !== 'string' || span.name === '') {
      failures.push(`a span on the step at ${sample.time} names no tool`)
    }
    if (!Number.isFinite(span.ms) || span.ms < 0) {
      failures.push(`a span on the step at ${sample.time} is ${span.ms} ms`)
    }
    // A wait that is not a part of its own span would make the work figure
    // disagree with the wall figure it was subtracted from.
    if (!Number.isFinite(span.waitMs) || span.waitMs < 0 || span.waitMs > span.ms) {
      failures.push(
        `a span on the step at ${sample.time} carries ${span.waitMs} ms of wait inside ${span.ms} ms of call`,
      )
    }
  }
}

// 2. One call, one count.
if (spans !== pairsOnAnsweredStep) {
  failures.push(
    `the fold counted ${spans} tool span(s) where the log pairs ${pairsOnAnsweredStep} ` +
      `call(s) on a step that answered (${pairs} pair(s) total, ${callsOnUnansweredStep} on a step that did not)`,
  )
}
const rowCalls = report.byModel.reduce((sum, row) => sum + row.toolCalls, 0)
if (rowCalls !== spans) {
  failures.push(`the rows carry ${rowCalls} call(s) where the samples carry ${spans}`)
}

// 1. The two spans are disjoint, or `overhead` is a second copy of this column.
if (pairsBeforeMessage > 0) {
  failures.push(
    `${pairsBeforeMessage} tool result(s) landed before their step's assistant/message, ` +
      'which would put tool time inside the step LLM span',
  )
}

// 4 + 5. The row arithmetic.
for (const row of [...report.byModel, ...report.byProvider]) {
  const label = `${row.provider}/${row.model ?? '(roll-up)'}`
  const expected = row.steps > 0 ? row.toolCalls / row.steps : null
  if (row.toolCallsPerStep !== expected) {
    failures.push(`${label}: toolCallsPerStep ${row.toolCallsPerStep} where ${expected} was expected`)
  }
  if (row.toolMs.count > row.steps) {
    failures.push(`${label}: ${row.toolMs.count} tool-time samples over ${row.steps} steps`)
  }
  const topCalls = row.toolCallsTop.reduce((sum, entry) => sum + entry.calls, 0)
  if (topCalls !== row.toolCalls) {
    failures.push(`${label}: the breakdown names ${topCalls} call(s) where the row carries ${row.toolCalls}`)
  }
  const topMs = row.toolCallsTop.reduce((sum, entry) => sum + entry.ms, 0)
  if (Math.abs(topMs / 1000 - row.toolSeconds) > 1e-6) {
    failures.push(`${label}: the breakdown totals ${topMs / 1000} s where the row carries ${row.toolSeconds} s`)
  }
}

const byModelCalls = new Map()
for (const row of report.byModel) {
  byModelCalls.set(row.provider, (byModelCalls.get(row.provider) ?? 0) + row.toolCalls)
}
for (const row of report.byProvider) {
  const summed = byModelCalls.get(row.provider) ?? 0
  if (summed !== row.toolCalls) {
    failures.push(
      `provider ${row.provider}: the roll-up carries ${row.toolCalls} call(s) where its models carry ${summed}`,
    )
  }
}

// 8. The wait split is a subtraction the reader can check, not a discount to be
//    trusted. Every row publishes both halves beside the wall total it came from,
//    and the three have to agree; a wait that grew past the span it belongs to,
//    or a classifier that stopped recognising one of the two identities, would
//    otherwise surface as a plausible milliseconds figure and nothing else. The
//    last check is the one that catches a silent break of the identities
//    themselves: this corpus has both halves, so a run that finds none, or finds
//    the wait eating the whole column, is a defect rather than a quiet history.
let waitSpans = 0
let waitTotal = 0
let rawTotal = 0
for (const sample of samples) {
  for (const span of sample.toolSpans ?? []) {
    rawTotal += span.ms
    if ((span.waitMs ?? 0) > 0) waitSpans += 1
    waitTotal += span.waitMs ?? 0
  }
}
for (const row of [...report.byModel, ...report.byProvider]) {
  const label = `${row.provider}/${row.model ?? '(roll-up)'}`
  if (row.toolCalls === 0) {
    // No call is no measurement: the two figures are `null` and the panel draws
    // `-`, exactly as it does for a median over no samples.
    if (row.toolWorkSeconds !== null || row.toolWaitSeconds !== null) {
      failures.push(
        `${label}: a row with no tool call reports ${row.toolWorkSeconds} s of work and ${row.toolWaitSeconds} s of wait`,
      )
    }
    continue
  }
  const split = (row.toolWorkSeconds ?? 0) + (row.toolWaitSeconds ?? 0)
  if (Math.abs(split - row.toolSeconds) > 1e-6) {
    failures.push(
      `${label}: work ${row.toolWorkSeconds} s + wait ${row.toolWaitSeconds} s is not the ${row.toolSeconds} s of wall time it reports`,
    )
  }
  const topWait = row.toolCallsTop.reduce((sum, entry) => sum + (entry.waitMs ?? 0), 0)
  if (Math.abs(topWait / 1000 - (row.toolWaitSeconds ?? 0)) > 1e-6) {
    failures.push(
      `${label}: the breakdown carries ${topWait / 1000} s of wait where the row carries ${row.toolWaitSeconds} s`,
    )
  }
  if (row.toolWorkMs.count !== row.toolMs.count) {
    failures.push(
      `${label}: ${row.toolWorkMs.count} work sample(s) against ${row.toolMs.count} wall sample(s) — the two columns are not over the same steps`,
    )
  }
}
if (rawTotal > 0 && (waitTotal <= 0 || waitTotal >= rawTotal)) {
  failures.push(
    `the corpus carries ${(waitTotal / 1000).toFixed(0)} s of wait inside ${(rawTotal / 1000).toFixed(0)} s of tool time: one of the two identities stopped being recognised`,
  )
}

// 6. What a Harness update must not do. The plugin never asks the Harness to
// change, so the log it reads is the log it gets — and a field it stops
// publishing has to cost this column its measurement, not quietly turn it into
// a zero that reads as "this model needs no tools".
//
// Three event shapes that a future release could plausibly produce, folded here
// through the real `foldSession` because the failure is in the fold and no
// corpus fixture would ever contain it.
const SHAPE_SOURCE = { provider: 'shape', model: 'shape' }

/**
 * One answered call. `messageIdentity` and `callIdentity` drop the step
 * identity from the two sides independently, because the two failures are
 * different: a log that stops naming a step on the call loses the measurement,
 * and a log that stops naming it anywhere piles the whole session's tool time
 * onto whichever step claims the key first.
 */
function shapedCall({ callId, name, from, to, spell, messageIdentity = true, callIdentity = true }) {
  const message = messageIdentity ? { turn: 1, step: 1 } : {}
  const call = callIdentity ? { turn: 1, step: 1 } : {}
  return [
    { type: 'step/start', time: from - 100, data: { ...message } },
    {
      type: 'assistant/message',
      time: from,
      data: {
        ...message,
        message: { source: SHAPE_SOURCE },
        usage: { outputTokens: 10 },
        stream: [],
      },
    },
    { type: 'tool/call', time: from, data: { ...call, callId, name: name ?? 'read' } },
    {
      type: 'tool/result',
      time: to,
      data: {
        ...call,
        message:
          spell === 'flat'
            ? { role: 'tool', toolCallId: callId, content: [] }
            : { role: 'tool', source: { kind: 'tool', callId }, content: [] },
        error: null,
      },
    },
  ]
}

const unnamed = foldSession(
  shapedCall({ callId: 'c1', name: 'bash', from: 1_000, to: 1_400, callIdentity: false }),
  { sessionId: 'shape-unnamed' },
)
if (unnamed.samples.length !== 1) {
  failures.push(`the unnamed-step fixture folded ${unnamed.samples.length} sample(s), not one`)
} else if (unnamed.samples[0].toolSpans !== null) {
  failures.push(
    'a call whose step the log does not name was filed on a step anyway: its spans are ' +
      `${JSON.stringify(unnamed.samples[0].toolSpans)} where the step must read unknown`,
  )
} else {
  const row = aggregate(unnamed.samples, { sort: 'steps' }).byModel[0]
  if (row.toolStepsUnknown !== 1 || row.toolCalls !== 0 || row.toolMs.count !== 0) {
    failures.push(
      `the unnamed-step row reports unknown=${row.toolStepsUnknown}, calls=${row.toolCalls}, ` +
        `time n=${row.toolMs.count} where 1/0/0 is the only honest answer`,
    )
  }
}

// The worse half of the same failure: a log that names no step anywhere puts
// every call in the session under one key, and without the guard the first
// sample to claim that key inherits the whole session's tool time — a figure
// that is measured, confident and wrong, which is the only shape this plugin
// treats as worse than no figure at all.
const anonymous = foldSession(
  [
    ...shapedCall({ callId: 'c0a', name: 'bash', from: 500, to: 700, messageIdentity: false, callIdentity: false }),
    ...shapedCall({ callId: 'c0b', name: 'read', from: 800, to: 1_100, messageIdentity: false, callIdentity: false }),
  ],
  { sessionId: 'shape-anonymous' },
)
for (const sample of anonymous.samples) {
  if (sample.toolSpans === null) continue
  failures.push(
    `a step in a log that names no steps carries ${JSON.stringify(sample.toolSpans)} ` +
      'of another step’s tool time',
  )
}

const flat = foldSession(
  shapedCall({ callId: 'c2', name: 'bash', from: 2_000, to: 2_900, spell: 'flat' }),
  { sessionId: 'shape-flat' },
)
if (flat.samples[0]?.toolSpans?.[0]?.ms !== 900) {
  failures.push(
    'the flat `toolCallId` spelling of a call id was not paired: ' +
      `${JSON.stringify(flat.samples[0]?.toolSpans)} where one 900 ms span was expected`,
  )
}

const control = foldSession(
  shapedCall({ callId: 'c3', name: 'bash', from: 3_000, to: 3_300 }),
  { sessionId: 'shape-control' },
)
if (control.samples[0]?.toolSpans?.[0]?.ms !== 300 || control.samples[0].toolStepsUnknown !== undefined) {
  failures.push(
    'the guard broke the ordinary case: ' +
      `${JSON.stringify(control.samples[0]?.toolSpans)} where one 300 ms span was expected`,
  )
}

console.log(`corpus: ${files.length} log(s), ${samples.length} step sample(s)`)
console.log(`tool/call ${callsInLog}, tool/result ${resultsInLog}, paired by callId ${pairs}`)
console.log(
  `results with no open call ${resultsWithoutCall} — re-committed after compaction ${reCommitResults} (their call was already timed), ` +
    `answered before the call ${outOfOrderResults}, naming a call never recorded ${orphanResults}`,
)
console.log(
  `compaction/prune events ${pruneEvents}, sessions where they do not match the re-commits ${pruneMismatches.length}, re-commits carrying an error ${errorsOnReCommits}`,
)
console.log(`negative durations in the log ${negativeInLog}`)
console.log(
  `spans carrying a wait ${waitSpans} of ${spans}: ${(waitTotal / 1000).toFixed(0)} s of a person, ` +
    `${((rawTotal - waitTotal) / 1000).toFixed(0)} s of work`,
)
console.log(`pairs on a step that answered ${pairsOnAnsweredStep}, on one that did not ${callsOnUnansweredStep}`)
console.log(`pairs landing before their step's assistant/message ${pairsBeforeMessage}`)
console.log('')

const head = [
  'provider/model',
  'steps',
  'calls',
  'calls/step',
  'tool_med',
  'tool_p90',
  'tool_s',
  'slowest tools',
]
const table = report.byModel
  .filter((row) => row.toolCalls > 0)
  .sort((a, b) => b.toolSeconds - a.toolSeconds)
  .map((row) => [
    `${row.provider}/${row.model}`,
    String(row.steps),
    String(row.toolCalls),
    row.toolCallsPerStep === null ? '-' : row.toolCallsPerStep.toFixed(2),
    row.toolMs.median === null ? '-' : String(Math.round(row.toolMs.median)),
    row.toolMs.p90 === null ? '-' : String(Math.round(row.toolMs.p90)),
    row.toolSeconds.toFixed(0),
    row.toolCallsTop
      .slice(0, 3)
      .map((entry) => `${entry.name}×${entry.calls}/${(entry.ms / 1000).toFixed(0)}s`)
      .join(' '),
  ])
const widths = head.map((name, index) =>
  Math.max(name.length, ...table.map((line) => line[index].length)),
)
const pad = (value, index) => (index === 0 ? value.padEnd(widths[index]) : value.padStart(widths[index]))
console.log(head.map(pad).join('  '))
for (const line of table) console.log(line.map(pad).join('  '))

console.log('')
if (failures.length === 0) {
  console.log('OK: every answerable tool call is counted once, every span is a real span,')
  console.log('    and no tool time overlaps the step LLM span the other columns measure.')
} else {
  for (const failure of failures) console.log(`FAIL: ${failure}`)
  process.exitCode = 1
}