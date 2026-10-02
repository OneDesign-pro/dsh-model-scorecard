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
import { panelPayload } from '../lib/index.js'
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
  // A legacy generation carries one corpus-wide hash behind its own file
  // identity, so touching any old log moves that hash for all of them - and
  // nothing else. Each session keeps its own identity, because the distinction
  // between "some other log was written" and "this log changed" is the whole
  // comparison: the real store carries 199 legacy sessions, and a rule that
  // re-reads them all whenever any of them moves costs 199 reads to learn
  // nothing about the one that did.
  let corpusHash = options.corpusHash ?? 'a'.repeat(64)
  const revisions = new Map()
  for (let index = 0; index < size; index += 1) {
    const id = `session-${index}`
    revisions.set(
      id,
      index < legacy ? `1:${index}:3:4:5:${corpusHash}` : `1:${index}:3:4:5`,
    )
  }

  return {
    revisions,
    addSession(id, revision) {
      revisions.set(id, revision)
    },
    bumpCorpus() {
      corpusHash = corpusHash === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64)
      for (const [id, revision] of revisions) {
        if (revision.includes(':' + 'a'.repeat(64))) {
          revisions.set(id, revision.replace('a'.repeat(64), 'b'.repeat(64)))
        }
      }
    },
    // One session's own log moved: size, mtime and ctime all differ.
    bumpFile(id) {
      const revision = revisions.get(id)
      if (typeof revision !== 'string') return
      revisions.set(id, revision.replace(/^(\d+:\d+):3:4:5/, '$1:9:8:7'))
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

  // The corpus-wide hash a legacy generation carries moves whenever *any* old log
  // is written. It says nothing about the log behind an entry, so nothing may be
  // re-read because of it: measured on this machine's real store on 2026-10-01,
  // comparing whole revisions made 195 of 483 sessions read as changed while not
  // one of their own logs had been written.
  fake.bumpCorpus()
  const moved = createCollector(fake.ctx, { persist: true, cacheDir })
  const afterMove = await moved.collect({ budgetMs: 60000, sort: 'steps' })
  check(
    'смена corpus-хеша не перечитывает ни одной сессии',
    afterMove.provenance.readNow === 0,
    `readNow=${afterMove.provenance.readNow}`,
  )
  const movedStatus = await moved.snapshotStatus()
  check('смена corpus-хеша не ломает свежесть', movedStatus.fresh === true, JSON.stringify(movedStatus))
  check('свежесть не выдаёт устаревший снимок', movedStatus.stale === 0, `stale=${movedStatus.stale}`)

  // The same corpus, one legacy log of which really did change: exactly one read,
  // named by its own file identity rather than by the generation it belongs to.
  await moved.saveSnapshot()
  fake.bumpFile('session-3')
  // Asked before anything folds the change in, because a collector that has
  // already re-read the session has, correctly, nothing left to report about it.
  const looker = createCollector(fake.ctx, { persist: true, cacheDir })
  const afterOneStatus = await looker.snapshotStatus()
  check('статус называет изменившуюся сессию', afterOneStatus.mismatches.length === 1, JSON.stringify(afterOneStatus.mismatches))
  check(
    'названная сессия — именно изменившаяся, с обеими ревизиями',
    afterOneStatus.mismatches[0]?.id === 'session-3' &&
      afterOneStatus.mismatches[0]?.reason === 'changed' &&
      afterOneStatus.mismatches[0]?.stored !== afterOneStatus.mismatches[0]?.current,
    JSON.stringify(afterOneStatus.mismatches[0] ?? null),
  )
  check('изменившийся снимот не свеж', afterOneStatus.fresh === false, `fresh=${afterOneStatus.fresh}`)

  const oneMoved = createCollector(fake.ctx, { persist: true, cacheDir })
  const afterOne = await oneMoved.collect({ budgetMs: 60000, sort: 'steps' })
  check('изменившийся legacy-лог перечитан ровно один', afterOne.provenance.readNow === 1, `readNow=${afterOne.provenance.readNow}`)

  // A current-format log that actually changed must be re-read too. The previous
  // pass is snapshotted first, so the only recorded change is this one log.
  await oneMoved.saveSnapshot()
  fake.revisions.set('session-39', '1:999:3:4:5')
  const changed = createCollector(fake.ctx, { persist: true, cacheDir })
  const afterChange = await changed.collect({ budgetMs: 60000, sort: 'steps' })
  check(
    'изменившийся лог перечитан, остальные взяты из снапшота',
    afterChange.provenance.readNow === 1,
    `readNow=${afterChange.provenance.readNow}`,
  )
}

