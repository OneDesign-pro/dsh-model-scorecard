// Проверяет слой метаданных маршрута (`lib/metadata.js`): что панель получает
// объявленные адаптером контекст, лимит вывода, модальности и reasoning, и что
// этот слой не может ни задержать ответ, ни сломать таблицу, ни утечь наружу.
//
// Метаданные — украшение уже собранного ответа: строки выбраны, отфильтрованы и
// обрезаны лимитом, и только после этого кто-то спрашивает адаптер. Поэтому у
// каждой проверки ниже две стороны: что значение пришло, и что при отказе строка
// остаётся пригодной, а число не подменяется нулём.
//
// Половина проверок — про отказы, потому что отказ здесь нормален: маршрут может
// быть объявлен в конфигурации и не иметь живого адаптера (тогда `ctx.llm`
// бросает `NO_ADAPTER`), модель могла быть удалена из адаптера (`UNKNOWN_MODEL`), а
// адаптер может вообще не уважать `AbortSignal` — это измерено на установленном
// рантайме: сигнал, отменённый до вызова, всё равно разрешился. Поэтому таймаут
// держится локальной гонкой, а не надеждой на отмену.
//
// Последняя секция — живая проверка контракта `resolveModelInfo` на настоящем
// `LlmRuntime` с настоящим адаптером профиля: без сети и без probe-запросов, но
// с реальным ответом адаптера. Если установки или патча профиля нет, секция
// печатает SKIP и не считается ни пройденной, ни проваленной.
//
// Usage: node tools/verify-metadata.mjs [--no-live]

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMetadata, METADATA_POLICY } from '../lib/metadata.js'
import { apply } from '../lib/index.js'

