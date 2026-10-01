// Проверяет выбор моделей: правила, каталог дерева и агрегаты, посчитанные
// только из выбранных замеров.
//
// Зачем отдельный инструмент. До выбора панель задавала один вопрос — «вся
// история под фильтром провайдера», — и ответ на него собирался одним
// проходом. Выбор добавляет второй вопрос, у которого есть три свойства,
// ломающихся тихо:
//
//   * **Провайдерская строка — это замеры провайдера, а не среднее из строк
//     моделей.** Агрегат бакетирует то, что ему дали, поэтому выбор обязан быть
//     фильтром на сырых записях (sample/error/retry) до агрегации. Соблазн
//     отфильтровать готовые строки даёт другие медианы — и именно на фикстуре
//     из двух моделей одного провайдера это видно: одна выбранная модель
//     обязана дать провайдеру ровно свои цифры.
//   * **Идентичность — точная пара, а не имя модели.** Два провайдера могут
//     отдавать один и тот же model ID, и выбор одного из них обязан оставить
//     второго за бортом. Фикстура это фиксирует.
//   * **Пустой выбор — не «выбрано всё».** Панель, где сняты все отметки,
//     должна показать пустую таблицу; панель, которая отметок ещё не делала,
//     показывает политику по умолчанию. Если эти два состояния схлопнутся, у
//     читателя молча вернётся вся история.
//
// Эталон здесь считается независимо: медианы выбранных записей пересчитываются
// в этом файле своей арифметикой, и только потом сравниваются с тем, что отдал
// хост. Сравнение ответа с самим собой ничего бы не проверило.
//
// Проверяются обе схемы API: старый GET (совместимость) и новый POST
// /api/model-scorecard/query (правила, лимит тела, коды ошибок).
//
// Usage: node tools/verify-selection.mjs

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The snapshot the plugin writes goes to a scratch directory: a verifier must not
// touch the cache the running harness reads.
process.env.DSH_MODEL_SCORE_CARD_CACHE_DIR = mkdtempSync(join(tmpdir(), 'dsh-selection-'))

const { foldSession } = await import('../lib/fold.js')
const {
  MAX_PANEL_ROWS,
  canonicalSelectionRules,
  createCollector,
  defaultSelectionRules,
  normalizeSelectionRules,
  resolveSelection,
  toPanelPayload,
} = await import('../lib/collect.js')

let failures = 0
function check(label, condition, detail) {
  const mark = condition ? 'OK  ' : 'FAIL'
  if (!condition) failures += 1
  console.log(`${mark} ${label}${detail ? ` — ${detail}` : ''}`)
}

// --- the corpus -----------------------------------------------------------------
//
// One session log per fact, built as the events the fold actually reads, so every
// number below travels the real path: events → samples → selection → aggregate.

let clock = 1_700_000_000_000

/**
 * One finished step: a request that streamed an answer.
 *
 * `ttftMs` is the distance from `step/start` to the first token delta, which is
 * the figure the fold divides into `ttft`. The stream's last delta is what makes
 * the decode span measurable, so a step with no second delta has no speed.
 */
