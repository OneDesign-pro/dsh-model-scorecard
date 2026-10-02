// Проверяет, что технический рейтинг приходит одним и тем же числом из всех трёх
// путей сбора и что область (`sinceMs`) режет его одинаково.
//
// Панель отвечает на один вопрос тремя способами, от дешёвого к дорогому:
// память процесса (`snapshotSummary`), снапшот на диске (`snapshotReport`) и
// холодная свёртка (`collect`). Пользователь видит первый ответ, который успел
// получиться, поэтому два пути, разошедшиеся в числе, — это не медленная
// сортировка, а два разных ответа на один вопрос, и заметить это можно только
// здесь: рейтинг считается из сэмплов, а сэмплы у путей берутся из разных мест.
//
// Вторая половина — про `sinceMs`, и у неё есть измеренная причина. Память
// фильтровала сэмплы по области, а ошибки и повторы отдавала агрегату
// нефильтрованными: панель, открытая из памяти, показывала долю ошибок и повторов
// из-за предела запрошенной области, а холодный путь — внутри неё. Фикстура ниже
// кладёт ошибку и несостоявшийся повтор в старую половину истории, поэтому
// расхождение видно как число, а не как рассуждение.
//
// Третья — про устаревание: §4.2 требует пометку при показе, панель ставит `*` с
// этапа 7, и текст отчёта обязан помечать ту же строку теми же словами, иначе две
// поверхности описывают одно число по-разному. Часы отчёта не читаются из
// `Date.now()`, а передаются, поэтому проверки идут на замороженной дате: реальные
// часы здесь были бы флаком, который этот репозиторий переучивает, — фикстура
// датирована будущим, и в один день она сама перейдёт порог.
//
// Usage: node tools/verify-rating-paths.mjs

import {
  createCollector,
  pairKey,
  PANEL_SORTS,
  renderReportText,
  SORTS,
  toPanelPayload,
} from '../lib/collect.js'
import { emptyRating, RATING_POLICY } from '../lib/rating.js'
import { apply, PARAMETERS } from '../lib/index.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Both the fold snapshot and the probe store live under one directory, so the
// real `apply()` below - which persists both - writes into a temp directory and
// never into the user's cache.
const cacheDir = await mkdtemp(join(tmpdir(), 'model-scorecard-rating-paths-'))
process.env.DSH_MODEL_SCORE_CARD_CACHE_DIR = cacheDir

const DAY = 86_400_000
const NEW_BASE = 1_800_000_000_000
const OLD_BASE = NEW_BASE - 5 * DAY
// Between the two generations of history, so one scope keeps exactly the new half.
const SINCE = NEW_BASE - DAY

let failures = 0
function check(label, condition, detail) {
  const mark = condition ? 'OK  ' : 'FAIL'
  if (!condition) failures += 1
  console.log(`${mark} ${label}${detail ? ` — ${detail}` : ''}`)
}

/**
 * One step the rating can qualify: first token `firstTokenMs` after the step
 * starts, `tokens` provider-reported tokens over a span of 190 ms carried by 20
 * fragments. The two generations of history differ in `firstTokenMs` and
 * `tokens`, which is what makes the weighted quantiles move when one of them is
 * scoped out.
 *
 * `retry` records one failed attempt before the answer, which the rating excludes
 * while the retry columns count it - the population difference is the point.
 */
