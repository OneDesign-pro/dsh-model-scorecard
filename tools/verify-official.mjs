// Cross-check dsh-model-stats against the official `sessionStats` projection.
//
// The official unit is not exported from its package, so this script copies the
// package's built entry into a temp module with the definition exported, links
// the same dependency tree beside it, folds one real session through both
// implementations, and prints the field-by-field difference.
//
// Usage: node tools/verify-official.mjs [path/to/session.v4.jsonl.zstd]

import { mkdirSync, writeFileSync, symlinkSync, readFileSync, readdirSync, existsSync } from 'node:fs'
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

function findSession(explicit) {
  if (explicit !== undefined) return explicit
  const root = join(process.env.DSH_HOME ?? join(process.env.HOME, '.dsh'), 'sessions')
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
      if (existsSync(file)) return file
    }
  }
  throw new Error(`no session log found under ${root}`)
}

const logFile = findSession(process.argv[2])
console.log('official package :', STATS_PKG)
console.log('session verified :', logFile)

// Build the patched official module in a temp dir with its dependencies linked.
const work = join(tmpdir(), `dsh-model-stats-verify-${process.pid}`)
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

const events = []
const raw = execFileSync('zstd', ['-d', '-c', logFile], { maxBuffer: 1 << 30 }).toString('utf8')
for (const line of raw.split('\n')) {
  const trimmed = line.trim()
  if (trimmed === '') continue
  try {
    events.push(JSON.parse(trimmed))
  } catch {
    /* torn tail */
  }
}

let state = unit.init()
for (const event of events) state = unit.apply(state, event)
const official = unit.wire.view(state)

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
  console.log('OK: every timing total matches the official sessionStats projection exactly.')
} else {
  console.log(`FAIL: ${timingMismatch} timing field(s) disagree with the official projection.`)
  process.exitCode = 1
}
