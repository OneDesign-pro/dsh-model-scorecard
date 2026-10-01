// Проверяет строки, которые панель строит из конфигурации, а не из истории:
// модель, которую харнесс обслуживает, но ни одна сессия ещё не запускала.
//
// Зачем это вообще строки таблицы. Панель отвечает на два вопроса сразу —
// «как ведёт себя то, что я уже запускал» и «что ещё настроено и это можно
// запустить», — и второй вопрос и есть смысл столбца «статус»: модель, которую
// никто не запускал, ровно та, чья живость никому не известна, и именно её
// читатель открывает таблицу, чтобы попробовать. Строка такой пары несёт шаги 0
// (это замер: ни одного шага не записано) и ни одного другого измерения, и
// кружок статуса, который можно нажать.
//
// Три свойства здесь — не косметика, а границы:
//
//   * **Строка не выдумана.** `configured` = `null` (хост не прочитал живой
//     каталог) — строк нет вовсе: то же правило, что у архива, и по той же
//     причине. Архив и эти строки — одно утверждение про одну строку: в
//     конфигурации и не видна истории (здесь) либо видна истории и не в
//     конфигурации (архив). Одна и та же пара в обеих половинах не удваивается.
//   * **Порядок один.** Слияние измеренных строк с неизмеренными — это
//     пересортировка общим компаратором (`comparatorFor`), а не склейка
//     «измеренные, потом остальные»: при сортировке по имени или по шагам
//     возрастанию неизмеренная строка обязана встать между измеренными, и
//     склейка дала бы порядок, противоречащий своему же заголовку.
//   * **Отчёт агенту не тронут.** Текстовая таблица `model_stats` остаётся
//     историей: у неё лимит в 15 строк, и вытеснять ими измеренные строки
//     нечем — протестировать модель агент может `model_liveness`, который
//     обходит весь каталог.
//
// Usage: node tools/verify-configured-rows.mjs

import { aggregate, unmeasuredRow } from '../lib/fold.js'
import { renderReportText, toPanelPayload } from '../lib/collect.js'
import { statusRanker } from '../lib/status.js'

let failures = 0
function check(label, condition, detail) {
  const mark = condition ? 'OK  ' : 'FAIL'
  if (!condition) failures += 1
  console.log(`${mark} ${label}${detail ? ` — ${detail}` : ''}`)
}

let clock = 1_700_000_000_000

/**
 * One folded step sample, with every field the aggregate reads.
 *
 * `llmMs` follows the first token rather than being fixed, because a step always
 * lasts at least that long: a fixture that broke the identity would make the
 * overhead column negative and prove nothing about it.
 */
function sample(provider, model, ttftMs) {
  clock += 1000
  return {
    sessionId: 's1',
    time: clock,
    provider,
    model,
    llmMs: ttftMs + 500,
    ttftMs,
    decodeMs: null,
    streamMs: 400,
    streamTokens: 100,
    streamFragments: 8,
    outputTokens: 100,
    inputTokens: 10,
    cacheReadTokens: 5,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    interrupted: false,
  }
}

// The history: three models, one provider, in an order every key below can tell
// apart — `a-fast` is the busiest and the quickest, `a-old` is quiet and slow,
// `b-slow` is the slowest of all and the only one that ever failed.
const samples = [
  ...Array.from({ length: 9 }, (_, i) => sample('a', 'a-fast', 100 + i)),
  ...Array.from({ length: 2 }, (_, i) => sample('a', 'a-old', 900 + i)),
  ...Array.from({ length: 4 }, (_, i) => sample('b', 'b-slow', 5000 + i)),
]
const errors = [{ provider: 'b', model: 'b-slow', kind: 'tool' }]

// The payload re-sorts the merged table with the key the caller asked for, so
// the fixture has to ask the fold for the same key and direction the payload is
// given — exactly as the route hands one `{ sort, dir }` to both.
const result = (sort = 'ttft', dir) => ({
  report: aggregate(samples, { sort, dir, errors }),
  scanned: 1,
  skipped: 0,
  pending: 0,
  provenance: { snapshotAt: null, readNow: 1, reused: 0 },
})

const catalog = (pairs, live = true) => ({ live, pairs })