function step(base, provider, model, { turn = 1, step: index = 1, tokens = 20, firstTokenMs = 1300, fragments = 20, retry = false } = {}) {
  const dt = new Array(fragments).fill(10)
  const time0 = base + firstTokenMs
  const events = [{ type: 'step/start', seq: 0, time: base + 100, data: { turn, step: index } }]
  if (retry) {
    events.push({
      type: 'llm/retry',
      seq: 1,
      time: base + 120,
      data: { turn, step: index, delayMs: 900, provider, failure: { code: 'RATE_LIMIT' } },
    })
    events.push({ type: 'llm/retry-started', seq: 2, time: base + 1020, data: { turn, step: index } })
  }
  events.push({
    type: 'assistant/message',
    seq: 3,
    time: time0 + (fragments - 1) * 10,
    data: {
      turn,
      step: index,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        source: { kind: 'model', provider, model },
      },
      stream: [
        { type: 'text-chunks', time0, index: 0, dt, texts: new Array(fragments).fill('x') },
      ],
      usage: { inputTokens: 10, outputTokens: tokens, cacheReadTokens: 0 },
    },
  })
  events.push({ type: 'step/end', seq: 4, time: time0 + fragments * 10, data: { turn, step: index } })
  return events
}

/** A step whose retries never produced a message: no sample, one retry record. */
function failedStep(base, provider, model, { turn = 1, step: index = 1 } = {}) {
  return [
    { type: 'step/start', seq: 0, time: base + 100, data: { turn, step: index } },
    {
      type: 'llm/retry',
      seq: 1,
      time: base + 150,
      data: { turn, step: index, delayMs: 1200, provider, failure: { code: 'TIMEOUT' } },
    },
    { type: 'step/end', seq: 2, time: base + 1500, data: { turn, step: index } },
  ]
}

/** A failed tool call, attributed to the model that spoke last in the session. */
function toolError(base) {
  return [
    {
      type: 'tool/result',
      seq: 0,
      time: base,
      data: { message: { source: { callId: 'call-1' } }, error: { code: 'INVALID_ARGS', name: 'ToolArgsError' } },
    },
  ]
}

// The old half: 16 qualified steps at 60 tokens over 190 ms (315.79 tok/s) and a
// 50 ms first token, plus the one retried-but-recovered step, the one step whose
// retries gave up, and the one failed tool call - all three out of scope.
const oldSteps = []
for (let index = 0; index < 8; index += 1) {
  oldSteps.push(...step(OLD_BASE + index * 60_000, 'alpha', 'fast', { step: index + 1, tokens: 60, firstTokenMs: 150 }))
}
const oldSteps2 = []
for (let index = 0; index < 8; index += 1) {
  oldSteps2.push(...step(OLD_BASE + 10 * 60_000 + index * 60_000, 'alpha', 'fast', { step: index + 1, tokens: 60, firstTokenMs: 150 }))
}
oldSteps.push(
  ...step(OLD_BASE + 20 * 60_000, 'alpha', 'fast', { step: 20, tokens: 60, firstTokenMs: 150, retry: true }),
  ...failedStep(OLD_BASE + 21 * 60_000, 'alpha', 'fast', { step: 21 }),
  ...toolError(OLD_BASE + 22 * 60_000),
)

// The new half: 12 qualified steps at 20 tokens over 190 ms (105.26 tok/s) and a
// 1200 ms first token.
const newSteps = []
for (let index = 0; index < 12; index += 1) {
  newSteps.push(...step(NEW_BASE + index * 60_000, 'alpha', 'fast', { step: index + 1, tokens: 20, firstTokenMs: 1300 }))
}

// A second pair, so a selection can keep one pair and drop the other.
const otherSteps = []
for (let index = 0; index < 12; index += 1) {
  otherSteps.push(...step(NEW_BASE + index * 60_000, 'beta', 'slow', { step: index + 1, tokens: 20, firstTokenMs: 1300 }))
}

const SESSIONS = new Map([
  ['old-1', oldSteps],
  ['old-2', oldSteps2],
  ['new-1', newSteps],
  ['other-1', otherSteps],
])