let failures = 0
let checks = 0
function check(label, condition, detail) {
  const mark = condition ? 'OK  ' : 'FAIL'
  checks += 1
  if (!condition) failures += 1
  console.log(`${mark} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}
function skip(label, reason) {
  console.log(`SKIP ${label}${reason === undefined ? '' : ` — ${reason}`}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Поздний ответ отброшенного запроса — ровно тот случай, ради которого слой
// существует. В Node он по умолчанию роняет процесс, поэтому здесь он
// превращается в проверку, а не в падение теста без объяснения.
const unhandled = []
process.on('unhandledRejection', (reason) => unhandled.push(reason))

// --- стенд -------------------------------------------------------------------

/**
 * Поддельный `ctx.llm` с настоящим учётом: сколько вызовов, сколько
 * одновременно, какие сигналы пришли и какие методы вообще трогали.
 *
 * `catalog` (необязательный) — то, что видят `listProviders`/`listModels`: их
 * читает конфигурация и liveness, и тест проверяет отдельно, что метаданные их
 * не трогают.
 */
function stubLlm(handler, catalog = null) {
  const calls = { resolveModelInfo: 0, listProviders: 0, listModels: 0, prepareCall: 0, stream: 0 }
  const signals = []
  let active = 0
  let maxActive = 0
  return {
    calls,
    signals,
    get maxActive() {
      return maxActive
    },
    async resolveModelInfo(provider, model, signal) {
      calls.resolveModelInfo += 1
      signals.push(signal)
      active += 1
      maxActive = Math.max(maxActive, active)
      try {
        return await handler(provider, model, signal)
      } finally {
        active -= 1
      }
    },
    // Ни один из этих методов не должен быть вызван: метаданные — это чтение
    // конфигурации, а не probe и не подготовка вызова.
    listProviders() {
      calls.listProviders += 1
      return catalog === null ? [] : [...new Set(catalog.map((pair) => pair.provider))].map((id) => ({ id }))
    },
    listModels(provider) {
      calls.listModels += 1
      return catalog === null
        ? []
        : catalog
            .filter((pair) => pair.provider === provider)
            .map((pair) => ({ provider: pair.provider, id: pair.model, name: pair.model }))
    },
    prepareCall() {
      calls.prepareCall += 1
      throw new Error('prepareCall вызван слоем метаданных')
    },
    stream() {
      calls.stream += 1
      throw new Error('stream вызван слоем метаданных')
    },
  }
}

const bench = (llm) => ({
  get: (name) => (name === 'llm' ? llm : undefined),
  effect: (fn) => fn(),
  logger: { info() {}, warn() {} },
})

const row = (provider, model, extra = {}) => ({ provider, model, steps: 7, rating: null, ...extra })
const panel = (...rows) => ({ ok: true, rows })
const rmOf = (payload, provider, model) =>
  payload.rows.find((entry) => entry.provider === provider && entry.model === model)?.routeMetadata

const routeInfo = (provider, model, extra = {}) => ({
  provider,
  id: model,
  name: `${provider}/${model}`,
  inputModalities: ['text'],
  context: { contextWindow: 1_000_000 },
  ...extra,
})

const ROUTE_METADATA_KEYS = [
  'source',
  'checkedAt',
  'contextWindow',
  'defaultMaxTokens',
  'inputModalities',
  'reasoningEfforts',
  'defaultReasoningEffort',
]

// --- один id модели у двух провайдеров ---------------------------------------

console.log('--- одинаковый id у двух провайдеров и ровно объявленные поля ---')

const twoProviders = stubLlm(async (provider, model) =>
  routeInfo(provider, model, {
    context: { contextWindow: provider === 'a' ? 1_048_576 : 262_144 },
    defaultMaxTokens: 65_536,
    reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' },
  }),
)
const twoMeta = createMetadata(bench(twoProviders))
let payload = await twoMeta.enrich(panel(row('a', 'same-model'), row('b', 'same-model')))

check(
  'окно контекста — от своего провайдера, а не от соседа',
  rmOf(payload, 'a', 'same-model').contextWindow === 1_048_576 &&
    rmOf(payload, 'b', 'same-model').contextWindow === 262_144,
  `${rmOf(payload, 'a', 'same-model').contextWindow} / ${rmOf(payload, 'b', 'same-model').contextWindow}`,
)
check(
  'две пары — два независимых вызова',
  twoProviders.calls.resolveModelInfo === 2,
  String(twoProviders.calls.resolveModelInfo),
)

const shape = rmOf(payload, 'a', 'same-model')
check(
  'ровно объявленные поля, и ничего больше',
  JSON.stringify(Object.keys(shape)) === JSON.stringify(ROUTE_METADATA_KEYS),
  Object.keys(shape).join(','),
)
check(
  'поля-источника и времени на месте',
  shape.source === 'dsh-adapter' &&
    Number.isInteger(shape.checkedAt) &&
    shape.checkedAt > 0 &&
    JSON.stringify(shape.reasoningEfforts) === JSON.stringify([{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }]) &&
    shape.defaultReasoningEffort === 'high',
  `${shape.source} ${shape.checkedAt}`,
)
check(
  '`defaultMaxTokens` назван лимитом по умолчанию и не выдаёт себя за максимум',
  shape.defaultMaxTokens === 65_536 &&
    !('maxTokens' in shape) &&
    !('maxOutputTokens' in shape) &&
    !('maxContextTokens' in shape) &&
    !('capacity' in shape),
  String(shape.defaultMaxTokens),
)
check(
  '`name` и `description` адаптера в панель не уезжают',
  !('name' in shape) && !('description' in shape),
)

const again = await twoMeta.enrich(panel(row('a', 'same-model'), row('b', 'same-model')))
check(
  'повторное обновление отвечает из кэша, а не новым вызовом',
  twoProviders.calls.resolveModelInfo === 2 &&
    rmOf(again, 'a', 'same-model').contextWindow === 1_048_576 &&
    rmOf(again, 'b', 'same-model').contextWindow === 262_144,
  String(twoProviders.calls.resolveModelInfo),
)
check(
  'строка кэша клонируется, а не отдаётся по ссылке',
  rmOf(again, 'a', 'same-model') !== rmOf(payload, 'a', 'same-model'),
)

check(
  'liveness-методы и путь запроса не тронуты',
  twoProviders.calls.listProviders === 0 &&
    twoProviders.calls.listModels === 0 &&
    twoProviders.calls.prepareCall === 0 &&
    twoProviders.calls.stream === 0,
  JSON.stringify(twoProviders.calls),
)

// --- что именно утекает наружу -----------------------------------------------

console.log('\n--- ничего, кроме перечисленных полей ---')

const leaky = stubLlm(async (provider, model) => ({
  ...routeInfo(provider, model),
  description: 'SECRET-ОПИСАНИЕ',
  apiKey: 'SECRET-КЛЮЧ',
  baseUrl: 'https://user:password@example.invalid/v1',
  headers: { authorization: 'Bearer SECRET-ЗАГОЛОВОК' },
  replay: { state: 'SECRET-СОСТОЯНИЕ' },
  raw: { nested: 'SECRET-СЫРОЕ' },
}))
const leakyPayload = await createMetadata(bench(leaky)).enrich(panel(row('p', 'm')))
const leaked = JSON.stringify(leakyPayload)
check(
  'секреты и адреса адаптера не попадают в панель',
  !leaked.includes('SECRET') && !leaked.includes('password') && !leaked.includes('example.invalid'),
  leaked.length > 400 ? `${leaked.length} символов` : leaked,
)
check(
  'и сам объект метаданных содержит только белый список',
  JSON.stringify(Object.keys(rmOf(leakyPayload, 'p', 'm'))) === JSON.stringify(ROUTE_METADATA_KEYS),
)

// --- чужая идентичность, битые значения, пустое объявление --------------------

console.log('\n--- чужая идентичность и битые значения остаются unknown ---')

for (const [label, answer] of [
  ['чужой провайдер', routeInfo('other', 'm')],
  ['чужой id', routeInfo('p', 'other')],
  ['ответ-строка', 'nope'],
  ['ответ-null', null],
  ['ответ-число', 42],
]) {
  const stub = stubLlm(async () => answer)
  const result = await createMetadata(bench(stub)).enrich(panel(row('p', 'm')))
  check(`ответ с чужим содержимым — unknown: ${label}`, rmOf(result, 'p', 'm') === null && result.rows[0].steps === 7)
}

const messy = stubLlm(async (provider, model) => ({
  provider,
  id: model,
  name: 'm',
  context: { contextWindow: 0 },
  defaultMaxTokens: -5,
  inputModalities: ['text', 7],
  reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: '', name: '' }, 'junk'], defaultEffort: 'missing' },
}))
const messyShape = rmOf(await createMetadata(bench(messy)).enrich(panel(row('p', 'm'))), 'p', 'm')
check(
  'ноль и минус в контексте — не измерение, а unknown',
  messyShape.contextWindow === null && messyShape.defaultMaxTokens === null,
  `${messyShape.contextWindow} / ${messyShape.defaultMaxTokens}`,
)
check(
  'смешанные модальности — unknown целиком, а не половина',
  messyShape.inputModalities === null,
  JSON.stringify(messyShape.inputModalities),
)
check(
  'битые и пустые reasoning-варианты отброшены, чужой default — unknown',
  JSON.stringify(messyShape.reasoningEfforts) === JSON.stringify([{ id: 'low', name: 'Low' }]) &&
    messyShape.defaultReasoningEffort === null,
  `${JSON.stringify(messyShape.reasoningEfforts)} / ${messyShape.defaultReasoningEffort}`,
)

