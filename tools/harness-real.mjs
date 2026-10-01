// Drives the collector against the real session store.
//
// `verify-budget.mjs` proves the bounded-collection contract on a synthetic
// corpus; this script answers the question that contract cannot: how long a cold
// pass actually takes against the logs on this machine, and how much of the
// corpus a second pass still has to read.
//
// It reuses the shipped `session-persistence-jsonl` backend and the real
// `sessionQuery` engine, because the cost being measured lives inside them —
// especially the per-session corpus listing that `readSession` used to pay.
//
// Usage: node tools/harness-real.mjs [--sessions-dir <path>] [--budget-ms <n>]

import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { statSync } from 'node:fs'

const DSH = '/Users/jeka/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const { Context } = await import(`${DSH}/cordis/lib/index.js`)
const { default: JsonlSessionPersistence } = await import(
  `${DSH}/dsh-session-persistence-jsonl/lib/index.js`
)
const { SessionQueryEngine } = await import(`${DSH}/dsh-session-query/lib/index.js`)
const { default: SessionStore } = await import(`${DSH}/dsh-session/lib/index.js`)
const { createCollector } = await import('../lib/collect.js')
const { panelPayload } = await import('../lib/index.js')

const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index === -1 ? fallback : argv[index + 1]
}

const sessionsRoot = argOf('--sessions-dir', join(homedir(), '.dsh', 'sessions'))
const budgetMs = Number.parseInt(argOf('--budget-ms', '120000'), 10)

// The real store is only ever read. The snapshot goes to a temp directory so the
// user's cache is untouched.
const cacheDir = await mkdtemp(join(tmpdir(), 'model-scorecard-harness-'))

// Mount the plugins the way the composition does, so the engine's optional
// persistence binding resolves through a real fiber instead of being wired by
// hand. The harness has no live sessions: the cold path is the one that
// consults persistence for every log.
const ctx = new Context()
ctx.plugin(SessionStore)
ctx.plugin(JsonlSessionPersistence, { root: sessionsRoot, compression: 'zstd' })
ctx.plugin(SessionQueryEngine, {})
await new Promise((resolve) => setTimeout(resolve, 200))

const engine = ctx.get('sessionQuery')
const persistence = ctx.get('sessionPersistence')
if (engine === undefined || persistence === undefined) {
  throw new Error('the harness could not mount sessionQuery/sessionPersistence')
}

const collector = createCollector(
  {
    get: (name) => ctx.get(name),
    logger: { info: () => {}, warn: (message) => console.warn(`warn: ${message}`) },
  },
  { persist: true, cacheDir },
)

function ms(value) {
  return `${Math.round(value)} ms`
}

async function timed(label, fn) {
  const started = performance.now()
  const value = await fn()
  const elapsed = performance.now() - started
  console.log(`${label}: ${ms(elapsed)}`)
  return { value, elapsed }
}

console.log(`store: ${sessionsRoot}`)
console.log(`snapshot: ${cacheDir}\n`)

const listing = await timed('listSessions()', () => engine.listSessions())
const total = listing.value.length
console.log(`sessions: ${total}\n`)

const first = await timed('cold pass (full corpus)', () =>
  collector.collect({ sort: 'steps', budgetMs }),
)
const report = first.value.report
console.log(
  `  scanned=${first.value.scanned} pending=${first.value.pending} ` +
    `steps=${report?.steps ?? 0} models=${report?.models ?? 0} ` +
    `readNow=${first.value.provenance.readNow} reused=${first.value.provenance.reused}\n`,
)

const second = await timed('second pass (nothing changed)', () =>
  collector.collect({ sort: 'steps', budgetMs }),
)
console.log(
  `  readNow=${second.value.provenance.readNow} reused=${second.value.provenance.reused} ` +
    `pending=${second.value.pending}\n`,
)

await timed('save snapshot', () => collector.saveSnapshot())

const artifact = join(cacheDir, 'fold-snapshot.json')
const saved = await statSync(artifact)
console.log(`  snapshot size: ${(saved.size / 1024).toFixed(0)} KiB\n`)

const reopened = createCollector(
  { get: (name) => ctx.get(name), logger: { info: () => {}, warn: () => {} } },
  { persist: true, cacheDir },
)
const status = await timed('fresh process: snapshotStatus()', () => reopened.snapshotStatus())
console.log(`  ${JSON.stringify(status.value)}\n`)

const instant = await timed('fresh process: snapshotReport()', () =>
  reopened.snapshotReport({ sort: 'steps' }),
)
if (instant.value === null) {
  console.log(`  null — the snapshot could not answer for any session\n`)
} else {
  console.log(
    `  rows=${instant.value.report.byModel.length} steps=${instant.value.report.steps} ` +
      `covered=${instant.value.scanned}/${instant.value.totalSessions} ` +
      `complete=${instant.value.complete} leftOver=${instant.value.skippedIds.length} ` +
      `(uncovered=${instant.value.uncovered} changed=${instant.value.changed})\n`,
  )
}

const memory = await timed('fresh process: snapshotSummary() (no I/O)', () =>
  reopened.snapshotSummary({ sort: 'steps' }),
)
// null here is the contract, not a failure: the in-memory phase answers only from
// what this process folded itself, and a process that has just started has folded
// nothing. The on-disk phase above is what serves it.
console.log(
  memory.value === null
    ? `  null — this process folded nothing yet, so the in-memory phase declines (expected)`
    : `  rows=${memory.value.report.byModel.length}`,
)
console.log()

// The question the panel actually asks, on a host that has just started: the whole
// phase chain, and what it cost against the cold pass printed above.
const panelReader = createCollector(
  { get: (name) => ctx.get(name), logger: { info: () => {}, warn: () => {} } },
  { persist: true, cacheDir },
)
const panel = await timed('fresh process: panelPayload() (the phase chain)', () =>
  panelPayload(panelReader, { sort: 'steps', view: 'model' }, { sort: 'steps', view: 'model' }),
)
console.log(
  `  ok=${panel.value.ok} rows=${panel.value.rows?.length ?? 0} ` +
    `steps=${panel.value.totals?.steps ?? '-'} complete=${panel.value.complete} ` +
    `pending=${panel.value.pending} scanned=${panel.value.scanned}\n`,
)

await rm(cacheDir, { recursive: true, force: true })
process.exit(0)