function step({ provider, model, ttftMs, llmMs = null, outputTokens = 100, retries = 0, retryDelayMs = 0, turn = 1, stepNumber = 1 }) {
  const start = clock
  const firstToken = start + ttftMs
  const end = start + (llmMs === null ? ttftMs + 500 : llmMs)
  clock = end + 1
  const events = [
    { type: 'step/start', time: start, data: { turn, step: stepNumber } },
    { type: 'assistant/attempt', time: start + 10, data: { turn, step: stepNumber } },
  ]
  for (let index = 0; index < retries; index += 1) {
    events.push({
      type: 'llm/retry',
      time: start + 20,
      data: { turn, step: stepNumber, provider, delayMs: retryDelayMs, failure: { code: 'RATE_LIMIT' } },
    })
    events.push({
      type: 'llm/retry-started',
      time: start + 20 + retryDelayMs,
      data: { turn, step: stepNumber },
    })
  }
  events.push({
    type: 'assistant/message',
    time: end,
    data: {
      turn,
      step: stepNumber,
      message: { source: { provider, model } },
      usage: {
        inputTokens: 1000,
        outputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      stream: [
        { type: 'chunk', time: firstToken, chunk: { type: 'text-delta', text: 'a' } },
        { type: 'chunk', time: firstToken + 400, chunk: { type: 'text-delta', text: 'b' } },
      ],
    },
  })
  return events
}

/** A step whose retries never produced a message: no sample, only a retry record. */
function failedStep({ provider, retries = 1, retryDelayMs = 500, turn = 1, stepNumber = 1 }) {
  const start = clock
  clock = start + 1000 + retryDelayMs
  const events = [{ type: 'step/start', time: start, data: { turn, step: stepNumber } }]
  for (let index = 0; index < retries; index += 1) {
    events.push({
      type: 'llm/retry',
      time: start + 10,
      data: { turn, step: stepNumber, provider, delayMs: retryDelayMs, failure: { code: 'SERVER' } },
    })
    events.push({ type: 'llm/retry-started', time: start + 10 + retryDelayMs, data: { turn, step: stepNumber } })
  }
  // The step has to be closed: a retry record is written by `step/end`, because
  // only there is it known that no message followed the last attempt.
  events.push({ type: 'step/end', time: clock, data: { turn, step: stepNumber } })
  return events
}

/**
 * A failed tool call, attributed by the fold to whoever spoke last.
 *
 * The fold reads `tool/result` and not a `tool/error` event: the rule is that a
 * failed tool is a stability signal for the model that raised it, and the
 * speaking model is the only attribution the event cannot supply itself.
 */
function toolError(turn = 1, stepNumber = 1) {
  clock += 5
  return {
    type: 'tool/result',
    time: clock,
    data: {
      turn,
      step: stepNumber,
      message: { source: { callId: 'call-1' } },
      error: { code: 'TOOL_ARGUMENTS', name: 'ToolError', message: 'bad arguments' },
    },
  }
}

// The three pairs the plan pins, plus the cases a selection has to answer for:
//
//   * `p-alpha` serves two models, so "one model selected" must give the provider
//     that model's own numbers and not an average of the two;
//   * `shared` is one model id under two providers, so identity cannot be the
//     model name;
//   * `fresh` is configured and never run, `gone/retired` is the opposite;
//   * `p-gamma` is a whole provider the history has never seen.
const SESSIONS = new Map([
  [
    's-alpha-one',
    [
      ...step({ provider: 'p-alpha', model: 'one', ttftMs: 100, stepNumber: 1 }),
      ...step({ provider: 'p-alpha', model: 'one', ttftMs: 102, stepNumber: 2 }),
      ...step({ provider: 'p-alpha', model: 'one', ttftMs: 104, stepNumber: 3 }),
      ...step({ provider: 'p-alpha', model: 'one', ttftMs: 106, stepNumber: 4 }),
      toolError(4, 4),
    ],
  ],
  [
    's-alpha-two',
    [
      ...step({ provider: 'p-alpha', model: 'two', ttftMs: 900, stepNumber: 1 }),
      ...step({ provider: 'p-alpha', model: 'two', ttftMs: 910, stepNumber: 2 }),
    ],
  ],
  ['s-alpha-shared', step({ provider: 'p-alpha', model: 'shared', ttftMs: 300 })],
  [
    's-beta-shared',
    [
      ...step({ provider: 'p-beta', model: 'shared', ttftMs: 500, stepNumber: 1 }),
      ...step({ provider: 'p-beta', model: 'shared', ttftMs: 510, retries: 1, retryDelayMs: 200, stepNumber: 2 }),
      ...step({ provider: 'p-beta', model: 'shared', ttftMs: 520, stepNumber: 3 }),
      toolError(3, 3),
    ],
  ],
  ['s-gone', [
    ...step({ provider: 'gone', model: 'retired', ttftMs: 700, stepNumber: 1 }),
    ...step({ provider: 'gone', model: 'retired', ttftMs: 710, stepNumber: 2 }),
  ]],
  // A retry on a provider that never spoke in this session: the record carries a
  // provider and no model, which is the one asymmetry the selection has to take a
  // side on — it is a measurement of the provider, so it follows the provider.
  ['s-alpha-failed', failedStep({ provider: 'p-alpha' })],
])

const eventsOf = (id) => SESSIONS.get(id) ?? []
const records = () => [...SESSIONS.keys()].map((id) => ({ header: { id }, revision: `r-${id}` }))

// The configuration: what the harness serves now. `fresh` and `p-gamma/g1` have
// no history at all; everything of `gone` is retired.
const CONFIGURED_PAIRS = [
  { provider: 'p-alpha', model: 'one' },
  { provider: 'p-alpha', model: 'two' },
  { provider: 'p-alpha', model: 'shared' },
  { provider: 'p-alpha', model: 'fresh' },
  { provider: 'p-beta', model: 'shared' },
  { provider: 'p-gamma', model: 'g1' },
  // The ids a delimiter would break on, each in the shape that actually occurs: a
  // route in the name (how most hosted models are named), a comma (which is what the
  // old query string used to separate names with), and a local file path (an `ollama`
  // model is a path, and this machine serves 22 of them). None of them has history,
  // because the point is the identity and not the numbers: it is read off a pair key
  // and off a JSON document, and both have to carry these characters through.
  { provider: 'p-alpha', model: 'z-ai/glm-5.3-flash' },
  { provider: 'p-beta', model: 'gemma-4-31b-it:free,v2' },
  { provider: 'p-gamma', model: '~/models/qwen3-coder-30b.gguf' },
]
const configured = () => ({ live: true, pairs: CONFIGURED_PAIRS })

// --- the fold, so every expectation below is read from the same records the host reads

function recordsOf() {
  const samples = []
  const errors = []
  const retries = []
  for (const [id, events] of SESSIONS) {
    const folded = foldSession(events, { sessionId: id })
    samples.push(...folded.samples)
    errors.push(...folded.errors.map((error) => ({ ...error, provider: error.provider ?? 'unknown', model: error.model ?? 'unknown' })))
    retries.push(...folded.retries)
  }
  return { samples, errors, retries }
}
const RECORDS = recordsOf()

// --- the reference: an independent recalculation --------------------------------
//
// Deliberately not `aggregate`: the point of a reference is to be arrived at by
// another road. One median and one count per selected pair, from the raw samples.

function medianOf(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** The rows a selection should produce, computed here from the raw records. */
function reference(pairs) {
  const wanted = new Set(pairs)
  const models = new Map()
  for (const sample of RECORDS.samples) {
    const key = `${sample.provider}\u0000${sample.model}`
    if (!wanted.has(key)) continue
    const bucket = models.get(key) ?? { provider: sample.provider, model: sample.model, steps: 0, ttft: [], errors: 0 }
    bucket.steps += 1
    if (sample.ttftMs !== null && sample.ttftMs !== undefined) bucket.ttft.push(sample.ttftMs)
    models.set(key, bucket)
  }
  for (const error of RECORDS.errors) {
    const key = `${error.provider}\u0000${error.model}`
    const bucket = models.get(key)
    if (bucket !== undefined) bucket.errors += 1
  }
  return [...models.values()]
    .map((bucket) => ({
      provider: bucket.provider,
      model: bucket.model,
      steps: bucket.steps,
      errors: bucket.errors,
      ttftMedian: medianOf(bucket.ttft),
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model))
}

/** The route's own payload, built the way the host builds it. */
async function panelPayload(options) {
  const ctx = {
    get(name) {
      if (name === 'sessionQuery') {
        return {
          async listSessions() {
            return records()
          },
          async observeSession(id) {
            return { events: eventsOf(id), revision: `r-${id}` }
          },
          async readSession(id) {
            return { events: eventsOf(id) }
          },
        }
      }
      if (name === 'sessionPersistence') {
        return {
          async list() {
            return records()
          },
          async stat(id) {
            return { header: { id }, revision: `r-${id}` }
          },
        }
      }
      return undefined
    },
    effect(fn) {
      return fn()
    },
    logger: { info() {}, warn() {} },
  }
  const collector = createCollector(ctx, { persist: false })
  // Normalized here exactly as the route normalizes it, so this harness asks the
  // same shape of question the panel's own route does — a raw document would let
  // the collector be more forgiving than the route and hide a gap between them.
  const normalized = normalizeSelectionRules(options.selectionRules ?? null)
  const result = await collector.collect({
    sort: options.sort ?? 'ttft',
    dir: options.dir,
    selectionRules: normalized.ok === true ? normalized.rules : null,
    configured: options.configured ?? configured(),
    includeArchived: options.includeArchived === true,
  })
  return toPanelPayload(result, {
    sort: options.sort ?? 'ttft',
    dir: options.dir,
    view: options.view ?? 'model',
    limit: options.limit ?? 200,
    configured: options.configured ?? configured(),
    includeArchived: options.includeArchived === true,
  })
}

const rowOf = (payload, provider, model) =>
  payload.rows.find((row) => row.provider === provider && row.model === model)
const keysOf = (payload) => payload.rows.map((row) => `${row.provider}/${row.model}`).sort()

// --- 1: правила ------------------------------------------------------------------

console.log('--- правила: приоритет и области ---')

// The catalog the rules are resolved against, taken from a real answer rather than
// written by hand here: a builder that disagrees with the host's own would make
// every check below agree with itself.
const full = await panelPayload({})
const hostCatalog = full.catalog
check('каталог дерева приходит с ответом', Array.isArray(hostCatalog) && hostCatalog.length > 0, JSON.stringify(hostCatalog?.length))
check(
  'каталог называет настроенные пары без истории',
  hostCatalog.some((group) => group.models.some((entry) => entry.model === 'fresh' && entry.noStats === true)),
  JSON.stringify(hostCatalog),
)
check(
  'каталог называет целого провайдера без истории',
  hostCatalog.map((group) => group.provider).join() === 'p-alpha,p-beta,p-gamma',
  hostCatalog.map((g) => g.provider).join(' | '),
)
check(
  'архив вне текущей области: `gone` в дереве нет',
  hostCatalog.every((group) => group.provider !== 'gone'),
  hostCatalog.map((g) => g.provider).join(' | '),
)

const defaultRules = defaultSelectionRules()
check('правило первого открытия — measured', defaultRules.live.base === 'measured' && defaultRules.archive.base === 'none')
const resolvedDefault = resolveSelection(defaultRules, hostCatalog)
check(
  'первое открытие выбирает замеренные пары без архива',
  [...resolvedDefault.pairs].map((key) => key.replace('\u0000', '/')).sort().join() ===
    'p-alpha/one,p-alpha/shared,p-alpha/two,p-beta/shared',
  [...resolvedDefault.pairs].map((key) => key.replace('\u0000', '/')).join(' | '),
)

const providerAll = defaultSelectionRules()
providerAll.live.providers['p-alpha'] = 'all'
const resolvedProvider = resolveSelection(providerAll, hostCatalog)
check(
  '«весь провайдер» подхватывает модель без истории',
  resolvedProvider.pairs.has('p-alpha\u0000fresh'),
  [...resolvedProvider.pairs].map((key) => key.replace('\u0000', '/')).join(' | '),
)

const exceptionOff = JSON.parse(JSON.stringify(providerAll))
exceptionOff.live.pairs['p-alpha\u0000one'] = 'off'
const resolvedException = resolveSelection(exceptionOff, hostCatalog)
check(
  'явное исключение пары сильнее правила провайдера',
  resolvedException.pairs.has('p-alpha\u0000fresh') && !resolvedException.pairs.has('p-alpha\u0000one'),
  [...resolvedException.pairs].map((key) => key.replace('\u0000', '/')).join(' | '),
)

const archiveAll = defaultSelectionRules()
archiveAll.live.base = 'none'
archiveAll.archive.base = 'all'
check(
  'выключенный архив не применяет свою область',
  resolveSelection(archiveAll, hostCatalog).pairs.size === 0,
  [...resolveSelection(archiveAll, hostCatalog).pairs].map((key) => key.replace('\u0000', '/')).join(' | '),
)
const archivedCatalog = (await panelPayload({ includeArchived: true })).catalog
check(
  'под включённым архивом каталог называет архивную пару',
  archivedCatalog.some((group) => group.provider === 'gone'),
  archivedCatalog.map((g) => g.provider).join(' | '),
)
check(
  'база архива `all` выбирает архивную пару',
  resolveSelection(archiveAll, archivedCatalog).pairs.has('gone\u0000retired'),
  [...resolveSelection(archiveAll, archivedCatalog).pairs].map((key) => key.replace('\u0000', '/')).join(' | '),
)

const noneRules = defaultSelectionRules()
noneRules.live.base = 'none'
noneRules.archive.base = 'none'
check('«снять все» даёт пустое множество пар', resolveSelection(noneRules, hostCatalog).pairs.size === 0)

const narrow = defaultSelectionRules()
narrow.live.base = 'none'
narrow.live.pairs['p-beta\u0000shared'] = 'on'
const resolvedNarrow = resolveSelection(narrow, hostCatalog)
check(
  'узкий ручной набор — ровно выбранные пары и ничего сверх',
  [...resolvedNarrow.pairs].join() === 'p-beta\u0000shared',
  [...resolvedNarrow.pairs].map((key) => key.replace('\u0000', '/')).join(' | '),
)

// A model the configuration gained after the rules were written: the rule is a
// rule, so it has to reach it without a second visit to the settings. This is the
// whole difference between a saved rule and a saved list of names.
const grown = hostCatalog.map((group) => ({ ...group, models: group.models.map((entry) => ({ ...entry })) }))
grown.find((group) => group.provider === 'p-beta').models.push({ model: 'later', archived: false, noStats: true, steps: 0 })
const betaAll = defaultSelectionRules()
betaAll.live.providers['p-beta'] = 'all'
check(
  'новая модель провайдера под правилом `all` включается сама',
  resolveSelection(betaAll, hostCatalog).pairs.has('p-beta\u0000later') === false &&
    resolveSelection(betaAll, grown).pairs.has('p-beta\u0000later'),
  [...resolveSelection(betaAll, grown).pairs].map((key) => key.replace('\u0000', '/')).join(' | '),
)
check(
  'а узкий ручной набор новую модель не пополняет',
  resolveSelection(narrow, grown).pairs.size === 1,
  [...resolveSelection(narrow, grown).pairs].map((key) => key.replace('\u0000', '/')).join(' | '),
)

// The third state a provider's checkbox asks for, and the one that cannot be faked
// with a list: everything of this provider the history has run. Both halves matter
// and they are checked apart — `fresh` stays out, and a model the provider gains
// with a step behind it joins the rule on the next answer.
const measuredRule = defaultSelectionRules()
measuredRule.live.base = 'none'
measuredRule.live.providers['p-alpha'] = 'measured'
const resolvedMeasured = resolveSelection(measuredRule, hostCatalog)
check(
  '«только измеренные» берёт замеренное и оставляет модель без истории',
  resolvedMeasured.pairs.has('p-alpha\u0000one') &&
    resolvedMeasured.pairs.has('p-alpha\u0000two') &&
    resolvedMeasured.pairs.has('p-alpha\u0000shared') &&
    resolvedMeasured.pairs.has('p-alpha\u0000fresh') === false,
  [...resolvedMeasured.pairs].map((key) => key.replace('\u0000', '/')).join(' | '),
)
const measuredGrown = hostCatalog.map((group) => ({ ...group, models: group.models.map((entry) => ({ ...entry })) }))
measuredGrown.find((group) => group.provider === 'p-alpha').models.push({ model: 'run-later', archived: false, noStats: false, steps: 3 })
check(
  'и новая замеренная модель провайдера подключается к нему сама',
  resolveSelection(measuredRule, hostCatalog).pairs.has('p-alpha\u0000run-later') === false &&
    resolveSelection(measuredRule, measuredGrown).pairs.has('p-alpha\u0000run-later'),
  [...resolveSelection(measuredRule, measuredGrown).pairs].map((key) => key.replace('\u0000', '/')).join(' | '),
)
check(
  'а совсем пустой провайдер под ним остаётся пустым, а не становится «всё»',
  resolveSelection(
    Object.assign(defaultSelectionRules(), { live: { base: 'none', providers: { 'p-gamma': 'measured' }, pairs: {} } }),
    hostCatalog,
  ).pairs.size === 0,
)

console.log('\n--- валидация правил ---')
check('null — это отсутствие политики', normalizeSelectionRules(null).rules === null)
check('пустой объект — та же политика по умолчанию', normalizeSelectionRules({}).ok === true)
check('не объект — отказ', normalizeSelectionRules('x').ok === false && normalizeSelectionRules([]).ok === false)
check(
  'неизвестная база отбрасывается в пользу области',
  normalizeSelectionRules({ live: { base: 'nonsense' } }).rules.live.base === 'measured',
)
check(
  'правило провайдера не из словаря отброшено, а не угадано',
  Object.keys(normalizeSelectionRules({ live: { providers: { a: 'maybe' } } }).rules.live.providers).length === 0,
)
check(
  '«измеренные» — правило из словаря, а не приглашение к отказу',
  normalizeSelectionRules({ live: { providers: { a: 'measured' } } }).rules.live.providers.a === 'measured',
  JSON.stringify(normalizeSelectionRules({ live: { providers: { a: 'measured' } } }).rules.live.providers),
)
check(
  'канонизация сортирует ключи',
  JSON.stringify(canonicalSelectionRules({
    live: { base: 'all', providers: { b: 'all', a: 'none' }, pairs: { z: 'off', a: 'on' } },
    archive: { base: 'none', providers: {}, pairs: {} },
  }).live.providers) === '{"a":"none","b":"all"}',
)

// --- 2: агрегаты из выбранных замеров -------------------------------------------

console.log('\n--- агрегаты: только выбранные замеры ---')

const onlyTwo = await panelPayload({
  selectionRules: Object.assign(defaultSelectionRules(), {
    live: { base: 'none', providers: {}, pairs: { 'p-alpha\u0000two': 'on' } },
  }),
})
const expectedTwo = reference(['p-alpha\u0000two'])
check(
  'одна модель одного провайдера: строка модели равна эталону',
  rowOf(onlyTwo, 'p-alpha', 'two')?.steps === expectedTwo[0].steps &&
    rowOf(onlyTwo, 'p-alpha', 'two')?.ttftMedian === expectedTwo[0].ttftMedian,
  `хост ${rowOf(onlyTwo, 'p-alpha', 'two')?.steps} шагов / ${rowOf(onlyTwo, 'p-alpha', 'two')?.ttftMedian} ms, эталон ${expectedTwo[0].steps} / ${expectedTwo[0].ttftMedian}`,
)

const providerViewOnlyTwo = await panelPayload({
  view: 'provider',
  selectionRules: Object.assign(defaultSelectionRules(), {
    live: { base: 'none', providers: {}, pairs: { 'p-alpha\u0000two': 'on' } },
  }),
})
const providerRow = providerViewOnlyTwo.rows.find((row) => row.provider === 'p-alpha')
check(
  'провайдерская строка — замеры выбранной модели, а не среднее двух',
  providerRow?.steps === 2 && providerRow?.ttftMedian === 905,
  `${providerRow?.steps} шагов / ${providerRow?.ttftMedian} ms (среднее двух моделей было бы 504)`,
)
check(
  'невыбранная модель провайдера не попала ни в строку, ни в итог',
  onlyTwo.shown.steps === 2,
  JSON.stringify(onlyTwo.shown),
)

const bothShared = await panelPayload({})
check(
  'одинаковый model ID у двух провайдеров — две разные строки',
  bothShared.rows.filter((row) => row.model === 'shared').length === 2,
  bothShared.rows.filter((row) => row.model === 'shared').map((row) => row.provider).join(' | '),
)
const onlyBeta = await panelPayload({
  selectionRules: Object.assign(defaultSelectionRules(), {
    live: { base: 'none', providers: {}, pairs: { 'p-beta\u0000shared': 'on' } },
  }),
})
check(
  'выбор одной пары `shared` не задевает вторую',
  keysOf(onlyBeta).join() === 'p-beta/shared',
  keysOf(onlyBeta).join(' | '),
)
check(
  'эталон подтверждает: это разные замеры, а не один',
  reference(['p-beta\u0000shared'])[0].ttftMedian === 510 &&
    reference(['p-alpha\u0000shared'])[0].ttftMedian === 300,
)

// Errors and failed retries follow the selection, and the provider-level retry
// record — one with no model of its own — stays with the provider that was
// selected rather than being dropped for having no pair.
const onlyOne = await panelPayload({
  selectionRules: Object.assign(defaultSelectionRules(), {
    live: { base: 'none', providers: {}, pairs: { 'p-alpha\u0000one': 'on' } },
  }),
})
check(
  'ошибка выбранной пары посчитана, а не потеряна',
  rowOf(onlyOne, 'p-alpha', 'one')?.errors === 1,
  String(rowOf(onlyOne, 'p-alpha', 'one')?.errors),
)
const providerOnlyOne = await panelPayload({
  view: 'provider',
  selectionRules: Object.assign(defaultSelectionRules(), {
    live: { base: 'none', providers: {}, pairs: { 'p-alpha\u0000one': 'on' } },
  }),
})
check(
  'retry без модели остаётся у провайдера, если выбрана любая его пара',
  providerOnlyOne.rows.find((row) => row.provider === 'p-alpha')?.retryFailedSteps === 1,
  JSON.stringify(providerOnlyOne.rows.find((row) => row.provider === 'p-alpha')?.retryFailedSteps),
)
const providerNoneOfAlpha = await panelPayload({
  view: 'provider',
  selectionRules: Object.assign(defaultSelectionRules(), {
    live: { base: 'none', providers: {}, pairs: { 'p-beta\u0000shared': 'on' } },
  }),
})
check(
  'и не остаётся, когда ни одна пара провайдера не выбрана',
  providerNoneOfAlpha.rows.every((row) => row.provider !== 'p-alpha'),
  providerNoneOfAlpha.rows.map((row) => row.provider).join(' | '),
)

console.log('\n--- итоги, shown и усечение ---')
check(
  'итоги остаются по всей истории',
  onlyTwo.totals.steps === 12 && onlyTwo.totals.models === 5,
  JSON.stringify(onlyTwo.totals),
)
check('shown считает выбранное, а не страницу', onlyTwo.shown.models === 1 && onlyTwo.shown.steps === 2, JSON.stringify(onlyTwo.shown))
const truncated = await panelPayload({
  limit: 1,
  selectionRules: Object.assign(defaultSelectionRules(), { live: { base: 'all' } }),
})
check(
  'лимит, отрезавший выбор, помечен явно',
  truncated.truncated === true && truncated.rows.length === 1,
  `truncated=${truncated.truncated} rows=${truncated.rows.length} shown=${truncated.shown.models}`,
)
check(
  'каталог дерева полон независимо от лимита и сортировки',
  (await panelPayload({ limit: 1, sort: 'name' })).catalog.length ===
    (await panelPayload({ limit: 200, sort: 'steps' })).catalog.length,
)

const partial = await panelPayload({
  view: 'provider',
  selectionRules: Object.assign(defaultSelectionRules(), {
    live: { base: 'none', providers: {}, pairs: { 'p-alpha\u0000one': 'on' } },
  }),
})
const alpha = partial.coverage.find((entry) => entry.provider === 'p-alpha')
check(
  'частичный провайдер помечен: N из M',
  alpha?.selected === 1 && alpha?.total === 5,
  JSON.stringify(alpha),
)
check(
  'провайдер без выбранных моделей отсутствует в покрытии строк',
  partial.rows.every((row) => row.provider === 'p-alpha'),
  partial.rows.map((row) => row.provider).join(' | '),
)

console.log('\n--- идентификаторы, которые ломают разделитель ---')
//
// A pair key is `provider\u0000model`, and the model half is not a word: it is a route
// (`z-ai/glm-5.3-flash`), sometimes with a comma in it (the separator the old query
// string used), sometimes a path (`~/models/…`, which is what an `ollama` model is).
// Every one of them has to survive the whole road — the tree entry, the rule document,
// the request body, the resolution and the row — because a delimiter that ate half an
// id would silently select a model nobody asked for.
for (const [provider, model] of [
  ['p-alpha', 'z-ai/glm-5.3-flash'],
  ['p-beta', 'gemma-4-31b-it:free,v2'],
  ['p-gamma', '~/models/qwen3-coder-30b.gguf'],
]) {
  const key = `${provider}\u0000${model}`
  const asked = await panelPayload({
    selectionRules: Object.assign(defaultSelectionRules(), {
      live: { base: 'none', providers: {}, pairs: { [key]: 'on' } },
    }),
  })
  check(
    `${provider}/${model}: выбран ровно он`,
    keysOf(asked).join() === `${provider}/${model}`,
    keysOf(asked).join(' | '),
  )
  check(
    `${provider}/${model}: строка пришла с пустыми метриками, а не выдуманными`,
    rowOf(asked, provider, model)?.steps === 0 && rowOf(asked, provider, model)?.ttftMedian === null,
    JSON.stringify(rowOf(asked, provider, model) === undefined ? null : `${rowOf(asked, provider, model).steps} шагов`),
  )
  check(
    `${provider}/${model}: ключ пары в ответе не порезан`,
    (await panelPayload({
      selectionRules: Object.assign(defaultSelectionRules(), {
        live: { base: 'none', providers: {}, pairs: { [key]: 'on' } },
      }),
      includeArchived: false,
    })).selection.live.pairs[key] === 'on',
    JSON.stringify(asked.selection?.live?.pairs ?? null),
  )
  check(
    `${provider}/${model}: дерево называет его целиком`,
    asked.catalog.some((group) => group.models.some((entry) => entry.model === model)),
    asked.catalog.map((group) => group.models.map((m) => m.model).join('|')).join(' '),
  )
}

console.log('\n--- каталог, который хост прочитать не смог ---')
const unknownCatalog = await panelPayload({ configured: { live: false, pairs: [] } })
check(
  'ни одна пара не объявлена живой, когда каталога нет',
  unknownCatalog.catalog.every((group) => group.models.every((entry) => entry.archived === null)),
  JSON.stringify(unknownCatalog.catalog.map((g) => g.models.map((m) => m.archived))),
)
check(
  'в дерево не попали пары, которых история не знает',
  unknownCatalog.catalog.map((group) => group.provider).join() === 'gone,p-alpha,p-beta',
  unknownCatalog.catalog.map((group) => group.provider).join(' | '),
)
// Nothing can be graded, so nothing is excluded: the table is the whole history —
// including the pair the configuration dropped — and a pair the configuration serves
// with no history is still not in it, because only the configuration could have said
// so. That is the same table the GET answers, which is the honest answer when the
// host cannot tell the two kinds of pair apart.
check(
  'таблица без каталога — вся история, и ни одной настроенной пары без истории',
  keysOf(unknownCatalog).join() === 'gone/retired,p-alpha/one,p-alpha/shared,p-alpha/two,p-beta/shared',
  keysOf(unknownCatalog).join(' | '),
)

console.log('\n--- пустой выбор ---')
const emptySelection = await panelPayload({ selectionRules: noneRules })
check(
  'пустой выбор — пустая таблица, а не вся история',
  emptySelection.rows.length === 0 && emptySelection.empty === true,
  `${emptySelection.rows.length} строк`,
)
check(
  'но каталог дерева при пустом выборе на месте',
  emptySelection.catalog.length === 3,
  String(emptySelection.catalog.length),
)
check(
  'ни одна настроенная пара не подставлена вместо выбора',
  emptySelection.noStats === null || emptySelection.noStats.rows === 0,
  JSON.stringify(emptySelection.noStats),
)

console.log('\n--- модель без статистики под выбором ---')
const withFresh = await panelPayload({ selectionRules: providerAll })
const freshRow = rowOf(withFresh, 'p-alpha', 'fresh')
check(
  'выбранная настроенная пара без истории — строка с нулём шагов',
  freshRow !== undefined && freshRow.steps === 0 && freshRow.noStats === true,
  JSON.stringify(freshRow === undefined ? null : `${freshRow.steps} steps, noStats=${freshRow.noStats}`),
)
check(
  'и ни одного выдуманного замера в ней',
  freshRow?.ttftMedian === null && freshRow?.tpsMedian === null && freshRow?.sessions === 0,
  JSON.stringify({ ttft: freshRow?.ttftMedian, tps: freshRow?.tpsMedian, sessions: freshRow?.sessions }),
)
const untouchedFresh = await panelPayload({ selectionRules: defaultSelectionRules() })
check(
  'а невыбранная — не появляется',
  rowOf(untouchedFresh, 'p-alpha', 'fresh') === undefined &&
    rowOf(untouchedFresh, 'p-gamma', 'g1') === undefined,
  keysOf(untouchedFresh).join(' | '),
)

// The third click's rule, end to end: the table is the measured part of the provider
// and nothing else, and the count beside the provider says the same thing the rows
// do — the two are read from one resolution, and a click on that count is what
// decides the next state of the group.
const measuredOnly = await panelPayload({ selectionRules: measuredRule })
check(
  'под правилом «измеренные» в таблице ровно замеренное от провайдера',
  keysOf(measuredOnly).join() === 'p-alpha/one,p-alpha/shared,p-alpha/two',
  keysOf(measuredOnly).join(' | '),
)
check(
  'и покрытие провайдера считает то же, что и строки',
  JSON.stringify(measuredOnly.coverage?.find((entry) => entry.provider === 'p-alpha')) ===
    JSON.stringify({ provider: 'p-alpha', selected: 3, total: 5 }),
  JSON.stringify(measuredOnly.coverage?.find((entry) => entry.provider === 'p-alpha')),
)

// --- 3: обе схемы API -----------------------------------------------------------

console.log('\n--- схемы API: GET и POST ---')

const routes = new Map()
const plugin = await import('../lib/index.js')
const { queryFromBody } = plugin
plugin.apply({
  get(name) {
    if (name === 'tools') return { register: () => () => {} }
    if (name === 'webServer') return { register: (route) => { routes.set(route.path, route); return () => {} } }
    if (name === 'sessionQuery') {
      return {
        async listSessions() {
          return records()
        },
        async observeSession(id) {
          return { events: eventsOf(id), revision: `r-${id}` }
        },
        async readSession(id) {
          return { events: eventsOf(id) }
        },
      }
    }
    if (name === 'sessionPersistence') {
      return {
        async list() {
          return records()
        },
        async stat(id) {
          return { header: { id }, revision: `r-${id}` }
        },
      }
    }
    if (name === 'llm') {
      return {
        listProviders: () => [{ id: 'p-alpha' }, { id: 'p-beta' }, { id: 'p-gamma' }],
        listModels: async (provider) =>
          CONFIGURED_PAIRS.filter((pair) => pair.provider === provider).map((pair) => ({
            provider,
            id: pair.model,
            name: pair.model,
          })),
      }
    }
    return undefined
  },
  effect(fn) {
    return fn()
  },
  logger: { info() {}, warn() {} },
})

check('зарегистрированы оба маршрута', routes.has('/api/model-scorecard') && routes.has('/api/model-scorecard/query'), [...routes.keys()].join(' | '))

// The deprecated namespace is mounted from the same handler objects, not from
// copies: a copied handler is a second implementation of the same route, and the
// one thing it must not do is answer a different question than the live path. So
// the assertion is identity, not presence — and then the answer itself, because
// identity plus a body that happens to match would still pass a route that
// ignores the request.
const legacyRoute = '/api/model-stats/query'
check('старый префикс /api/model-stats/query смонтирован', routes.has(legacyRoute), [...routes.keys()].join(' | '))
const legacyHandler = routes.get(legacyRoute)?.handler
const liveHandler = routes.get('/api/model-scorecard/query')?.handler
check(
  'старый и новый путь — один и тот же обработчик',
  legacyHandler !== undefined && legacyHandler === liveHandler,
  legacyHandler === liveHandler ? 'один объект обработчика на оба пути' : 'обработчики разошлись',
)

async function call(path, { method = 'GET', body = null, rawBody = undefined } = {}) {
  const route = routes.get(path.split("?")[0])
  let text = ''
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(key, value) {
      this.headers[key] = value
    },
    end(chunk) {
      text = chunk
    },
  }
  const payload = rawBody !== undefined ? rawBody : body === null ? undefined : JSON.stringify(body)
  const req = {
    url: path,
    method,
    body: undefined,
    async *[Symbol.asyncIterator]() {
      if (payload !== undefined) yield payload
    },
  }
  await route.handler(req, res)
  return { status: res.statusCode, json: text === '' ? null : JSON.parse(text) }
}

const get = await call('/api/model-scorecard?sort=ttft&limit=200')
check(
  'GET отвечает без политики выбора',
  get.status === 200 && get.json.selection === null && get.json.coverage === null,
  `status ${get.status}, selection ${JSON.stringify(get.json.selection)}`,
)
check(
  'GET отдаёт всю историю, как и раньше: 4 измеренные пары и 5 настроенных без истории',
  get.json.rows.length === 9 && get.json.totals.models === 5 && get.json.rows.every((row) => row.archived !== true),
  `${get.json.rows.length} строк, итог по моделям ${get.json.totals.models}`,
)
check(
  'каталог дерева приходит и на GET: панель рисует дерево с первой отрисовки',
  Array.isArray(get.json.catalog) && get.json.catalog.length === 3,
  String(get.json.catalog?.length),
)

const noPost = await call('/api/model-scorecard/query')
check('GET на маршрут запроса — 405', noPost.status === 405, String(noPost.status))

const badSelection = await call('/api/model-scorecard/query', { method: 'POST', body: { selection: 'everything' } })
check('неверный выбор — 400, а не полный список', badSelection.status === 400, JSON.stringify(badSelection.json))
check(
  'и в теле отказа нет ни одной строки таблицы',
  badSelection.json.rows === undefined,
  JSON.stringify(Object.keys(badSelection.json)),
)

const badSort = await call('/api/model-scorecard/query', { method: 'POST', body: { sort: 'nonsense' } })
check('неизвестная сортировка — 400', badSort.status === 400, JSON.stringify(badSort.json))
const badLimit = await call('/api/model-scorecard/query', { method: 'POST', body: { limit: 0 } })
check('лимит вне диапазона — 400', badLimit.status === 400, JSON.stringify(badLimit.json))
const badArchived = await call('/api/model-scorecard/query', { method: 'POST', body: { archived: 'yes' } })
check('не-булево `archived` — 400', badArchived.status === 400, JSON.stringify(badArchived.json))
const notJson = await call('/api/model-scorecard/query', { method: 'POST', rawBody: '{not json' })
check('тело не JSON — 400', notJson.status === 400, JSON.stringify(notJson.json))
const tooBig = await call('/api/model-scorecard/query', {
  method: 'POST',
  rawBody: `{"selection":{"live":{"pairs":{"${'x'.repeat(1_100_000)}":"on"}}}}`,
})
check('тело сверх лимита — 413', tooBig.status === 413, `${tooBig.status} ${JSON.stringify(tooBig.json)}`)

const asked = await call('/api/model-scorecard/query', {
  method: 'POST',
  body: {
    sort: 'ttft',
    dir: 'asc',
    view: 'model',
    limit: 200,
    archived: false,
    selection: { live: { base: 'none', pairs: { 'p-alpha\u0000two': 'on' } } },
  },
})
check('корректный запрос отвечает 200', asked.status === 200, `status ${asked.status}`)
check(
  'в таблице только выбранная пара',
  asked.json.rows.length === 1 && asked.json.rows[0].provider === 'p-alpha' && asked.json.rows[0].model === 'two',
  asked.json.rows.map((row) => `${row.provider}/${row.model}`).join(' | '),
)
check(
  'ответ несёт применённые правила и каталог',
  asked.json.selection?.live?.pairs?.['p-alpha\u0000two'] === 'on' &&
    Array.isArray(asked.json.catalog) &&
    asked.json.catalog.length === 3,
  JSON.stringify({ selection: asked.json.selection?.live?.pairs, catalog: asked.json.catalog?.length }),
)
check(
  'итоги и покрытие в ответе на запрос тоже есть',
  asked.json.totals.steps === 12 && Array.isArray(asked.json.coverage),
  JSON.stringify({ totals: asked.json.totals.steps, coverage: asked.json.coverage?.length }),
)

// The characters that would break a query string, sent where they belong — in a JSON
// body. A comma in a model id is the case this route exists for: the old question
// spelled several names with commas, so an id containing one could not be asked for
// over the address at all.
const awkward = await call('/api/model-scorecard/query', {
  method: 'POST',
  body: {
    sort: 'ttft',
    dir: 'asc',
    limit: 200,
    selection: { live: { base: 'none', pairs: { 'p-beta\u0000gemma-4-31b-it:free,v2': 'on' } } },
  },
})
check(
  'идентификатор с запятой и слэшем доезжает через тело запроса',
  awkward.status === 200 &&
    awkward.json.rows.length === 1 &&
    awkward.json.rows[0].provider === 'p-beta' &&
    awkward.json.rows[0].model === 'gemma-4-31b-it:free,v2',
  `${awkward.status} ${awkward.json.rows.map((row) => `${row.provider}/${row.model}`).join(' | ')}`,
)

const absent = await call('/api/model-scorecard/query', { method: 'POST', body: { sort: 'ttft', limit: 200 } })
check(
  'отсутствие выбора — та же семантика, что у GET',
  absent.status === 200 &&
    absent.json.rows.map((row) => `${row.provider}/${row.model}`).sort().join() ===
      get.json.rows.map((row) => `${row.provider}/${row.model}`).sort().join(),
  `${absent.json.rows.length} строк против ${get.json.rows.length}`,
)

const sameQuery = await call('/api/model-scorecard/query', {
  method: 'POST',
  body: { sort: 'ttft', limit: 200, selection: noneRules },
})
check(
  'пустой выбор через HTTP — пустая таблица',
  sameQuery.status === 200 && sameQuery.json.rows.length === 0 && sameQuery.json.empty === true,
  JSON.stringify({ rows: sameQuery.json.rows.length, empty: sameQuery.json.empty }),
)

const archiveQuery = await call('/api/model-scorecard/query', {
  method: 'POST',
  body: { sort: 'ttft', limit: 200, archived: true, selection: archiveAll },
})
check(
  'архив включается только своим правилом и своей отметкой',
  archiveQuery.status === 200 &&
    archiveQuery.json.rows.some((row) => row.provider === 'gone') &&
    archiveQuery.json.rows.some((row) => row.archived === true),
  archiveQuery.json.rows.map((row) => `${row.provider}/${row.model}:${row.archived}`).join(' | '),
)

const withoutFlag = await call('/api/model-scorecard/query', {
  method: 'POST',
  body: { sort: 'ttft', limit: 200, archived: false, selection: archiveAll },
})
check(
  'архивное правило без включённого архива не показывает архивных строк',
  withoutFlag.json.rows.every((row) => row.provider !== 'gone'),
  withoutFlag.json.rows.map((row) => row.provider).join(' | '),
)

// The number beside the archive switch is a fact about the configuration and the
// history, and not about the table. The first-open selection is `live: measured,
// archive: none`, so a count taken off the selected rows reads zero here — and
// keeps reading zero with the archive switched on, which is the one state where the
// reader cannot learn the size of the archive any other way. `gone/retired` is the
// whole archive of this fixture: one row, two steps.
check(
  'счётчик архива не сходится к нулю из-за выбора',
  withoutFlag.json.archive?.rows === 1 && withoutFlag.json.archive?.steps === 2 && withoutFlag.json.archive?.shown === false,
  JSON.stringify(withoutFlag.json.archive),
)
check(
  'и он тот же, что у GET без выбора',
  withoutFlag.json.archive?.rows === get.json.archive?.rows && withoutFlag.json.archive?.steps === get.json.archive?.steps,
  `${JSON.stringify(withoutFlag.json.archive)} против GET ${JSON.stringify(get.json.archive)}`,
)
check(
  'включение архива меняет `shown`, а не размер архива',
  archiveQuery.json.archive?.rows === 1 && archiveQuery.json.archive?.shown === true,
  JSON.stringify(archiveQuery.json.archive),
)

// --- 4: the two resolutions of one rule -----------------------------------------
//
// The panel resolves the stored rules itself, over the catalog of the last answer,
// because a checkbox has to be drawn before the next answer arrives — and the host
// resolves the same rules over the catalog only it can see in full. Two
// implementations of one precedence is a drift this repository cannot afford, so
// they are pinned against each other here: the same rule document, the same catalog,
// and the two pair sets compared.
console.log('\n--- резолв правил: панель и хост об одном и том же ---')

const panelSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const registrations = []
await import('node:vm').then(({ createContext, runInContext }) => {
  const sandbox = { window: { __ModuleLoader__: { load: (mod) => registrations.push(mod) } }, console }
  createContext(sandbox)
  runInContext(panelSource, sandbox, { filename: 'client.js' })
})
// The factory is asked for React and hooks as it destructures them; the pure helpers
// below use none of them, so the stub only has to exist.
const reactStub = {
  createElement: () => null,
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
}
const panelTest = registrations[0].factory((name) => (name === 'react' ? reactStub : undefined)).__test__

const asPairs = (set) => [...set].map((key) => key.replace('\u0000', '/')).sort()

const CROSS_CASES = [
  ['правило по умолчанию', defaultSelectionRules()],
  ['весь провайдер', Object.assign(defaultSelectionRules(), { live: { base: 'measured', providers: { 'p-alpha': 'all' }, pairs: {} } })],
  ['провайдеры сняты', Object.assign(defaultSelectionRules(), { live: { base: 'measured', providers: { 'p-alpha': 'none', 'p-beta': 'all' }, pairs: {} } })],
  ['провайдер по измеренным', Object.assign(defaultSelectionRules(), { live: { base: 'none', providers: { 'p-alpha': 'measured', 'p-gamma': 'measured' }, pairs: {} } })],
  ['исключение сильнее правила', Object.assign(defaultSelectionRules(), { live: { base: 'all', providers: {}, pairs: { 'p-alpha\u0000two': 'off', 'gone\u0000retired': 'on' } } })],
  ['всё, включая архив', Object.assign(defaultSelectionRules(), { live: { base: 'all' }, archive: { base: 'all', providers: {}, pairs: {} } })],
  ['ничего', Object.assign(defaultSelectionRules(), { live: { base: 'none' }, archive: { base: 'none', providers: {}, pairs: {} } })],
]

for (const [label, rulesDocument] of CROSS_CASES) {
  for (const [scopeLabel, catalogUnderTest] of [
    ['без архива', hostCatalog],
    ['с архивом', archivedCatalog],
  ]) {
    const host = resolveSelection(canonicalSelectionRules(rulesDocument), catalogUnderTest)
    const panel = panelTest.resolveSelection(panelTest.canonicalSelectionRules(rulesDocument), catalogUnderTest)
    check(
      `${label}, ${scopeLabel}: панель и хост выбрали одни и те же пары`,
      asPairs(host.pairs).join() === asPairs(panel.pairs).join(),
      `хост ${asPairs(host.pairs).join(' | ') || '(пусто)'} / панель ${asPairs(panel.pairs).join(' | ') || '(пусто)'}`,
    )
    check(
      `${label}, ${scopeLabel}: и одинаково посчитали покрытие провайдеров`,
      JSON.stringify(host.providers) === JSON.stringify(panel.providers),
      JSON.stringify(panel.providers) === JSON.stringify(host.providers) ? '' : `${JSON.stringify(host.providers)} / ${JSON.stringify(panel.providers)}`,
    )
  }
}

// The document the panel writes is the document the host reads: canonicalized the
// same way on both sides, so a stored rule cannot become a different question by
// travelling through a cache key.
check(
  'канонизация правил совпадает у панели и у хоста',
  JSON.stringify(panelTest.canonicalSelectionRules({ archive: { pairs: { b: 'off', a: 'on' } }, live: { base: 'all', providers: { z: 'none', a: 'all' }, pairs: { 'p\u0000m': 'on' } } })) ===
    JSON.stringify(canonicalSelectionRules({ archive: { pairs: { b: 'off', a: 'on' } }, live: { base: 'all', providers: { z: 'none', a: 'all' }, pairs: { 'p\u0000m': 'on' } } })),
  'сравнение канонических форм',
)
// The other half of the same contract: the panel's own question, fed to the host's
// own validator. A renamed field, a limit past the host's ceiling or a `view`
// spelling would come back as a 400 — which the reader would read as the panel being
// broken — so the two are checked against each other rather than against a
// hand-written copy of the schema.
const panelBody = panelTest.panelQueryBody({
  sort: 'ttft',
  dir: 'asc',
  view: 'model',
  archived: false,
  selection: defaultSelectionRules(),
  wholeSelection: false,
})
const pageMaxBody = panelTest.panelQueryBody({
  sort: 'steps',
  dir: 'desc',
  view: 'provider',
  archived: true,
  selection: Object.assign(defaultSelectionRules(), { live: { base: 'all' } }),
  wholeSelection: true,
})
for (const [label, body] of [['обычный запрос панели', panelBody], ['запрос всей выдачи', pageMaxBody]]) {
  const query = queryFromBody(body)
  check(
    `${label} принимается хостом без правок`,
    query.error === undefined && query.selectionRules !== null,
    JSON.stringify(query),
  )
  const answered = await call('/api/model-scorecard/query', { method: 'POST', body })
  check(`${label} отвечает 200, а не 400`, answered.status === 200, `${answered.status} ${JSON.stringify(answered.json?.error)}`)
}
check(
  'потолок страницы у панели и у хоста — одно число',
  pageMaxBody.limit === MAX_PANEL_ROWS && queryFromBody({ limit: MAX_PANEL_ROWS + 1 }).error !== undefined,
  `${pageMaxBody.limit} / ${MAX_PANEL_ROWS}`,
)
check(
  'панель терпима к испорченному документу так же, как хост',
  asPairs(panelTest.resolveSelection(panelTest.normalizeSelectionRules({ live: { base: 'nonsense', pairs: 'x' } }).pairs ? panelTest.normalizeSelectionRules({ live: { base: 'nonsense' } }) : {}, hostCatalog).pairs).join() ===
    asPairs(resolveSelection(normalizeSelectionRules({ live: { base: 'nonsense' } }).rules, hostCatalog).pairs).join(),
  'одна и та же политика по умолчанию',
)

console.log('')
if (failures === 0) {
  console.log('ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ')
} else {
  console.log(`ПРОВАЛЕНО ПРОВЕРОК: ${failures}`)
  process.exitCode = 1
}