const floatContext = stubLlm(async (provider, model) => ({
  provider,
  id: model,
  name: 'm',
  context: { contextWindow: 1.5 },
  defaultMaxTokens: 2 ** 60,
}))
const floatShape = rmOf(await createMetadata(bench(floatContext)).enrich(panel(row('p', 'm'))), 'p', 'm')
check(
  'дробное окно и небезопасно большое число — unknown',
  floatShape.contextWindow === null && floatShape.defaultMaxTokens === null,
  `${floatShape.contextWindow} / ${floatShape.defaultMaxTokens}`,
)

const bare = stubLlm(async (provider, model) => ({ provider, id: model, name: 'm' }))
const bareShape = rmOf(await createMetadata(bench(bare)).enrich(panel(row('p', 'm'))), 'p', 'm')
check(
  'маршрут, который ничего не объявляет, — объект с unknown, а не null',
  bareShape !== null &&
    bareShape.source === 'dsh-adapter' &&
    bareShape.contextWindow === null &&
    bareShape.defaultMaxTokens === null &&
    bareShape.inputModalities === null &&
    bareShape.reasoningEfforts === null &&
    bareShape.defaultReasoningEffort === null,
)

// --- отказ и таймаут не ломают таблицу ---------------------------------------

console.log('\n--- отказ, таймаут и поздние ответы ---')

const thrower = stubLlm(async () => {
  throw Object.assign(new Error('no adapter registered'), { code: 'NO_ADAPTER' })
})
const thrown = await createMetadata(bench(thrower)).enrich(panel(row('p', 'm'), row('p', 'm2')))
check(
  'исключение адаптера — unknown на строке, а не ошибка панели',
  thrown.ok === true &&
    thrown.rows.length === 2 &&
    rmOf(thrown, 'p', 'm') === null &&
    thrown.rows[0].steps === 7,
)

