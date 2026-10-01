// Cross-check dsh-model-scorecard against the official `sessionStats` projection.
//
// The official unit is not exported from its package, so this script copies the
// package's built entry into a temp module with the definition exported, links
// the same dependency tree beside it, folds one real session through both
// implementations, and prints the field-by-field difference.
//
// The session is chosen for containing timed steps, not merely for existing.
// This check exists to protect an exact-equality contract, and an exact
// comparison of two zeros is not evidence of anything: on 2026-10-01 the first
// session the previous `readdirSync` order happened to return held five events
// and no completed step, so every field was 0, the diff was 0, and the tool
// printed OK. Nothing about the formula had been checked. So a session is only
// accepted once its own official projection carries a nonzero time-to-first-
// token, and when no session under the root qualifies the tool says it cannot
// verify and exits non-zero - an unverifiable run must not read as a pass.
//
// Usage: node tools/verify-official.mjs [path/to/session.v4.jsonl.zstd]

import { mkdirSync, writeFileSync, symlinkSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { foldSession } from '../lib/fold.js'

const DSH = process.env.DSH_INSTALL ?? findDshInstall()
const STATS_PKG = DSH === null ? null : join(DSH, 'node_modules', '@deepseek-ai', 'dsh-session-stats')

if (STATS_PKG === null || !existsSync(STATS_PKG)) {
  console.error(`official session-stats package not found (tried ${STATS_PKG})`)
  console.error('set DSH_INSTALL to the dsh installation directory')
  process.exit(1)
}

function findDshInstall() {
  for (const candidate of [
    '/Users/jeka/.npm-global/lib/node_modules/@deepseek-ai/dsh',
    join(process.env.HOME ?? '', '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
  ]) {
    if (existsSync(join(candidate, 'node_modules', '@deepseek-ai', 'dsh-session-stats'))) {
      return candidate
    }
  }
  return null
}

// Candidates, largest first: a long session is almost certain to hold completed
// steps, so in practice the first one qualifies and the loop stops there. The
// cap bounds the work when it does not - twelve decompressions of the largest
// local logs is seconds, not minutes, and it is still better than asserting
// nothing.
const SESSION_CANDIDATE_LIMIT = 12
// A session that is still being appended to grows while it is read, so the same
// command prints different totals on different days - and its tail can be torn.
// A log that has been quiet for an hour is settled, and a settled log makes the
// evidence line below reproducible. The size still decides: among settled logs
// the longest is the one most likely to hold a completed step.
const SESSION_SETTLED_MS = 3_600_000

function findSessions(explicit) {
  if (explicit !== undefined) return { root: null, files: [explicit] }
  const root = join(process.env.DSH_HOME ?? join(process.env.HOME, '.dsh'), 'sessions')
  const files = []
  for (const dir of readdirSync(root)) {
    let entries = []
    try {
      entries = readdirSync(join(root, dir))
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.startsWith('session-')) continue
      const file = join(root, dir, entry, 'session.v4.jsonl.zstd')
      if (!existsSync(file)) continue
      let stat
      try {
        stat = statSync(file)
      } catch {
        continue
      }
      files.push({ file, size: stat.size, settled: Date.now() - stat.mtimeMs > SESSION_SETTLED_MS })
    }
  }
  files.sort((a, b) => (a.settled === b.settled ? b.size - a.size : a.settled ? -1 : 1))
  if (files.length === 0) throw new Error(`no session log found under ${root}`)
  return { root, files: files.slice(0, SESSION_CANDIDATE_LIMIT).map((f) => f.file), of: files.length }
}

let candidates
try {
  candidates = findSessions(process.argv[2])
} catch (error) {
  console.error(`no session to compare against: ${error.message}`)
  console.error('pass a session path as argv[2], or point DSH_HOME at a profile that has one')
  process.exit(1)
}
console.log('official package :', STATS_PKG)
console.log('sessions to try  :', candidates.files.length, candidates.of === undefined ? '(explicit path)' : `of ${candidates.of} under ${candidates.root}`)

// Build the patched official module in a temp dir with its dependencies linked.
const work = join(tmpdir(), `dsh-model-scorecard-verify-${process.pid}`)
mkdirSync(join(work, 'node_modules', '@deepseek-ai'), { recursive: true })
const links = [
  [join(DSH, 'node_modules', 'zod'), join(work, 'node_modules', 'zod')],
  [join(DSH, 'node_modules', '@deepseek-ai', 'dsh-llm'), join(work, 'node_modules', '@deepseek-ai', 'dsh-llm')],
  [STATS_PKG, join(work, 'node_modules', '@deepseek-ai', 'dsh-session-stats')],
]
for (const [from, to] of links) {
  try {
    symlinkSync(from, to)
  } catch {
    /* already linked */
  }
}

const entry = readFileSync(join(STATS_PKG, 'lib', 'index.js'), 'utf8').replace(
  'export { apply, inject, name };',
  'export { apply, inject, name, sessionStatsProjectionDefinition };',
)
const patched = join(work, 'stats.mjs')
writeFileSync(patched, entry)

const { sessionStatsProjectionDefinition: unit } = await import(patched)

const readEvents = (file) => {
  const events = []
  const raw = execFileSync('zstd', ['-d', '-c', file], { maxBuffer: 1 << 30 }).toString('utf8')
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      /* torn tail */
    }
  }
  return events
}

