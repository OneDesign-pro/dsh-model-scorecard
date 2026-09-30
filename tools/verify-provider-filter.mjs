// Проверяет фильтрацию по провайдеру на всех трёх поверхностях сразу: сборщик,
// панельный payload и текстовый отчёт тула.
//
// Провайдеров фильтрует одна функция (`providerFilter`), и именно на этом
// стоит всё остальное. Если маршрут панели, аргумент тула и сохранённая
// настройка браузера начнут понимать «провайдера» по-разному, таблица в панели
// и текст в ответе агенту разойдутся — а расхождение этих двух поверхностей
// здесь и есть главный запрет.
//
// Два свойства проверяются отдельно, потому что на них держится сам фильтр в
// панели:
//
//   * `providerList` — полный список провайдеров истории, а не те, что попали
//     в строки. Строки отсортированы, обрезаны лимитом и уже отфильтрованы;
//     если список брать из них, фильтр не сможет предложить именно того
//     провайдера, ради которого и открывается.
//   * `shown` — что осталось от истории после фильтра, а не то, что влезло в
//     страницу. Подвал панели печатает это рядом с итогами по всей истории,
//     и молчаливый обмен одного на другое там недопустим.
//
// Usage: node tools/verify-provider-filter.mjs

import { aggregate } from '../lib/fold.js'
import {
  configuredIndex,
  providerFilter,
  providerIndex,
  renderReportText,
  toPanelPayload,
} from '../lib/collect.js'

let failures = 0
function check(label, condition, detail) {
  const mark = condition ? 'OK  ' : 'FAIL'
  if (!condition) failures += 1
  console.log(`${mark} ${label}${detail ? ` — ${detail}` : ''}`)
}

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

const full = toPanelPayload(result(), { view: 'model', limit: 50 })
check('без фильтра в таблице все строки', full.rows.length === 4, String(full.rows.length))
check('список провайдеров полный', full.providerList.map((entry) => entry.provider).join() === 'a,b,c', full.providerList.map((e) => e.provider).join(' | '))
check(
  'список несёт модели и шаги каждого провайдера',
  full.providerList.every((entry) => entry.steps > 0 && entry.models > 0),
  JSON.stringify(full.providerList.map((e) => `${e.provider}:${e.models}m/${e.steps}`)),
)
check('список busiest-first, как и сортировка', full.providerList[0].provider === 'a' && full.providerList[2].provider === 'c')

// The case the filter exists for: the rows name two providers, the list has to
// name three, or the control can only ever offer what is already on screen.
const one = toPanelPayload(result(), { view: 'model', limit: 50, provider: 'a' })
check('строки отфильтрованы', one.rows.map((row) => row.provider).join() === 'a,a', one.rows.map((r) => r.provider).join(' | '))
check('список провайдеров при этом не пострадал', one.providerList.length === 3, one.providerList.map((e) => e.provider).join(' | '))
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
check('пустой результат фильтра — пустой результат, а не вся таблица', miss.rows.length === 0 && miss.empty === true)

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
  'список провайдеров совпадает со строками этого вида',
  providerIndex(result().report).map((entry) => entry.provider).join() === 'a,b,c',
  providerIndex(result().report).map((entry) => entry.provider).join(' | '),
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
// `sort` is named here because the payload orders the rows by the key it is
// given — the route hands one `{ sort, dir }` to the fold and to the payload
// alike — and the assertion below is about which rows survive the grade, in the
// order this fixture was folded in.
const hidden = toPanelPayload(result(), { view: 'model', limit: 50, sort: 'ttft', configured: retired })
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
check('список провайдеров по-прежнему полный', hidden.providerList.length === 3, hidden.providerList.map((e) => e.provider).join(' | '))

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

const shown = toPanelPayload(result(), { view: 'model', limit: 50, configured: retired, includeArchived: true })
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

console.log('')
if (failures === 0) {
  console.log('ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ')
} else {
  console.log(`ПРОВАЛЕНО ПРОВЕРОК: ${failures}`)
  process.exitCode = 1
}