const slow = stubLlm(async (provider, model) => {
  await sleep(300)
  return routeInfo(provider, model)
})
const slowMeta = createMetadata(bench(slow), { policy: { lookupTimeoutMs: 20, enrichBudgetMs: 40 } })
const started = Date.now()
const timedOut = await slowMeta.enrich(panel(row('p', 'm')))
const elapsed = Date.now() - started
check(
  'бюджет важнее медленного адаптера: ответ приходит внутри бюджета',
  elapsed < 250 && rmOf(timedOut, 'p', 'm') === null,
  `${elapsed} мс`,
)
check(
  'сигнал отмены передан адаптеру и отменён таймаутом',
  slow.signals[0] instanceof AbortSignal && slow.signals[0].aborted === true,
)
await sleep(400)
const lateWin = await slowMeta.enrich(panel(row('p', 'm')))
check(
  'поздний ответ доезжает в кэш для следующего обновления',
  rmOf(lateWin, 'p', 'm')?.contextWindow === 1_000_000 && slow.calls.resolveModelInfo === 1,
  String(slow.calls.resolveModelInfo),
)

const lateFail = stubLlm(async () => {
  await sleep(200)
  throw new Error('late failure')
})
const lateFailMeta = createMetadata(bench(lateFail), { policy: { lookupTimeoutMs: 10, enrichBudgetMs: 20 } })
await lateFailMeta.enrich(panel(row('p', 'm')))
await sleep(320)
check(
  'поздний отказ не остаётся необработанным',
  unhandled.length === 0,
  unhandled.map((error) => String(error?.message ?? error)).join(' | '),
)
const afterFail = await lateFailMeta.enrich(panel(row('p', 'm')))
check(
  'поздний отказ кэшируется как отказ, без нового вызова',
  rmOf(afterFail, 'p', 'm') === null && lateFail.calls.resolveModelInfo === 1,
  String(lateFail.calls.resolveModelInfo),
)

// --- TTL, слияние вызовов, предел параллельности ------------------------------

console.log('\n--- TTL, слияние вызовов и границы работы ---')

let clock = 1_700_000_000_000
const fakeNow = () => clock
const positive = stubLlm(async (provider, model) => routeInfo(provider, model))
const ttlMeta = createMetadata(bench(positive), { now: fakeNow })
await ttlMeta.enrich(panel(row('p', 'm')))
clock += METADATA_POLICY.positiveTtlMs - 1
await ttlMeta.enrich(panel(row('p', 'm')))
check('положительный ответ живёт час', positive.calls.resolveModelInfo === 1, String(positive.calls.resolveModelInfo))
clock += 2
await ttlMeta.enrich(panel(row('p', 'm')))
check('через час спрашиваем заново', positive.calls.resolveModelInfo === 2, String(positive.calls.resolveModelInfo))

clock = 1_700_000_000_000
const negative = stubLlm(async () => {
  throw new Error('UNKNOWN_MODEL')
})
const negativeMeta = createMetadata(bench(negative), { now: fakeNow })
await negativeMeta.enrich(panel(row('p', 'm')))
clock += METADATA_POLICY.negativeTtlMs - 1
await negativeMeta.enrich(panel(row('p', 'm')))
check('отказ кэшируется на пять минут', negative.calls.resolveModelInfo === 1, String(negative.calls.resolveModelInfo))
clock += 2
await negativeMeta.enrich(panel(row('p', 'm')))
check('через пять минут спрашиваем снова', negative.calls.resolveModelInfo === 2, String(negative.calls.resolveModelInfo))

let releaseGate
const gate = new Promise((resolve) => {
  releaseGate = resolve
})
const gated = stubLlm(async (provider, model) => {
  await gate
  return routeInfo(provider, model, { context: { contextWindow: 987_654 } })
})
const gatedMeta = createMetadata(bench(gated), { policy: { enrichBudgetMs: 500, lookupTimeoutMs: 3_000 } })
const firstAnswer = gatedMeta.enrich(panel(row('p', 'm'), row('p', 'm')))
const secondAnswer = gatedMeta.enrich(panel(row('p', 'm')))
releaseGate()
const [firstPayload, secondPayload] = await Promise.all([firstAnswer, secondAnswer])
check(
  'одна пара — один вызов, даже из двух одновременных ответов',
  gated.calls.resolveModelInfo === 1,
  String(gated.calls.resolveModelInfo),
)
check(
  'оба ответа получили значение, а повтор строки — тот же объект',
  rmOf(firstPayload, 'p', 'm')?.contextWindow === 987_654 &&
    rmOf(secondPayload, 'p', 'm')?.contextWindow === 987_654,
)