// --- 6. the panel's phase choice, against a snapshot that is one log behind ---
//
// The panel answers cheapest-first: memory, then the on-disk snapshot, then a
// bounded fold. The third phase used to be the only way to see a session the
// snapshot had never heard of — `snapshotReport` returned null for the whole
// corpus if even one session was uncovered, so one new conversation anywhere on
// the machine cost a full re-read of every other log. This drives the real
// phase choice over a corpus whose read count is exact.
{
  resetReads()
  const phaseDir = await mkdtemp(join(tmpdir(), 'model-scorecard-phases-'))
  const fake = store({ size: SESSIONS, legacy: 10 })

  const cold = createCollector(fake.ctx, { persist: true, cacheDir: phaseDir })
  await cold.collect({ budgetMs: 60000, sort: 'steps' })
  await cold.saveSnapshot()

  // One session the snapshot has never seen, and one whose log has since changed:
  // the two cases the old contract refused to answer at all.
  fake.addSession('session-new', '1:500:3:4:5')
  fake.bumpFile('session-7')

  const reader = createCollector(fake.ctx, { persist: true, cacheDir: phaseDir })
  const status = await reader.snapshotStatus()
  check('статус видит непокрытую сессию', status.uncovered === 1, `uncovered=${status.uncovered}`)
  check('статус видит изменившуюся сессию', status.stale === 1, `stale=${status.stale}`)
  check('непокрытая сессия названа', status.mismatches.some((m) => m.id === 'session-new' && m.reason === 'uncovered'), JSON.stringify(status.mismatches))
  check('неполный снимот не объявлен свежим', status.fresh === false, `fresh=${status.fresh}`)

  const before = totalReads()
  const report = await reader.snapshotReport({ sort: 'steps' })
  check('снапшот отвечает, хотя не покрывает корпус', report !== null && report.report !== undefined)
  check('его ответ назван неполным', report?.complete === false, `complete=${report?.complete}`)
  check('его ответ перечисляет остаток', report?.skippedIds?.length === 2, `skippedIds=${JSON.stringify(report?.skippedIds)}`)
  check('остаток разделён на непокрытое и изменившееся', report?.uncovered === 1 && report?.changed === 1, `uncovered=${report?.uncovered} changed=${report?.changed}`)
  check('отвечая из снапшота, ни один лог не прочитан', totalReads() === before, `чтений=${totalReads() - before}`)

  const started = performance.now()
  // A collector of its own, the way a restarted host would have one: the one above
  // has already folded the snapshot's index into memory, and answering from memory
  // is phase 1's right — an in-memory answer is a first paint that never claimed
  // to have re-checked the store.
  const panelReader = createCollector(fake.ctx, { persist: true, cacheDir: phaseDir })
  const listingsBefore = listCounts.query
  const payload = await panelPayload(panelReader, { sort: 'steps', view: 'model' }, { sort: 'steps', view: 'model' })
  const payloadMs = performance.now() - started
  check('полная фаза прочитала ровно остаток', totalReads() - before === 2, `чтений=${totalReads() - before}`)
  check(
    'полная фаза перечислила корпус ровно один раз — фаза догрузки переиспользовала листинг',
    listCounts.query === listingsBefore + 1,
    `list=${listCounts.query - listingsBefore}`,
  )
  check('полная фаза дала полный ответ', payload.complete === true, `complete=${payload.complete} pending=${payload.pending}`)
  check('полный ответ считает весь корпус, включая догруженное', payload.totals?.steps === SESSIONS + 1, `steps=${payload.totals?.steps} ожидалось=${SESSIONS + 1}`)
  check('в ответе есть строки', payload.rows.length > 0, `rows=${payload.rows.length}`)
  // A full cold fold of this corpus would read 40 logs; the panel read the two it
  // was missing. The budget is what makes the other case safe, and the wall clock
  // is here to catch a regression that spends the whole corpus again.
  check('полная фаза уложилась в бюджет', payloadMs < SESSIONS * PER_SESSION_MS, `${payloadMs.toFixed(0)} мс`)

  await rm(phaseDir, { recursive: true, force: true })
}

