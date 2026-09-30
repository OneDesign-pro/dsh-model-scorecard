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
// every order the panel's own columns ask for, the direction each order is
// offered in and the same order turned around, and the provider-level report,
// which sorts by the same comparator as the model-level one.
//
// Usage: node tools/verify-sort-order.mjs

import { aggregate, SPEED_QUALIFICATION, errorCategory, ERROR_CATEGORY_NAMES } from '../lib/fold.js'
import { probeState, statusRank, statusRanker } from '../lib/status.js'

let clock = 1_700_000_000_000

/** One folded step sample, with the fields the comparators read. */
function sample(
  provider,
  model,
  {
    ttftMs = null,
    streamMs = null,
    streamTokens = null,
    streamFragments = null,
    llmMs = 500,
    inputTokens = 0,
    cacheReadTokens = 0,
    retryCount = 0,
    retryBackoffMs = null,
    retryDeadMs = null,
    ttftCleanMs = null,
  } = {},
) {
  clock += 1000
  return {
    sessionId: 's1',
    time: clock,
    provider,
    model,
    llmMs,
    ttftMs,
    decodeMs: null,
    streamMs,
    streamTokens,
    streamFragments,
    outputTokens: null,
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    interrupted: false,
    retryCount,
    retryBackoffMs,
    retryDeadMs,
    ttftCleanMs,
  }
}

/**
 * One recorded streaming span, written as the rate it yields. A span only
 * becomes a throughput sample when it is long enough, carries enough tokens and
 * arrived in enough fragments, so every span here clears all three — unless
 * `extra` says otherwise, which is how the one model below is left without a
 * trustworthy rate.
 */