// The configuration serves everything the history knows and three pairs nobody
// has ever run — including `c`, a provider with no history at all, which is the
// case the provider view and the provider filter have to answer for.
const CONFIGURED = [
  { provider: 'a', model: 'a-fast' },
  { provider: 'a', model: 'a-old' },
  { provider: 'a', model: 'a-new' },
  { provider: 'b', model: 'b-slow' },
  { provider: 'b', model: 'b-new' },
  { provider: 'c', model: 'c-new' },
]
const configured = catalog(CONFIGURED)
const payload = (options = {}) => {
  const sort = options.sort ?? 'ttft'
  return toPanelPayload(result(sort, options.dir), { ...options, sort })
}
const models = (value) => value.rows.map((row) => row.model).join(' < ')
const providers = (value) => value.rows.map((row) => row.provider).join(' < ')

console.log('--- что построено из пары, у которой нет истории ---')

const row = unmeasuredRow('p', 'm')
const measured = aggregate([sample('p', 'm', 100)], { sort: 'ttft' }).byModel[0]
check(
  'строка пары без истории — та же форма, что у измеренной',
  Object.keys(row).join() === Object.keys(measured).join(),
  `${Object.keys(row).length} полей против ${Object.keys(measured).length}`,
)
check(
  'ни одно измерение не подставлено нулём',
  row.steps === 0 &&
    row.sessions === 0 &&
    row.ttft.median === null &&
    row.ttft.count === 0 &&
    row.speedTps.median === null &&
    row.ttftClean.median === null &&
    row.llmMs.median === null &&
    row.cacheHitRate === null &&
    row.errorRate === null &&
    row.retryRate === null &&
    row.lastSeen === null,
  JSON.stringify({
    steps: row.steps,
    ttft: row.ttft.median,
    tps: row.speedTps.median,
    cache: row.cacheHitRate,
    lastSeen: row.lastSeen,
  }),
)
check(
  'нулевые счётчики остаются замерами: ошибок нет, прерванных нет, контекста нет',
  row.errors === 0 && row.toolErrors === 0 && row.interrupted === 0 && row.maxContextTokens === 0 &&
    row.retrySteps === 0 && row.retryFailedSteps === 0 && row.retryCodes.length === 0,
)
// The rating is on this row too, and its absence of evidence has to read as
// absence: a configured pair nobody ran is `no_samples`, while the provider
// roll-up - which has no single pair to rate - is `pair_only`. Neither is a zero
// and neither is a score.
check(
  'пара без истории — `no_samples`, провайдерский свёрт — `pair_only`',
  row.rating.score === null &&
    row.rating.reason === 'no_samples' &&
    row.rating.qualifiedSamples === 0 &&
    unmeasuredRow('p', null).rating.reason === 'pair_only',
  `модель → ${row.rating.reason}, провайдер → ${unmeasuredRow('p', null).rating.reason}`,
)

const base = payload({ view: 'model', configured })
check(
  'пара из конфигурации без истории стала строкой, и она помечена',
  base.rows.length === 6 &&
    base.rows.filter((entry) => entry.noStats === true).map((entry) => entry.model).join() ===
      'a-new,b-new,c-new',
  models(base),
)
check(
  'эта строка не в архиве: архив — это то, чего конфигурация не знает',
  base.rows.filter((entry) => entry.noStats === true).every((entry) => entry.archived === false),
)
check(
  'пара, которую знает и история, осталась одна, а не удвоилась',
  base.rows.filter((entry) => entry.model === 'a-fast').length === 1,
  models(base),
)
check('счётчик называет их число', base.noStats.rows === 3, JSON.stringify(base.noStats))

console.log('\n--- порядок: одна таблица, а не две склейки ---')

check(
  'по умолчанию неизмеренные строки внизу, а не поверх измеренных',
  models(base) === 'a-fast < a-old < b-slow < a-new < b-new < c-new',
  models(base),
)
const byStepsAsc = payload({ view: 'model', configured, sort: 'steps', dir: 'asc' })
check(
  'по шагам возрастанию нулевые шаги идут первыми: 0 — это замер, а не пропуск',
  models(byStepsAsc) === 'a-new < b-new < c-new < a-old < b-slow < a-fast',
  models(byStepsAsc),
)
const byStepsDesc = payload({ view: 'model', configured, sort: 'steps', dir: 'desc' })
check(
  'по шагам убыванию они внизу',
  models(byStepsDesc) === 'a-fast < b-slow < a-old < a-new < b-new < c-new',
  models(byStepsDesc),
)
const byName = payload({ view: 'model', configured, sort: 'name', dir: 'asc' })
check(
  'по имени они встают между измеренными, а не после них',
  models(byName) === 'a-fast < a-new < a-old < b-new < b-slow < c-new',
  models(byName),
)
const byLastSeen = payload({ view: 'model', configured, sort: 'lastSeen', dir: 'desc' })
check(
  'по свежести они внизу, и перевёрнутый порядок их наверх не поднимает',
  models(byLastSeen) === 'b-slow < a-old < a-fast < a-new < b-new < c-new' &&
    models(payload({ view: 'model', configured, sort: 'lastSeen', dir: 'asc' })) ===
      'a-fast < a-old < b-slow < a-new < b-new < c-new',
  `${models(byLastSeen)} / ${models(payload({ view: 'model', configured, sort: 'lastSeen', dir: 'asc' }))}`,
)

