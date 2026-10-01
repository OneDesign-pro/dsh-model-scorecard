// Verifies the collection contract of the collector.
//
// Two properties matter, and they are easy to break silently:
//
//   1. A request must stay bounded. The real store charges tens of milliseconds
//      per session, so a cold corpus of several hundred logs used to stall one
//      HTTP request for minutes. A bounded call returns promptly, reports what
//      is still pending, and repeated calls converge.
//   2. A session must be read once per collector, however many passes run. The
//      fold used to pay a `stat` plus a full corpus listing per session inside
//      `sessionQuery`, which is what made a cold pass minutes long; a regression
//      there is invisible in wall-clock timings on a warm machine but obvious in
//      this read counter.
//
// Usage: node tools/verify-budget.mjs

import { createCollector, toPanelPayload } from '../lib/collect.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PER_SESSION_MS = 20
const SESSIONS = 40

function makeEventLog(index) {
  const base = 1790000000000 + index * 100000
  const provider = index % 2 === 0 ? 'prov-a' : 'prov-b'
  const model = `model-${index % 3}`
  const events = [
    { type: 'user/message', seq: 0, time: base, data: { role: 'user', content: [] } },
    { type: 'step/start', seq: 1, time: base + 100, data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message',
      seq: 2,
      time: base + 900,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          source: { kind: 'model', provider, model },
        },
        stream: [
          {
            type: 'text-chunks',
            time0: base + 300,
            index: 0,
            dt: new Array(20).fill(10),
            texts: new Array(20).fill('x'),
          },
        ],
        usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 5 },
      },
    },
    { type: 'step/end', seq: 3, time: base + 950, data: { turn: 1, step: 1 } },
  ]
  return events
}

const readCounts = new Map()
const listCounts = { persistence: 0, query: 0 }

/** A store whose revision spelling matches the real JSONL backend. */
function store(options = {}) {
  const size = options.size ?? SESSIONS
  const legacy = options.legacy ?? 0
  // A legacy generation shares one corpus-wide revision, so touching any old log
  // changes it for all of them.
  let corpusHash = options.corpusHash ?? 'a'.repeat(64)
  const revisions = new Map()
  for (let index = 0; index < size; index += 1) {
    const id = `session-${index}`
    revisions.set(
      id,
      index < legacy
        ? `1:2:3:4:5:${corpusHash}`
        : `1:${index}:3:4:5`,
    )
  }

  return {
    revisions,
    bumpCorpus() {
      corpusHash = corpusHash === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64)
      for (const [id, revision] of revisions) {
        if (revision.endsWith(corpusHash === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64))) {
          revisions.set(id, `1:2:3:4:5:${corpusHash}`)
        }
      }
    },
    ctx: {
      get(name) {
        if (name === 'sessionQuery') {
          return {
            async listSessions() {
              listCounts.query += 1
              return [...revisions.keys()].map((id) => ({
                header: { id },
                live: false,
                persisted: true,
              }))
            },
            async observeSession(id) {
              await new Promise((resolve) => setTimeout(resolve, PER_SESSION_MS))
              readCounts.set(id, (readCounts.get(id) ?? 0) + 1)
              const index = Number(id.split('-')[1])
              return {
                source: 'prepared',
                header: { id },
                events: makeEventLog(index),
                revision: revisions.get(id).split(':').slice(0, 5).join(':'),
                [Symbol.dispose]: () => {},
              }
            },
          }
        }
        if (name === 'sessionPersistence') {
          return {
            async list() {
              listCounts.persistence += 1
              return [...revisions.entries()].map(([id, revision]) => ({
                header: { id },
                revision,
              }))
            },
          }
        }
        return undefined
      },
      effect: (fn) => fn(),
      logger: { info: () => {}, warn: () => {} },
    },
  }
}

const totalReads = () => [...readCounts.values()].reduce((sum, value) => sum + value, 0)
const resetReads = () => {
  readCounts.clear()
  listCounts.persistence = 0
  listCounts.query = 0
}

let failures = 0
function check(label, condition, detail) {
  const mark = condition ? 'OK  ' : 'FAIL'
  if (!condition) failures += 1
  console.log(`${mark} ${label}${detail ? ` — ${detail}` : ''}`)
}

const cacheDir = await mkdtemp(join(tmpdir(), 'model-scorecard-contract-'))

console.log(`синтетический корпус: ${SESSIONS} сессий, ${PER_SESSION_MS} мс на чтение`)
console.log(`полный проход без бюджета занял бы ~${(SESSIONS * PER_SESSION_MS) / 1000} с\n`)