let openPool
const poolGate = new Promise((resolve) => {
  openPool = resolve
})
const pool = stubLlm(async (provider, model) => {
  await poolGate
  return routeInfo(provider, model)
})
const poolMeta = createMetadata(bench(pool), { policy: { enrichBudgetMs: 30, lookupTimeoutMs: 5_000 } })
const manyRows = panel(...Array.from({ length: 8 }, (_, index) => row('p', `m${index}`)))
const poolStarted = Date.now()
const pooled = await poolMeta.enrich(manyRows)
const poolElapsed = Date.now() - poolStarted
check(
  'бюджет ограничивает ожидание, а не работу',
  poolElapsed < 250 && pooled.rows.every((entry) => entry.routeMetadata === null),
  `${poolElapsed} мс`,
)
check(
  'одновременных вызовов не больше четырёх',
  pool.maxActive === 4,
  String(pool.maxActive),
)
openPool()
await sleep(30)
const pooledLater = await poolMeta.enrich(manyRows)
check(
  'фоновая работа доезжает до следующего обновления',
  pool.calls.resolveModelInfo === 8 &&
    pooledLater.rows.every((entry) => entry.routeMetadata?.contextWindow === 1_000_000),
  String(pool.calls.resolveModelInfo),
)
poolMeta.dispose()

const manyStub = stubLlm(async (provider, model) => routeInfo(provider, model))
const capMeta = createMetadata(bench(manyStub), { policy: { maxNewPerEnrich: 8, enrichBudgetMs: 500 } })
const wide = panel(...Array.from({ length: 70 }, (_, index) => row('p', `w${index}`)))
await capMeta.enrich(wide)
check(
  'один ответ спрашивает не больше maxNewPerEnrich новых пар',
  manyStub.calls.resolveModelInfo === 8,
  String(manyStub.calls.resolveModelInfo),
)
await capMeta.enrich(wide)
check('следующее обновление сдвигает окно вперёд', manyStub.calls.resolveModelInfo === 16, String(manyStub.calls.resolveModelInfo))
const capped = await capMeta.enrich(wide)
check(
  'первые пары приходят из кэша, а не спрашиваются снова',
  manyStub.calls.resolveModelInfo === 24 && capped.rows.slice(0, 16).every((entry) => entry.routeMetadata !== null),
  String(manyStub.calls.resolveModelInfo),
)

// --- провайдерская строка и хост без сервиса ---------------------------------

console.log('\n--- провайдерская строка и хост без метаданных ---')

const never = stubLlm(async () => {
  throw new Error('не должен вызываться')
})
const providerPayload = await createMetadata(bench(never)).enrich(
  panel(row('p', null, { steps: 3 }), { provider: 'p', steps: 4 }),
)
check(
  'провайдерская строка не берёт контекст у своих моделей',
  providerPayload.rows.every((entry) => entry.routeMetadata === null),
)
check('для провайдерской строки никто не спрашивается', never.calls.resolveModelInfo === 0, String(never.calls.resolveModelInfo))

const noService = await createMetadata({ get: () => undefined }).enrich(panel(row('p', 'm')))
const noMethod = await createMetadata(bench({ listProviders: () => [] })).enrich(panel(row('p', 'm'), row('p', null)))
check(
  'хост без ctx.llm и llm без resolveModelInfo — unknown на каждой строке, без падения',
  noService.rows[0].routeMetadata === null &&
    noService.rows[0].steps === 7 &&
    noMethod.rows.every((entry) => entry.routeMetadata === null),
)

const passthrough = { error: 'boom' }
const passthroughMeta = createMetadata(bench(stubLlm(async () => routeInfo('p', 'm'))))
check(
  'полезная нагрузка без строк возвращается как есть',
  (await passthroughMeta.enrich(passthrough)) === passthrough &&
    (await passthroughMeta.enrich(null)) === null &&
    JSON.stringify(await passthroughMeta.enrich({ rows: 'nope' })) === JSON.stringify({ rows: 'nope' }),
)

// --- уборка владельцем -------------------------------------------------------

console.log('\n--- dispose гасит очередь и не пускает поздние ответы в кэш ---')