function span(provider, model, tokens, milliseconds, fragments = 8, extra = {}) {
  return sample(provider, model, {
    ...extra,
    streamMs: milliseconds,
    streamTokens: tokens,
    streamFragments: fragments,
  })
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

// --- p6: what a throughput sample is allowed to be built from ------------------
// steady streams a real rate; packed arrived long enough and carried enough
// tokens, but its tokens came in two fragments, so it is one flushed packet and
// not a rate; unmeasured streamed the same way but the provider reported no token
// count, so there is no numerator at all. Only `steady` may produce a tok/s
// figure — a missing half of the rate is never filled in from the other one.
for (let index = 0; index < 5; index += 1) {
  samples.push(span('p6', 'steady', 500, 1000))
  samples.push(span('p6', 'packed', 5000, 1000, 2))
  samples.push(sample('p6', 'unmeasured', { streamMs: 1000, streamFragments: 8 }))
}

// --- p7: the panel's own columns, one order each -------------------------------
// The four models are ordered differently by every column the table shows, so
// any order that names the wrong figure is caught here rather than by a reader.
// alpha answers fastest, streams fastest and serves its input from cache; gamma
// sits in the middle of both and reports no cache at all, which is a missing
// figure and not a cache share of zero; beta answers slowly but is the only
// model with a burst, so the order by peak rate and the order by median rate are
// not the same order; delta streamed in packets too small to be a rate at all,
// so it has neither a trustworthy rate nor a peak one.
for (let index = 0; index < 3; index += 1) {
  samples.push(
    sample('p7', 'alpha', {
      ttftMs: 500,
      llmMs: 100,
      inputTokens: 1000,
      cacheReadTokens: 900,
    }),
  )
  samples.push(
    sample('p7', 'beta', {
      ttftMs: 1500,
      llmMs: 300,
      inputTokens: 1000,
      cacheReadTokens: 100,
    }),
  )
  samples.push(sample('p7', 'gamma', { ttftMs: 1000, llmMs: 200 }))
  samples.push(span('p7', 'alpha', 500, 1000))
  samples.push(span('p7', 'beta', 100, 1000))
  samples.push(span('p7', 'gamma', 300, 1000))
  samples.push(span('p7', 'delta', 5000, 1000, 2))
}
// The one burst, recorded after the three steady spans of beta: its median stays
// at 100 tok/s while its peak is the highest of the four.
samples.push(span('p7', 'beta', 3000, 1000))

// --- p8: retries, the two orders they split, and the row that never retried ----
// The point of the pair is that they disagree. `flaky` is the fastest model
// measured and the slowest one the table shows: half its steps are measured
// after a retry, and the dead time those retries cost is inside its `ttft`. So
// `sort=ttft` puts it last and `sort=ttftClean` puts it first, and an order that
// named the wrong figure of the two would be caught here rather than by a
// reader. `steady` and `quiet` are the controls — neither ever retried, so both
// of their medians are the same number, which is the assertion that keeps
// `ttftClean` from quietly becoming a different measurement. They also have no
// retry rate at all (`null`, not `0`), and must stay at the bottom of
// `sort=retry` in both directions.
for (const entry of [
  // ttft, and the dead time a retry cost that step (0 = this step never retried)
  { model: 'flaky', steps: [[1000, 900], [500, 0]] },
  { model: 'steady', steps: [[400, 0], [500, 0]] },
  { model: 'noisy', steps: [[600, 100], [700, 0]] },
  { model: 'quiet', steps: [[500, 0], [550, 0]] },
]) {
  for (const [ttftMs, dead] of entry.steps) {
    const retried = dead > 0
    samples.push(
      sample('p8', entry.model, {
        ttftMs,
        retryCount: retried ? 1 : 0,
        retryBackoffMs: retried ? dead : null,
        retryDeadMs: retried ? dead : null,
        ttftCleanMs: retried ? ttftMs - dead : null,
      }),
    )
  }
}

// --- p9: the streaming rate and the end-to-end rate disagree ------------------
// `late` decodes faster than `prompt` (250 against 210 tok/s) but takes 7 s to
// start against 0.1 s, so the order by the streaming rate and the order by the
// end-to-end rate are exactly opposite. A panel that sorted by the wrong one of
// the two would call the slow starter the better model, which is the mistake
// these three columns exist to prevent.
// `llmMs` is written out rather than left at the default, because a real step
// always lasts at least ttft + streamMs and a fixture that does not would make
// the overhead column negative and prove nothing about it.
// `batched` is the control for the qualification: it streams 1000 tokens in a
// 20 ms packed burst, which is a rate the guard rejects, so it must have no
// end-to-end rate either — the end-to-end figure reuses the same evidence and
// must not smuggle the burst through on a wider denominator.
// `tight` never streams a qualified span at all, so its three figures stay null
// rather than being read off an unqualified sample.
for (let index = 0; index < 3; index += 1) {
  samples.push(span('p9', 'late', 250, 1000, 8, { ttftMs: 7000, llmMs: 8100 }))
  samples.push(span('p9', 'prompt', 210, 1000, 8, { ttftMs: 100, llmMs: 1150 }))
  samples.push(span('p9', 'batched', 1000, 20, 2, { ttftMs: 50, llmMs: 500 }))
}
samples.push(sample('p9', 'tight', { ttftMs: 5000, llmMs: 5500 }))

// --- p10: an error count is not a verdict -------------------------------------
// Three different mistakes, three different orders.
//
// `noisy` and `clean` fail the same number of times, so the total calls them
// identical. They are not: every failure of `clean` is a filesystem state race
// or a sandbox denial, which no change of model fixes, while most of `noisy`'s
// are malformed calls — the one thing a different model would have avoided.
//
// `blamed` has the *lowest* raw count of the three and the *highest* rate, and
// the reason is the denominator: 5 failures over 20 steps is a quarter of its
// steps, against 5 over 100. So the two orders genuinely disagree, and a sort
// key that quietly read the count instead of the rate would be caught here
// rather than by a reader.
const p10Errors = [
  { provider: 'p10', model: 'noisy', steps: 100, codes: ['INVALID_ARGS', 'INVALID_ARGS', 'INVALID_ARGS', 'INVALID_ARGS', 'FS_STALE_VERSION'] },
  { provider: 'p10', model: 'clean', steps: 100, codes: ['FS_STALE_VERSION', 'FS_EDIT_NOT_FOUND', 'FS_NOT_OBSERVED', 'FS_SANDBOX_DENIED', 'FS_NOT_FOUND'] },
  { provider: 'p10', model: 'blamed', steps: 20, codes: ['INVALID_ARGS', 'INVALID_ARGS', 'FS_STALE_VERSION', 'FS_STALE_VERSION', 'FS_STALE_VERSION'] },
  { provider: 'p10', model: 'quiet', steps: 100, codes: [] },
]
for (const entry of p10Errors) {
  for (let index = 0; index < entry.steps; index += 1) {
    samples.push(sample(entry.provider, entry.model, { ttftMs: 500, llmMs: 600 }))
  }
  for (const code of entry.codes) {
    errors.push({ provider: entry.provider, model: entry.model, time: clock, kind: 'tool', code, name: 'x' })
  }
  clock += 1000
}

let failures = 0
function check(label, condition, detail) {
  const mark = condition ? 'OK  ' : 'FAIL'
  if (!condition) failures += 1
  console.log(`${mark} ${label}${detail ? ` — ${detail}` : ''}`)
}

/** Model-level rows for one provider, ordered by `sort` in `dir`. */
const rowsFor = (provider, sort, dir) =>
  aggregate(
    samples.filter((entry) => entry.provider === provider),
    { sort, dir, errors },
  ).byModel

const names = (rows) => rows.map((row) => row.model).join(' < ')
const same = (rows, expected) => names(rows) === expected.join(' < ')
const timing = (value) =>
  value === null || value === undefined ? '-' : Math.round(value)

/** Float comparison for a derived rate, where the exact value is a fraction. */
const near = (value, expected, tolerance = 0.01) =>
  typeof value === 'number' && Math.abs(value - expected) <= tolerance

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

console.log('\n--- порядки, которые спрашивают заголовки панели ---')

// The panel asks for the order of its own column when a heading is clicked, so
// each of these keys is a column the user can sort by. A key that read the
// wrong figure would still produce an order — the wrong one.
const byModelName = rowsFor('p7', 'name')
check('sort=name идёт по имени модели', same(byModelName, ['alpha', 'beta', 'delta', 'gamma']), names(byModelName))
const byP90 = rowsFor('p7', 'ttftP90')
check('sort=ttftP90 идёт по 90-му процентилю отклика', same(byP90, ['alpha', 'gamma', 'beta', 'delta']), `${names(byP90)} (p90 ${byP90.map((r) => timing(r.ttft.p90)).join('/')})`)
const byMax = rowsFor('p7', 'tpsMax')
check('sort=tpsMax идёт по лучшему единичному замеру', same(byMax, ['beta', 'alpha', 'gamma', 'delta']), `${names(byMax)} (max ${byMax.map((r) => timing(r.speedTps.max)).join('/')})`)
// The same four rows in the order their median rate puts them: the burst of
// beta is the whole difference between the two columns, so if the two orders
// ever agree, the fixture stopped proving that `tpsMax` reads the peak.
const byMedianRate = rowsFor('p7', 'speed')
check(
  'корпус tok/s различает медиану и максимум',
  names(byMax) !== names(byMedianRate) && byMedianRate[0].model === 'alpha',
  `max → ${names(byMax)}, медиана → ${names(byMedianRate)}`,
)
const byConfidence = rowsFor('p7', 'confidence')
check(
  'sort=confidence ставит вперёд строки с достоверной скоростью',
  byConfidence[byConfidence.length - 1].model === 'delta' && byConfidence.slice(0, 3).every((row) => row.speedConfidence === 1),
  `${names(byConfidence)} (${byConfidence.map((r) => String(r.speedConfidence)).join('/')})`,
)
const byLlm = rowsFor('p7', 'llm')
check('sort=llm идёт по средней длительности шага', same(byLlm, ['alpha', 'gamma', 'beta', 'delta']), `${names(byLlm)} (llm ${byLlm.map((r) => timing(r.llmMs.mean)).join('/')})`)
const byCache = rowsFor('p7', 'cache')
check('sort=cache идёт по доле чтения из кэша', same(byCache, ['alpha', 'beta', 'gamma', 'delta']), `${names(byCache)} (cache ${byCache.map((r) => (r.cacheHitRate === null ? '-' : r.cacheHitRate.toFixed(2))).join('/')})`)

console.log('\n--- ретраи: два порядка, которые расходятся ---')

const p8Ttft = rowsFor('p8', 'ttft')
const p8Clean = rowsFor('p8', 'ttftClean')
const p8Retry = rowsFor('p8', 'retry')
const byName8 = Object.fromEntries(p8Clean.map((row) => [row.model, row]))

// The fixture has to discriminate or it proves nothing: the two orders must
// genuinely differ, and `flaky` must be the row that moves.
check(
  'фикстура различает отклик и чистый отклик',
  names(p8Ttft) === 'steady < quiet < noisy < flaky' && names(p8Clean) === 'flaky < steady < quiet < noisy',
  `ttft → ${names(p8Ttft)}, чистый → ${names(p8Clean)}`,
)
check(
  'sort=ttftClean идёт по первому токену без мёртвого времени ретраев',
  same(p8Clean, ['flaky', 'steady', 'quiet', 'noisy']),
  `${names(p8Clean)} (ttft ${p8Clean.map((r) => timing(r.ttft.median)).join('/')} → clean ${p8Clean.map((r) => timing(r.ttftClean.median)).join('/')})`,
)
check(
  'модель без ретраев отвечает одинаково в обоих столбцах',
  byName8.steady.ttft.median === byName8.steady.ttftClean.median &&
    byName8.quiet.ttft.median === byName8.quiet.ttftClean.median,
  `steady ${timing(byName8.steady.ttft.median)}/${timing(byName8.steady.ttftClean.median)}, quiet ${timing(byName8.quiet.ttft.median)}/${timing(byName8.quiet.ttftClean.median)}`,
)
check(
  'чистый отклик считается по тем же шагам, что и отклик',
  p8Clean.every((row) => row.ttft.count === row.ttftClean.count),
  p8Clean.map((row) => `${row.model} ${row.ttft.count}/${row.ttftClean.count}`).join(', '),
)
check(
  'sort=retry идёт по доле шагов с повтором, больше — выше',
  same(p8Retry, ['flaky', 'noisy', 'steady', 'quiet']),
  `${names(p8Retry)} (rate ${p8Retry.map((r) => (r.retryRate === null ? '-' : r.retryRate.toFixed(2))).join('/')})`,
)
check(
  'ноль ретраев — это замер, а не отсутствие замера',
  byName8.steady.retryRate === 0 && byName8.steady.retrySteps === 0 && byName8.quiet.retryRate === 0,
  `steady rate=${byName8.steady.retryRate}, steps=${byName8.steady.retrySteps}; quiet rate=${byName8.quiet.retryRate}`,
)
check(
  'без ретраев у строки нет скорости восстановления — нечего восстанавливать',
  byName8.steady.retryRecovery === null && byName8.flaky.retryRecovery === 1,
  `steady=${byName8.steady.retryRecovery}, flaky=${byName8.flaky.retryRecovery}`,
)
const p8RetryReversed = rowsFor('p8', 'retry', 'asc')
// Not a strict mirror, and deliberately so: the two rows at 0.50 tie, and a tie
// keeps the first of the tied rows in the order the rows were built rather than
// swapping them — the same rule every other key follows.
check(
  'перевёрнутый порядок ретраев разворачивает значения, но не меняет местами равные',
  same(p8RetryReversed, ['steady', 'quiet', 'flaky', 'noisy']),
  names(p8RetryReversed),
)

console.log('\n--- направление порядка ---')

// Each key is offered in one direction and asked for in the other one by the
// second click on its heading. The other direction is the same order turned
// around — one comparison per key, never a second rule — with two exceptions
// that are the whole point of it: a row with no measurement stays at the bottom
// in both, and a tie-break keeps its own direction.
const ttftReversed = rowsFor('p1', 'ttft', 'desc')
check('dir=desc переворачивает sort=ttft', same(ttftReversed, ['pb', 'pa']), names(ttftReversed))
const stepsAsc = rowsFor('p4', 'steps', 'asc')
check('dir=asc переворачивает sort=steps', same(stepsAsc, ['y', 'x']), names(stepsAsc))
check('dir=asc по имени идёт от Z к A', same(rowsFor('p7', 'name', 'desc'), ['gamma', 'delta', 'beta', 'alpha']), names(rowsFor('p7', 'name', 'desc')))
check('без dir порядок ключа не меняется', names(rowsFor('p1', 'ttft')) === names(ttft), names(rowsFor('p1', 'ttft')))
check('dir= nonsense не ломает порядок, а берёт направление ключа', names(rowsFor('p1', 'ttft', 'nonsense')) === names(ttft), names(rowsFor('p1', 'ttft', 'nonsense')))

const gapReversed = rowsFor('p5', 'ttft', 'desc')
check(
  'перевёрнутый порядок не поднимает строку без замера наверх',
  same(gapReversed, ['measured', 'silent']),
  names(gapReversed),
)
const cacheReversed = rowsFor('p7', 'cache', 'asc')
check(
  'в обратном порядке строка без кэша тоже внизу',
  same(cacheReversed, ['beta', 'alpha', 'gamma', 'delta']),
  names(cacheReversed),
)

const errorsAsc = rowsFor('p3', 'errors', 'asc')
check('dir=asc по ошибкам ставит вперёд наименее проблемные', same(errorsAsc, ['ec', 'eb', 'ea']), names(errorsAsc))
check(
  'при равных ошибках перевёрнутый порядок решает та же медиана ttft',
  errorsAsc[1].errors === errorsAsc[2].errors && errorsAsc[1].ttft.median < errorsAsc[2].ttft.median,
  `ошибок ${errorsAsc.map((r) => r.errors).join('/')}, med ${errorsAsc.map((r) => timing(r.ttft.median)).join('/')}`,
)

console.log('\n--- ошибки: одно число не приговор ---')

const p10ByTotal = rowsFor('p10', 'errors')
const p10ByRate = rowsFor('p10', 'errorRate')
const p10ByBlame = rowsFor('p10', 'modelErrors')
const p10 = Object.fromEntries(rowsFor('p10', 'steps').map((row) => [row.model, row]))
check(
  'сырое число ошибок уравнивает шумную и чистую модель',
  p10.noisy.errors === p10.clean.errors && p10.noisy.errors === 5,
  `noisy=${p10.noisy?.errors}, clean=${p10.clean?.errors}`,
)
check(
  'на долю модели попадает только плохой вызов, а не гонка файла',
  p10.noisy.modelErrors === 4 && p10.clean.modelErrors === 0 && p10.quiet.modelErrors === 0 &&
    p10.blamed.modelErrors === 2,
  `noisy=${p10.noisy?.modelErrors}, clean=${p10.clean?.modelErrors}, blamed=${p10.blamed?.modelErrors}, quiet=${p10.quiet?.modelErrors}`,
)
check(
  'категории различают отказ песочницы и гонку состояния',
  p10.clean.errorCategories.length === 2 &&
    p10.clean.errorCategories.some((e) => e.category === 'state_race' && e.count === 4) &&
    p10.clean.errorCategories.some((e) => e.category === 'denied' && e.count === 1),
  p10.clean?.errorCategories.map((e) => `${e.category}=${e.count}`).join(' '),
)
check(
  'FS_SANDBOX_DENIED — это отказ, а не гонка состояния файла',
  (errorCategory('FS_SANDBOX_DENIED', 'FsError') === 'denied') &&
    (errorCategory('FS_STALE_VERSION', 'FsError') === 'state_race'),
  `FS_SANDBOX_DENIED→${errorCategory('FS_SANDBOX_DENIED', 'FsError')}, FS_STALE_VERSION→${errorCategory('FS_STALE_VERSION', 'FsError')}`,
)
check(
  'каждая категория из словаря встречается в корпусе фикстуры',
  new Set(p10Errors.flatMap((e) => e.codes).map((c) => errorCategory(c, 'x'))).size >= 2 &&
    p10Errors.every((e) => e.codes.length === 0 || e.codes.every((c) => ERROR_CATEGORY_NAMES.includes(errorCategory(c, 'x')))),
  ERROR_CATEGORY_NAMES.join(', '),
)
check(
  'sort=errorRate идёт по доле на 100 шагов, а не по абсолютному числу',
  same(p10ByRate, ['blamed', 'noisy', 'clean', 'quiet']) &&
    p10.blamed.errorRate === 25 && p10.noisy.errorRate === 5 && p10.clean.errorRate === 5,
  `rate → ${names(p10ByRate)} (${p10ByRate.map((r) => r.errorRate.toFixed(1)).join('/')}), счёт → ${names(p10ByTotal)} (${p10ByTotal.map((r) => r.errors).join('/')})`,
)
check(
  'sort=modelErrors ставит вперёд модель, чьи ошибки лечатся сменой модели',
  same(p10ByBlame, ['noisy', 'blamed', 'clean', 'quiet']),
  `${names(p10ByBlame)} (model err ${p10ByBlame.map((r) => r.modelErrors).join('/')})`,
)
check(
  'у строки без ошибок нулевая доля, а не «нет данных»',
  p10.quiet.errorRate === 0 && p10.quiet.errorCategories.length === 0,
  `rate=${p10.quiet?.errorRate}, cats=${p10.quiet?.errorCategories.length}`,
)
check(
  'прерванные шаги попадают в свою колонку и в свой порядок',
  same(rowsFor('p10', 'interrupted'), ['noisy', 'clean', 'blamed', 'quiet']),
  names(rowsFor('p10', 'interrupted')),
)

console.log('\n--- что может стать замером скорости ---')

// The three derived figures of item 3, on a fixture where the streaming rate
// and the end-to-end rate disagree — the case they exist for.
const p9Stream = rowsFor('p9', 'speed')
const p9E2e = rowsFor('p9', 'e2e')
const p9Prefill = rowsFor('p9', 'prefill')
const byName9 = Object.fromEntries(p9E2e.map((row) => [row.model, row]))
check(
  'фикстура различает скорость стриминга и скорость от первого ответа',
  names(p9Stream) === 'late < prompt < batched < tight' && names(p9E2e) === 'prompt < late < batched < tight',
  `stream → ${names(p9Stream)}, e2e → ${names(p9E2e)}`,
)
check(
  'sort=e2e идёт по токенам на всё ожидание первого ответа',
  near(byName9.late.e2eTps.median, 31.25) && near(byName9.prompt.e2eTps.median, 190.9),
  `late ${byName9.late.speedTps.median}→${byName9.late.e2eTps.median}, prompt ${byName9.prompt.speedTps.median}→${byName9.prompt.e2eTps.median} tok/s`,
)
check(
  'слипшийся пакет не становится замером и в end-to-end',
  byName9.batched.e2eTps.median === null && byName9.batched.e2eTps.count === 0,
  `e2e=${byName9.batched.e2eTps.median}, n=${byName9.batched.e2eTps.count}`,
)
check(
  'без спана нет ни скорости, ни префилла, ни оверхеда',
  byName9.tight.e2eTps.median === null &&
    byName9.tight.prefillShare.median === null &&
    byName9.tight.overheadMs.median === null,
  `e2e=${byName9.tight.e2eTps.median}, prefill=${byName9.tight.prefillShare.median}, overhead=${byName9.tight.overheadMs.median}`,
)
check(
  'префилл — доля ожидания до первого токена, худший сверху',
  same(p9Prefill, ['late', 'prompt', 'batched', 'tight']) &&
    byName9.late.prefillShare.median === 0.875 && byName9.prompt.prefillShare.median > 0.09,
  `${names(p9Prefill)} (share ${p9Prefill.map((r) => (r.prefillShare.median === null ? '-' : r.prefillShare.median.toFixed(3))).join('/')})`,
)
check(
  'оверхед — часть шага на стороне хоста, и он не отрицателен',
  same(rowsFor('p9', 'overhead'), ['prompt', 'late', 'batched', 'tight']) &&
    byName9.prompt.overheadMs.median === 50 &&
    byName9.late.overheadMs.median === 100 &&
    byName9.batched.overheadMs.median === 430,
  rowsFor('p9', 'overhead').map((r) => `${r.model} ${timing(r.overheadMs.median)}`).join(', '),
)
const qualified = rowsFor('p6', 'speed')
const byName = Object.fromEntries(qualified.map((row) => [row.model, row]))
check('слипшийся пакет не становится замером', byName.packed?.speedTps.median === null && byName.packed.speedTps.count === 0, `tps=${byName.packed?.speedTps.median}`)
check('без отчёта провайдера о токенах замера нет', byName.unmeasured?.speedTps.median === null && byName.unmeasured.speedTps.count === 0, `tps=${byName.unmeasured?.speedTps.median}`)
check('у настоящего спана замер есть', byName.steady?.speedTps.median === 500 && byName.steady.speedTps.count === 5, `tps=${byName.steady?.speedTps.median}, n=${byName.steady?.speedTps.count}`)
check(
  'замер требует спана, 8 токенов и 4 фрагментов',
  SPEED_QUALIFICATION.minSpanMs === 100 && SPEED_QUALIFICATION.minTokens === 8 && SPEED_QUALIFICATION.minFragments === 4,
  JSON.stringify(SPEED_QUALIFICATION),
)

// How the provider report groups its rows is a separate question from how it
// sorts them, and the grouping used to be wrong in a way only this assertion
// could have caught: `byProvider` was bucketed by (provider, model) exactly like
// `byModel`, so a provider with two models came out as two rows, `providers`
// counted models, and a provider filter over that report kept one row per model
// of the same provider instead of the one row it names.
const corpus = aggregate(samples, { sort: 'ttft' })
const providerNames = (rows) => rows.map((row) => row.provider).join(' < ')
const expectedProviders = new Set(samples.map((entry) => entry.provider)).size
check(
  'отчёт по провайдерам — одна строка на провайдера, а не на модель',
  corpus.byProvider.length === expectedProviders && corpus.providers === expectedProviders,
  `${providerNames(corpus.byProvider)} (byModel: ${names(corpus.byModel)})`,
)
check('в строке провайдера нет модели — строка идёт по провайдеру', corpus.byProvider.every((row) => row.model === null))

const p1 = aggregate(samples.filter((entry) => entry.provider === 'p1'), { sort: 'ttft' })
check('две модели одного провайдера свернулись в одну строку', p1.byProvider.length === 1 && p1.byModel.length === 2, providerNames(p1.byProvider))
check('шаги провайдера — сумма шагов его моделей', p1.byProvider[0].steps === 20, String(p1.byProvider[0].steps))
check(
  'отклик провайдера взят по всем его шагам, а не по лучшей модели',
  p1.byProvider[0].ttft.median === 1100 && p1.byProvider[0].ttft.count === 20,
  `median=${timing(p1.byProvider[0].ttft.median)}, n=${p1.byProvider[0].ttft.count}`,
)

const p3 = aggregate(samples.filter((entry) => entry.provider === 'p3'), { sort: 'errors', errors })
check(
  'ошибки провайдера — сумма ошибок его моделей, включая сбои инструмента',
  p3.byProvider.length === 1 && p3.byProvider[0].errors === 7 && p3.byProvider[0].toolErrors === 6,
  `errors=${p3.byProvider[0]?.errors}, tool=${p3.byProvider[0]?.toolErrors}`,
)

check(
  'отчёт по провайдерам упорядочен тем же компаратором',
  monotone(corpus.byProvider, (row) => row.ttft.median, false),
  providerNames(corpus.byProvider),
)

// --- порядок по статусу: единственный, которого нет в журнале сессий -----------
//
// Every order above is folded from the session log. The status column is not: its
// figure is a probe's, from a store of its own, so the host reads the rank there
// (`lib/status.js`) and hands it to the aggregate as `options.statusOf` — the
// aggregate never sees a probe and never guesses one. What is asserted here is
// that the order is the column: the same states the panel draws, the same rule
// that history outranks a stale check, and a row nobody ever checked at the
// bottom in *both* directions rather than promoted to the worst.

console.log('\n--- порядок по статусу ---')

const PROBED_AT = 1_800_000_000_000
const answered = (provider, model) => ({
  provider,
  model,
  status: 'ok',
  code: 'stop',
  error: null,
  latencyMs: 400,
  checkedAt: PROBED_AT,
})
const refused = (provider, model, code, error, checkedAt = PROBED_AT) => ({
  provider,
  model,
  status: 'fail',
  code,
  error,
  latencyMs: 120,
  checkedAt,
})

const probeSnapshot = {
  results: [
    answered('p11', 'zulu'),
    answered('p11', 'alpha'),
    answered('p11', 'beta'),
    refused('p11', 'throttled', 'RATE_LIMIT', '429: Rate limit reached. Please try again in 1.2s.'),
    refused('p11', 'silent', 'TIMEOUT', 'no answer within 15000 ms'),
    refused('p11', 'nokey', 'AUTH', '401 Unauthorized: missing or invalid bearer token'),
    refused('p11', 'nosuch', 'UNKNOWN_MODEL', 'the provider has no configured model "x"'),
    // The rule the whole column rests on, asked of the order rather than of the
    // cell: this one failed at T and answered at T+n, so it is not broken and
    // must not sort among the broken.
    refused('p11', 'recovered', 'TIMEOUT', 'no answer within 15000 ms'),
    // `p12` is reachable — one model answers — and `p13` failed for two unrelated
    // reasons, which is a provider being down rather than a limit.
    answered('p12', 'best'),
    refused('p12', 'worst', 'TIMEOUT', 'no answer within 15000 ms'),
    refused('p13', 'first', 'AUTH', '401 Unauthorized'),
    refused('p13', 'second', 'RATE_LIMIT', '429: try again in 1.2s'),
  ],
  checking: [],
}

const steps = { nokey: 9, unchecked: 8, zulu: 6, silent: 5, throttled: 4, alpha: 2, beta: 2, nosuch: 1, recovered: 1, best: 4, worst: 2, first: 3, second: 2 }
const providerOf = (model) =>
  model === 'best' || model === 'worst' ? 'p12' : model === 'first' || model === 'second' ? 'p13' : 'p11'
// The one moment that matters for the status order is the relationship between a
// request and a check, so the steps carry it: every row was last used before the
// probe ran, and the one that answered afterwards is the row whose failure the
// history has overtaken.
const BEFORE = 1_700_000_000_000
const AFTER = PROBED_AT + 60_000
const probedSamples = Object.entries(steps).flatMap(([model, count]) =>
  Array.from({ length: count }, () => {
    const step = sample(providerOf(model), model)
    step.time = model === 'recovered' ? AFTER : BEFORE
    return step
  }),
)
const byStatus = (dir) =>
  aggregate(probedSamples, { sort: 'liveness', dir, statusOf: statusRanker(probeSnapshot) })
const p11Rows = (dir) => byStatus(dir).byModel.filter((row) => row.provider === 'p11')

const worstFirst = p11Rows(undefined)
const bestFirst = p11Rows('asc')
console.log(`sort=liveness  : ${names(worstFirst)}  (rank ${worstFirst.map((r) => r.livenessRank).join('/')})`)
console.log(`sort=liveness asc: ${names(bestFirst)}  (rank ${bestFirst.map((r) => r.livenessRank).join('/')})`)

check(
  'статус сортирует по тому, что нарисовано в кружках, и чинить нужно сверху',
  same(worstFirst, ['nokey', 'nosuch', 'silent', 'throttled', 'zulu', 'alpha', 'beta', 'recovered', 'unchecked']),
  names(worstFirst),
)
check(
  'перевёрнутый порядок ставит доступные сверху, а непроверенные — в самый низ',
  same(bestFirst, ['zulu', 'alpha', 'beta', 'recovered', 'throttled', 'silent', 'nokey', 'nosuch', 'unchecked']),
  names(bestFirst),
)
check(
  'непроверенная строка не ранг ни в одном направлении, а внизу остаётся в обоих',
  worstFirst.at(-1).livenessRank === null && bestFirst.at(-1).livenessRank === null &&
    worstFirst.at(-1).model === 'unchecked' && bestFirst.at(-1).model === 'unchecked',
  `desc → ${worstFirst.at(-1).model} (${worstFirst.at(-1).livenessRank}), asc → ${bestFirst.at(-1).model} (${bestFirst.at(-1).livenessRank})`,
)
check(
  'проверка, которую история перегнала, ранжируется как доступная, а не как сломанная',
  worstFirst.find((row) => row.model === 'recovered')?.livenessRank === 0 &&
    worstFirst.indexOf(worstFirst.find((row) => row.model === 'recovered')) >
      worstFirst.indexOf(worstFirst.find((row) => row.model === 'throttled')),
  `recovered rank=${worstFirst.find((row) => row.model === 'recovered')?.livenessRank}`,
)
check(
  'внутри одного состояния порядок тотальный: сначала занятые, потом по имени',
  worstFirst.find((row) => row.model === 'nokey')?.livenessRank === 3 &&
    worstFirst.find((row) => row.model === 'nosuch')?.livenessRank === 3 &&
    worstFirst.indexOf(worstFirst.find((r) => r.model === 'zulu')) < worstFirst.indexOf(worstFirst.find((r) => r.model === 'alpha')) &&
    worstFirst.indexOf(worstFirst.find((r) => r.model === 'alpha')) < worstFirst.indexOf(worstFirst.find((r) => r.model === 'beta')),
  `up: ${worstFirst.filter((r) => r.livenessRank === 0).map((r) => `${r.model}(${r.steps})`).join(' < ')}`,
)
check(
  'пара, о которой хранилище не знает, ранга не получает вовсе',
  statusRanker(probeSnapshot)('p11', 'never-probed', PROBED_AT) === null &&
    statusRanker(probeSnapshot)('nowhere', null, PROBED_AT) === null,
  `p11/never-probed → ${statusRanker(probeSnapshot)('p11', 'never-probed', PROBED_AT)}`,
)

const providerRows = byStatus(undefined).byProvider
const rankOf = (provider) => providerRows.find((row) => row.provider === provider)?.livenessRank
check(
  'строка провайдера ранжируется по своему свёрту, а не по лучшей модели',
  rankOf('p12') === 0 && rankOf('p13') === 2,
  `p12 (один ответил) → ${rankOf('p12')}, p13 (две разные причины) → ${rankOf('p13')}`,
)

// A caller with no probe store — the agent's tool, and any fold on its own —
// asks for an order it cannot rank by. The rows must not come out in the order
// the fold happened to build them in, which is the failure a stable sort makes
// invisible: the tie-break is what carries the order, and it is busiest first.
const withoutProbes = aggregate(probedSamples, { sort: 'liveness' }).byModel.filter((row) => row.provider === 'p11')
check(
  'без хранилища проверок порядок по статусу вырождается в «занятые сверху», а не в порядок свёртки',
  same(withoutProbes, ['nokey', 'unchecked', 'zulu', 'silent', 'throttled', 'alpha', 'beta', 'nosuch', 'recovered']),
  names(withoutProbes),
)

// The classifier itself, because the rank is only as good as the state under it:
// one state per family the panel draws, and the one mixture that must not wear a
// family's colour.
const stateOf = (probe) => `${probeState(probe)}/${statusRank(probe, probe.checkedAt)}`
const cases = [
  ['отвечает', answered('p', 'm'), 'up/0'],
  ['отказ по лимиту', refused('p', 'm', 'RATE_LIMIT', '429: try again in 1.2s'), 'limited/1'],
  ['лимит по квоте', refused('p', 'm', 'QUOTA', 'Insufficient balance'), 'limited/1'],
  ['не отвечает', refused('p', 'm', 'TIMEOUT', 'no answer within 15000 ms'), 'down/2'],
  ['нет ключа', refused('p', 'm', 'AUTH', '401 Unauthorized'), 'denied/3'],
  ['нет маршрута', refused('p', 'm', 'NO_ROUTE', 'no adapter serves this provider'), 'missing/3'],
  ['нет модели', refused('p', 'm', 'UNKNOWN_MODEL', 'has no configured model'), 'missing/3'],
  ['смесь причин — это провайдер, а не аккаунт', { ...refused('p', 'm', 'AUTH', '401'), codes: ['QUOTA', 'TIMEOUT'] }, 'down/2'],
]
for (const [label, probe, expected] of cases) {
  check(`состояние статуса: ${label}`, stateOf(probe) === expected, stateOf(probe))
}
check(
  'хранилище проверок публикует состояние вместе с результатом',
  probeState(refused('p', 'm', 'TIMEOUT', 'no answer within 15000 ms')) === 'down' &&
    probeState(null) === 'unknown' && statusRank(null, null) === null,
  `no probe → ${probeState(null)}`,
)

console.log('')
if (failures === 0) {
  console.log('ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ')
} else {
  console.log(`ПРОВАЛЕНО ПРОВЕРОК: ${failures}`)
  process.exitCode = 1
}