// --- 7. the in-memory phase answers for the corpus, not for the delta --------
//
// The regression this guards: a host restarts onto a complete snapshot, its warm
// pass walks every listed session but reads only the logs that moved since that
// snapshot, and the in-memory phase then answered from those few reads alone.
// Measured on this machine's real store on 2026-10-02: 7 of 499 sessions read,
// so the panel drew 1 217 steps over 4 models and 4 providers where the tool —
// folding the same cache — drew 36 096 over 71 and 16, and the answer said
// `pending: 0` with `complete: false`, which is a client that never re-asks.
{
  resetReads()
  const memoryDir = await mkdtemp(join(tmpdir(), 'model-scorecard-memory-'))
  const fake = store({ size: SESSIONS, legacy: 10 })

  const cold = createCollector(fake.ctx, { persist: true, cacheDir: memoryDir })
  await cold.collect({ budgetMs: 60000, sort: 'steps' })
  await cold.saveSnapshot()

  // The two logs a restarted host actually reads: one the snapshot never saw,
  // and one whose own file moved since.
  fake.addSession('session-new', '1:500:3:4:5')
  fake.bumpFile('session-7')

  const warm = createCollector(fake.ctx, { persist: true, cacheDir: memoryDir })
  check(
    'память молчит, пока процесс не свёл корпус',
    (await warm.snapshotSummary({ sort: 'steps' })) === null,
  )

  const before = totalReads()
  const pass = await warm.collect({ budgetMs: 60000, sort: 'steps' })
  check(
    'тёплый проход прочитал только изменившееся',
    totalReads() - before === 2,
    `чтений=${totalReads() - before}, readNow=${pass.provenance.readNow}`,
  )
  check(
    'тёплый проход переиспользовал снимок',
    pass.provenance.reused === SESSIONS - 1,
    `reused=${pass.provenance.reused}`,
  )

  const memory = await warm.snapshotSummary({ sort: 'steps' })
  check(
    'память отвечает всем корпусом, а не прочитанной дельтой',
    memory !== null &&
      memory.report.steps === SESSIONS + 1 &&
      memory.report.byModel.length >= 3 &&
      memory.scanned === SESSIONS + 1,
    `sessions=${memory?.scanned} steps=${memory?.report?.steps} models=${memory?.report?.byModel.length}`,
  )
  const memoryReads = totalReads()
  const panel = await panelPayload(warm, { sort: 'steps', view: 'model' }, { sort: 'steps', view: 'model' })
  check(
    'панель и инструмент показывают один корпус',
    panel.totals?.steps === SESSIONS + 1 && totalReads() === memoryReads,
    `steps=${panel.totals?.steps} чтений=${totalReads() - memoryReads}`,
  )

  // Half a fold is not a corpus: a pass that left work behind must not arm the
  // in-memory phase, or the same partial table returns by another road.
  const partial = createCollector(store().ctx, { persist: false })
  const bounded = await partial.collect({ budgetMs: 0, sort: 'steps' })
  check('ограниченный проход оставил остаток', bounded.pending > 0, `pending=${bounded.pending}`)
  check(
    'неполная свёртка не отвечает как за весь корпус',
    (await partial.snapshotSummary({ sort: 'steps' })) === null,
  )
  await rm(memoryDir, { recursive: true, force: true })
}

// --- 8. a long-budget warm pass finishes a cold corpus on its own ------------
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