const disposedStub = stubLlm(async (provider, model) => {
  await sleep(80)
  return routeInfo(provider, model)
})
const disposedMeta = createMetadata(bench(disposedStub), { policy: { enrichBudgetMs: 5, lookupTimeoutMs: 5_000 } })
await disposedMeta.enrich(panel(row('p', 'm')))
const disposeStarted = disposedStub.calls.resolveModelInfo
disposedMeta.dispose()
await sleep(150)
const afterDispose = await disposedMeta.enrich(panel(row('p', 'm')))
check(
  'dispose отменяет сигнал незавершённого вызова',
  disposedStub.signals[0].aborted === true,
)
check(
  'после dispose ничего не спрашивается и поздний ответ не кэшируется',
  disposeStarted === 1 && afterDispose.rows[0].routeMetadata === null && disposedStub.calls.resolveModelInfo === 1,
  String(disposedStub.calls.resolveModelInfo),
)

let openQueue
const queueGate = new Promise((resolve) => {
  openQueue = resolve
})
const queuedStub = stubLlm(async (provider, model) => {
  await queueGate
  return routeInfo(provider, model)
})
const queuedMeta = createMetadata(bench(queuedStub), { policy: { enrichBudgetMs: 5, lookupTimeoutMs: 5_000, concurrency: 4 } })
await queuedMeta.enrich(panel(...Array.from({ length: 8 }, (_, index) => row('p', `q${index}`))))
check('до dispose стартовали ровно четыре вызова', queuedStub.calls.resolveModelInfo === 4, String(queuedStub.calls.resolveModelInfo))
queuedMeta.dispose()
openQueue()
await sleep(50)
check(
  'очередь после dispose не запускается',
  queuedStub.calls.resolveModelInfo === 4,
  String(queuedStub.calls.resolveModelInfo),
)

check('ни одного необработанного отказа за весь прогон', unhandled.length === 0, unhandled.length ? String(unhandled.length) : undefined)

// --- те же правила на настоящих маршрутах панели ------------------------------

console.log('\n--- маршруты панели: GET и POST обогащаются одним и тем же помощником ---')

const cacheDir = await mkdtemp(join(tmpdir(), 'model-stats-metadata-'))
process.env.DSH_MODEL_STATS_CACHE_DIR = cacheDir

const CATALOG = [
  { provider: 'p-live', model: 'm-live' },
  { provider: 'p-live', model: 'm-throws' },
]

function pluginContext(llm) {
  const registered = []
  const routes = new Map()
  const ctx = {
    get(name) {
      if (name === 'tools') return { register: (def) => (registered.push(def), () => {}) }
      if (name === 'webServer') return { register: (route) => (routes.set(route.path, route), () => {}) }
      if (name === 'sessionQuery') {
        return {
          async listSessions() {
            return []
          },
          async observeSession(id) {
            return { session: { id }, events: [], revision: null }
          },
          async readSession(id) {
            return { session: { id }, events: [] }
          },
        }
      }
      if (name === 'sessionPersistence') {
        return {
          async list() {
            return []
          },
          async stat(id) {
            return { header: { id }, revision: null }
          },
        }
      }
      if (name === 'llm') return llm
      return undefined
    },
    effect: (fn) => fn(),
    logger: { info() {}, warn() {} },
  }
  return { ctx, registered, routes }
}

function callRoute(routes, path, { method = 'GET', query = '', body = null } = {}) {
  const route = routes.get(path)
  return new Promise((resolve, reject) => {
    let text = ''
    const res = {
      statusCode: 0,
      setHeader() {},
      end(chunk) {
        text = chunk
        let json = null
        try {
          json = JSON.parse(chunk)
        } catch {
          json = null
        }
        resolve({ status: this.statusCode, json, text })
      },
    }
    Promise.resolve(route.handler({ method, url: `${path}${query}`, body }, res)).catch(reject)
  })
}

const routeLlm = stubLlm(
  async (provider, model) => {
    if (model === 'm-throws') throw Object.assign(new Error('no adapter'), { code: 'NO_ADAPTER' })
    return routeInfo(provider, model, { context: { contextWindow: 987_654 }, defaultMaxTokens: 12_345 })
  },
  CATALOG,
)
const wired = pluginContext(routeLlm)
apply(wired.ctx)
await sleep(50)

const getAnswer = await callRoute(wired.routes, '/api/model-stats')
check(
  'GET отвечает 200 и обогащает строки конфигурации',
  getAnswer.status === 200 &&
    getAnswer.json.ok === true &&
    getAnswer.json.rows.length === 2 &&
    rmOf(getAnswer.json, 'p-live', 'm-live')?.source === 'dsh-adapter',
  `${getAnswer.status}, строк ${getAnswer.json?.rows?.length}`,
)
check(
  'отказ адаптера на одном маршруте не роняет таблицу',
  rmOf(getAnswer.json, 'p-live', 'm-throws') === null &&
    rmOf(getAnswer.json, 'p-live', 'm-live')?.contextWindow === 987_654,
  `${rmOf(getAnswer.json, 'p-live', 'm-throws')} / ${rmOf(getAnswer.json, 'p-live', 'm-live')?.contextWindow}`,
)

