// Verify the step-level identities folded from the real session corpus.
//
// Usage: node tools/verify-retry.mjs [corpus-dir]
//
// This is the only tool that runs over the real history rather than a fixture,
// so it is where the claims README makes about a *corpus* are checked — the
// ones a synthetic fixture cannot prove because the fixture is what makes them
// true. Seven things are asserted, then the table is printed:
//
//   1. The dead-time identity never produces a negative `ttftCleanMs`. If the
//      definition of dead time were wrong — a bad timestamp, a retry that
//      belongs to another step — the subtraction would go below zero, and a
//      clamped value would hide it.
//   2. A step that never retried has no clean figure of its own, and is
//      counted as such (`ttftCleanMs === null`).
//   3. Every retry event in the corpus lands in exactly one bucket: recovered
//      steps plus exhausted steps.
//   4. `retryRate` never exceeds 1, and `retryRecovery` is never 1 for a row
//      that gave a step up.
//   5. `overheadMs` is never negative, which is what "the step's wall time is at
//      least its wait plus its streaming" looks like in a real log.
//   6. The end-to-end rate never exceeds the streaming rate, and its prefill
//      share stays inside [0, 1) — the two are the same numerator over a larger
//      denominator, and a log that broke that would mean a folded span is
//      reaching past the message that closed it.
//   7. Every tool error is attributed. This is the item-1 bug: they all used to
//      reach `aggregate` labelled `unknown/unknown` and be dropped.
//
// A file of session logs, one JSON event per line, is the input. The default is
// the same directory the analysis scripts use.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  foldSession,
  aggregate,
  SPEED_QUALIFICATION,
  ERROR_CATEGORY_NAMES,
} from '../lib/fold.js'

const CORPUS = process.argv[2] ?? '/tmp/dshcorpus'
if (!existsSync(CORPUS)) {
  console.error(`no corpus at ${CORPUS}`)
  console.error('usage: node tools/verify-retry.mjs [corpus-dir]')
  process.exit(1)
}

const files = readdirSync(CORPUS).filter((name) => name.endsWith('.jsonl'))
if (files.length === 0) {
  // An empty directory passes every assertion below without asserting anything:
  // the fold produces no samples, the checks compare empty lists, and the tool
  // prints OK. That is the failure `verify-official` already refuses — an
  // unverifiable run must not read as a pass — and it is not hypothetical: the
  // corpus at the default path had been emptied by /tmp between two runs, and
  // this tool stayed green for as long as nobody counted its output rows.
  console.error(`no session logs at ${CORPUS} (${files.length} .jsonl file(s))`)
  console.error('an empty corpus asserts nothing; extract the logs first')
  process.exit(1)
}
const samples = []
const errors = []
const retries = []
let events = 0
let retryEventsInLog = 0

for (const name of files) {
  const sessionId = name.replace(/\.jsonl$/, '')
  const lines = []
  for (const line of readFileSync(join(CORPUS, name), 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      lines.push(JSON.parse(trimmed))
    } catch {
      /* torn tail */
    }
  }
  events += lines.length
  for (const line of lines) if (line?.type === 'llm/retry') retryEventsInLog += 1
  const folded = foldSession(lines, { sessionId })
  for (const sample of folded.samples) samples.push(sample)
  for (const error of folded.errors) errors.push(error)
  for (const failure of folded.retries) retries.push(failure)
}

const report = aggregate(samples, { sort: 'steps', errors, retries })
const failures = []

// 7: every tool error must name a model. All of them used to arrive as
// `unknown/unknown` and be dropped by the aggregate, which is what made the
// `err` column read zero for every row.
const unattributedErrors = errors.filter(
  (error) => error.provider === null || error.model === null,
)
if (unattributedErrors.length > 0) {
  failures.push(`${unattributedErrors.length} of ${errors.length} tool error(s) name no model`)
}

// 1 + 2: the identity, and the absence of a clean figure on an unretried step.
let negative = 0
let dirtyUnretried = 0
let cleanOnUnretried = 0
let retriedWithNoClean = 0
for (const sample of samples) {
  if (sample.ttftCleanMs !== null && sample.ttftCleanMs < 0) negative += 1
  if ((sample.retryCount ?? 0) === 0) {
    if (sample.ttftCleanMs !== null) cleanOnUnretried += 1
    if (sample.retryDeadMs !== null) dirtyUnretried += 1
  } else if (sample.ttftCleanMs === null && sample.ttftMs !== null) {
    retriedWithNoClean += 1
  }
}
if (negative > 0) failures.push(`${negative} step(s) produced a negative ttftCleanMs`)
if (cleanOnUnretried > 0) failures.push(`${cleanOnUnretried} unretried step(s) carry a ttftCleanMs`)
if (dirtyUnretried > 0) failures.push(`${dirtyUnretried} unretried step(s) carry a retryDeadMs`)
if (retriedWithNoClean > 0) {
  failures.push(`${retriedWithNoClean} retried step(s) with a ttft have no ttftCleanMs`)
}