const project = (events) => {
  let state = unit.init()
  for (const event of events) state = unit.apply(state, event)
  return unit.wire.view(state)
}

// The first candidate whose own official projection shows a timed step is the
// one worth comparing on. An explicit path is taken as given - a caller who
// names a session is entitled to be told the truth about that session, even
// when the truth is that there is nothing in it to compare. The first candidate
// is also kept as the fallback, so a run that finds no timed step anywhere still
// reports against a real session and says what was wrong with it.
let logFile = null
let events = null
let official = null
const withoutSteps = []
for (const candidate of candidates.files) {
  const candidateEvents = readEvents(candidate)
  const candidateOfficial = project(candidateEvents)
  if (logFile === null) {
    logFile = candidate
    events = candidateEvents
    official = candidateOfficial
  }
  if (candidateOfficial.ttftMs > 0) {
    logFile = candidate
    events = candidateEvents
    official = candidateOfficial
    break
  }
  withoutSteps.push(`${candidate} (${candidateEvents.length} events, ttftMs ${candidateOfficial.ttftMs})`)
}
console.log('session verified :', logFile)

if (official.ttftMs === 0) {
  console.log('')
  for (const line of withoutSteps) console.log(`no timed step: ${line}`)
  console.log('')
  console.log('FAIL: no candidate session contains a completed step, so there is no timing total to')
  console.log('      compare. This is an inability to verify, not a parity result - pass a session')
  console.log('      path as argv[2], or point DSH_HOME at a profile that has one.')
  process.exit(1)
}

const { samples } = foldSession(events, { sessionId: 'verify' })
const mine = samples.reduce(
  (acc, sample) => {
    acc.llmMs += sample.llmMs
    if (sample.ttftMs !== null) {
      acc.ttftMs += sample.ttftMs
      acc.ttftSteps += 1
    }
    if (sample.ttftMs !== null && sample.outputTokens !== null) {
      acc.decodeMs += sample.decodeMs
      acc.decodeTokens += sample.outputTokens
    }
    return acc
  },
  { llmMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 },
)

const rows = [
  ['llmMs', official.llmMs, mine.llmMs],
  ['ttftMs', official.ttftMs, mine.ttftMs],
  ['ttftSteps', official.ttftSteps, mine.ttftSteps],
  ['decodeMs', official.decodeMs, mine.decodeMs],
  ['decodeTokens', official.decodeTokens, mine.decodeTokens],
]

console.log(`\nevents folded: ${events.length}\n`)
console.log('field'.padEnd(16), 'official'.padStart(10), 'mine'.padStart(10), 'diff'.padStart(7))
let timingMismatch = 0
for (const [name, a, b] of rows) {
  const diff = b - a
  if (diff !== 0) timingMismatch += 1
  console.log(name.padEnd(16), String(a).padStart(10), String(b).padStart(10), String(diff).padStart(7))
}
console.log(
  'steps'.padEnd(16),
  String(official.steps).padStart(10),
  String(samples.length).padStart(10),
  String(samples.length - official.steps).padStart(7),
  '  (assembled messages vs step/end)',
)

console.log('')
if (timingMismatch === 0) {
  // The evidence travels with the verdict: a pass that cannot say how much it
  // compared is the pass this file was rewritten to stop producing.
  console.log(
    `OK: every timing total matches the official sessionStats projection exactly - ${events.length} events, ` +
      `${official.ttftSteps} timed step(s), ${official.ttftMs} ms of time-to-first-token, ${official.llmMs} ms in a model call.`,
  )
} else {
  console.log(`FAIL: ${timingMismatch} timing field(s) disagree with the official projection.`)
  process.exitCode = 1
}