const getAgain = await callRoute(wired.routes, '/api/model-stats')
check(
  'второй GET отвечает из кэша метаданных',
  routeLlm.calls.resolveModelInfo === 2 && rmOf(getAgain.json, 'p-live', 'm-live')?.contextWindow === 987_654,
  String(routeLlm.calls.resolveModelInfo),
)

const postAnswer = await callRoute(wired.routes, '/api/model-stats/query', {
  method: 'POST',
  body: { sort: 'rating', limit: 10 },
})
check(
  'POST-запрос панели обогащается тем же помощником',
  postAnswer.status === 200 &&
    postAnswer.json.rows.length === 2 &&
    rmOf(postAnswer.json, 'p-live', 'm-live')?.defaultMaxTokens === 12_345,
  `${postAnswer.status}`,
)

const tool = wired.registered.find((def) => def.name === 'model_stats')
const toolText = await tool.execute({})
check(
  'текстовый отчёт инструмента не вырос от метаданных',
  !toolText.includes('987654') && !toolText.includes('987 654') && !toolText.includes('12345'),
)

// A host whose `llm` service predates `resolveModelInfo`: the catalog is there, so
// the configured rows are there, and every one of them answers unknown rather
// than failing the route or inventing a zero.
const catalogOnly = {
  listProviders: () => [...new Set(CATALOG.map((pair) => pair.provider))].map((id) => ({ id })),
  listModels: (provider) =>
    CATALOG.filter((pair) => pair.provider === provider).map((pair) => ({
      provider: pair.provider,
      id: pair.model,
      name: pair.model,
    })),
}
const withoutMetadata = pluginContext(catalogOnly)
apply(withoutMetadata.ctx)
await sleep(50)
const oldHostAnswer = await callRoute(withoutMetadata.routes, '/api/model-stats')
check(
  'хост без resolveModelInfo отдаёт строки с unknown, а не 500',
  oldHostAnswer.status === 200 &&
    oldHostAnswer.json.rows.length === 2 &&
    oldHostAnswer.json.rows.every((entry) => entry.routeMetadata === null),
  `${oldHostAnswer.status}, строк ${oldHostAnswer.json?.rows?.length}`,
)

await rm(cacheDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {})

// --- живой контракт resolveModelInfo -----------------------------------------

console.log('\n--- живой контракт resolveModelInfo на установленном рантайме ---')

const LIVE = !process.argv.includes('--no-live')
const DSH = '/Users/jeka/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const PROFILE = process.env.LIVENESS_PROFILE || 'web'