// 3: no retry event may fall on the floor, and none may be counted twice.
//
// The provider view is exact — `llm/retry` names its own provider — so every
// event must reach a provider row. The model view is best effort: a step whose
// retries never recovered carries no model, and it is attributed only when that
// provider spoke earlier in the same session. Whatever is left over is
// reported, not hidden, and must stay a small minority of the exhausted steps.
const foldedRetries = samples.reduce((sum, s) => sum + (s.retryCount ?? 0), 0)
const givenUpRetries = retries.reduce((sum, r) => sum + r.retryCount, 0)
const unattributed = retries.filter((r) => r.model === null)
const countedByProvider = report.byProvider.reduce((sum, row) => sum + row.retryEvents, 0)
const countedByModel = report.byModel.reduce((sum, row) => sum + row.retryEvents, 0)
const attributable = foldedRetries + retries.reduce((sum, r) => sum + (r.model === null ? 0 : r.retryCount), 0)
if (foldedRetries + givenUpRetries !== retryEventsInLog) {
  failures.push(
    `retry events: ${retryEventsInLog} in the log, ${foldedRetries} on recovered steps + ` +
      `${givenUpRetries} on exhausted steps`,
  )
}
if (countedByProvider !== foldedRetries + givenUpRetries) {
  failures.push(
    `retry events: ${countedByProvider} reached provider rows, ${foldedRetries + givenUpRetries} were folded`,
  )
}
if (countedByModel !== attributable) {
  failures.push(`retry events: ${countedByModel} reached model rows, ${attributable} were attributable`)
}
if (unattributed.length > givenUpRetries / 2) {
  failures.push(
    `${unattributed.length} of ${givenUpRetries} exhausted step(s) could not be attributed to a model`,
  )
}

// 5 + 6: the derived step identities, on the real history.
const Q = SPEED_QUALIFICATION
let negativeOverhead = 0
let e2eAboveStream = 0
let shareOutOfRange = 0
let overheadSamples = 0
const allShares = []
for (const row of report.byModel) {
  if (row.overheadMs.count > 0) {
    overheadSamples += row.overheadMs.count
    if (row.overheadMs.min < 0) negativeOverhead += 1
  }
  if (row.e2eTps.count === 0) continue
  if (row.e2eTps.max > row.speedTps.max + 1e-9) e2eAboveStream += 1
  if (row.prefillShare.min < 0 || row.prefillShare.max >= 1) shareOutOfRange += 1
}
// The corpus-wide prefill share, which is the claim README makes: most of the
// wait for a first answer is spent before the first token.
for (const sample of samples) {
  if (
    sample.streamMs === null ||
    sample.streamFragments === null ||
    sample.streamTokens === null ||
    sample.ttftMs === null ||
    sample.streamMs < Q.minSpanMs ||
    sample.streamTokens < Q.minTokens ||
    sample.streamFragments < Q.minFragments
  ) {
    continue
  }
  allShares.push(sample.ttftMs / (sample.ttftMs + sample.streamMs))
}
allShares.sort((a, b) => a - b)
const at = (fraction) =>
  allShares.length === 0
    ? '-'
    : allShares[Math.min(allShares.length - 1, Math.floor(allShares.length * fraction))].toFixed(2)
const prefillSummary = `p10 ${at(0.1)} · median ${at(0.5)} · p90 ${at(0.9)} (n=${allShares.length})`
if (negativeOverhead > 0) {
  failures.push(`${negativeOverhead} model row(s) report a negative minimum overhead`)
}
if (e2eAboveStream > 0) {
  failures.push(`${e2eAboveStream} model row(s) report an end-to-end rate above their streaming rate`)
}
if (shareOutOfRange > 0) {
  failures.push(`${shareOutOfRange} model row(s) report a prefill share outside [0, 1)`)
}

