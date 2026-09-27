// Verifies that the report order follows the metric the panel puts on screen.
//
// The regression this guards: the row order used to be decided by the mean while
// the table showed the median. On these distributions the two disagree exactly
// where it matters — one stalled step pushes the mean up and moves the model
// with the best median to the bottom of the list, so the table looks unsorted
// next to its own column.
//
// A fixture can only catch that if the two orders actually differ on it, so
// every discriminating fixture is checked for that property as well: if the mean
// and the median ever pick the same winner, the case stops proving anything and
// fails here instead of passing quietly. The rest of the file covers the orders
// that share the comparator table but not the disagreement: the `errors`
// tie-break, `lastSeen`, `steps`, metrics that are missing (they belong last),
// and the provider-level report, which sorts by the same comparator as the
// model-level one.
//
// Usage: node tools/verify-sort-order.mjs

import { aggregate } from '../lib/fold.js'

let clock = 1_700_000_000_000

/** One folded step sample, with the fields the comparators read. */
function sample(provider, model, { ttftMs = null, streamMs = null, streamTokens = null } = {}) {
  clock += 1000
  return {
    sessionId: 's1',
    time: clock,
    provider,
    model,
    llmMs: 500,
    ttftMs,
    decodeMs: null,
    streamMs,
    streamTokens,
    outputTokens: null,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    interrupted: false,
  }
}

/**
 * One recorded streaming span. Only spans of at least 100 ms and 8 tokens count
 * as a throughput sample, so every span here is written as the rate it yields.
 */
function span(provider, model, tokens, milliseconds) {
  return sample(provider, model, { streamMs: milliseconds, streamTokens: tokens })
}

const samples = []
const errors = []

// --- p1: ttft, where the mean and the median disagree ------------------------
// pa is the outlier: nine fast steps and one stall. Its median (1000 ms) beats
// pb, its mean (1800 ms) loses to pb.
for (let index = 0; index < 9; index += 1) samples.push(sample('p1', 'pa', { ttftMs: 1000 }))
samples.push(sample('p1', 'pa', { ttftMs: 9000 }))
for (let index = 0; index < 10; index += 1) samples.push(sample('p1', 'pb', { ttftMs: 1100 }))

// --- p2: tok/s, same disagreement the other way ------------------------------
// sa crawls at 20 tok/s eight times and bursts at 5000 twice: median 20, mean
// 1016. sb streams a steady 500: median 500, mean 500. So the median prefers sb
// and the mean prefers sa.
for (let index = 0; index < 8; index += 1) samples.push(span('p2', 'sa', 8, 400))
for (let index = 0; index < 2; index += 1) samples.push(span('p2', 'sa', 1000, 200))
for (let index = 0; index < 10; index += 1) samples.push(span('p2', 'sb', 500, 1000))

// --- p3: errors, including the tie-break -------------------------------------
// ea and eb tie at three errors, so the order between them is decided by the
// ttft median; ec has one error and belongs below both however fast it answers.
for (let index = 0; index < 3; index += 1) {
  samples.push(sample('p3', 'ea', { ttftMs: 5000 }))
  samples.push(sample('p3', 'eb', { ttftMs: 1000 }))
  errors.push({ provider: 'p3', model: 'ea', kind: 'tool' })
  errors.push({ provider: 'p3', model: 'eb', kind: 'tool' })
}
samples.push(sample('p3', 'ec', { ttftMs: 7000 }))
errors.push({ provider: 'p3', model: 'ec', kind: 'request' })

// --- p4: steps against lastSeen ----------------------------------------------
// x is busier but older, y is quieter but newer: the two orders must disagree.
for (let index = 0; index < 5; index += 1) samples.push(sample('p4', 'x', { ttftMs: 100 }))
for (let index = 0; index < 2; index += 1) samples.push(sample('p4', 'y', { ttftMs: 200 }))

// --- p5: a model that never reported a first token ---------------------------
samples.push(sample('p5', 'measured', { ttftMs: 100 }))
samples.push(sample('p5', 'silent'))

let failures = 0
function check(label, condition, detail) {
  const mark = condition ? 'OK  ' : 'FAIL'
  if (!condition) failures += 1
  console.log(`${mark} ${label}${detail ? ` — ${detail}` : ''}`)
}

/** Model-level rows for one provider, ordered by `sort`. */
const rowsFor = (provider, sort) =>
  aggregate(
    samples.filter((entry) => entry.provider === provider),
    { sort, errors },
  ).byModel

const names = (rows) => rows.map((row) => row.model).join(' < ')
const same = (rows, expected) => names(rows) === expected.join(' < ')
const timing = (value) =>
  value === null || value === undefined ? '-' : Math.round(value)