console.log('\n--- порядок по статусу: тот, ради которого их и видно ---')

// A probe answers one pair and history never has: `c-new` did not answer, `a-new`
// did, `b-new` was never checked. The status order has to put them in that order
// — worst first — and leave the never-checked at the bottom, or the one order a
// reader uses to ask "what is broken right now" would file the row this change
// added by accident of construction.
const probes = {
  results: [
    { provider: 'c', model: 'c-new', status: 'fail', code: 'TIMEOUT', error: 'no answer', checkedAt: 5, latencyMs: 1 },
    { provider: 'a', model: 'a-new', status: 'ok', code: 'stop', error: null, checkedAt: 5, latencyMs: 400 },
  ],
  checking: [],
}
const statusOf = statusRanker(probes)
const byStatus = payload({ view: 'model', configured, sort: 'liveness', dir: 'desc', statusOf })
check(
  'сломанная пара из конфигурации сортируется выше доступной, а непроверенная — в самом низу',
  models(byStatus) === 'c-new < a-new < a-fast < b-slow < a-old < b-new',
  models(byStatus),
)
check(
  'перевёрнутый порядок по статусу не поднимает непроверенные наверх',
  models(payload({ view: 'model', configured, sort: 'liveness', dir: 'asc', statusOf })).endsWith(
    'b-new',
  ),
  models(payload({ view: 'model', configured, sort: 'liveness', dir: 'asc', statusOf })),
)

console.log('\n--- фильтр, лимит и архив ---')

const filtered = payload({ view: 'model', configured, provider: 'a' })
check(
  'фильтр по провайдеру добирается и до строк конфигурации',
  models(filtered) === 'a-fast < a-old < a-new' && filtered.noStats.rows === 1,
  `${models(filtered)} (${JSON.stringify(filtered.noStats)})`,
)
const onlyNew = payload({ view: 'model', configured, provider: 'c' })
check(
  'провайдер, у которого истории нет вовсе, отвечает своими строками',
  models(onlyNew) === 'c-new' && filtered.shown.models === 3,
  `${models(onlyNew)} / показано ${filtered.shown.models}`,
)
check(
  'лимит режет страницу после слияния, и страницу могут занять строки конфигурации',
  payload({ view: 'model', configured, sort: 'steps', dir: 'asc', limit: 2 }).rows.length === 2 &&
    models(payload({ view: 'model', configured, sort: 'steps', dir: 'asc', limit: 2 })) ===
      'a-new < b-new' &&
    payload({ view: 'model', configured, sort: 'steps', dir: 'asc', limit: 2 }).shown.models === 6,
  models(payload({ view: 'model', configured, sort: 'steps', dir: 'asc', limit: 2 })),
)
check(
  'счётчик строк конфигурации считает отфильтрованное множество, а не страницу',
  payload({ view: 'model', configured, limit: 1 }).noStats.rows === 3 &&
    payload({ view: 'model', configured, limit: 1 }).rows.length === 1,
)

// The two halves of one statement, in one table: the pair the configuration lost
// is hidden by default and marked, the pair it serves and the history never saw
// is shown and marked as the other kind.
const withoutSlow = catalog(CONFIGURED.filter((pair) => pair.model !== 'b-slow'))
const mixed = payload({ view: 'model', configured: withoutSlow, sort: 'name', dir: 'asc' })
check(
  'строка вне конфигурации по-прежнему скрыта, а строки конфигурации видны',
  models(mixed) === 'a-fast < a-new < a-old < b-new < c-new' &&
    mixed.archive.rows === 1 &&
    mixed.archive.steps === 4,
  `${models(mixed)} / ${JSON.stringify(mixed.archive)}`,
)
check(
  'и с флагом архива обе половины в одной таблице, различимые',
  payload({ view: 'model', configured: withoutSlow, includeArchived: true, sort: 'name', dir: 'asc' })
    .rows.map((entry) => `${entry.model}:${entry.archived ? 'архив' : entry.noStats ? 'без статистики' : 'история'}`)
    .join(' < ') === 'a-fast:история < a-new:без статистики < a-old:история < b-new:без статистики < b-slow:архив < c-new:без статистики',
  payload({ view: 'model', configured: withoutSlow, includeArchived: true, sort: 'name', dir: 'asc' })
    .rows.map((entry) => `${entry.model}:${entry.archived}:${entry.noStats}`)
    .join(' < '),
)