if (!LIVE) {
  skip('живая проверка контракта', '--no-live')
} else {
  try {
    const { Context } = await import(`${DSH}/cordis/lib/index.js`)
    const { default: LlmRuntime } = await import(`${DSH}/dsh-llm/lib/index.js`)
    const { default: LocalCredentialProvider } = await import(`${DSH}/dsh-credentials-local/lib/index.js`)
    const piAiModule = await import(`${DSH}/dsh-llm-pi-ai/lib/index.js`)
    const yamlModule = await import(`${DSH_HOME}/profiles/${PROFILE}/node_modules/js-yaml/index.js`)
    const yaml = yamlModule?.default ?? yamlModule
    const patch = yaml.load(await readFile(join(DSH_HOME, 'profiles', PROFILE, 'cordis.patch.yml'), 'utf8'))
    const entry = (Array.isArray(patch) ? patch : []).find((item) => item?.id === 'llm-pi-ai')
    const providers = entry?.config?.providers ?? {}

    const liveCtx = new Context()
    liveCtx.plugin(LlmRuntime)
    liveCtx.plugin(LocalCredentialProvider, {
      path: join(DSH_HOME, '.credentials.yaml'),
      dshHome: DSH_HOME,
      watch: false,
    })
    liveCtx.plugin(
      { name: piAiModule.name, inject: piAiModule.inject, Config: piAiModule.Config, apply: piAiModule.apply },
      { providers },
    )
    await sleep(400)

    const liveLlm = liveCtx.get('llm')
    const liveIds = new Set((liveLlm?.listProviders() ?? []).map((item) => item.id ?? item))
    const pairs = []
    for (const [provider, profile] of Object.entries(providers)) {
      if (!liveIds.has(provider)) continue
      for (const model of profile?.models ?? []) {
        if (typeof model?.id === 'string') pairs.push({ provider, model: model.id })
      }
    }

    check(
      'установленный рантайм объявляет resolveModelInfo',
      typeof liveLlm?.resolveModelInfo === 'function',
      typeof liveLlm?.resolveModelInfo,
    )
    check('в профиле есть маршруты для проверки', pairs.length > 0, `${pairs.length} пар, ${liveIds.size} провайдеров`)

    const liveCalls = { count: 0 }
    const liveMeta = createMetadata(
      {
        get: (name) =>
          name === 'llm'
            ? {
                resolveModelInfo(provider, model, signal) {
                  liveCalls.count += 1
                  return liveLlm.resolveModelInfo(provider, model, signal)
                },
              }
            : undefined,
      },
      { policy: { maxNewPerEnrich: 500, enrichBudgetMs: 5_000 } },
    )
    const liveRows = panel(...pairs.map((pair) => row(pair.provider, pair.model)))
    const liveStarted = Date.now()
    const livePayload = await liveMeta.enrich(liveRows)
    const liveFirstMs = Date.now() - liveStarted
    const known = livePayload.rows.filter((entry) => entry.routeMetadata !== null)
    const withContext = known.filter((entry) => entry.routeMetadata.contextWindow !== null)
    const withCap = known.filter((entry) => entry.routeMetadata.defaultMaxTokens !== null)
    const withReasoning = known.filter((entry) => entry.routeMetadata.reasoningEfforts !== null)
    check(
      'каждый объявленный маршрут получает свои метаданные, идентичность сходится',
      known.length === pairs.length && known.every((entry) => entry.routeMetadata.source === 'dsh-adapter'),
      `${known.length}/${pairs.length}`,
    )
    check(
      'объявленные значения — целые положительные числа',
      withContext.every((entry) => Number.isInteger(entry.routeMetadata.contextWindow) && entry.routeMetadata.contextWindow > 0) &&
        withCap.every((entry) => Number.isInteger(entry.routeMetadata.defaultMaxTokens) && entry.routeMetadata.defaultMaxTokens > 0),
      `контекст ${withContext.length}, лимит ${withCap.length}, reasoning ${withReasoning.length}`,
    )
    const cachedStarted = Date.now()
    await liveMeta.enrich(liveRows)
    const liveCachedMs = Date.now() - cachedStarted
    check(
      'повторный проход по живому рантайму не спрашивает адаптер снова',
      liveCalls.count === pairs.length,
      `${liveCalls.count} вызовов на ${pairs.length} пар, ${liveFirstMs} мс первый проход, ${liveCachedMs} мс повторный`,
    )

    const unknownRoute = await liveMeta.enrich(
      panel(row('no-such-provider-xyz', 'x'), row(pairs[0].provider, 'no-such-model-xyz')),
    )
    check(
      'несуществующий провайдер и несуществующая модель остаются unknown',
      unknownRoute.rows.every((entry) => entry.routeMetadata === null),
    )

    // Измерение, а не утверждение: адаптер может уважать отмену, а может и нет.
    // Пока он её игнорирует, таймаут обязан держаться локальной гонкой — это и
    // проверяет секция с фикстурой выше.
    const aborted = new AbortController()
    aborted.abort()
    let abortNote
    try {
      const info = await liveLlm.resolveModelInfo(pairs[0].provider, pairs[0].model, aborted.signal)
      abortNote = `отменённый сигнал всё равно разрешился (${info.context?.contextWindow ?? 'без контекста'})`
    } catch (error) {
      abortNote = `отменённый сигнал отвергнут: ${error?.code ?? error?.message}`
    }
    console.log(`     измерено: ${abortNote}`)
    console.log(
      `     измерено: вариант с контекстом ${withContext.length}/${pairs.length}, с лимитом по умолчанию ${withCap.length}/${pairs.length}, с reasoning ${withReasoning.length}/${pairs.length}`,
    )
  } catch (error) {
    skip('живая проверка контракта', `установка или патч профиля недоступны: ${String(error?.message ?? error)}`)
  }
}

console.log('')
console.log(`проверок: ${checks}, провалено: ${failures}`)
if (failures === 0) {
  console.log('ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ')
} else {
  console.log(`ПРОВАЛЕНО ПРОВЕРОК: ${failures}`)
  process.exitCode = 1
}