/** True when `pick` is non-decreasing (or non-increasing) top to bottom. */
const monotone = (rows, pick, down) => {
  const values = rows.map(pick).filter((value) => value !== null && value !== undefined)
  return values.every(
    (value, index) =>
      index === 0 || (down ? values[index - 1] >= value : values[index - 1] <= value),
  )
}

/** The row a whole column would put first, used to prove a fixture discriminates. */
const winnerBy = (rows, pick, better) =>
  rows.reduce((winner, row) => {
    const value = pick(row)
    if (value === null || value === undefined) return winner
    if (winner === null || better(value, pick(winner))) return row
    return winner
  }, null)

console.log('--- порядок по медиане против порядка по среднему ---')

const ttft = rowsFor('p1', 'ttft')
console.log(`sort=ttft  : ${names(ttft)}  (med ${ttft.map((r) => timing(r.ttft.median)).join('/')}, mean ${ttft.map((r) => timing(r.ttft.mean)).join('/')})`)
check('sort=ttft ставит первым лучшую медиану', same(ttft, ['pa', 'pb']), names(ttft))
check('sort=ttft не убывает по медиане', monotone(ttft, (row) => row.ttft.median, false))

const speed = rowsFor('p2', 'speed')
console.log(`sort=speed : ${names(speed)}  (med ${speed.map((r) => timing(r.speedTps.median)).join('/')}, mean ${speed.map((r) => timing(r.speedTps.mean)).join('/')})`)
check('sort=speed ставит первым лучшую медиану', same(speed, ['sb', 'sa']), names(speed))
check('sort=speed не возрастает по медиане', monotone(speed, (row) => row.speedTps.median, true))

const fastestByMedian = winnerBy(ttft, (row) => row.ttft.median, (a, b) => a < b)
const fastestByMean = winnerBy(ttft, (row) => row.ttft.mean, (a, b) => a < b)
check(
  'корпус ttft различает медиану и среднее',
  fastestByMedian !== null && fastestByMean !== null && fastestByMedian.model !== fastestByMean.model,
  `медиана → ${fastestByMedian?.model}, среднее → ${fastestByMean?.model}`,
)

const quickestByMedian = winnerBy(speed, (row) => row.speedTps.median, (a, b) => a > b)
const quickestByMean = winnerBy(speed, (row) => row.speedTps.mean, (a, b) => a > b)
check(
  'корпус tok/s различает медиану и среднее',
  quickestByMedian !== null && quickestByMean !== null && quickestByMedian.model !== quickestByMean.model,
  `медиана → ${quickestByMedian?.model}, среднее → ${quickestByMean?.model}`,
)

console.log('\n--- остальные ключи сортировки ---')

const byErrors = rowsFor('p3', 'errors')
console.log(`sort=errors: ${names(byErrors)}  (ошибок ${byErrors.map((r) => r.errors).join('/')}, med ttft ${byErrors.map((r) => timing(r.ttft.median)).join('/')})`)
check('sort=errors ставит первыми самые проблемные', same(byErrors, ['eb', 'ea', 'ec']), names(byErrors))
check('при равных ошибках первым идёт лучшая медиана ttft', byErrors[0].errors === byErrors[1].errors && byErrors[0].ttft.median < byErrors[1].ttft.median)
check('частичный сбой инструмента посчитан как ошибка модели', byErrors.find((row) => row.model === 'eb')?.toolErrors === 3, `toolErrors=${byErrors.find((row) => row.model === 'eb')?.toolErrors}`)

const bySteps = rowsFor('p4', 'steps')
const stepsOrder = names(bySteps)
check('sort=steps ставит первыми самые занятые', same(bySteps, ['x', 'y']), stepsOrder)

const byLastSeen = rowsFor('p4', 'lastSeen')
check('sort=lastSeen ставит первыми самые свежие', same(byLastSeen, ['y', 'x']), names(byLastSeen))

const byDefault = rowsFor('p4', undefined)
check('без sort порядок по шагам, а не по свежести', names(byDefault) === stepsOrder, names(byDefault))

const withGap = rowsFor('p5', 'ttft')
check('модель без метрики уходит вниз, а не наверх', same(withGap, ['measured', 'silent']), names(withGap))
check('у модели без метрики медиана пустая', withGap[1].ttft.median === null)

// Only the order is asserted here. How the provider report groups its rows is a
// separate question from how it sorts them.
const providerRows = aggregate(samples.filter((entry) => entry.provider === 'p1'), { sort: 'ttft' }).byProvider
check(
  'отчёт по провайдерам упорядочен тем же компаратором',
  monotone(providerRows, (row) => row.ttft.median, false),
  providerRows.map((row) => `${row.provider}/${row.model}`).join(' < '),
)

console.log('')
if (failures === 0) {
  console.log('ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ')
} else {
  console.log(`ПРОВАЛЕНО ПРОВЕРОК: ${failures}`)
  process.exitCode = 1
}
