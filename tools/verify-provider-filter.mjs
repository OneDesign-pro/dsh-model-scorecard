// Проверяет фильтрацию по провайдеру на всех трёх поверхностях сразу: сборщик,
// панельный payload и текстовый отчёт тула.
//
// Провайдеров фильтрует одна функция (`providerFilter`), и именно на этом
// стоит всё остальное. Если маршрут панели, аргумент тула и сохранённая
// настройка браузера начнут понимать «провайдера» по-разному, таблица в панели
// и текст в ответе агенту разойдутся — а расхождение этих двух поверхностей
// здесь и есть главный запрет.
//
// Три свойства проверяются отдельно, потому что на них держится сам фильтр в
// панели:
//
//   * `catalog` — полный список провайдеров и моделей истории и конфигурации,
//     а не те, что попали в строки. Строки отсортированы, обрезаны лимитом и
//     уже отфильтрованы; если выборку строить из них, фильтр не сможет
//     предложить именно того провайдера, ради которого и открывается.
//   * `catalog` под архивом — провайдер, у которого в архиве все строки, из
//     списка уходит и возвращается вместе с ними, когда архив включён: у
//     каталога то же обещание, что у таблицы, — назвать того, до кого фильтр
//     дотянется.
//   * `coverage` — сколько моделей каждого провайдера выбрано текущими
//     правилами, а не что влезло в страницу. Панель печатает это рядом с
//     итогами по всей истории, и молчаливый обмен одного на другое там
//     недопустим.
//
// Usage: node tools/verify-provider-filter.mjs

import { aggregate } from '../lib/fold.js'
import {
  configuredIndex,
  pairKey,
  providerFilter,
  renderReportText,
  resolveSelection,
  selectionCatalog,
  toPanelPayload,
} from '../lib/collect.js'

let failures = 0
function check(label, condition, detail) {
  const mark = condition ? 'OK  ' : 'FAIL'
  if (!condition) failures += 1
  console.log(`${mark} ${label}${detail ? ` — ${detail}` : ''}`)
}

// The scope rules the panel stores: every measured pair of the live scope on,
// nothing of the archive scope on. This is the panel's first-open default, so
// the coverage derived from it is what the tree's "selected" column must match.
// The payload prints coverage from the pairs the route resolved, and a caller
// that drove the payload without a collector hands the payload those pairs the
// same way the route hands them: `resolveSelection` of the rules over the same
// catalog.
const RULES = {
  live: { base: 'measured', providers: {}, pairs: {} },
  archive: { base: 'none', providers: {}, pairs: {} },
}

const providersOf = (catalog) => catalog.map((group) => group.provider).join()
const stepsOf = (catalog, provider) =>
  catalog.find((group) => group.provider === provider)?.models.reduce((sum, entry) => sum + entry.steps, 0) ?? 0
// The pairs the panel's stored rules resolve to over a catalog, and the counts
// they imply per provider.
const pairsOf = (catalog) => resolveSelection(RULES, catalog).pairs
const coverageOf = (catalog) => resolveSelection(RULES, catalog).providers

let clock = 1_700_000_000_000