console.log('\n--- вид по провайдерам и список провайдеров ---')

const byProvider = payload({ view: 'provider', configured })
check(
  'провайдер без единой строки истории получает строку из конфигурации',
  providers(byProvider) === 'a < b < c' &&
    byProvider.rows.at(-1).provider === 'c' &&
    byProvider.rows.at(-1).steps === 0 &&
    byProvider.rows.at(-1).noStats === true &&
    byProvider.rows.at(-1).archived === false,
  `${providers(byProvider)} / ${JSON.stringify(byProvider.rows.at(-1)?.steps)}`,
)
check(
  'список провайдеров для фильтра добирает провайдера, которого история не знает',
  byProvider.providerList.map((entry) => `${entry.provider}:${entry.steps}`).join() ===
    'a:11,b:4,c:0',
  byProvider.providerList.map((entry) => `${entry.provider}:${entry.steps}`).join(' | '),
)
check(
  'провайдер, который в истории есть, не задваивается и не теряет шаги',
  base.providerList.map((entry) => `${entry.provider}:${entry.steps}`).join() === 'a:11,b:4,c:0',
  base.providerList.map((entry) => `${entry.provider}:${entry.steps}`).join(' | '),
)

console.log('\n--- пустая история и неизвестная конфигурация ---')

const empty = toPanelPayload(
  { empty: true, scanned: 3, skipped: 0, pending: 0, provenance: { snapshotAt: null, readNow: 0, reused: 0 } },
  { view: 'model', configured, sort: 'name', dir: 'asc' },
)
check(
  'пустая история при живой конфигурации отвечает таблицей, а не пустотой',
  empty.empty === false &&
    models(empty) === 'a-fast < a-new < a-old < b-new < b-slow < c-new' &&
    empty.rows.every((entry) => entry.noStats === true),
  `${models(empty)} / empty=${empty.empty}`,
)
check(
  'итогов по истории в таком ответе нет: нули читались бы как посчитанная история',
  empty.totals === null && empty.noStats.rows === 6,
  JSON.stringify(empty.totals),
)
const noCatalog = payload({ view: 'model' })
check(
  'без каталога ничего не выдумано: только история и `archive: null`',
  models(noCatalog) === 'a-fast < a-old < b-slow' &&
    noCatalog.noStats === null &&
    noCatalog.archive === null,
  `${models(noCatalog)} / noStats=${JSON.stringify(noCatalog.noStats)}`,
)
const partial = payload({ view: 'model', configured: catalog(CONFIGURED, false) })
check(
  'частичный каталог (без живого ctx.llm) — тоже «неизвестно», а не «ничего не настроено»',
  models(partial) === 'a-fast < a-old < b-slow' && partial.noStats === null,
  `${models(partial)} / noStats=${JSON.stringify(partial.noStats)}`,
)
const emptyNoCatalog = toPanelPayload(
  { empty: true, scanned: 3, skipped: 0, pending: 0, provenance: { snapshotAt: null, readNow: 0, reused: 0 } },
  { view: 'model' },
)
check(
  'пустая история без каталога остаётся пустой таблицей',
  emptyNoCatalog.empty === true && emptyNoCatalog.rows.length === 0,
  `row=${emptyNoCatalog.rows.length}`,
)

console.log('\n--- текстовая таблица агента не выросла ---')

const text = renderReportText(result(), { limit: 50, configured })
const textRows = text.split('\n').filter((line) => /^[abc]\//.test(line))
check(
  'в отчёте агента только строки истории',
  textRows.length === 3 && !text.includes('c/c-new') && !text.includes('a/a-new'),
  textRows.join(' | '),
)
// Every line but the archive's own: with a catalog the tool has an archive to
// grade against, so that one line differs by design. The table and the summary
// must not.
const withoutArchiveLine = (value) =>
  value.split('\n').filter((line) => !line.startsWith('archive:')).join('\n')
check(
  'порядок и сводка отчёта не тронуты строками конфигурации',
  withoutArchiveLine(text) === withoutArchiveLine(renderReportText(result(), { limit: 50 })),
  text.split('\n').find((line) => line.startsWith('fastest first token:')),
)

console.log('')
if (failures === 0) {
  console.log('ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ')
} else {
  console.log(`ПРОВАЛЕНО ПРОВЕРОК: ${failures}`)
  process.exitCode = 1
}
