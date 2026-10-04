// Verify the turn-outcome figures folded from the real session corpus.
//
// Usage: node tools/verify-turn-ends.mjs [corpus-dir]
//
// `turn/end` carries `reason.kind` — why the conversation stopped — and the fold
// used to parse it and throw it away, keeping only the `pendingCalls` clear on
// the same event. Folding a field that a column can read is what makes it
// testable, and three things about it are worth asserting over real history
// rather than a fixture:
//
//   1. One turn, one record, and only for a turn that reached a model. A turn
//      that ended before any model spoke keeps no row: 61 of 1 002 on this
//      history, and every one of them would otherwise have been filed under
//      whatever model spoke in the previous turn.
//   2. The kinds add up. `turns` is the breakdown's total, `turnsUnclean` plus the
//      completed count is `turns` again, and the rate is their quotient — so a
//      future kind cannot be counted in one place and forgotten in another.
//   3. The vocabulary is not one word. A fold that recorded `kind` and only ever
//      saw `completed` would pass every assertion above and publish a column of
//      zeroes; so the corpus has to exercise more than one kind, or this tool
//      says it cannot verify.
//
// The provider view must be the roll-up of its models here as well.
//
// A directory of session logs, one JSON event per line, is the input — the same
// corpus `tools/verify-retry.mjs` reads.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { foldSession, aggregate } from '../lib/fold.js'

const CORPUS = process.argv[2] ?? '/tmp/dshcorpus'
if (!existsSync(CORPUS)) {
  console.error(`no corpus at ${CORPUS}`)
  console.error('usage: node tools/verify-turn-ends.mjs [corpus-dir]')
  process.exit(1)
}

const files = readdirSync(CORPUS).filter((name) => name.endsWith('.jsonl'))
if (files.length === 0) {
  console.error(`no session logs at ${CORPUS} (${files.length} .jsonl file(s))`)
  console.error('an empty corpus asserts nothing; extract the logs first')
  process.exit(1)
}

const samples = []
const errors = []
const retries = []
const turnEnds = []

// What the log says, counted without the fold.
let turnEndEvents = 0
let turnEndEventsWithSpeaker = 0
let turnEndEventsWithoutSpeaker = 0
const kindsInLog = new Map()

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

  let speaker = false
  for (const event of events) {
    if (event?.type === 'assistant/message') speaker = true
    if (event?.type !== 'turn/end') continue
    turnEndEvents += 1
    const kind = typeof event.data?.reason?.kind === 'string' ? event.data.reason.kind : 'unknown'
    kindsInLog.set(kind, (kindsInLog.get(kind) ?? 0) + 1)
    if (speaker) turnEndEventsWithSpeaker += 1
    else turnEndEventsWithoutSpeaker += 1
    speaker = false
  }

  const folded = foldSession(events, { sessionId })
  for (const sample of folded.samples) samples.push(sample)
  for (const error of folded.errors) errors.push(error)
  for (const failure of folded.retries) retries.push(failure)
  for (const turn of folded.turnEnds) turnEnds.push(turn)
}

const report = aggregate(samples, {
  sort: 'steps',
  errors,
  retries,
  turnEnds,
})
const failures = []

if (turnEnds.length !== turnEndEventsWithSpeaker) {
  failures.push(
    `the fold kept ${turnEnds.length} turn record(s) where the log has ${turnEndEventsWithSpeaker} ` +
      `turn/end event(s) that reached a model (of ${turnEndEvents} in total, ` +
      `${turnEndEventsWithoutSpeaker} with no model in them)`,
  )
}
for (const turn of turnEnds) {
  if (typeof turn.kind !== 'string' || turn.kind === '') {
    failures.push(`a turn at ${turn.time} names no kind`)
  }
}

if (kindsInLog.size < 2) {
  // Refuse rather than pass. One kind means this corpus cannot show the
  // distinction the figures exist for, so every check above would hold on a
  // column of identical values.
  console.error(`the corpus exercises ${kindsInLog.size} turn-end kind(s); at least 2 are needed to verify`)
  process.exit(1)
}

for (const row of [...report.byModel, ...report.byProvider]) {
  const label = `${row.provider}/${row.model ?? '(roll-up)'}`
  const byKind = row.turnEndKinds.reduce((sum, entry) => sum + entry.count, 0)
  if (byKind !== row.turns) {
    failures.push(`${label}: the breakdown totals ${byKind} turn(s) where the row carries ${row.turns}`)
  }
  const completed = row.turnEndKinds.find((entry) => entry.kind === 'completed')?.count ?? 0
  if (completed + row.turnsUnclean !== row.turns) {
    failures.push(
      `${label}: ${completed} completed + ${row.turnsUnclean} unclean is not ${row.turns} turn(s)`,
    )
  }
  const expected = row.turns > 0 ? row.turnsUnclean / row.turns : null
  if (row.turnsUncleanRate !== expected) {
    failures.push(`${label}: the rate is ${row.turnsUncleanRate} where ${expected} was expected`)
  }
  // Sorted by count, then by name — the same order as the code and retry
  // breakdowns, so a reader scanning two of them reads them the same way.
  const sorted = [...row.turnEndKinds].sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind))
  if (JSON.stringify(sorted) !== JSON.stringify(row.turnEndKinds)) {
    failures.push(`${label}: the breakdown is not sorted the way the others are`)
  }
}

const byModelTurns = new Map()
for (const row of report.byModel) {
  byModelTurns.set(row.provider, (byModelTurns.get(row.provider) ?? 0) + row.turns)
}
for (const row of report.byProvider) {
  const summed = byModelTurns.get(row.provider) ?? 0
  if (summed !== row.turns) {
    failures.push(`provider ${row.provider}: the roll-up carries ${row.turns} turn(s) where its models carry ${summed}`)
  }
}

console.log(`corpus: ${files.length} log(s), ${samples.length} step sample(s)`)
console.log(`turn/end events ${turnEndEvents}, of which ${turnEndEventsWithSpeaker} reached a model`)
console.log(`turns with no model in them (kept on no row) ${turnEndEventsWithoutSpeaker}`)
console.log(`turn records folded ${turnEnds.length}`)
console.log('')
console.log('kinds in the log:')
for (const [kind, count] of [...kindsInLog].sort((a, b) => b[1] - a[1])) {
  console.log(`   ${kind.padEnd(14)} ${count}`)
}

const head = ['provider/model', 'steps', 'turns', 'unclean', 'unclean%', 'kinds']
const table = report.byModel
  .filter((row) => row.turns > 0)
  .sort((a, b) => b.turns - a.turns)
  .map((row) => [
    `${row.provider}/${row.model}`,
    String(row.steps),
    String(row.turns),
    String(row.turnsUnclean),
    row.turnsUncleanRate === null ? '-' : (row.turnsUncleanRate * 100).toFixed(1),
    row.turnEndKinds.map((entry) => `${entry.kind}×${entry.count}`).join(' '),
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
  console.log('OK: every turn that reached a model is recorded once, the kinds add up to the')
  console.log('    count, and a turn nobody spoke in reaches no row.')
} else {
  for (const failure of failures) console.log(`FAIL: ${failure}`)
  process.exitCode = 1
}