// The category vocabulary, against the codes this history actually produced.
// Two failures are possible and both are real: a category the classifier can
// emit that the corpus never exercises is one nobody has checked, and a
// category the corpus produces that is not in the vocabulary is a code the
// classifier sent somewhere nobody planned. The second is how `FS_SANDBOX_DENIED`
// was caught being filed as a filesystem state race rather than a denial.
const seenCategories = new Set(
  report.byModel.flatMap((row) => row.errorCategories.map((entry) => entry.category)),
)
const unknown = [...seenCategories].filter((name) => !ERROR_CATEGORY_NAMES.includes(name))
const unused = ERROR_CATEGORY_NAMES.filter((name) => !seenCategories.has(name))
if (unknown.length > 0) failures.push(`error category outside the vocabulary: ${unknown.join(', ')}`)
for (const row of report.byModel) {
  if (row.retryRate !== null && row.retryRate > 1) {
    failures.push(`${row.provider}/${row.model} reports retryRate ${row.retryRate}`)
  }
  if (row.retryFailedSteps > 0 && row.retryRecovery === 1) {
    failures.push(`${row.provider}/${row.model} recovered every retried step despite giving some up`)
  }
  if (row.retrySteps > 0 && row.retryDeadMs.count !== row.retrySteps) {
    failures.push(
      `${row.provider}/${row.model} folded ${row.retrySteps} retried step(s) but summarised ` +
        `${row.retryDeadMs.count} dead time(s)`,
    )
  }
}

console.log(`corpus        : ${CORPUS} (${files.length} session log(s), ${events} events)`)
console.log(`steps folded  : ${samples.length}`)
console.log(`tool errors   : ${errors.length} (${errors.length - unattributedErrors.length} named a model)`)
console.log('')
console.log('retry events  :', retryEventsInLog)
console.log('  recovered   :', foldedRetries, `on ${samples.filter((s) => (s.retryCount ?? 0) > 0).length} step(s)`)
console.log('  gave up     :', givenUpRetries, `on ${retries.length} step(s)`)
console.log('  unattributed:', unattributed.length, 'exhausted step(s) had no model to name')
console.log('  by provider :', countedByProvider, 'by model:', countedByModel)
console.log('')
console.log('derived       :', overheadSamples, 'overhead sample(s),',
  report.byModel.reduce((sum, row) => sum + row.e2eTps.count, 0), 'end-to-end rate sample(s)')
console.log('prefill share :', prefillSummary)
console.log('error categories:', seenCategories.size, 'of', ERROR_CATEGORY_NAMES.length,
  'exercised' + (unused.length === 0 ? ' (all)' : `, unused: ${unused.join(', ')}`))
console.log('')

const codes = new Map()
for (const row of report.byModel) {
  for (const entry of row.retryCodes) codes.set(entry.code, (codes.get(entry.code) ?? 0) + entry.count)
}
console.log('failure codes :')
for (const [code, count] of [...codes].sort((a, b) => b[1] - a[1])) {
  console.log('   ', code.padEnd(16), count)
}

const head = [
  'provider/model',
  'steps',
  'retry%',
  'ttft_med',
  'ttft_clean',
  'dead_p50',
  'dead_p90',
  'recovered',
  'gave_up',
  'codes',
]
const table = report.byModel
  .filter((row) => row.retrySteps > 0 || row.retryFailedSteps > 0)
  .sort((a, b) => b.retryEvents - a.retryEvents)
  .map((row) => [
    `${row.provider}/${row.model}`,
    String(row.steps),
    row.retryRate === null ? '-' : (row.retryRate * 100).toFixed(1),
    row.ttft.median === null ? '-' : String(Math.round(row.ttft.median)),
    row.ttftClean.median === null ? '-' : String(Math.round(row.ttftClean.median)),
    row.retryDeadMs.median === null ? '-' : String(Math.round(row.retryDeadMs.median)),
    row.retryDeadMs.p90 === null ? '-' : String(Math.round(row.retryDeadMs.p90)),
    row.retryRecovery === null ? '-' : `${Math.round(row.retryRecovery * 100)}%`,
    String(row.retryFailedSteps),
    row.retryCodes.slice(0, 3).map((entry) => `${entry.code}x${entry.count}`).join(' '),
  ])
const widths = head.map((name, index) =>
  Math.max(name.length, ...table.map((line) => line[index].length)),
)
const pad = (value, index) => (index === 0 ? value.padEnd(widths[index]) : value.padStart(widths[index]))
console.log('')
console.log(head.map(pad).join('  '))
for (const line of table) console.log(line.map(pad).join('  '))

console.log('')
if (failures.length === 0) {
  console.log(
    'OK: every tool error is attributed, every retry event is accounted for exactly once,',
  )
  console.log('    and no derived step figure is out of bounds on this corpus.')
} else {
  for (const failure of failures) console.log(`FAIL: ${failure}`)
  process.exitCode = 1
}