/** A store backed by the four fixture sessions, revisions matching the real spelling. */
function store() {
  const revisions = new Map([...SESSIONS.keys()].map((id, index) => [id, `1:${index}:3:4:5`]))
  return {
    ctx: {
      get(name) {
        if (name === 'sessionQuery') {
          return {
            async listSessions() {
              return [...revisions.keys()].map((id) => ({ header: { id }, live: false, persisted: true }))
            },
            async observeSession(id) {
              return {
                source: 'prepared',
                header: { id },
                events: SESSIONS.get(id),
                revision: revisions.get(id),
                [Symbol.dispose]: () => {},
              }
            },
          }
        }
        if (name === 'sessionPersistence') {
          return {
            async list() {
              return [...revisions.entries()].map(([id, revision]) => ({ header: { id }, revision }))
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

// `persist: false` keeps the user's cache untouched and, because `hydrate()`
// returns at once without it, also guarantees the in-memory phase answers from
// this process's own fold rather than from whatever snapshot is on disk.
const collector = createCollector(store().ctx, { persist: false })

const rowOf = (result, provider, model) =>
  (result?.report?.byModel ?? []).find((row) => row.provider === provider && row.model === model)

const RATING_KEYS = Object.keys(emptyRating()).sort().join()
const sameRating = (left, right) => JSON.stringify(left) === JSON.stringify(right)

console.log('--- три пути отвечают одним числом ---')

const cold = await collector.collect({ sort: 'rating', budgetMs: 60_000 })
check('холодная свёртка прочитала весь корпус', cold.pending === 0 && cold.scanned === SESSIONS.size, `scanned=${cold.scanned}, pending=${cold.pending}`)

const hydrated = await collector.snapshotReport({ sort: 'rating' })
const memory = await collector.snapshotSummary({ sort: 'rating' })
check(
  'снапшот и память отвечают, а не отказываются',
  hydrated !== null && memory !== null,
  `snapshotReport=${hydrated !== null}, snapshotSummary=${memory !== null}`,
)

const coldRating = rowOf(cold, 'alpha', 'fast')?.rating
const hydratedRating = rowOf(hydrated, 'alpha', 'fast')?.rating
const memoryRating = rowOf(memory, 'alpha', 'fast')?.rating
check(
  'одна пара — одно число во всех трёх путях',
  typeof coldRating?.score === 'number' &&
    sameRating(coldRating, hydratedRating) &&
    sameRating(coldRating, memoryRating),
  `cold=${coldRating?.score}, snapshot=${hydratedRating?.score}, memory=${memoryRating?.score}`,
)
check(
  'и одна и та же популяция: 28 годных из 29 ответивших, один исключён повтором',
  coldRating.qualifiedSamples === 28 &&
    coldRating.answeredSamples === 29 &&
    coldRating.excludedRetried === 1 &&
    coldRating.excludedInterrupted === 0,
  `годных=${coldRating.qualifiedSamples}, ответивших=${coldRating.answeredSamples}, повтор=${coldRating.excludedRetried}`,
)
// The hand-checkable consequence of the fixture: 16 steps at 60 tok/s over 190 ms
// outweigh the 12 at 20 tok/s, so the weighted median of the whole history is the
// old throughput and the old 50 ms first token, and the p90 is the new 1200 ms.
check(
  'взвешенные квантили — по всей истории, а не только по свежей половине',
  coldRating.inputs.tpsMedian === (60 * 1000) / 190 &&
    coldRating.inputs.ttftMedianMs === 50 &&
    coldRating.inputs.ttftP90Ms === 1200,
  `V50=${coldRating.inputs.tpsMedian}, T50=${coldRating.inputs.ttftMedianMs}, T90=${coldRating.inputs.ttftP90Ms}`,
)
check(
  'якорь — самый свежий шаг пары, а не максимум корпуса',
  coldRating.anchor === NEW_BASE + 11 * 60_000 + 1300 + 190,
  `anchor=${coldRating.anchor} (ожидание ${NEW_BASE + 11 * 60_000 + 1300 + 190})`,
)
check(
  'три сессии пары и опубликованная, но тонкая оценка (nEffective < 30)',
  coldRating.sessions === 3 && coldRating.provisional === true && coldRating.effectiveSamples < 30,
  `сессий=${coldRating.sessions}, nEff=${coldRating.effectiveSamples}, provisional=${coldRating.provisional}`,
)

console.log('\n--- выбор пары не двигает оценку оставшейся ---')

const selected = await collector.collect({
  sort: 'rating',
  budgetMs: 60_000,
  selectionRules: { live: { base: 'none', pairs: { [pairKey('alpha', 'fast')]: 'on' } } },
})
check(
  'выбор оставил одну пару, а полный отчёт — все',
  selected.report.byModel.length === 1 &&
    selected.report.byModel[0].model === 'fast' &&
    (selected.fullReport?.byModel.length ?? 0) === 2,
  `выбрано=${selected.report.byModel.length}, полный=${selected.fullReport?.byModel.length}`,
)
check(
  'оценка оставшейся пары не изменилась от выбора',
  sameRating(rowOf(selected, 'alpha', 'fast')?.rating, coldRating),
  `${rowOf(selected, 'alpha', 'fast')?.rating?.score} против ${coldRating.score}`,
)

console.log('\n--- sinceMs режет все три пути одинаково ---')

const coldScoped = await collector.collect({ sort: 'rating', sinceMs: SINCE, budgetMs: 60_000 })
const hydratedScoped = await collector.snapshotReport({ sort: 'rating', sinceMs: SINCE })
const memoryScoped = await collector.snapshotSummary({ sort: 'rating', sinceMs: SINCE })
const scopedRating = rowOf(coldScoped, 'alpha', 'fast')?.rating
check(
  'область оставила только свежую половину: 12 годных из 12 ответивших',
  scopedRating.qualifiedSamples === 12 &&
    scopedRating.answeredSamples === 12 &&
    scopedRating.excludedRetried === 0,
  `годных=${scopedRating.qualifiedSamples}, ответивших=${scopedRating.answeredSamples}, повтор=${scopedRating.excludedRetried}`,
)
check(
  'область переставила квантили: медианы стали свежими, а не смешанными',
  scopedRating.inputs.tpsMedian === (20 * 1000) / 190 &&
    scopedRating.inputs.ttftMedianMs === 1200 &&
    scopedRating.inputs.ttftP90Ms === 1200 &&
    scopedRating.score !== coldRating.score,
  `V50=${scopedRating.inputs.tpsMedian}, T50=${scopedRating.inputs.ttftMedianMs}, score=${scopedRating.score} против ${coldRating.score}`,
)
check(
  'одно и то же число во всех трёх путях и под областью',
  sameRating(scopedRating, rowOf(hydratedScoped, 'alpha', 'fast')?.rating) &&
    sameRating(scopedRating, rowOf(memoryScoped, 'alpha', 'fast')?.rating),
  `cold=${scopedRating.score}, snapshot=${rowOf(hydratedScoped, 'alpha', 'fast')?.rating?.score}, memory=${rowOf(memoryScoped, 'alpha', 'fast')?.rating?.score}`,
)
// The regression this file exists for: the error and the failed retry sit in the
// old half, so a scoped answer must not count either of them. The memory path used
// to pass both through unfiltered and reported 1 error and 2 retry events here.
const scopedCounts = (result) => {
  const row = rowOf(result, 'alpha', 'fast')
  return { steps: row.steps, errors: row.errors, retryEvents: row.retryEvents, retryFailedSteps: row.retryFailedSteps }
}
check(
  'ошибки и повторы за пределами области не считаются ни в одном пути',
  JSON.stringify(scopedCounts(coldScoped)) === JSON.stringify({ steps: 12, errors: 0, retryEvents: 0, retryFailedSteps: 0 }) &&
    JSON.stringify(scopedCounts(hydratedScoped)) === JSON.stringify(scopedCounts(coldScoped)) &&
    JSON.stringify(scopedCounts(memoryScoped)) === JSON.stringify(scopedCounts(coldScoped)),
  `cold=${JSON.stringify(scopedCounts(coldScoped))}, snapshot=${JSON.stringify(scopedCounts(hydratedScoped))}, memory=${JSON.stringify(scopedCounts(memoryScoped))}`,
)
check(
  'а без области они считаются: одна ошибка и два повтора в старой половине',
  scopedCounts(cold).errors === 1 && scopedCounts(cold).retryEvents === 2 && scopedCounts(cold).retryFailedSteps === 1,
  JSON.stringify(scopedCounts(cold)),
)

console.log('\n--- полезная нагрузка панели и текст отчёта ---')

const payload = toPanelPayload(cold, { sort: 'rating', view: 'model', sinceMs: SINCE })
check(
  'payload называет ключ, область и несёт rating в каждой строке',
  payload.sort === 'rating' &&
    payload.sinceMs === SINCE &&
    payload.rows.length > 0 &&
    payload.rows.every((row) => Object.keys(row.rating ?? {}).sort().join() === RATING_KEYS),
  `sort=${payload.sort}, sinceMs=${payload.sinceMs}, строк=${payload.rows.length}`,
)
check(
  'rating строки совпадает с rating отчёта, а не пересчитан проекцией',
  sameRating(payload.rows.find((row) => row.model === 'fast')?.rating, coldRating),
)
check(
  'область не передана — поле говорит «вся история», а не молчит',
  toPanelPayload(cold, { sort: 'rating', view: 'model' }).sinceMs === null,
)
check(
  'ключ rating принят и агентом, и панелью',
  SORTS.includes('rating') && PANEL_SORTS.includes('rating'),
  `SORTS=${SORTS.join(',')}; PANEL_SORTS=${PANEL_SORTS.join(',')}`,
)

// A configured pair the history never saw is a row of the panel's table, and it
// must arrive with the honest empty rating rather than with no field at all.
const configured = { live: true, pairs: [{ provider: 'alpha', model: 'fast' }, { provider: 'gamma', model: 'new' }] }
const withNoStats = toPanelPayload(cold, { sort: 'rating', view: 'model', configured })
const fresh = withNoStats.rows.find((row) => row.model === 'new')
check(
  'строка без истории несёт `no_samples`, а не отсутствующее поле',
  fresh?.noStats === true && fresh?.rating?.reason === 'no_samples' && fresh.rating.score === null,
  `noStats=${fresh?.noStats}, reason=${fresh?.rating?.reason}`,
)
const providerView = toPanelPayload(cold, { sort: 'rating', view: 'provider', configured })
check(
  'строка провайдера несёт `pair_only`',
  providerView.rows.length > 0 && providerView.rows.every((row) => row.rating.reason === 'pair_only'),
  providerView.rows.map((row) => `${row.provider}:${row.rating.reason}`).join(', '),
)
check(
  'у строки без истории rating не равен измеренному нулю',
  fresh.rating.qualifiedSamples === 0 && fresh.rating.coverage === null && fresh.rating.effectiveSamples === null,
  JSON.stringify({ qualified: fresh.rating.qualifiedSamples, coverage: fresh.rating.coverage }),
)

const text = renderReportText(cold, { sort: 'rating', limit: 15 })
check(
  'текстовый отчёт несёт колонку rating и её объяснение',
  text.split('\n')[1].includes('rating') &&
    text.includes('rating technical-v1 (0-100)') &&
    text.includes('shown row(s) rated'),
  text.split('\n').find((line) => line.startsWith('rating technical-v1'))?.slice(0, 120),
)
const scopedText = renderReportText(coldScoped, { sort: 'rating', limit: 15, sinceMs: SINCE })
check(
  'область названа в отчёте явно',
  scopedText.includes('scope: steps at or after') &&
    scopedText.includes(new Date(SINCE).toISOString()) &&
    !text.includes('scope: steps at or after'),
  scopedText.split('\n').find((line) => line.startsWith('scope:'))?.slice(0, 80),
)
check(
  'провайдерский вид объясняет `pair_only`, а не молчит про прочерк',
  renderReportText(cold, { sort: 'rating', view: 'provider', limit: 15 }).includes('no score: pair_only 2'),
  renderReportText(cold, { sort: 'rating', view: 'provider', limit: 15 })
    .split('\n')
    .find((line) => line.startsWith('rating technical-v1'))
    ?.slice(0, 160),
)

console.log('\n--- устаревание: старый якорь помечается, а не пересчитывается ---')

// §4.2 wants a stale-data note at display time, and the panel and the text report
// are two displays of one number: the panel has marked a row `*` since stage 7,
// and this is the report catching up. The clock is injected rather than read, so
// the assertions are about a date that cannot move — the fixture history is dated
// *after* today (`NEW_BASE`), which is why the whole file passed before this block
// existed and why a real `Date.now()` here would be the flake this repository keeps
// re-learning: on some future day these fixtures would age past the threshold and
// every text expectation above would grow a glyph.
const anchor = coldRating.anchor
const STALE_MS = RATING_POLICY.halfLifeDays * DAY
const atNow = (now) => renderReportText(cold, { sort: 'rating', limit: 15, now })
const realClock = renderReportText(cold, { sort: 'rating', limit: 15 })
// The rating column of one row, read off the padded table: the label is the first
// cell, the marks and the figure the second.
const cellOf = (text, label) => {
  const line = text.split('\n').find((row) => row.startsWith(label))
  return line === undefined ? null : line.trim().split(/\s+/)[1]
}
// The rating cells of the named rows, read off the padded table: the label is the
// first cell, the marks and the figure the second. Named rather than scraped,
// because the report also contains a provenance line, summary lines and an `FS_*`
// footnote, and a rule loose enough to find cells among them is also loose enough
// to read one of those as a cell.
const cellsOf = (text, labels) => labels.map((label) => cellOf(text, label))
const figure = coldRating.score.toFixed(1)
const thinMark = coldRating.provisional === true ? '~' : ''
// The marks lead the figure, in both surfaces: the column is padded from the
// left, so a mark printed after the number would move the digits of the marked
// rows out of the column the unmarked rows are read in.
const freshCell = `${thinMark}${figure}`

check(
  'фикстура датирована будущим, и будущий замер не устаревает',
  anchor > Date.now() &&
    cellsOf(realClock, ['alpha/fast', 'beta/slow']).every((cell) => cell !== null && !cell.startsWith('*')) &&
    !realClock.includes('stale ('),
  `якорь ${new Date(anchor).toISOString()}, сегодня ${new Date().toISOString()}, ячейки ${cellsOf(realClock, ['alpha/fast', 'beta/slow']).join(' ')}`,
)
const justUnder = atNow(anchor + STALE_MS - 1)
check(
  'на миллисекунду меньше порога — пометки нет',
  cellOf(justUnder, 'alpha/fast') === freshCell && !justUnder.includes('stale ('),
  `ячейка ${cellOf(justUnder, 'alpha/fast')}`,
)
// The boundary is strict (`>`), the same comparison the panel makes, so the two
// surfaces cannot disagree about the row that sits exactly on it: at 30 days and
// 0 ms the measurement is not yet *over* 30 days.
const onThreshold = atNow(anchor + STALE_MS)
check(
  'ровно на пороге — всё ещё без пометки, как и в панели',
  cellOf(onThreshold, 'alpha/fast') === freshCell && !onThreshold.includes('stale ('),
  `ячейка ${cellOf(onThreshold, 'alpha/fast')}`,
)
const justOver = atNow(anchor + STALE_MS + 1)
check(
  'на миллисекунду больше — помечена, и число не изменилось',
  cellOf(justOver, 'alpha/fast') === `${thinMark}*${figure}` && justOver.includes(figure),
  `ячейка ${cellOf(justOver, 'alpha/fast')}, было ${freshCell}`,
)
check(
  'знаки стоят в том же порядке, что в панели: `~` перед `*`, и оба перед числом',
  coldRating.provisional !== true ||
    cellOf(justOver, 'alpha/fast') === `~*${figure}`,
  `provisional=${coldRating.provisional}, ячейка ${cellOf(justOver, 'alpha/fast')}`,
)
check(
  'строка про устаревание называет порог формулы и не пересчитывает оценку',
  justOver.includes(
    `stale (2, marked *: the pair's newest usable measurement is over ` +
      `${RATING_POLICY.halfLifeDays} days old, so the score is historical and not recomputed from its age): `,
  ) && justOver.includes('alpha/fast, beta/slow'),
  justOver.split('\n').find((line) => line.startsWith('stale ('))?.slice(0, 150),
)
// A provider row is the whole provider and carries no pair score (`pair_only`), so
// it has no anchor and nothing to call old: the marks belong to a pair's evidence
// and a dash stays a dash however far the clock is moved. That is the same rule the
// panel follows, and the reason the sentence counts pairs rather than rows.
const providerOld = renderReportText(cold, { sort: 'rating', view: 'provider', limit: 15, now: anchor + 10 * STALE_MS })
check(
  'вид по провайдерам не помечает ничего: у строки-провайдера нет оценки',
  !providerOld.includes('stale (') &&
    cellsOf(providerOld, ['alpha', 'beta']).every((cell) => cell === '-'),
  `ячейки ${cellsOf(providerOld, ['alpha', 'beta']).join(' ')}, срок сдвинут на ${10 * RATING_POLICY.halfLifeDays} дней`,
)
// A report whose rows are all stale still counts its own rows, so the sentence
// cannot claim rows the table refused to show.
check(
  'в счёте устаревших — только показанные строки',
  justOver.includes('stale (2,') &&
    justOver
      .split('\n')
      .filter((line) => /^(alpha|beta)\//.test(line)).length === 2,
  justOver.split('\n').find((line) => line.startsWith('stale ('))?.match(/stale \(\d+/)?.[0],
)

console.log('\n--- схема инструмента описывает новый ключ ---')
check(
  'enum инструмента — это SORTS, и rating в нём',
  PARAMETERS.properties.sort.enum === SORTS && PARAMETERS.properties.sort.enum.includes('rating'),
  PARAMETERS.properties.sort.enum.join(','),
)
check(
  'описание сортировки и sinceMs называют рейтинг',
  PARAMETERS.properties.sort.description.includes('rating') &&
    PARAMETERS.properties.sinceMs.description.includes('rating') &&
    PARAMETERS.properties.sort.description.includes('Default remains steps'),
)

// The schema says the tool accepts `rating`; this drives the registered tool to
// prove it does. `apply()` is the real entry point, with a mock context whose
// store is the same four fixture sessions, and the only service it is not given
// is `webServer` - the tool half does not need it, and the panel half is
// exercised through the collector directly above.
const registeredTools = []
const routes = new Map()
const toolCtx = {
  get(name) {
    if (name === 'tools') {
      return {
        register(definition) {
          registeredTools.push(definition)
        },
      }
    }
    if (name === 'webServer') {
      return {
        register(route) {
          routes.set(route.path, route.handler)
        },
      }
    }
    return store().ctx.get(name)
  },
  effect: (fn) => fn(),
  // Silent on purpose: the background warm pass saves a snapshot into the temp
  // directory this file deletes on exit, and its failure to write afterwards is
  // the isolation working, not a result to print.
  logger: { info: () => {}, warn: () => {} },
}
apply(toolCtx)
const tool = registeredTools.find((definition) => definition.name === 'model_stats')
const toolRatingText = await tool.execute({ sort: 'rating', limit: 5 })
const toolDefaultText = await tool.execute({ sort: 'nonsense', limit: 5 })
check(
  'sort: rating работает в выводе инструмента, а не только в схеме',
  toolRatingText.split('\n')[1].includes('rating') &&
    toolRatingText.includes('rating technical-v1') &&
    toolRatingText.includes('sorted by rating'),
  toolRatingText.split('\n').find((line) => line.startsWith('view='))?.slice(0, 60),
)
check(
  'прежний порядок по умолчанию остался шагами',
  toolDefaultText.includes('sorted by steps') && !toolDefaultText.includes('sorted by rating'),
  toolDefaultText.split('\n').find((line) => line.startsWith('view='))?.slice(0, 60),
)
check(
  'и рейтинг в выводе инструмента — то же число, что в отчёте коллектора',
  toolRatingText.includes(`${thinMark}${coldRating.score.toFixed(1)}`),
  `${thinMark}${coldRating.score.toFixed(1)}${toolRatingText.includes(`${thinMark}${coldRating.score.toFixed(1)}`) ? ' найдено' : ' не найдено'} в выводе инструмента`,
)

// The panel's own route, driven end to end: this is the contract the settings
// panel reads, and the one place where the rating, the scope and the rows meet.
const getJson = async (url) => {
  let body = ''
  const res = {
    statusCode: 0,
    setHeader: () => {},
    end: (chunk) => {
      body = chunk
    },
  }
  await routes.get('/api/model-scorecard')({ url, method: 'GET' }, res)
  return { status: res.statusCode, json: JSON.parse(body) }
}
const scopedGet = await getJson(`/api/model-scorecard?sort=rating&sinceMs=${SINCE}&limit=10`)
check(
  'панельный GET принимает rating и называет область, а не молчит о ней',
  scopedGet.status === 200 &&
    scopedGet.json.sort === 'rating' &&
    scopedGet.json.sinceMs === SINCE &&
    scopedGet.json.rows.length > 0 &&
    scopedGet.json.rows.every((row) => typeof row.rating?.score === 'number'),
  `status=${scopedGet.status}, sort=${scopedGet.json.sort}, sinceMs=${scopedGet.json.sinceMs}, строк=${scopedGet.json.rows?.length}`,
)
check(
  'и строка панели несёт то же число, что отчёт коллектора под той же областью',
  scopedGet.json.rows.find((row) => row.model === 'fast')?.rating?.score === scopedRating.score,
  `${scopedGet.json.rows.find((row) => row.model === 'fast')?.rating?.score} против ${scopedRating.score}`,
)
const plainGet = await getJson('/api/model-scorecard?sort=rating&limit=10')
check(
  'без области панель говорит «вся история» и отдаёт полное число',
  plainGet.json.sinceMs === null &&
    plainGet.json.rows.find((row) => row.model === 'fast')?.rating?.score === coldRating.score,
  `sinceMs=${plainGet.json.sinceMs}, score=${plainGet.json.rows.find((row) => row.model === 'fast')?.rating?.score}`,
)
const providerGet = await getJson('/api/model-scorecard?sort=rating&view=provider&limit=10')
check(
  'провайдерский вид панели отвечает `pair_only` и не выдумывает оценку',
  providerGet.status === 200 &&
    providerGet.json.rows.length > 0 &&
    providerGet.json.rows.every((row) => row.rating.reason === 'pair_only' && row.rating.score === null),
  providerGet.json.rows.map((row) => `${row.provider}:${row.rating.reason}`).join(', '),
)

// The background warm pass the real `apply()` started may still be writing its
// snapshot into this directory, so the cleanup retries and finally tolerates a
// late entry: a leftover temp directory is not a test result, and a removal
// error must not decide the exit code.
await rm(cacheDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {})

console.log('')
if (failures === 0) {
  console.log('ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ')
} else {
  console.log(`ПРОВАЛЕНО ПРОВЕРОК: ${failures}`)
  process.exitCode = 1
}