/** One folded step sample. */
function sample(provider, model, ttftMs) {
  clock += 1000
  return {
    sessionId: 's1',
    time: clock,
    provider,
    model,
    llmMs: 500,
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

// `a` is busy and quick, `b` is slow and quiet, `c` answers so rarely that a
// one-row table next to it is the only place a mistake would show.
const samples = [
  ...Array.from({ length: 9 }, (_, index) => sample('a', 'a-fast', 100 + index)),
  ...Array.from({ length: 2 }, (_, index) => sample('a', 'a-second', 900 + index)),
  ...Array.from({ length: 4 }, (_, index) => sample('b', 'b-slow', 5000 + index)),
  sample('c', 'c-rare', 10),
]
const errors = [
  { provider: 'b', model: 'b-slow', kind: 'tool' },
  { provider: 'a', model: 'a-fast', kind: 'request' },
]

const result = (sort = 'ttft') => ({
  report: aggregate(samples, { sort, errors }),
  scanned: 1,
  skipped: 0,
  pending: 0,
  provenance: { snapshotAt: null, readNow: 1, reused: 0 },
})

console.log('--- как читается сам фильтр ---')

check('одно имя', providerFilter('openrouter').join() === 'openrouter')
check('список через запятую', providerFilter('openrouter,codex').join() === 'openrouter,codex')
check('массив', providerFilter(['openrouter', 'codex']).join() === 'openrouter,codex')
check('повтор одного параметра', providerFilter(['openrouter', 'openrouter']).join() === 'openrouter')
check('пробелы вокруг имени', providerFilter(' openrouter , codex ').join() === 'openrouter,codex')
check('пустое значение — это отсутствие фильтра', providerFilter('').length === 0 && providerFilter(null).length === 0)
check('мусор отброшен, а не отправлен', providerFilter([1, null, {}, 'codex']).join() === 'codex', JSON.stringify(providerFilter([1, null, {}, 'codex'])))
check('неизвестное имя остаётся фильтром, а не снимает его', providerFilter('nope').join() === 'nope')

console.log('\n--- что панель получает по HTTP ---')

const fullCatalog = selectionCatalog(result().report, null, false)
const fullSelection = pairsOf(fullCatalog)
const full = toPanelPayload(result(), { view: 'model', limit: 50, selection: fullSelection })
check('без фильтра в таблице все строки', full.rows.length === 4, String(full.rows.length))
check('каталог знает все провайдеры истории', providersOf(full.catalog) === 'a,b,c', providersOf(full.catalog))
check(
  'каталог несёт модели и шаги каждого провайдера',
  stepsOf(full.catalog, 'a') === 11 && stepsOf(full.catalog, 'b') === 4 && stepsOf(full.catalog, 'c') === 1,
  JSON.stringify(full.catalog.map((group) => `${group.provider}:${group.models.length}m/${group.models.reduce((sum, entry) => sum + entry.steps, 0)}`)),
)
check(
  'покрытие считает все измеренные модели выбранными',
  JSON.stringify(full.coverage ?? null) === JSON.stringify([
    { provider: 'a', selected: 2, total: 2 },
    { provider: 'b', selected: 1, total: 1 },
    { provider: 'c', selected: 1, total: 1 },
  ]),
  JSON.stringify(full.coverage ?? null),
)

// The case the filter exists for: the rows name two providers, the catalog has to
// name three, or the control can only ever offer what is already on screen.
const one = toPanelPayload(result(), { view: 'model', limit: 50, provider: 'a' })
check('строки отфильтрованы', one.rows.map((row) => row.provider).join() === 'a,a', one.rows.map((r) => r.provider).join(' | '))
check('каталог при этом не пострадал', providersOf(one.catalog) === 'a,b,c', providersOf(one.catalog))
check('применённый фильтр возвращается эхом', one.providers.join() === 'a')
check('итоги после фильтра считают отфильтрованное', one.shown.models === 2 && one.shown.steps === 11, JSON.stringify(one.shown))
check('итоги всей истории не изменились', one.totals.models === 4 && one.totals.providers === 3, JSON.stringify(one.totals))

const several = toPanelPayload(result(), { view: 'model', limit: 50, provider: 'a,c' })
// The rows stay in the chosen order, so the filter is asserted as a set: what
// the question asked for, not where the answer puts it.
check(
  'несколько провайдеров за один раз',
  several.rows.map((row) => row.provider).sort().join() === 'a,a,c',
  several.rows.map((r) => r.provider).join(' | '),
)
check('эхо сохраняет оба имени', several.providers.join() === 'a,c')

// The limit is a page, the filter is a question: the two are counted apart.
const page = toPanelPayload(result(), { view: 'model', limit: 1, provider: 'a' })
check('лимит режет страницу, а не фильтр', page.rows.length === 1 && page.shown.models === 2, `${page.rows.length} / ${page.shown.models}`)

const miss = toPanelPayload(result(), { view: 'model', provider: 'nope' })
check('пустой результат фильтра — пустой результат, а не вся таблица', miss.rows.length === 0 && miss.totals.models === 4, `${miss.rows.length} строк, ${JSON.stringify(miss.totals)}`)

console.log('\n--- что достаёт агент ---')

const text = renderReportText(result(), { provider: 'a', limit: 50 })
const textRows = text.split('\n').filter((line) => /^(a|b|c)\//.test(line))
check('в таблице только выбранный провайдер', textRows.every((line) => line.startsWith('a/')), textRows.join(' | '))
check('в сводке назван фильтр', text.includes('provider=a'), text.split('\n').find((line) => line.startsWith('view=')))
check('«самый быстрый первый токен» — из отфильтрованных', text.includes('fastest first token: a/a-fast'), text.split('\n').find((line) => line.startsWith('fastest first token:')))
check('ошибки в сводке — из отфильтрованных', text.includes('errors: a/a-fast=1') && !text.includes('b/b-slow=1'), text.split('\n').find((line) => line.startsWith('errors:')))
// The page a limit cuts is not the set the answer is about: raising the limit
// must not change which model is the fastest.
const wide = renderReportText(result(), { provider: 'a', limit: 1 })
const fastest = (value) => value.split('\n').find((line) => line.startsWith('fastest first token:'))
check('лимит не меняет ответ об отфильтрованных', fastest(wide) === fastest(text), `${fastest(wide)} / ${fastest(text)}`)

const emptyText = renderReportText(result(), { provider: 'nope' })
check('пустой фильтр объяснён в тексте', emptyText.includes('no rows for provider=nope'), emptyText.split('\n').find((line) => line.startsWith('no rows')))

console.log('\n--- вид по провайдерам ---')

const byProvider = toPanelPayload(result(), { view: 'provider', limit: 50 })
// Indexed by name: this view is still ordered by the sort, not by provider.
const providerRow = Object.fromEntries(byProvider.rows.map((row) => [row.provider, row]))
check(
  'одна строка на провайдера, а не на модель',
  byProvider.rows.length === 3 && Object.keys(providerRow).sort().join() === 'a,b,c',
  byProvider.rows.map((row) => row.provider).join(' | '),
)
check('модели провайдера свернуты в его шаги', providerRow.a.steps === 11 && providerRow.b.steps === 4, `a=${providerRow.a.steps}, b=${providerRow.b.steps}`)
check('ошибки моделей свернуты в провайдера', providerRow.a.errors === 1 && providerRow.b.errors === 1 && providerRow.c.errors === 0, `a=${providerRow.a.errors}, b=${providerRow.b.errors}, c=${providerRow.c.errors}`)
check('в строке провайдера нет модели', byProvider.rows.every((row) => row.model === null))
check(
  'каталог совпадает со строками этого вида',
  providersOf(byProvider.catalog) === 'a,b,c',
  providersOf(byProvider.catalog),
)

console.log('\n--- архив: модели вне текущей конфигурации ---')

// The archive grades a row against what the harness serves, so the fixture is the
// catalog and not the history: `a/second` and `b/slow` are configured, `a/fast`
// — the busiest and the quickest row in the history — is not. It is deliberately
// the busiest: a retired model that outranks the live ones is exactly the case
// where "hide it" has to mean "hide it before the page is cut", not "hide what is
// left of it".
const catalog = (pairs, live = true) => ({ live, pairs })

const retired = catalog([{ provider: 'a', model: 'a-second' }, { provider: 'b', model: 'b-slow' }])
// The pairs the panel's stored rules resolve to over each scope of the archive:
// the coverage is printed from the resolved pairs, so the payload must be driven
// with them exactly the way the route drives it.
const idxRetired = configuredIndex(retired)
const catalogNoArchive = selectionCatalog(result().report, idxRetired, false)
const catalogWithArchive = selectionCatalog(result().report, idxRetired, true)
const hiddenSelection = pairsOf(catalogNoArchive)
const shownSelection = pairsOf(catalogWithArchive)
// `sort` is named here because the payload orders the rows by the key it is
// given — the route hands one `{ sort, dir }` to the fold and to the payload
// alike — and the assertion below is about which rows survive the grade, in the
// order this fixture was folded in.
const hidden = toPanelPayload(result(), { view: 'model', limit: 50, sort: 'ttft', configured: retired, selection: hiddenSelection })
check(
  'по умолчанию строки вне конфигурации не выводятся',
  hidden.rows.map((row) => row.model).join() === 'a-second,b-slow',
  hidden.rows.map((row) => row.model).join(' | '),
)
check(
  'архив посчитан фильтром, а не страницей',
  hidden.archive.rows === 2 && hidden.archive.steps === 10 && hidden.archive.shown === false,
  JSON.stringify(hidden.archive),
)
check('архив не попал в «что осталось после фильтра»', hidden.shown.models === 2 && hidden.shown.steps === 6, JSON.stringify(hidden.shown))
check('итоги всей истории не тронуты', hidden.totals.models === 4 && hidden.totals.steps === 16, JSON.stringify(hidden.totals))
check('строка помечена архивной', hidden.rows.every((row) => row.archived === false))
// The catalog is what the filter can reach, so the archive grades it too: `c` is
// served by nothing the configuration knows, so every row it has is in the
// archive — and a name that can only ever answer an empty table is not a filter,
// it is a trap. `a` keeps its place although its busiest row is retired:
// `a/a-second` is configured, and one live model is all a provider needs to be
// worth offering.
check(
  'провайдер, у которого весь архив, уходит из каталога без архива',
  providersOf(hidden.catalog) === 'a,b',
  providersOf(hidden.catalog),
)
check(
  'а покрытие знает, что провайдер c — это один архивный замер',
  JSON.stringify(hidden.coverage ?? null) === JSON.stringify([
    { provider: 'a', selected: 1, total: 1 },
    { provider: 'b', selected: 1, total: 1 },
  ]),
  JSON.stringify(hidden.coverage ?? null),
)

// The page is filled with rows the reader can use: the retired `a/fast` is the
// busiest row in the history, so a limit applied before the grade would take
// `b/slow` off a one-row page and then refuse to show what took its place.
const pageOf = (options) => toPanelPayload(result('steps'), { view: 'model', limit: 1, sort: 'steps', ...options })
check(
  'лимит набирается после архива, а не до него',
  pageOf({ configured: retired }).rows[0]?.model === 'b-slow' &&
    pageOf({ configured: retired, includeArchived: true }).rows[0]?.model === 'a-fast',
  `${pageOf({ configured: retired }).rows[0]?.model} / ${pageOf({ configured: retired, includeArchived: true }).rows[0]?.model}`,
)

const shown = toPanelPayload(result(), { view: 'model', limit: 50, configured: retired, includeArchived: true, selection: shownSelection })
check(
  'с флагом архив снова в таблице',
  shown.rows.length === 4 && shown.archive.rows === 2 && shown.archive.shown === true,
  `${shown.rows.length} строк, ${JSON.stringify(shown.archive)}`,
)
check(
  'архивная строка отличима от строки конфигурации',
  shown.rows
    .filter((row) => row.archived === true)
    .map((row) => row.model)
    .sort()
    .join() === 'a-fast,c-rare',
  shown.rows.map((row) => `${row.model}:${row.archived}`).join(' | '),
)
// The one checkbox the catalog is graded by: the archive on, and the provider whose
// every row is archived is offered again — beside the very rows it names, which
// is the test of "the catalog names every provider a row could come from".
check(
  'с архивом провайдер возвращается в каталог',
  providersOf(shown.catalog) === 'a,b,c' && shown.rows.some((row) => row.provider === 'c'),
  providersOf(shown.catalog),
)
// And the coverage says exactly how much of it the panel's stored rules select:
// nothing of `c` — its only model is archived, and the archive scope starts empty.
check(
  'покрытие архивного провайдера — ноль выбранных',
  JSON.stringify(shown.coverage ?? null) === JSON.stringify([
    { provider: 'a', selected: 1, total: 2 },
    { provider: 'b', selected: 1, total: 1 },
    { provider: 'c', selected: 0, total: 1 },
  ]),
  JSON.stringify(shown.coverage ?? null),
)

// The guard the whole feature stands on. A catalog built from the configuration
// files alone is a partial picture of what the harness serves — measured on this
// machine it misses `deepseek-official/deepseek-flash`, the harness's own default
// model, and 15932 of 26600 steps with it — so it grades nothing at all rather
// than hiding 60% of the history behind a filter nobody asked for.
const partial = toPanelPayload(result(), {
  view: 'model',
  limit: 50,
  configured: catalog([{ provider: 'a', model: 'a-second' }], false),
})
check(
  'каталог без живого ctx.llm ничего не архивирует',
  partial.archive === null && partial.rows.length === 4,
  `archive=${JSON.stringify(partial.archive)}, строк ${partial.rows.length}`,
)
check('и не выдаёт метку за измерение', partial.rows.every((row) => row.archived === null))
// Nothing was graded, so nothing was taken out of the filter either: the same
// `archive: null` that withholds the control has to withhold its effect.
check(
  'неизвестная конфигурация не убирает из каталога никого',
  providersOf(partial.catalog) === 'a,b,c',
  providersOf(partial.catalog),
)
check(
  'сборка индекса отличает частичный каталог от полного',
  configuredIndex(catalog([{ provider: 'a', model: 'a-second' }], false)) === null &&
    configuredIndex(catalog([{ provider: 'a', model: 'a-second' }])) !== null,
)
check('пустой каталог — тоже «неизвестно», а не «всё в архиве»', toPanelPayload(result(), { view: 'model', configured: catalog([]) }).archive === null)
check('без каталога вовсе — то же самое', toPanelPayload(result(), { view: 'model' }).rows.length === 4)

// In the provider view the row is a provider, so it is graded as one: `c` is
// served by nothing, while `a` is served — by a model other than the ones its
// history holds, which is still a provider a request can reach.
const byProviderArchive = toPanelPayload(result(), {
  view: 'provider',
  limit: 50,
  configured: catalog([{ provider: 'a', model: 'a-other' }, { provider: 'b', model: 'b-slow' }]),
})
check(
  'строка провайдера архивна, только если конфигурация не знает ни одной его модели',
  byProviderArchive.rows.map((row) => `${row.provider}:${row.archived}`).join() === 'a:false,b:false',
  byProviderArchive.rows.map((row) => `${row.provider}:${row.archived}`).join(' | '),
)
check('и такой провайдер уходит в архив', byProviderArchive.archive.rows === 1, JSON.stringify(byProviderArchive.archive))

console.log('\n--- что достаёт агент про архив ---')

const hiddenText = renderReportText(result(), { limit: 50, configured: retired })
const textLine = (value, prefix) => value.split('\n').find((line) => line.startsWith(prefix))
check(
  'агент видит, что часть строк скрыта',
  (textLine(hiddenText, 'archive:') ?? '').includes('2 row(s) / 10 step(s)') &&
    (textLine(hiddenText, 'archive:') ?? '').includes('archived: true'),
  textLine(hiddenText, 'archive:'),
)
check(
  'и самих строк в таблице нет',
  !hiddenText.split('\n').some((line) => line.startsWith('a/a-fast')),
  hiddenText.split('\n').filter((line) => /^a\//.test(line)).join(' | '),
)
// The summary answers about the rows the reader can see: a retired model holding
// the fastest median must not be named as the fastest model.
check(
  'сводка не называет скрытую строку',
  (textLine(hiddenText, 'fastest first token:') ?? '').includes('a/a-second'),
  textLine(hiddenText, 'fastest first token:'),
)
// With the archive on, `c/c-rare` — retired and the quickest row in the fixture
// by a factor of ninety — is a candidate again, which is the whole difference the
// flag makes to a decision.
const shownText = renderReportText(result(), { limit: 50, configured: retired, includeArchived: true })
check(
  'с флагом строка возвращается в таблицу',
  shownText.split('\n').some((line) => line.startsWith('a/a-fast')),
  textLine(shownText, 'a/a-fast'),
)
check(
  'и снова участвует в сводке',
  (textLine(shownText, 'fastest first token:') ?? '').includes('c/c-rare'),
  textLine(shownText, 'fastest first token:'),
)
check(
  'и это сказано словами',
  (textLine(shownText, 'archive:') ?? '').includes('are included above'),
  textLine(shownText, 'archive:'),
)
check(
  'неизвестная конфигурация названа, а не умолчана',
  (textLine(renderReportText(result(), { limit: 50 }), 'archive:') ?? '').includes('unknown'),
  textLine(renderReportText(result(), { limit: 50 }), 'archive:'),
)
check(
  'пустой архив не занимает строку',
  textLine(renderReportText(result(), { limit: 50, configured: catalog([{ provider: 'a', model: 'a-fast' }, { provider: 'a', model: 'a-second' }, { provider: 'b', model: 'b-slow' }, { provider: 'c', model: 'c-rare' }]) }), 'archive:') === undefined,
)

// The exports the panel tree is built from must agree with what the payload
// carries: same catalog, same resolution, or the checkbox tree and the counts
// printed beside it describe different sets.
console.log('\n--- сборка дерева и payload одно и то же ---')

check(
  'каталог payload и selectionCatalog сданы из одного места',
  JSON.stringify(full.catalog) === JSON.stringify(fullCatalog) &&
    JSON.stringify(hidden.catalog) === JSON.stringify(catalogNoArchive) &&
    JSON.stringify(shown.catalog) === JSON.stringify(catalogWithArchive),
)
// The payload counts its coverage by testing the resolved pairs, the panel tree
// counts it by walking the rules. Two different walks over the same catalog have
// to land on the same numbers, or a provider row and the checkbox above it
// disagree about the same set of models.
const countFromPairs = (catalog, pairs) =>
  catalog.map((group) => ({
    provider: group.provider,
    selected: group.models.filter((entry) => pairs.has(pairKey(group.provider, entry.model))).length,
    total: group.models.length,
  }))
const countFromRules = (catalog) => resolveSelection(RULES, catalog).providers
check(
  'покрытие payload и покрытие дерева — одно и то же',
  JSON.stringify(full.coverage) === JSON.stringify(countFromRules(fullCatalog)) &&
    JSON.stringify(full.coverage) === JSON.stringify(countFromPairs(fullCatalog, fullSelection)) &&
    JSON.stringify(hidden.coverage) === JSON.stringify(countFromRules(catalogNoArchive)) &&
    JSON.stringify(hidden.coverage) === JSON.stringify(countFromPairs(catalogNoArchive, hiddenSelection)) &&
    JSON.stringify(shown.coverage) === JSON.stringify(countFromRules(catalogWithArchive)) &&
    JSON.stringify(shown.coverage) === JSON.stringify(countFromPairs(catalogWithArchive, shownSelection)),
  `full=${JSON.stringify(full.coverage)} / rules=${JSON.stringify(countFromRules(fullCatalog))}`,
)

console.log('')
if (failures === 0) {
  console.log('ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ')
} else {
  console.log(`ПРОВАЛЕНО ПРОВЕРОК: ${failures}`)
  process.exitCode = 1
}