// --- 1. a bounded call must return quickly and stay partial -------------------
{
  resetReads()
  const fake = store()
  const collector = createCollector(fake.ctx, { persist: false })
  const t0 = performance.now()
  const first = await collector.collect({ budgetMs: 200, sort: 'steps' })
  const firstMs = performance.now() - t0

  check('ограниченный вызов вернулся быстро', firstMs < 1200, `${firstMs.toFixed(0)} мс`)
  check('вызов отдал частичный результат', first.pending > 0, `pending=${first.pending}`)
  check('complete=false при остатке', first.complete === false)
  check('что-то уже прочитано', first.scanned > 0, `scanned=${first.scanned}`)

  const payload = toPanelPayload(first, { sort: 'steps', view: 'model' })
  check('payload несёт признак незавершённости', payload.pending > 0 && payload.complete === false)
  check(
    'payload содержит строки',
    Array.isArray(payload.rows) && payload.rows.length > 0,
    `rows=${payload.rows.length}`,
  )

  // --- 2. repeated bounded calls converge ------------------------------------
  let last = first
  let calls = 0
  while (last.pending > 0 && calls < 40) {
    last = await collector.collect({ budgetMs: 500, sort: 'steps' })
    calls += 1
  }

  check('повторные вызовы сходятся к полному корпусу', last.pending === 0, `вызовов=${calls}`)
  check('итог помечен complete', last.complete === true)
  check('прочитаны все сессии', last.scanned === SESSIONS, `scanned=${last.scanned}`)

  // --- 3. each session is read exactly once, whatever the pass did ------------
  check(
    'сессия прочитана ровно один раз за все проходы',
    [...readCounts.values()].every((value) => value === 1),
    `максимум чтений=${Math.max(...readCounts.values())}`,
  )
  check('все сессии прочитаны', readCounts.size === SESSIONS, `уникальных=${readCounts.size}`)

  // --- 4. a further pass re-reads nothing ------------------------------------
  const before = totalReads()
  const repeat = await collector.collect({ budgetMs: 5000, sort: 'steps' })
  check('повторный проход не читает ничего', totalReads() === before, `чтений=${totalReads()}`)
  check(
    'повторный проход сообщает об переиспользовании',
    repeat.provenance.readNow === 0 && repeat.provenance.reused === SESSIONS,
    `readNow=${repeat.provenance.readNow} reused=${repeat.provenance.reused}`,
  )
  check('выборка использует одно перечисление корпуса', listCounts.persistence === 1, `list=${listCounts.persistence}`)
}

// --- 5. a snapshot survives a process restart --------------------------------
{
  resetReads()
  const fake = store({ legacy: 10 })
  const first = createCollector(fake.ctx, { persist: true, cacheDir })
  await first.collect({ budgetMs: 60000, sort: 'steps' })
  check('снапшот записан', await first.saveSnapshot())

  const reopened = createCollector(fake.ctx, { persist: true, cacheDir })
  const status = await reopened.snapshotStatus()
  check('снапшот признан свежим после перезапуска', status.fresh === true, JSON.stringify(status))
  check('снапшот покрывает весь корпус', status.covered === SESSIONS, `covered=${status.covered}`)

  // Legacy generations share one corpus-wide revision, but each carries its own
  // `<file identity>` prefix around it. Recording one session's whole revision as
  // the snapshot's fingerprint would match that single entry and condemn every
  // other legacy log to a re-read, so the reuse is asserted with every log of the
  // corpus, legacy included, taken from the snapshot.
  const beforeRestart = totalReads()
  const restarted = await reopened.collect({ budgetMs: 60000, sort: 'steps' })
  check(
    'после перезапуска ни один лог не перечитан (включая legacy)',
    restarted.provenance.readNow === 0 && totalReads() === beforeRestart,
    `readNow=${restarted.provenance.readNow}`,
  )

  const before = totalReads()
  const answer = await reopened.snapshotReport({ sort: 'steps' })
  check('отчёт из снапшота получен', answer !== null && answer.report !== undefined)
  check('отчёт из снапшота не читал логи', totalReads() === before, `чтений=${totalReads() - before}`)
  check(
    'отчёт из снапшота совпадает по шагам',
    answer !== null && answer.report.steps === SESSIONS,
    `steps=${answer?.report?.steps}`,
  )

  const warm = await reopened.collect({ budgetMs: 60000, sort: 'steps' })
  check('догрузка после снапшота не читает ничего', warm.provenance.readNow === 0, `readNow=${warm.provenance.readNow}`)

  // A legacy corpus revision moves whenever any old log is written, so every
  // legacy entry becomes unverifiable and must be re-read rather than trusted.
  fake.bumpCorpus()
  const moved = createCollector(fake.ctx, { persist: true, cacheDir })
  const afterMove = await moved.collect({ budgetMs: 60000, sort: 'steps' })
  check(
    'смена legacy-ревизии перечитывает только legacy-сессии',
    afterMove.provenance.readNow === 10,
    `readNow=${afterMove.provenance.readNow}`,
  )

  // A current-format log that actually changed must be re-read too. The previous
  // pass is snapshotted first, so the only recorded change is this one log.
  await moved.saveSnapshot()
  fake.revisions.set('session-39', '1:999:3:4:5')
  const changed = createCollector(fake.ctx, { persist: true, cacheDir })
  const afterChange = await changed.collect({ budgetMs: 60000, sort: 'steps' })
  check(
    'изменившийся лог перечитан, остальные взяты из снапшота',
    afterChange.provenance.readNow === 1,
    `readNow=${afterChange.provenance.readNow}`,
  )
}

// --- 6. a long-budget warm pass finishes a cold corpus on its own ------------
{
  resetReads()
  const fake = store()
  const cold = createCollector(fake.ctx, { persist: false })
  const t2 = performance.now()
  const folded = await cold.warm({ budgetMs: 60000 })
  const warmMs = performance.now() - t2
  check('warm прочитал весь корпус', folded === SESSIONS, `folded=${folded} за ${warmMs.toFixed(0)} мс`)

  const afterWarm = await cold.collect({ budgetMs: 100, sort: 'steps' })
  check('после warm запрос мгновенно полный', afterWarm.complete === true && afterWarm.pending === 0)
}

await rm(cacheDir, { recursive: true, force: true })

console.log('')
if (failures === 0) {
  console.log('ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ')
} else {
  console.log(`ПРОВАЛЕНО ПРОВЕРОК: ${failures}`)
  process.exitCode = 1
}
