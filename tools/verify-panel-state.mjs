// Drives the bundle page the panel registers in the Plugins section the way the
// browser drives it.
//
// The regression this guards: choosing another sort took the table off the
// screen. The panel replaced its rows with a spinner the moment the query
// changed, and if that request was slow, failed or was aborted by the next
// click, the rows did not come back on their own — the failure path meant to
// keep the table had nothing left to keep, because the rows had already been
// dropped before the request went out.
//
// `client.js` has no build step and no importer: it registers itself through
// `window.__ModuleLoader__`, renders with React, caches payloads in
// `localStorage` and asks the host over `fetch`. All four are replaced here with
// the smallest fakes that can run it for real, so what is asserted is the
// registered page — its hooks, its effects, its request — and not a copy of
// its logic. The one contract under test:
//
//   rows already on screen are never replaced by a message.
//
// Usage: node tools/verify-panel-state.mjs

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

// The host's own list of orders, imported rather than restated: a heading that
// asks for an order the route does not know would be answered with the default
// order and shown under an arrow claiming otherwise, and only a shared list
// catches that.
import { PANEL_SORTS } from '../lib/collect.js'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

let failures = 0
function check(label, condition, detail) {
  const mark = condition ? 'OK  ' : 'FAIL'
  if (!condition) failures += 1
  console.log(`${mark} ${label}${detail ? ` — ${detail}` : ''}`)
}

// --- a React small enough to read -------------------------------------------
//
// Hooks are a per-fiber cursor, exactly as in React: call order is identity.
// `render` repeats the pass while a setter or an effect has marked the fiber
// dirty, which is what lets one click flow through effects and state the way it
// does in the browser.
function createReact() {
  let current = null

  const sameDeps = (before, after) => {
    if (before === undefined || after === undefined) return false
    return before.length === after.length && before.every((value, index) => Object.is(value, after[index]))
  }
  const useHook = () => {
    const hook = current.hooks[current.index] ?? (current.hooks[current.index] = {})
    current.index += 1
    return hook
  }
  const remember = (hook, deps, compute) => {
    if (!sameDeps(hook.deps, deps)) {
      hook.deps = deps === undefined ? undefined : [...deps]
      hook.memo = compute()
    }
    return hook.memo
  }

  const React = {
    createElement(type, props, ...children) {
      const flat = children
        .flat(Infinity)
        .filter((child) => child !== null && child !== undefined && child !== false)
      return { type, props: { ...(props ?? {}), children: flat } }
    },
    useState(initial) {
      const owner = current
      const hook = useHook()
      if (!('value' in hook)) hook.value = typeof initial === 'function' ? initial() : initial
      return [
        hook.value,
        (next) => {
          hook.value = typeof next === 'function' ? next(hook.value) : next
          // A setter runs long after the render that created it — from a
          // promise, from an effect — so it marks the fiber it belongs to.
          owner.dirty = true
        },
      ]
    },
    useEffect(effect, deps) {
      const hook = useHook()
      if (!sameDeps(hook.deps, deps)) {
        hook.deps = deps === undefined ? undefined : [...deps]
        hook.effect = effect
        current.pending.push(hook)
      }
    },
    useCallback(fn, deps) {
      return remember(useHook(), deps, () => fn)
    },
    useMemo(factory, deps) {
      return remember(useHook(), deps, factory)
    },
    useRef(initial) {
      const hook = useHook()
      if (!('ref' in hook)) hook.ref = { current: initial }
      return hook.ref
    },
  }

  function instantiate(Component, props) {
    const previous = current
    current.index = 0
    let tree
    try {
      tree = Component(props)
    } finally {
      current = previous
    }
    return tree
  }

  function flush(fiber) {
    const pending = fiber.pending
    fiber.pending = []
    for (const hook of pending) {
      if (typeof hook.cleanup === 'function') hook.cleanup()
      const result = hook.effect()
      hook.cleanup = typeof result === 'function' ? result : undefined
    }
  }

  function render(Component, props, fiber, limit = 30) {
    const previous = current
    current = fiber
    try {
      let tree = null
      for (let pass = 0; pass < limit; pass += 1) {
        fiber.dirty = false
        tree = instantiate(Component, props)
        flush(fiber)
        if (!fiber.dirty) return tree
      }
      throw new Error('панель не пришла в устойчивое состояние')
    } finally {
      current = previous
    }
  }

  /** One mounted component: the same hook slots across every re-render. */
  function mount(Component, props) {
    const fiber = { hooks: [], index: 0, dirty: false, pending: [] }
    return { render: () => render(Component, props, fiber), fiber }
  }

  return { React, mount }
}

/** Lets the panel's promises settle, then renders again. */
async function pump(mounted, rounds = 8) {
  let tree = null
  for (let round = 0; round < rounds; round += 1) {
    await new Promise((resolve) => setImmediate(resolve))
    tree = mounted.render()
  }
  return tree
}

// --- reading the rendered tree ----------------------------------------------

function walk(node, visit) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  visit(node)
  walk(node.props?.children, visit)
}

const nodesWhere = (tree, predicate) => {
  const found = []
  walk(tree, (node) => {
    if (predicate(node)) found.push(node)
  })
  return found
}

const texts = (node) => {
  const parts = []
  walk(node, (n) => {
    // The stylesheet travels in the tree; its text is not screen copy.
    if (n.type === 'style' || n.type === 'script') return
    for (const child of n.props?.children ?? []) if (typeof child === 'string') parts.push(child)
  })
  return parts
}

const textOf = (node) => texts(node).join(' ')
const text = (tree) => texts(tree).join(' ')
const hasTable = (tree) => nodesWhere(tree, (node) => node.type === 'table').length > 0

/** The model column of every rendered row, in order. */
const rowLabels = (tree) => {
  const table = nodesWhere(tree, (node) => node.type === 'table')[0]
  if (table === undefined) return []
  const body = nodesWhere(table, (node) => node.type === 'tbody')[0]
  return (body?.props.children ?? [])
    .filter((child) => typeof child === 'object' && child?.type === 'tr')
    .map((row) => textOf(row.props.children[0]).replace(/\s+/g, ' ').trim())
}

/** A button anywhere in the panel whose text contains `label`. */
const buttonWithText = (tree, label) =>
  nodesWhere(tree, (node) => node.type === 'button' && textOf(node).includes(label))[0]

// --- sorting by a column heading ----------------------------------------------

/** The heading cell of one column, found by the key that column declares. */
const headingFor = (tree, key) => headings(tree).find((th) => th.props.key === key)

/** The sort control inside a heading, or undefined for a heading without one. */
const sortButton = (tree, key) => {
  const children = headingFor(tree, key)?.props.children ?? []
  return children.find((child) => typeof child === 'object' && child?.type === 'button')
}

/** What the table says about the order of one column: `ascending`, `descending`, `none`. */
const ariaSort = (tree, key) => headingFor(tree, key)?.props['aria-sort']

/**
 * The text of a heading without its sort arrow.
 *
 * The arrow is decoration inside the heading — `aria-hidden`, and empty on every
 * column that is not the order — so it is stripped before the heading's text is
 * compared with the sentence the heading repeats.
 */
const headingText = (th) => text(th).replace(/[▲▼]/g, '').replace(/\s+/g, ' ').trim()

// --- the provider filter ------------------------------------------------------

/** The control's own summary: what the filter currently is, in one line. */
const filterSummary = (tree) => nodesWhere(tree, (node) => node.type === 'summary')[0]

/**
 * Every provider the filter offers, in the order it offers them.
 *
 * The archive's own row wears the same styling and is not a provider, so the
 * name on its checkbox is what tells the two apart: a helper that read both would
 * report the archive as a provider the filter can compare.
 */
const filterOptions = (tree) =>
  nodesWhere(
    tree,
    (node) =>
      node.props?.className === 'dsh-ms-filter-row' &&
      node.props.children[0]?.props?.name === 'provider',
  )

/** The archive's own row in the filter panel, or null when there is none. */
const archiveRow = (tree) =>
  nodesWhere(tree, (node) => String(node.props?.className ?? '').includes('dsh-ms-filter-archive'))[0] ??
  null

/** Its checkbox — the first child of the row, as for a provider. */
const archiveCheck = (tree) => archiveRow(tree)?.props.children[0] ?? null

const optionName = (option) =>
  (option.props.children.find((child) => child?.props?.className === 'dsh-ms-filter-name')?.props
    .children ?? []).join('')

const filterOption = (tree, name) => filterOptions(tree).find((option) => optionName(option) === name)

/** The checkbox of one provider — the first child of its row, always. */
const filterCheck = (tree, name) => filterOption(tree, name).props.children[0]

const filterChecked = (tree) =>
  filterOptions(tree)
    .filter((option) => option.props.children[0].props.checked === true)
    .map(optionName)
    .sort()

/** Every rendered row, as its list of cells. */
const bodyRows = (tree) => {
  const table = nodesWhere(tree, (node) => node.type === 'table')[0]
  if (table === undefined) return []
  const body = nodesWhere(table, (node) => node.type === 'tbody')[0]
  return (body?.props.children ?? []).filter((child) => typeof child === 'object' && child?.type === 'tr')
}

/** The rendered cells of one column, as `[label, className]` pairs, row by row. */
const columnCells = (tree, key) => {
  const head = nodesWhere(tree, (node) => node.type === 'thead')[0]
  const heading = (head?.props.children ?? []).flatMap((row) => row?.props?.children ?? [])
  const index = heading.findIndex((cell) => cell?.props?.key === key)
  if (index === -1) return []
  return bodyRows(tree).map((row) => {
    const cell = row.props.children[index]
    return [textOf(cell), cell.props.className]
  })
}

const headings = (tree) => nodesWhere(tree, (node) => node.type === 'th')

const NOTICE = 'Показан прежний ответ'

// --- fixtures ---------------------------------------------------------------

/** One panel row, with the fields the visible columns read. */
function row(provider, model, { steps = 1, ttftMedian = null, tpsMedian = null, errors = 0, lastSeen = 0, liveness = null, livenessChecking = false, archived = null, noStats = false } = {}) {
  return {
    provider,
    model,
    steps,
    sessions: 1,
    errors,
    toolErrors: 0,
    ttftMean: ttftMedian,
    ttftMedian,
    ttftMin: ttftMedian,
    ttftMax: ttftMedian,
    ttftP90: ttftMedian,
    ttftCount: steps,
    tpsMean: tpsMedian,
    tpsMedian,
    tpsMin: tpsMedian,
    tpsMax: tpsMedian,
    tpsCount: steps,
    speedConfidence: 0.9,
    llmMeanMs: 1200,
    outputTokens: 4000,
    cacheHitRate: 0.5,
    maxContextTokens: 10000,
    lastSeen,
    liveness,
    livenessChecking,
    // What the host graded this row as: `true` outside the current configuration,
    // `false` inside it, `null` when it could not read one at all.
    archived,
    // And whether the row exists only because the configuration serves the pair:
    // `true` on a row the history has no step for, `false` on every other one.
    noStats,
  }
}

function payload(sort, rows, { providers = [], providerList = null, archive = null, noStats = null } = {}) {
  return {
    ok: true,
    empty: false,
    scanned: rows.length,
    skipped: 0,
    pending: 0,
    complete: true,
    snapshotAt: 1_790_549_902_860,
    readNow: 0,
    reused: rows.length,
    generatedAt: 1_790_549_902_900,
    fromSnapshot: true,
    totals: { steps: 10, errors: 0, models: rows.length, providers: providerList?.length ?? rows.length },
    sort,
    view: 'model',
    providers,
    // What the host offers the filter, taken from the whole history and not from
    // the rows it is sending: the filtered rows are exactly the ones that are
    // missing from that list.
    providerList:
      providerList ??
      [...new Set(rows.map((entry) => entry.provider))]
        .sort()
        .map((provider) => ({
          provider,
          models: rows.filter((entry) => entry.provider === provider).length,
          steps: rows.filter((entry) => entry.provider === provider).reduce((sum, r) => sum + r.steps, 0),
          errors: 0,
          lastSeen: 0,
        })),
    shown: { models: rows.length, steps: rows.reduce((sum, r) => sum + r.steps, 0), errors: 0 },
    // What the archive holds under this filter, or `null` for a host that could
    // not read the configuration. The two are different answers and the panel
    // draws a different control for each.
    archive,
    // And how many rows of this answer come from the configuration with no
    // history behind them — `null` for that same unreadable host, which is the
    // one statement it has no standing to make either.
    noStats,
    rows,
  }
}

/** The payload the host sends for a filtered query, and the rows it keeps. */
function filtered(sort, rows, names, { providerList = PROVIDER_LIST } = {}) {
  return payload(sort, rows.filter((entry) => names.includes(entry.provider)), {
    providers: names,
    providerList,
  })
}

// The two orders share no row in first place, so a table that failed to follow
// the sort cannot pass by accident.
const PROVIDER_LIST = [
  { provider: 'codex', models: 1, steps: 106, errors: 0, lastSeen: 3000 },
  { provider: 'local-uns', models: 1, steps: 28, errors: 0, lastSeen: 1000 },
  { provider: 'openrouter', models: 1, steps: 5, errors: 0, lastSeen: 2000 },
]

const byTtft = payload(
  'ttft',
  [
    row('local-uns', 'Ornith-9B', { steps: 28, ttftMedian: 46, tpsMedian: 0.5, lastSeen: 1000 }),
    row('openrouter', 'glm-5.3-flash', { steps: 5, ttftMedian: 985, tpsMedian: 32.2, lastSeen: 2000 }),
    row('codex', 'gpt-6-astra', { steps: 106, ttftMedian: 3500, tpsMedian: 34.7, lastSeen: 3000 }),
  ],
  { providerList: PROVIDER_LIST },
)
const bySpeed = payload(
  'speed',
  [
    row('codex', 'gpt-6-astra', { steps: 106, ttftMedian: 3500, tpsMedian: 34.7, lastSeen: 3000 }),
    row('openrouter', 'glm-5.3-flash', { steps: 5, ttftMedian: 985, tpsMedian: 32.2, lastSeen: 2000 }),
    row('local-uns', 'Ornith-9B', { steps: 28, ttftMedian: 46, tpsMedian: 0.5, lastSeen: 1000 }),
  ],
  { providerList: PROVIDER_LIST },
)

// --- mounting the real panel ------------------------------------------------

/**
 * Loads `client.js` into its own context and renders the bundle page it
 * registers. Every store and transport starts empty, so a case says exactly what
 * the panel already has before it is asked anything.
 */
function mountPanel({ entries = null, prefs = null, instantDeadline = false, search = '' } = {}) {
  const store = new Map()
  if (entries !== null) store.set('dsh-model-stats:v1', JSON.stringify({ entries }))
  // State-machine scenarios exercise every sortable heading. Compact layout
  // has its own assertion below and explicitly opts out of the expanded set.
  store.set('dsh-model-stats:prefs:v1', JSON.stringify({ columnsAll: true, ...prefs }))

  const requests = []
  // Every address the panel writes, in order. The question lives in the address
  // as well as in the request, and a link that reopened something else would be
  // invisible to a test that only watched `fetch`.
  const addresses = []
  let registration = null

  const sandbox = Object.create(globalThis)
  sandbox.window = {
    __ModuleLoader__: {
      load(mod) {
        registration = mod
      },
    },
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
    location: { search, href: `https://host/plugins${search}` },
    history: { replaceState: (_state, _title, url) => addresses.push(String(url)) },
  }
  // The panel's own deadline, fired at once when a case asks for it: waiting
  // sixty seconds to prove that a timeout does not leave a spinner up forever
  // would be a test nobody runs.
  sandbox.setTimeout = (fn, ms, ...rest) => {
    if (instantDeadline && ms >= 60_000) {
      queueMicrotask(fn)
      return 0
    }
    const timer = setTimeout(fn, ms, ...rest)
    timer.unref?.()
    return timer
  }
  sandbox.fetch = (url, options = {}) => {
    const entry = { url: String(url), method: options.method ?? 'GET', settled: false }
    if (typeof options.body === 'string') {
      try {
        entry.body = JSON.parse(options.body)
      } catch {
        entry.body = options.body
      }
    }
    entry.response = new Promise((resolve, reject) => {
      entry.answer = (body, status = 200) => {
        entry.settled = true
        resolve(
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          }),
        )
      }
      entry.fail = (error) => {
        entry.settled = true
        reject(error)
      }
    })
    // The panel aborts its request on a deadline, on unmount and on the next
    // click; the fake has to honour that or it would answer a dead request.
    options.signal?.addEventListener?.('abort', () => {
      if (entry.settled) return
      entry.fail(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    })
    requests.push(entry)
    return entry.response
  }

  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })

  const panel = createReact()
  const mod = registration.factory((name) => {
    if (name === 'react') return panel.React
    throw new Error(`неожидаемый require: ${name}`)
  })

  const sections = []
  let i18n = null
  mod.apply({
    get(name) {
      if (name !== 'slots') return undefined
      return {
        inject: (slot, register) => {
          if (slot === 'plugins.bundle.config') register()
        },
        register: (definition, render) => sections.push({ definition, render }),
      }
    },
  })
  if (sections.length !== 1) throw new Error('панель не зарегистрировала страницу бандла в «Плагинах»')

  const { render, definition } = sections[0]
  // The entry is this bundle's configuration page: keyed by the package name, so
  // the Plugins page finds it under the name the profile installed, and rendered
  // for the page view the contract gives bundle configuration (it has no other).
  if (definition.name !== 'plugins.bundle.config') {
    throw new Error(`панель зарегистрирована в слоте ${definition.name}`)
  }
  if (definition.key !== 'dsh-model-stats') {
    throw new Error(`ключ страницы — ${definition.key}, а не имя пакета`)
  }
  // A view the slot never asks for renders nothing, rather than a second copy of
  // the table where the page expects a one-liner.
  if (render({ view: 'summary' }) !== null) throw new Error('панель отрисовалась вне страницы бандла')

  // The registered renderer returns `h(Panel, props)`: the element names the
  // panel and carries the props the slot would have supplied.
  const element = render({ view: 'page' })
  i18n = element.props.i18n
  const mounted = panel.mount(element.type, element.props)

  return {
    definition,
    mod,
    requests,
    addresses,
    store,
    i18n,
    render: () => mounted.render(),
    pump: () => pump(mounted),
  }
}

console.log('--- краткий набор и группы ---')
{
  const view = mountPanel({ prefs: { columnsAll: false } })
  await view.pump()
  view.requests[0].answer(byTtft)
  const tree = await view.pump()
  check('краткий вид: отклик, e2e и ошибки на 100 шагов',
    headings(tree).map((th) => th.props.key).join(',') === 'name,liveness,steps,ttft,e2e,errorRate')
}

console.log('--- переключение сортировки ---')

// --- 1: no cache, the answer arrives, then the sort is switched ---------------
{
  const view = mountPanel()
  let tree = await view.pump()
  check('до первого ответа таблицы нет, показан ход загрузки', !hasTable(tree) && text(tree).includes('Считаю статистику'))
  check('панель спросила сортировку по умолчанию', view.requests[0]?.url === '/api/model-stats?sort=ttft&dir=asc&view=model&limit=200', view.requests[0]?.url)

  view.requests[0].answer(byTtft)
  tree = await view.pump()
  check('после ответа таблица построена', hasTable(tree))
  check('первым идёт лидер по отклику', rowLabels(tree)[0]?.startsWith('Ornith-9B'), rowLabels(tree)[0])
  check('отдельных кнопок сортировки над таблицей больше нет', nodesWhere(tree, (node) => node.props?.['aria-label'] === 'Сортировка').length === 0)
  check(
    'активный заголовок — «отклик», остальные столбцы не сортируют',
    ariaSort(tree, 'ttft') === 'ascending' && ariaSort(tree, 'tps') === 'none' && ariaSort(tree, 'steps') === 'none',
    `ttft=${ariaSort(tree, 'ttft')} tps=${ariaSort(tree, 'tps')}`,
  )

  sortButton(tree, 'tps').props.onClick()
  tree = await view.pump()
  check('переключение сортировки запрошено у хоста', view.requests[1]?.url === '/api/model-stats?sort=speed&dir=desc&view=model&limit=200', view.requests[1]?.url)
  check('ответа ещё нет', view.requests[1]?.settled === false)
  check('ТАБЛИЦА ОСТАЛАСЬ НА ЭКРАНЕ, пока ответ в пути', hasTable(tree), text(tree).slice(0, 80))
  check('на экране те же строки, а не пустота', rowLabels(tree).join('|').startsWith('Ornith-9B'), rowLabels(tree).join(' | '))
  check('панель говорит, что это прежний ответ', text(tree).includes(NOTICE))
  check('заголовок tok/s взял сортировку, прежний сброшен', ariaSort(tree, 'tps') === 'descending' && ariaSort(tree, 'ttft') === 'none', `tps=${ariaSort(tree, 'tps')} ttft=${ariaSort(tree, 'ttft')}`)

  view.requests[1].answer(bySpeed)
  tree = await view.pump()
  check('после ответа порядок сменился на новый', rowLabels(tree)[0]?.startsWith('gpt-6-astra'), rowLabels(tree)[0])
  check('предупреждение о прежнем ответе снято', !text(tree).includes(NOTICE))
}

// --- 2: a switch whose request fails ----------------------------------------
{
  const cached = { 'ttft.asc|model|': { at: Date.now(), data: byTtft } }
  const view = mountPanel({ entries: cached })
  let tree = await view.pump()
  check('кэш отдан сразу, без ожидания', hasTable(tree) && rowLabels(tree)[0]?.startsWith('Ornith-9B'))

  sortButton(tree, 'errors').props.onClick()
  tree = await view.pump()
  check('смена сортировки не тронула строки', hasTable(tree) && rowLabels(tree)[0]?.startsWith('Ornith-9B'))

  view.requests[1].answer({ ok: false, error: 'boom' }, 500)
  tree = await view.pump()
  check('упавший запрос не унёс таблицу', hasTable(tree), text(tree).slice(0, 80))
  check('строки остались прежними', rowLabels(tree)[0]?.startsWith('Ornith-9B'), rowLabels(tree).join(' | '))
  check('панель объясняет сбой и просит повторить', text(tree).includes('Не удалось получить порядок') && text(tree).includes('Обновить'))
  check('сообщение о прежнем ответе заменено предупреждением', !text(tree).includes(NOTICE))
}

// --- 3: the first request fails, there is nothing to keep --------------------
{
  const view = mountPanel()
  let tree = await view.pump()
  check('пустая панель сначала грузится', !hasTable(tree))
  view.requests[0].answer({ ok: false, error: 'boom' }, 500)
  tree = await view.pump()
  check('показывать нечего — честная ошибка вместо пустой таблицы', !hasTable(tree) && text(tree).includes('Не удалось получить статистику'))
}

// --- 4: the deadline does not leave the spinner up ---------------------------
{
  const view = mountPanel({ instantDeadline: true })
  const tree = await view.pump()
  check('сорванный по времени запрос объяснён', !hasTable(tree) && text(tree).includes('превышено время ожидания'), text(tree).slice(0, 80))
  check('панель не осталась в бесконечной загрузке', !text(tree).includes('Считаю статистику'))
}

// --- 5: the stored choice, validated ----------------------------------------
{
  // The stored order has no `dir` of its own — an older preference — so the
  // direction comes from the map of natural directions, not from the global
  // default. `errors` is a visible column, so the restored direction has a
  // heading to show its arrow in.
  //
  // The cached answer is built for the question it is cached under: the panel
  // draws the arrow from the order the host says it applied, and a payload that
  // claims another one is a host that did not answer this question.
  const entries = {
    'errors.desc|model|': { at: Date.now(), data: { ...bySpeed, sort: 'errors' } },
  }
  const view = mountPanel({ entries, prefs: { sort: 'errors', view: 'model' } })
  const tree = await view.pump()
  check('сохранённая сортировка восстановлена', view.requests[0]?.url === '/api/model-stats?sort=errors&dir=desc&view=model&limit=200', view.requests[0]?.url)
  check('кэшированный ответ отдан без ожидания', hasTable(tree))
  check('сохранённое направление показано стрелкой заголовка', ariaSort(tree, 'errors') === 'descending', headings(tree).map((th) => `${th.props.key}=${th.props['aria-sort']}`).join(' ') || '(заголовков нет)')
}
{
  const view = mountPanel({ prefs: { sort: 'nonsense', view: 'provider' } })
  view.render()
  check('испорченная сортировка не уходит на хост', view.requests[0]?.url === '/api/model-stats?sort=ttft&dir=asc&view=provider&limit=200', view.requests[0]?.url)
}

console.log('\n--- фильтрация по провайдеру ---')

// The filter is the same kind of question as the sort — a different answer from
// the host, and a different set of rows — so the contract of section 1 applies to
// it unchanged: a switch must never take the table off the screen, and the notice
// about a stale answer has to name the filter as well as the sort, or a table of
// every provider is read as a table of the selected ones.
{
  const view = mountPanel()
  let tree = await view.pump()
  view.requests[0].answer(byTtft)
  tree = await view.pump()
  check('без выбора в сводке написано «все»', textOf(filterSummary(tree)) === 'Провайдеры: все', textOf(filterSummary(tree)))
  check('число шагов провайдера показано рядом с именем', textOf(filterOption(tree, 'openrouter')).includes('шагов: 5'), textOf(filterOption(tree, 'openrouter')))

  filterCheck(tree, 'codex').props.onChange({})
  tree = await view.pump()
  check('первый выбранный провайдер ушёл на хост', view.requests[1]?.url === '/api/model-stats?sort=ttft&dir=asc&view=model&provider=codex&limit=200', view.requests[1]?.url)
  view.requests[1].answer(filtered('ttft', byTtft.rows, ['codex']))
  tree = await view.pump()

  filterCheck(tree, 'openrouter').props.onChange({})
  tree = await view.pump()
  check(
    'выбор ушёл на хост одним запросом со сортировкой, в порядке имён',
    view.requests[2]?.url === '/api/model-stats?sort=ttft&dir=asc&view=model&provider=codex%2Copenrouter&limit=200',
    view.requests[2]?.url,
  )
  check('ответа ещё нет', view.requests[2]?.settled === false)
  check('ТАБЛИЦА ОСТАЛАСЬ НА ЭКРАНЕ, пока ответ на фильтр в пути', hasTable(tree))
  check('на экране прежняя строка, а не пустота', rowLabels(tree).length === 1, rowLabels(tree).join(' | '))
  check('панель говорит, что это прежний ответ', text(tree).includes(NOTICE))
  check(
    'в уведомлении назван и фильтр, а не только сортировка',
    text(tree).includes('выбрано провайдеров: 2 из 3'),
    text(tree).slice(text(tree).indexOf(NOTICE), text(tree).indexOf(NOTICE) + 90),
  )

  view.requests[2].answer(filtered('ttft', byTtft.rows, ['codex', 'openrouter']))
  tree = await view.pump()
  check('после ответа в таблице только выбранные провайдеры', rowLabels(tree).length === 2, rowLabels(tree).join(' | '))
  check('предупреждение о прежнем ответе снято', !text(tree).includes(NOTICE))
  check('сводка фильтра считает выбранное', textOf(filterSummary(tree)) === 'Провайдеры: 2 из 3', textOf(filterSummary(tree)))
  check('отмечены ровно выбранные провайдеры', filterChecked(tree).join() === 'codex,openrouter', filterChecked(tree).join(' | '))
  check(
    'выбор записан в настройки панели',
    JSON.parse(view.store.get('dsh-model-stats:prefs:v1')).providers.join() === 'codex,openrouter',
    view.store.get('dsh-model-stats:prefs:v1'),
  )
  check(
    'подвал говорит, что осталось от истории после фильтра',
    text(tree).includes('в таблице: 2 моделей, 111 шагов'),
    text(tree).match(/в таблиц[ея][^·]*/)?.[0],
  )

  filterCheck(tree, 'codex').props.onChange({})
  tree = await view.pump()
  check('снятие одного провайдера оставляет остальные', view.requests[3]?.url === '/api/model-stats?sort=ttft&dir=asc&view=model&provider=openrouter&limit=200', view.requests[3]?.url)

  buttonWithText(tree, 'Сбросить').props.onClick()
  tree = await view.pump()
  check('сброс убирает фильтр из запроса', view.requests[4]?.url === '/api/model-stats?sort=ttft&dir=asc&view=model&limit=200', view.requests[4]?.url)
  check('сброс записан в настройки', JSON.parse(view.store.get('dsh-model-stats:prefs:v1')).providers.join() === '')
  check('кнопки сброса больше нет', buttonWithText(tree, 'Сбросить') === undefined)
}

// --- the list the filter offers ----------------------------------------------
// The rows on screen cannot answer this: they are sorted, cut to the limit and
// already filtered, so they name a few of the providers in the history — and the
// ones a filter exists to compare are exactly the ones missing.
{
  const view = mountPanel({ prefs: { providers: ['openrouter'] } })
  let tree = await view.pump()
  view.requests[0].answer(filtered('ttft', byTtft.rows, ['openrouter']))
  tree = await view.pump()
  check('строки отфильтрованного ответа показаны', rowLabels(tree).length === 1, rowLabels(tree).join(' | '))
  check(
    'фильтр предлагает всех провайдеров истории, а не только строки таблицы',
    filterOptions(tree).map(optionName).join() === 'codex,local-uns,openrouter',
    filterOptions(tree).map(optionName).join(' | '),
  )
  check('сводка считает выбранное из общего списка', textOf(filterSummary(tree)) === 'Провайдеры: 1 из 3', textOf(filterSummary(tree)))
}

// --- the order the filter offers them in --------------------------------------
// The host sends its list busiest first, which is the order the table itself is
// read in and the wrong one to find a name in: the control is a list of
// checkboxes, and a name that moves between two answers is a name the reader has
// to hunt for again. The fixture makes the two orders disagree — openrouter
// (106 steps), codex (28), local-uns (5) — because a fixture the two orders
// agree on can only pass by accident, whichever order the panel follows.
{
  const byTraffic = [
    { provider: 'openrouter', models: 1, steps: 106, errors: 0, lastSeen: 3000 },
    { provider: 'codex', models: 1, steps: 28, errors: 0, lastSeen: 1000 },
    { provider: 'local-uns', models: 1, steps: 5, errors: 0, lastSeen: 2000 },
  ]
  const byName = [...byTraffic]
    .sort((a, b) => a.provider.localeCompare(b.provider))
    .map((entry) => entry.provider)
  check(
    'фикстура различает порядок по имени и порядок по трафику',
    byTraffic.map((entry) => entry.provider).join() !== byName.join(),
    `${byTraffic.map((entry) => entry.provider).join(' | ')} / ${byName.join(' | ')}`,
  )
  const view = mountPanel({ prefs: { providers: ['openrouter'] } })
  let tree = await view.pump()
  view.requests[0].answer(filtered('ttft', byTtft.rows, ['openrouter'], { providerList: byTraffic }))
  tree = await view.pump()
  check(
    'фильтр предлагает провайдеров по алфавиту, а не по числу шагов',
    filterOptions(tree).map(optionName).join() === byName.join(),
    filterOptions(tree).map(optionName).join(' | '),
  )
  check('число шагов осталось на строке, рядом с именем', textOf(filterOption(tree, 'openrouter')).includes('шагов: 106'), textOf(filterOption(tree, 'openrouter')))
}

// --- the filter and the two views --------------------------------------------
// In the provider view a row already is a provider, so a filter could only ever
// leave one row: it is not sent. The selection is kept, so the way back to the
// model view is the table the user left, not a new question.
{
  const view = mountPanel({ prefs: { sort: 'ttft', view: 'model', providers: ['openrouter'] } })
  let tree = await view.pump()
  view.requests[0].answer(filtered('ttft', byTtft.rows, ['openrouter']))
  tree = await view.pump()
  check('сохранённый фильтр отправлен при открытии', view.requests[0]?.url === '/api/model-stats?sort=ttft&dir=asc&view=model&provider=openrouter&limit=200', view.requests[0]?.url)

  // The chip names the view it is showing, so the switch is the other name.
  buttonWithText(tree, 'по моделям').props.onClick()
  tree = await view.pump()
  check('в режиме по провайдерам фильтр не отправляется', view.requests[1]?.url === '/api/model-stats?sort=ttft&dir=asc&view=provider&limit=200', view.requests[1]?.url)
  check('в режиме по провайдерам фильтр не показан', filterSummary(tree) === undefined)

  view.requests[1].answer({ ...byTtft, view: 'provider' })
  tree = await view.pump()
  buttonWithText(tree, 'по провайдерам').props.onClick()
  tree = await view.pump()
  check('возврат к моделям вернул и фильтр', view.requests[2]?.url === '/api/model-stats?sort=ttft&dir=asc&view=model&provider=openrouter&limit=200', view.requests[2]?.url)
  check('выбор не потерялся при смене вида', textOf(filterSummary(tree)) === 'Провайдеры: 1 из 3', textOf(filterSummary(tree)))
}

// --- the filter's own edge cases ---------------------------------------------
{
  // An answer from a host that predates the filter carries no provider list.
  // The rows still name the providers that are in it, so the control works.
  const view = mountPanel({ entries: { 'ttft.asc|model|': { at: Date.now(), data: byTtft } } })
  const { providerList, ...withoutList } = byTtft
  view.render()
  view.requests[0].answer(withoutList)
  const tree = await view.pump()
  check('без списка провайдеров фильтр собран из строк', filterOptions(tree).map(optionName).join() === 'codex,local-uns,openrouter', filterOptions(tree).map(optionName).join(' | '))
}
{
  // A corrupt selection is not a query: only the real names go to the host.
  const view = mountPanel({ prefs: { providers: [1, null, 'codex', 'codex', '  ', 'openrouter'] } })
  view.render()
  check('испорченный фильтр очищен и не уходит на хост', view.requests[0]?.url === '/api/model-stats?sort=ttft&dir=asc&view=model&provider=codex%2Copenrouter&limit=200', view.requests[0]?.url)
}
{
  // A filter can leave nothing, and that is not an empty history: the sessions
  // are there, just not behind the selected providers.
  const view = mountPanel({ prefs: { providers: ['openrouter'] } })
  let tree = await view.pump()
  view.requests[0].answer(payload('ttft', [], { providers: ['openrouter'], providerList: PROVIDER_LIST }))
  tree = await view.pump()
  check('пустой результат фильтра объяснён отдельно', text(tree).includes('У выбранных провайдеров'), text(tree).slice(0, 60))
  check('пустой результат фильтра не зовёт поработать в сессии', !text(tree).includes('Поработайте в сессии'))
  check('фильтр на месте, его можно снять', buttonWithText(tree, 'Сбросить') !== undefined)
}
{
  // The cache is keyed by the whole question, so a filtered answer is not shown
  // for the unfiltered question and the other way round.
  const filteredEntry = { at: Date.now(), data: filtered('ttft', byTtft.rows, ['openrouter']) }
  const view = mountPanel({ entries: { 'ttft.asc|model|openrouter': filteredEntry }, prefs: { providers: ['openrouter'] } })
  const tree = view.render()
  check('отфильтрованный кэш отдан сразу, без ожидания', hasTable(tree) && rowLabels(tree).length === 1, rowLabels(tree).join(' | '))
}
{
  // A selection the current answer does not know is still offered: the control
  // must never hide a filter the user is looking at.
  const view = mountPanel({ prefs: { providers: ['openrouter', 'retired-provider'] } })
  let tree = await view.pump()
  view.requests[0].answer(byTtft)
  tree = await view.pump()
  check('выбранный провайдер остаётся в списке, даже если его нет в ответе', filterOptions(tree).map(optionName).includes('retired-provider'), filterOptions(tree).map(optionName).join(' | '))
}

console.log('\n--- архив: модели вне текущей конфигурации ---')

// The archive is a filter with one control, one default and one word. The host
// sends what it holds (`archive`) and grades every row it sends (`archived`); the
// panel's job is to keep the three honest — the default is off, the control is
// offered only where the host could grade at all, and a row that came back with
// the flag says out loud which kind it is.
const RETIRED = row('codex', 'gpt-6-astra', { steps: 106, ttftMedian: 3500, tpsMedian: 34.7, lastSeen: 3000, archived: true })
const withArchive = (rows, archive) => payload('ttft', rows, { providerList: PROVIDER_LIST, archive })
{
  const view = mountPanel()
  let tree = await view.pump()
  view.requests[0].answer(withArchive(byTtft.rows, { rows: 1, steps: 106, shown: false }))
  tree = await view.pump()
  check('архив — отметка в фильтре, а не место в списке провайдеров', archiveCheck(tree) !== null && filterOptions(tree).length === 3)
  check('по умолчанию она снята', archiveCheck(tree)?.props.checked === false)
  check('в ней посчитано, что лежит в архиве', textOf(archiveRow(tree)).includes('штук: 1'), textOf(archiveRow(tree)))
  check('сводка фильтра про архив молчит, пока он выключен', textOf(filterSummary(tree)) === 'Провайдеры: все', textOf(filterSummary(tree)))
  check('подвал говорит, сколько строк держит архив', text(tree).includes('в архиве: 1'), text(tree).match(/в архиве[^·]*/)?.[0])
  check('ни одна строка не помечена архивной', nodesWhere(tree, (node) => node.props?.className === 'dsh-ms-archive').length === 0)

  archiveCheck(tree).props.onChange({})
  tree = await view.pump()
  check('отметка уходит на хост одним флагом', view.requests[1]?.url === '/api/model-stats?sort=ttft&dir=asc&view=model&archived=1&limit=200', view.requests[1]?.url)
  check('ТАБЛИЦА ОСТАЛАСЬ НА ЭКРАНЕ, пока ответ на архив в пути', hasTable(tree))
  check('уведомление называет и архив, а не только провайдеров', text(tree).includes('(архив)'), text(tree).slice(text(tree).indexOf(NOTICE), text(tree).indexOf(NOTICE) + 60))

  view.requests[1].answer(withArchive([RETIRED, ...byTtft.rows], { rows: 1, steps: 106, shown: true }))
  tree = await view.pump()
  check('ответ с архивом показан целиком', rowLabels(tree).length === 4, rowLabels(tree).join(' | '))
  check('архивная строка помечена словом', nodesWhere(tree, (node) => node.props?.className === 'dsh-ms-archive').length === 1)
  check('и только она', textOf(bodyRows(tree)[0]).includes('архив'), textOf(bodyRows(tree)[0]).slice(0, 60))
  check('сводка фильтра называет архив', textOf(filterSummary(tree)).includes('+ архив'), textOf(filterSummary(tree)))
  check('подвал не считает архив скрытым, когда он показан', !text(tree).includes('в архиве:'), text(tree).match(/в архиве[^·]*/)?.[0])
  check('выбор записан в настройки панели', JSON.parse(view.store.get('dsh-model-stats:prefs:v1')).archived === true, view.store.get('dsh-model-stats:prefs:v1'))
  check('адрес называет архив', String(view.addresses.at(-1)).includes('msArchived=1'), String(view.addresses.at(-1)))
  check(
    'и кэш — под своим ключом, а не под ключом таблицы без архива',
    Object.keys(JSON.parse(view.store.get('dsh-model-stats:v1')).entries).some((key) => key.endsWith('|archive')),
    Object.keys(JSON.parse(view.store.get('dsh-model-stats:v1')).entries).join(' | '),
  )

  archiveCheck(tree).props.onChange({})
  tree = await view.pump()
  check('снятие отметки убирает архив из запроса', view.requests[2]?.url === '/api/model-stats?sort=ttft&dir=asc&view=model&limit=200', view.requests[2]?.url)
  check('и из адреса', !String(view.addresses.at(-1)).includes('msArchived'), String(view.addresses.at(-1)))
}

// --- a host that cannot grade at all ------------------------------------------
// `null` from a host that read no configuration and nothing at all from a host
// that predates the field are one answer to the panel: there is no archive to
// offer. A checkbox that could only ever read zero would be a claim about the
// configuration this host is in no position to make.
for (const [label, answer] of [
  ['хост до появления поля', payload('ttft', byTtft.rows, { providerList: PROVIDER_LIST })],
  ['хост без каталога', payload('ttft', byTtft.rows, { providerList: PROVIDER_LIST, archive: null })],
]) {
  const view = mountPanel()
  let tree = await view.pump()
  view.requests[0].answer(answer)
  tree = await view.pump()
  check(`архив не предлагается: ${label}`, archiveRow(tree) === null && hasTable(tree))
}

// --- the table the archive emptied --------------------------------------------
{
  const view = mountPanel()
  let tree = await view.pump()
  view.requests[0].answer(payload('ttft', [], { providerList: PROVIDER_LIST, archive: { rows: 3, steps: 12, shown: false } }))
  tree = await view.pump()
  check('пустая таблица объясняет архив, а не историю', text(tree).includes('вне текущей конфигурации'), text(tree).slice(0, 90))
  check('и называет, сколько строк там лежит', text(tree).includes('3'), text(tree).slice(0, 90))
  check('и не зовёт поработать в сессии', !text(tree).includes('Поработайте в сессии'))
  check('отметка остаётся под рукой', archiveCheck(tree) !== null)
}

// --- the archive in the address and in the stored question --------------------
{
  const view = mountPanel({ search: '?msView=model&msArchived=1' })
  view.render()
  check('адрес с архивом открывает архив', view.requests[0]?.url === '/api/model-stats?sort=ttft&dir=asc&view=model&archived=1&limit=200', view.requests[0]?.url)
}
{
  const view = mountPanel({ prefs: { archived: true } })
  view.render()
  check('сохранённый архив отправлен при открытии', view.requests[0]?.url === '/api/model-stats?sort=ttft&dir=asc&view=model&archived=1&limit=200', view.requests[0]?.url)
}
{
  // A broken preference must not turn the filter on: the archive is the one
  // filter whose default decides what the reader is shown.
  const view = mountPanel({ prefs: { archived: 'yes please' } })
  view.render()
  check('испорченное значение не включает архив', view.requests[0]?.url === '/api/model-stats?sort=ttft&dir=asc&view=model&limit=200', view.requests[0]?.url)
}
{
  // The reset button lifts the whole filter, and the archive is part of it.
  const view = mountPanel({ prefs: { providers: ['codex'], archived: true } })
  let tree = await view.pump()
  view.requests[0].answer(withArchive(byTtft.rows, { rows: 1, steps: 106, shown: true }))
  tree = await view.pump()
  buttonWithText(tree, 'Сбросить').props.onClick()
  tree = await view.pump()
  check('сброс снимает и провайдеров, и архив', view.requests[1]?.url === '/api/model-stats?sort=ttft&dir=asc&view=model&limit=200', view.requests[1]?.url)
  check('и записан в настройки', JSON.parse(view.store.get('dsh-model-stats:prefs:v1')).archived === false, view.store.get('dsh-model-stats:prefs:v1'))
}

// --- the words the panel promises to have -------------------------------------
{
  const mod = mountPanel().mod
  const placeholders = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join()
  const ru = mod.__test__.MESSAGES.ru
  const en = mod.__test__.MESSAGES.en
  check(
    'слова об архиве есть в обоих словарях',
    ['filter.group', 'filter.archive', 'filter.archive.short', 'filter.archive.count', 'footer.archive', 'empty.archived', 'hint.archive', 'archive.badge'].every((key) => typeof ru[key] === 'string' && typeof en[key] === 'string'),
    Object.keys(ru).filter((key) => !(key in en)).join(' | ') || '(все ключи на месте)',
  )
  check(
    'подстановки в словах об архиве совпадают между языками',
    placeholders(ru['filter.archive.count']) === placeholders(en['filter.archive.count']) &&
      placeholders(ru['empty.archived']) === placeholders(en['empty.archived']) &&
      placeholders(ru['footer.archive']) === placeholders(en['footer.archive']),
  )
}

console.log('\n--- строки конфигурации, у которых нет ни одного замера ---')

// The table lists the models the configuration serves even when no session has
// ever run one of them — that is how such a model can be seen and tested at all.
// Every figure in such a row but the step count is a dash, so the row says out
// loud which kind it is, and the footer counts them exactly as it counts the
// archive: over the filtered set, and silently when the host could not read the
// configuration.
const NEVER_USED = row('ollama', 'qwen3-coder:30b', { steps: 0, lastSeen: null, noStats: true })
{
  const view = mountPanel()
  let tree = await view.pump()
  view.requests[0].answer(
    payload('ttft', [...byTtft.rows, NEVER_USED], {
      providerList: PROVIDER_LIST,
      noStats: { rows: 1 },
    }),
  )
  tree = await view.pump()

  check('строка конфигурации без замеров нарисована как строка', rowLabels(tree).length === 4, rowLabels(tree).join(' | '))
  const marks = nodesWhere(tree, (node) => node.props?.className === 'dsh-ms-nostats')
  check('и помечена словом', marks.length === 1 && textOf(marks[0]) === 'нет статистики', marks.map(textOf).join(' | ') || '(метки нет)')
  check(
    'метка стоит на своей строке, а не на всех',
    textOf(bodyRows(tree)[3]).includes('нет статистики') &&
      !textOf(bodyRows(tree)[0]).includes('нет статистики'),
    textOf(bodyRows(tree)[3]).slice(0, 60),
  )
  check(
    'у такой строки есть кружок проверки — ею и тестируют',
    nodesWhere(bodyRows(tree)[3], (node) => node.props?.className === 'dsh-ms-live-button').length === 1,
  )
  check(
    'подвал считает такие строки',
    text(tree).includes('без статистики: 1'),
    text(tree).match(/без статистики[^·]*/)?.[0],
  )
  check(
    'шаги у такой строки — измеренный ноль, а не пропуск',
    columnCells(tree, 'steps')[3]?.[0] === '0',
    JSON.stringify(columnCells(tree, 'steps')),
  )
  check(
    'и ни одно измерение не выдано за число',
    columnCells(tree, 'ttft')[3]?.[0] === '-' && columnCells(tree, 'tps')[3]?.[0] === '-',
    JSON.stringify([columnCells(tree, 'ttft')[3], columnCells(tree, 'tps')[3]]),
  )
}
{
  // A host that could not read the configuration has no standing to count the
  // rows it holds for models the live catalog might serve: it says nothing.
  const view = mountPanel()
  let tree = await view.pump()
  view.requests[0].answer(payload('ttft', byTtft.rows, { providerList: PROVIDER_LIST, noStats: null }))
  tree = await view.pump()
  check('хост без каталога о таких строках молчит', !text(tree).includes('без статистики'))
  check('и ни одна строка не помечена', nodesWhere(tree, (node) => node.props?.className === 'dsh-ms-nostats').length === 0)
}
{
  // What the host answers on a fresh install: no history at all, and the
  // configured models as the whole table. The panel draws it rather than telling
  // the reader to go and work in a session.
  const view = mountPanel()
  let tree = await view.pump()
  view.requests[0].answer(
    payload('ttft', [NEVER_USED], { providerList: PROVIDER_LIST, noStats: { rows: 1 } }),
  )
  tree = await view.pump()
  check(
    'пустая история при живом каталоге — таблица, а не «поработайте в сессии»',
    hasTable(tree) && !text(tree).includes('Поработайте в сессии'),
    text(tree).slice(0, 70),
  )
  check('в такой таблице одна строка и она помечена', rowLabels(tree).length === 1 && text(tree).includes('нет статистики'), rowLabels(tree).join(' | '))
}

console.log('\n--- правила, которые панель обещает ---')

// --- 6: rows always win over a message --------------------------------------
{
  const view = mountPanel()
  const { contentKind } = view.mod.__test__
  const rows = byTtft.rows
  for (const phase of ['loading', 'refreshing', 'ready', 'error']) {
    check(`строки вытесняют сообщение в состоянии ${phase}`, contentKind(rows, { phase }) === 'table')
  }
  check('без строк и без ответа — загрузка', contentKind([], { phase: 'loading' }) === 'loading')
  check('без строк ошибка остаётся ошибкой', contentKind([], { phase: 'error' }) === 'error')
  check('пустой ответ — это пустой ответ', contentKind([], { phase: 'ready' }) === 'empty')

  const { querySwitched, queryAnswered, queryFailed } = view.mod.__test__
  const previous = { phase: 'ready', data: byTtft, dataQuery: 'ttft.asc|model|', warning: null, error: null }
  const switched = querySwitched(previous, null, 'speed|model')
  check('смена сортировки сохраняет прежние строки', switched.data === byTtft && switched.dataQuery === 'ttft.asc|model|')
  check('смена сортировки помечает состояние как загрузку', switched.phase === 'loading')
  check('кэш нового запроса отменяет прежние строки', querySwitched(previous, bySpeed, 'speed|model').dataQuery === 'speed|model')
  check('пустое состояние не выдаёт себя за данные', querySwitched({ data: null }, null, 'speed|model').data === null)
  check('ответ помечается своим запросом', queryAnswered(bySpeed, 'speed|model').dataQuery === 'speed|model')
  const failed = queryFailed(previous, 'boom')
  check('сбой не выбрасывает строки', failed.data === byTtft && failed.warning === 'boom' && failed.phase === 'ready')
  check('сбой без строк — это ошибка', queryFailed({ data: null }, 'boom').phase === 'error')
}

// --- 7: both dictionaries stay whole ----------------------------------------
{
  const view = mountPanel()
  const { MESSAGES } = view.mod.__test__
  const ru = Object.keys(MESSAGES.ru).sort()
  const en = Object.keys(MESSAGES.en).sort()
  check('русский и английский словари описывают одни и те же ключи', ru.join() === en.join(), `ru=${ru.length}, en=${en.length}`)

  const placeholders = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join()
  const mismatched = ru.filter((key) => placeholders(MESSAGES.ru[key]) !== placeholders(MESSAGES.en[key]))
  check('подстановки в переводах совпадают', mismatched.length === 0, mismatched.join(', '))

  // Every key the panel asks for, taken from the shipped source: a missing
  // translation renders as the raw key id, which is how a half-translated
  // release reaches the user. A key named by a function — the model/provider
  // columns pick their label and their hint by the current view, and the footer
  // counts models or providers the same way — is only visible as a quoted
  // string on that line, so the patterns read the literals rather than the shape
  // of the property. Only `namespace.key` strings count: every id in the
  // dictionaries has that shape, the values around them (`'model'`,
  // `'provider'`, `'plugins.bundle.config'`) do not.
  const asked = new Set([
    ...[...source.matchAll(/\bt\('([^']+)'/g)].map((match) => match[1]),
    ...[...source.matchAll(/labelKey:[^\n]*?'(\w+\.\w+)'/g)].map((match) => match[1]),
    // The column tooltips are named the same way, through `t(hint)` at render
    // time — so the shipped source, not the call, is what has to list them.
    ...[...source.matchAll(/hintKey:[^\n]*?'(\w+\.\w+)'/g)].map((match) => match[1]),
    // Every other id, wherever it sits: a key chosen inside a ternary is
    // invisible to the patterns above and would go untranslated in silence.
    ...[...source.matchAll(
      /'(?:action|announce|column|columns|empty|error|filter|footer|hint|loading|note|panel|query|section|sort|status|timeout|view|warn)\.[\w.]+'/g,
    )].map((match) => match[0].slice(1, -1)),
  ])
  const missing = [...asked].filter((key) => !(key in MESSAGES.ru) || !(key in MESSAGES.en))
  check(`все ${asked.size} ключей интерфейса переведены`, missing.length === 0, missing.join(', '))
}

// --- 8: the two ends of the ranking, and the column tooltips -----------------
//
// The panel marks the best median green, so it has to mark the worst one too —
// a reader who sees green and nothing else cannot tell an average model from a
// bad one. Both ends come out of one ranking (see `ranked` in the panel), and
// the heading tooltips have to carry the rule to whoever hovers.
{
  const view = mountPanel({ entries: { 'ttft.asc|model|': { at: Date.now(), data: byTtft } } })
  const tree = view.render()

  // byTtft: ttft 46 / 985 / 3500 ms, tps 0.5 / 32.2 / 34.7 tok/s.
  const ttft = columnCells(tree, 'ttft')
  check('лучший отклик — зелёный', ttft[0]?.[1] === 'dsh-ms-good', JSON.stringify(ttft))
  check('худший отклик — красный', ttft[2]?.[1] === 'dsh-ms-worst', JSON.stringify(ttft))
  check('средний отклик не выделен', ttft[1]?.[1] === 'dsh-ms-num', JSON.stringify(ttft))

  const tps = columnCells(tree, 'tps')
  check('лучшая скорость — зелёная', tps[2]?.[1] === 'dsh-ms-good', JSON.stringify(tps))
  check('худшая скорость — красная', tps[0]?.[1] === 'dsh-ms-worst', JSON.stringify(tps))
  check('средняя скорость не выделена', tps[1]?.[1] === 'dsh-ms-num', JSON.stringify(tps))

  check('легенда называет оба цвета', text(tree).includes('Зелёным') && text(tree).includes('красным'))

  // The tooltip and the hidden copy of it are the same sentence: one rendered
  // for the mouse, one for everything that reads the markup.
  const tips = headings(tree).map((th) => {
    const button = th.props.children.find((child) => child?.type === 'button')
    const label = button === undefined ? th.props.children[0] : button.props.children[0]
    return {
      label,
      hint: th.props.title,
      // The fake DOM joins text nodes with a space; the browser only concatenates
      // them, so runs of whitespace are the one difference allowed here.
      // Strip visual arrows so the spoken text reflects words and hints.
      spoken: headingText(th),
    }
  })
  check(
    'у каждого заголовка есть подсказка',
    tips.length > 0 && tips.every(({ hint }) => typeof hint === 'string' && hint.length > 10),
  )
  check(
    'подсказка заголовка дословно повторена текстом для чтения с экрана',
    tips.every(({ label, hint, spoken }) => spoken === `${label} — ${hint}`),
    tips
      .filter(({ label, hint, spoken }) => spoken !== `${label} — ${hint}`)
      .map(({ label, hint, spoken }) => `${spoken} != ${label} — ${hint}`)
      .join(' | '),
  )
  check(
    'подсказка объясняет и зелёный, и красный',
    tips.some(({ hint }) => hint.includes('Зелёным') && hint.includes('красным')),
  )
}
{
  // Nothing to compare against: one row is neither the best nor the worst.
  const single = payload('ttft', [row('local-uns', 'Ornith-9B', { steps: 28, ttftMedian: 46, tpsMedian: 30 })])
  const view = mountPanel({ entries: { 'ttft.asc|model|': { at: Date.now(), data: single } } })
  const tree = view.render()
  const tones = [...columnCells(tree, 'ttft'), ...columnCells(tree, 'tps')].map(([, cls]) => cls)
  check('единственная строка не выделена ни лучшей, ни худшей', tones.every((cls) => cls === 'dsh-ms-num'), tones.join(', '))
}
{
  // A model the provider recorded no stream timing for is missing a figure, not
  // slow: it must not be painted as the worst of the column.
  const unmeasured = payload('ttft', [
    row('local-uns', 'Ornith-9B', { steps: 28, ttftMedian: 46, tpsMedian: null }),
    row('openrouter', 'glm-5.3-flash', { steps: 5, ttftMedian: 985, tpsMedian: 12 }),
    row('codex', 'gpt-6-astra', { steps: 106, ttftMedian: null, tpsMedian: 34.7 }),
  ])
  const view = mountPanel({ entries: { 'ttft.asc|model|': { at: Date.now(), data: unmeasured } } })
  const tree = view.render()
  const ttft = columnCells(tree, 'ttft')
  const tps = columnCells(tree, 'tps')
  check('нет замера — «-» без цвета', ttft[2]?.[0] === '-' && ttft[2]?.[1] === 'dsh-ms-num', JSON.stringify(ttft))
  check('нет замера — «-» без цвета', tps[0]?.[0] === '-' && tps[0]?.[1] === 'dsh-ms-num', JSON.stringify(tps))
  check('худший из замеренных отмечен, а не незамеренный', ttft[1]?.[1] === 'dsh-ms-worst' && tps[1]?.[1] === 'dsh-ms-worst', `${JSON.stringify(ttft)} ${JSON.stringify(tps)}`)
}

console.log('\n--- сортировка по клику на заголовок столбца ---')
{
  const cached = { 'ttft.asc|model|': { at: Date.now(), data: byTtft } }
  const view = mountPanel({ entries: cached })
  let tree = await view.pump()

  check('по умолчанию колонка отклика имеет aria-sort=ascending', ariaSort(tree, 'ttft') === 'ascending', ariaSort(tree, 'ttft'))
  check('остальные колонки имеют aria-sort=none', ariaSort(tree, 'steps') === 'none' && ariaSort(tree, 'name') === 'none')

  // Click on "steps" column heading
  const stepsBtn = sortButton(tree, 'steps')
  check('у заголовка шагов есть кнопка сортировки', stepsBtn !== undefined)
  stepsBtn.props.onClick()
  tree = await view.pump()

  check(
    'клик по заголовку шагов запросил у хоста сортировку steps по убыванию',
    view.requests[1]?.url === '/api/model-stats?sort=steps&dir=desc&view=model&limit=200',
    view.requests[1]?.url,
  )
  check('колонка шагов получила aria-sort=descending', ariaSort(tree, 'steps') === 'descending')
  check('колонка отклика вернулась в aria-sort=none', ariaSort(tree, 'ttft') === 'none')
  check('в настройках сохранён порядок steps.desc', view.store.get('dsh-model-stats:prefs:v1')?.includes('"sort":"steps"') && view.store.get('dsh-model-stats:prefs:v1')?.includes('"dir":"desc"'))

  // Click on "steps" heading again to flip direction
  sortButton(tree, 'steps').props.onClick()
  tree = await view.pump()

  check(
    'повторный клик развернул направление на steps.asc',
    view.requests[2]?.url === '/api/model-stats?sort=steps&dir=asc&view=model&limit=200',
    view.requests[2]?.url,
  )
  check('колонка шагов получила aria-sort=ascending', ariaSort(tree, 'steps') === 'ascending')
  check('в настройках сохранён порядок steps.asc', view.store.get('dsh-model-stats:prefs:v1')?.includes('"dir":"asc"'))
}

{
  // Test restoring arbitrary column sort and direction from prefs
  const view = mountPanel({
    prefs: { sort: 'cache', dir: 'desc', columnsAll: true },
  })
  await view.pump()
  check(
    'восстановление сортировки по глубокой метрике (cache) и направлению из prefs',
    view.requests[0]?.url === '/api/model-stats?sort=cache&dir=desc&view=model&limit=200',
    view.requests[0]?.url,
  )
}

{
  // Check that every visible column in columnsAll view renders a sort button
  // and maps to a valid PANEL_SORTS key recognized by the host.
  //
  // The status column used to be the deliberate exception — "a probe result is a
  // fact about one moment, not a quantity to order rows by" — and it now has an
  // order of its own, so the exception is gone rather than moved: a heading that
  // looks like a control has to be one, and that is asserted here as "no heading
  // is left without a button" rather than as "exactly one heading is exempt",
  // which would keep passing after the exemption quietly moved somewhere else.
  const cached = { 'ttft.asc|model|': { at: Date.now(), data: byTtft } }
  const view = mountPanel({ entries: cached, prefs: { columnsAll: true } })
  const tree = await view.pump()
  const tableHeadings = headings(tree)
  check('полный вид группирует однотипные метрики',
    tableHeadings.map((th) => th.props.key).join(',') ===
      'name,liveness,steps,lastSeen,ttft,ttftP90,ttftClean,retry,e2e,tps,tpsMax,confidence,errorRate,modelErrors,errors,interrupted,llm,prefill,overhead,cache')
  // The count is derived from PANEL_SORTS rather than written down, so adding a
  // column cannot leave a stale literal here that only fails on the next person
  // to run the tool. One heading per sort key, and every heading is one.
  const expectedHeadings = PANEL_SORTS.length
  check(
    `развёрнутая таблица показывает все ${expectedHeadings} колонок`,
    tableHeadings.length === expectedHeadings,
    `length=${tableHeadings.length}`,
  )

  const keys = []
  const unsorted = []
  for (const th of tableHeadings) {
    const btn = th.props.children.find((c) => typeof c === 'object' && c?.type === 'button')
    if (!btn) {
      unsorted.push(th.props.key)
      continue
    }
    // Create isolated mount to click this column
    const subView = mountPanel({ entries: cached, prefs: { columnsAll: true } })
    const subTree = await subView.pump()
    const colBtn = headingFor(subTree, th.props.key)?.props.children.find((c) => typeof c === 'object' && c?.type === 'button')
    colBtn.props.onClick()
    await subView.pump()
    const reqUrl = subView.requests[1]?.url
    const sortParam = new URL(reqUrl, 'http://localhost').searchParams.get('sort')
    keys.push(sortParam)
  }

  check(
    `все ${PANEL_SORTS.length} метрик таблицы кликабельны и просят допустимый ключ хоста`,
    keys.length === PANEL_SORTS.length && keys.every((k) => PANEL_SORTS.includes(k)),
    keys.join(', '),
  )
  check(
    'у каждого заголовка есть кнопка сортировки, включая статус',
    unsorted.length === 0,
    unsorted.join(', ') || '(нет)',
  )
  check(
    'ключи колонок покрывают все PANEL_SORTS',
    PANEL_SORTS.every((k) => keys.includes(k)),
    PANEL_SORTS.filter((k) => !keys.includes(k)).join(', '),
  )
}

{
  // The stylesheet pins the first cell of every row to the left edge while the
  // table scrolls sideways, and it addresses it as ':first-child' because that
  // is the one cell the header and every row already agree on. The pin is the
  // name column only while the name column is the first one — a column moved in
  // front of it would silently hand the pin to that column, and 'dsh-ms-left'
  // cannot stand in: the status column is left-aligned too. So the invariant the
  // selector rests on is asserted here rather than left in a stylesheet comment.
  const cached = { 'ttft.asc|model|': { at: Date.now(), data: byTtft } }
  const view = mountPanel({ entries: cached })
  const tree = await view.pump()
  const firstHeading = headings(tree)[0]
  const pinnedCells = bodyRows(tree).map((row) => row.props.children[0])
  check(
    'первая колонка таблицы — колонка модели, и в заголовке, и в каждой строке',
    firstHeading?.props.key === 'name' &&
      pinnedCells.length > 0 &&
      pinnedCells.every((cell) => cell?.props.key === 'name'),
    `${firstHeading?.props.key} / ${pinnedCells.map((cell) => cell?.props.key).join(', ')}`,
  )
}

{
  // The status heading asks the host for the one order the fold cannot read off
  // the session log, and the host's own default is the broken end of it: a
  // reader who orders by status is asking what is wrong right now. The second
  // click is the reversal, like every other column — the one order whose rows do
  // not move on the second click would be an order with a second rule.
  const cached = { 'ttft.asc|model|': { at: Date.now(), data: byTtft } }
  const view = mountPanel({ entries: cached })
  let tree = await view.pump()

  sortButton(tree, 'liveness').props.onClick()
  tree = await view.pump()
  check(
    'клик по заголовку статуса просит хост порядок по статусу, худшим сверху',
    view.requests[1]?.url === '/api/model-stats?sort=liveness&dir=desc&view=model&limit=200',
    view.requests[1]?.url,
  )
  check('колонка статуса получила aria-sort=descending', ariaSort(tree, 'liveness') === 'descending')
  check(
    'в настройках сохранён порядок liveness.desc',
    view.store.get('dsh-model-stats:prefs:v1')?.includes('"sort":"liveness"') &&
      view.store.get('dsh-model-stats:prefs:v1')?.includes('"dir":"desc"'),
  )

  sortButton(tree, 'liveness').props.onClick()
  tree = await view.pump()
  check(
    'повторный клик перевернул направление на liveness.asc',
    view.requests[2]?.url === '/api/model-stats?sort=liveness&dir=asc&view=model&limit=200',
    view.requests[2]?.url,
  )
  check('колонка статуса получила aria-sort=ascending', ariaSort(tree, 'liveness') === 'ascending')
}

{
  // The rollout case: a panel newer than the host it is talking to. A host that
  // does not know a key answers the tool's default rather than failing the
  // request, so the rows come back in another order — and a heading that kept
  // its arrow would be claiming an order its rows are not in, out loud to a
  // screen reader. The echoed order is the one field that can contradict the
  // question, so it is what the arrow is drawn from.
  const view = mountPanel({ entries: { 'ttft.asc|model|': { at: Date.now(), data: byTtft } } })
  let tree = await view.pump()
  sortButton(tree, 'liveness').props.onClick()
  tree = await view.pump()
  check(
    'заголовок статуса рисует стрелку, пока хост отвечает тем же порядком',
    ariaSort(tree, 'liveness') === 'descending',
    ariaSort(tree, 'liveness'),
  )

  view.requests[1].answer({ ...byTtft, sort: 'steps' })
  tree = await view.pump()
  check(
    'хост, ответивший другим порядком, снимает стрелку с заголовка статуса',
    ariaSort(tree, 'liveness') === 'none' && ariaSort(tree, 'steps') === 'descending',
    headings(tree).map((th) => `${th.props.key}=${th.props['aria-sort']}`).join(' '),
  )
}

{
  // The host classifies a probe once and ships the verdict with the result, and
  // this is the assertion that the panel reads it: the two rows below carry codes
  // the panel's own copy would classify the other way round, so whichever state
  // the circle draws is the host's. It is what keeps the cell and the row order
  // one rule — a circle drawn as a limit while the order ranks the row as down
  // is a table that contradicts itself about the same model.
  const probeAt = 1_790_000_000_000
  const hostVerdict = payload('liveness', [
    row('openrouter', 'limited-by-host', {
      lastSeen: probeAt - 60_000,
      // A timeout the host classified as a refusal: the circle must be the
      // host's word, not this panel's reading of the same code.
      liveness: { provider: 'openrouter', model: 'limited-by-host', status: 'fail', state: 'limited', code: 'TIMEOUT', error: 'no answer within 15000 ms', checkedAt: probeAt, latencyMs: 15000, source: 'llm' },
    }),
    row('openrouter', 'down-by-host', {
      lastSeen: probeAt - 60_000,
      // And a refused credential the host could not call a configuration fault.
      liveness: { provider: 'openrouter', model: 'down-by-host', status: 'fail', state: 'down', code: 'AUTH', error: 'Invalid API key', checkedAt: probeAt, latencyMs: 40, source: 'llm' },
    }),
  ], { providerList: PROVIDER_LIST })
  const view = mountPanel({
    entries: { 'liveness.desc|model|': { at: Date.now(), data: hostVerdict } },
    prefs: { sort: 'liveness', dir: 'desc' },
  })
  const tree = await view.pump()
  const states = nodesWhere(tree, (node) => node.props?.className === 'dsh-ms-live-dot').map((dot) => dot.props['data-state'])
  check(
    'состояние кружка берётся у хоста, а не из кода второй раз в панели',
    states[0] === 'limited' && states[1] === 'down',
    `data-state=${states.join(', ')}`,
  )
}

// --- liveness: what the status circle is allowed to claim --------------------
//
// The rule under test is the one the feature exists for: a probe answers for a
// moment, and history that is *later* than that moment outranks it. A model
// whose probe failed at T but which answered at T+n is not down — the check is
// simply older than the evidence. The counter-case matters just as much: a
// failure with no later evidence has to stay red, or the rule would quietly
// turn every dead model green.

console.log('')
console.log('--- живость: что кружок имеет право утверждать ---')

{
  const probeAt = 1_790_000_000_000
  const withLiveness = (rows) => payload('ttft', rows, { providerList: PROVIDER_LIST })

  const livePayload = withLiveness([
    row('openrouter', 'checked-ok', {
      lastSeen: probeAt - 60_000,
      liveness: { provider: 'openrouter', model: 'checked-ok', status: 'ok', checkedAt: probeAt, latencyMs: 820, source: 'llm' },
    }),
    row('openrouter', 'failed-then-answered', {
      // The probe failed, and then the model answered — the case the rule is for.
      lastSeen: probeAt + 30_000,
      liveness: { provider: 'openrouter', model: 'failed-then-answered', status: 'fail', code: 'TIMEOUT', error: 'no answer within 15000 ms', checkedAt: probeAt, latencyMs: 15000, source: 'llm' },
    }),
    row('openrouter', 'failed-and-silent', {
      // The probe failed and history says nothing later: this one stays red.
      lastSeen: probeAt - 120_000,
      liveness: { provider: 'openrouter', model: 'failed-and-silent', status: 'fail', code: 'HTTP_401', error: 'Invalid API key', checkedAt: probeAt, latencyMs: 40, source: 'llm' },
    }),
    row('openrouter', 'never-checked', { lastSeen: probeAt - 5_000 }),
  ])

  const view = mountPanel({ entries: { 'ttft.asc|model|': { at: Date.now(), data: livePayload } }, prefs: { columnsAll: true } })
  const tree = await view.pump()

  const dots = nodesWhere(tree, (node) => node.props?.className === 'dsh-ms-live-dot')
  const states = dots.map((dot) => dot.props['data-state'])
  check(
    'кружок есть у каждой строки — включая непроверенную',
    dots.length === 4,
    states.join(', '),
  )
  check(
    'успешная проверка — зелёный',
    states[0] === 'up',
    `data-state=${states[0]}`,
  )
  check(
    'провал, после которого модель отвечала, — зелёный: проверка устарела, а не модель упала',
    states[1] === 'up',
    `data-state=${states[1]}`,
  )
  check(
    // The same refusal, the same code, and the difference is only the evidence:
    // this one did not answer afterwards, so it keeps the refusal's own circle.
    'тот же провал без позднего ответа не зеленеет — отказанный ключ остаётся «нет доступа»',
    states[2] === 'denied',
    `data-state=${states[2]}`,
  )
  check(
    'непроверенная модель — серый кружок, а не «недоступна»',
    states[3] === 'unknown',
    `data-state=${states[3]}`,
  )

  // The derived state says where the answer came from. A green circle that meant
  // "history says so" while looking identical to "probed just now" would let a
  // reader act on an old fact believing it fresh.
  const rowsRendered = bodyRows(tree)
  const derivedMeta = nodesWhere(rowsRendered[1], (node) => node.props?.className === 'dsh-ms-live-meta')
  const plainMeta = nodesWhere(rowsRendered[0], (node) => node.props?.className === 'dsh-ms-live-meta')
  check(
    'у кружка «провал, но отвечала позже» есть пометка о происхождении',
    derivedMeta.length === 1 && textOf(derivedMeta[0]).includes('по истории'),
    derivedMeta.length === 0 ? '(нет подписи)' : textOf(derivedMeta[0]).slice(0, 90),
  )
  check(
    'у обычной успешной проверки такой пометки нет',
    plainMeta.length === 0 || !textOf(plainMeta[0]).includes('по истории'),
    plainMeta.length === 0 ? '(нет подписи)' : textOf(plainMeta[0]).slice(0, 90),
  )
  const derivedDot = nodesWhere(rowsRendered[1], (node) => node.props?.className === 'dsh-ms-live-dot')[0]
  check('пометка стоит рядом с кружком, а не вместо него', derivedDot !== undefined && derivedDot.props['data-state'] === 'up')
}

{
  // A click on one circle asks about one model. A route that swept the catalog
  // because a provider was named would make a targeted check a full sweep.
  const probeAt = 1_790_000_000_000
  const cached = payload('ttft', [
    row('openrouter', 'glm-5.3-flash', { lastSeen: probeAt - 1000 }),
  ])
  const view = mountPanel({ entries: { 'ttft.asc|model|': { at: Date.now(), data: cached } }, prefs: { columnsAll: true } })
  const tree = await view.pump()

  const circle = nodesWhere(tree, (node) => node.props?.className === 'dsh-ms-live-button')[0]
  circle.props.onClick()
  await view.pump()

  const post = view.requests.find((entry) => entry.method === 'POST')
  check('клик по кружку отправляет POST на маршрут проверки', post?.url === '/api/model-stats/liveness/check', post?.url)
  check(
    'клик проверяет одну модель, а не весь каталог',
    post?.body?.provider === 'openrouter' && post?.body?.model === 'glm-5.3-flash' && post?.body?.all !== true,
    JSON.stringify(post?.body),
  )

  // The host answers a sweep immediately and keeps working, so the panel has to
  // follow the work down its own count rather than treat the first answer as the
  // last one.
  const sweep = nodesWhere(tree, (node) => node.type === 'button').find((node) => textOf(node) === 'Проверить все')
  check('есть кнопка проверки всех моделей', sweep !== undefined)
  const stale = nodesWhere(tree, (node) => node.type === 'button').find((node) => textOf(node) === 'Только устаревшие')
  check('есть кнопка проверки только устаревших', stale !== undefined)
}

// --- лимит: отказ провайдера — это ответ, а не поломка модели ----------------
//
// A provider that refuses on a limit reached the model and was told no. Painted
// red like a timeout, it says "this model does not work" — and the one move that
// cannot help is the move a reader then makes, which is picking another model.
// The counter-cases matter as much: a refused credential is not a limit, and a
// limit whose history is later is stale, exactly like the timeout above.

console.log('')
console.log('--- лимит: отказ провайдера — это ответ, а не поломка модели ---')

{
  const probeAt = 1_790_000_000_000
  const refused = (model, liveness, lastSeen) => row('openrouter', model, { lastSeen, liveness })
  const limitPayload = payload('ttft', [
    refused('quota-model', { provider: 'openrouter', model: 'quota-model', status: 'fail', code: 'QUOTA', error: 'Insufficient balance', httpStatus: 402, checkedAt: probeAt, latencyMs: 300, source: 'llm' }, probeAt - 120_000),
    // The provider's own words, and they are the whole reason this rule exists:
    // `dsh-llm` calls a spent daily allowance `RATE_LIMIT`, so a panel that read
    // only the code answered "слишком часто" while the message in the same cell
    // said the limit was reached and when it resets.
    refused('daily-model', { provider: 'openrouter', model: 'daily-model', status: 'fail', code: 'RATE_LIMIT', error: '429: {"message":"Rate limit exceeded: free-models-per-day","code":429}', httpStatus: null, checkedAt: probeAt, latencyMs: 210, source: 'llm' }, probeAt - 120_000),
    // A promise of a retry in seconds outranks the word "limit" in the same
    // sentence: this one is momentary and patience is the fix.
    refused('burst-model', { provider: 'openrouter', model: 'burst-model', status: 'fail', code: 'RATE_LIMIT', error: '429: Rate limit reached for gpt-4o on requests per min (RPM): Limit 3, Used 3. Please try again in 1.2s.', httpStatus: null, checkedAt: probeAt, latencyMs: 180, source: 'llm' }, probeAt - 120_000),
    // Nothing to read: a bare 429 with no prose stays the throttle its code is
    // named after.
    refused('http-limit-model', { provider: 'openrouter', model: 'http-limit-model', status: 'fail', code: 'HTTP_429', error: 'too many requests', httpStatus: 429, checkedAt: probeAt, latencyMs: 90, source: 'http' }, probeAt - 120_000),
    // An explicit quota code needs no prose and is not overruled by one.
    refused('quota-code-model', { provider: 'openrouter', model: 'quota-code-model', status: 'fail', code: 'ACCOUNT_QUOTA', error: 'try again in 5s', httpStatus: null, checkedAt: probeAt, latencyMs: 120, source: 'llm' }, probeAt - 120_000),
    // A refused credential is the account's problem too, but not a limit: it
    // does not clear by waiting, so it stays as red as a broken route.
    refused('auth-model', { provider: 'openrouter', model: 'auth-model', status: 'fail', code: 'AUTH', error: 'Invalid API key', httpStatus: 401, checkedAt: probeAt, latencyMs: 40, source: 'llm' }, probeAt - 120_000),
    // The rule from the block above, applied to a limit: the model answered
    // after the refusal, so the refusal is stale and the model is not throttled.
    refused('stale-limit', { provider: 'openrouter', model: 'stale-limit', status: 'fail', code: 'QUOTA', error: 'Insufficient balance', httpStatus: 402, checkedAt: probeAt, latencyMs: 300, source: 'llm' }, probeAt + 60_000),
    // A provider row carries a roll-up: every model failed, and the codes of
    // those failures travel as a list. A provider whose whole catalog was
    // refused on a limit is refused, not broken.
    refused('rollup-limit', { provider: 'openrouter', model: null, status: 'fail', codes: ['QUOTA', 'RATE_LIMIT'], error: 'Insufficient balance', counts: { ok: 0, fail: 5, total: 5 }, checkedAt: probeAt, latencyMs: 300, source: 'llm', rolledUp: true }, probeAt - 120_000),
    // One failure of another kind is enough to make the provider down: the
    // amber circle is a claim about all of it.
    refused('rollup-mixed', { provider: 'openrouter', model: null, status: 'fail', codes: ['QUOTA', 'TIMEOUT'], error: 'Insufficient balance', counts: { ok: 0, fail: 5, total: 5 }, checkedAt: probeAt, latencyMs: 300, source: 'llm', rolledUp: true }, probeAt - 120_000),
    // A roll-up that only ever saw 429s has no quota code to lean on and reads
    // the same prose its models do, so it does not word itself differently from
    // the rows it summarises.
    refused('rollup-spent', { provider: 'openrouter', model: null, status: 'fail', codes: ['RATE_LIMIT'], error: '429: {"message":"Daily free limit reached for model x: 3587969 of 3500000 tokens used. The limit resets at 00:00 UTC."}', counts: { ok: 0, fail: 5, total: 5 }, checkedAt: probeAt, latencyMs: 300, source: 'llm', rolledUp: true }, probeAt - 120_000),
    // The same `RATE_LIMIT` a momentary throttle arrives as, and a message that
    // names the fix instead: the key has to be paid for before the free models
    // answer again. Read as a throttle it told the reader to wait for a pause no
    // pause can end.
    refused('topup-model', { provider: 'openrouter', model: 'topup-model', status: 'fail', code: 'RATE_LIMIT', error: '429: {"code":429,"message":"Free models are for active keys. The last top-up on this key was 2026-09-21, which is more than 7 days ago. Top it up to use free models again.","type":"api_error"}', httpStatus: null, checkedAt: probeAt, latencyMs: 140, source: 'llm' }, probeAt - 120_000),
  ])

  const view = mountPanel({ entries: { 'ttft.asc|model|': { at: Date.now(), data: limitPayload } }, prefs: { columnsAll: true } })
  const tree = await view.pump()

  const dots = nodesWhere(tree, (node) => node.props?.className === 'dsh-ms-live-dot')
  const states = dots.map((dot) => dot.props['data-state'])
  check(
    'исчерпанная квота, частота и HTTP-429 — жёлтый кружок, а не красный',
    states.slice(0, 5).every((state) => state === 'limited'),
    states.join(', '),
  )
  check(
    'отказ по ключу — это «нет доступа», а не «недоступна»: пауза его не лечит',
    states[5] === 'denied',
    states[5],
  )
  check(
    'лимит, после которого модель отвечала, — зелёный: отказ устарел',
    states[6] === 'up',
    states[6],
  )
  check(
    'провайдер, у которого на лимите отказали все модели, — жёлтый',
    states[7] === 'limited',
    states[7],
  )
  check(
    'одна не-лимитная ошибка в провайдере делает его красным, а не жёлтым',
    states[8] === 'down',
    states[8],
  )
  check(
    'провайдер из одних 429-х читает те же слова, что его модели',
    states[9] === 'limited',
    states[9],
  )

  const labels = nodesWhere(tree, (node) => node.props?.className === 'dsh-ms-live-label').map((node) => textOf(node))
  check(
    'исчерпанную квоту словом не называют «слишком часто»',
    labels[0] === 'лимит исчерпан' && labels[1] === 'лимит исчерпан' && labels[4] === 'лимит исчерпан',
    `${labels[0]} / ${labels[1]} / ${labels[4]}`,
  )
  check(
    'мгновенную частоту словом не называют «лимит исчерпан»',
    labels[2] === 'слишком часто' && labels[3] === 'слишком часто',
    `${labels[2]} / ${labels[3]}`,
  )
  check(
    'провайдер из одних 429-х получает слово по провайдерской же формулировке',
    labels[7] === 'лимит исчерпан' && labels[9] === 'лимит исчерпан',
    `${labels[7]} / ${labels[9]}`,
  )
  check(
    'отказ, который просит пополнить счёт, не называют «слишком часто»: пауза его не лечит',
    states[10] === 'limited' && labels[10] === 'лимит исчерпан',
    `${states[10]} / ${labels[10]}`,
  )

  const buttons = nodesWhere(tree, (node) => node.props?.className === 'dsh-ms-live-button')
  check(
    'подсказка называет код отказа и причину провайдера',
    String(buttons[0].props.title).includes('QUOTA') && String(buttons[0].props.title).includes('Insufficient balance'),
    buttons[0].props.title,
  )
  const stale = buttons.filter((button) => String(button.props.title).includes('по истории'))
  check(
    'подсказка объясняет, почему провал нарисован зелёным',
    stale.length === 1 && String(stale[0].props.title).includes('но модель отвечала позже неё'),
    stale.map((button) => button.props.title).join(' | '),
  )

  // The short column set is the default one. There the status cell is a claim and
  // nothing else: the circumstances move into the tooltip rather than widening a
  // cell every row has to share — and nothing is lost for a reader who cannot
  // hover, because the same sentence is the button's own accessible name.
  const short = mountPanel({ entries: { 'ttft.asc|model|': { at: Date.now(), data: limitPayload } }, prefs: { columnsAll: false } })
  const shortTree = await short.pump()
  check(
    'в кратком наборе колонок строка обстоятельств не рисуется',
    nodesWhere(shortTree, (node) => node.props?.className === 'dsh-ms-live-meta').length === 0,
    `мета-строк: ${nodesWhere(shortTree, (node) => node.props?.className === 'dsh-ms-live-meta').length}`,
  )
  check(
    'в кратком наборе колонок остаётся кружок и слово',
    nodesWhere(shortTree, (node) => node.props?.className === 'dsh-ms-live-dot').length === limitPayload.rows.length,
  )
  const shortButtons = nodesWhere(shortTree, (node) => node.props?.className === 'dsh-ms-live-button')
  const shortAria = String(shortButtons[0].props['aria-label'])
  check(
    'то, что ушло из клетки, доступно и в подсказке, и читалке с экрана',
    String(shortButtons[0].props.title).includes('Insufficient balance') &&
      shortAria.includes('QUOTA') &&
      shortAria.includes('Insufficient balance'),
    `${shortButtons[0].props.title} || ${shortAria}`,
  )
}

// --- чей ход: круг говорит, кто должен чинить ---------------------------------
//
// A failed check has three very different meanings, and the panel used to have one
// red word for all of them: nobody answered, the provider refused the account, or
// the row was never configured. The first is the provider's move, the second is a
// key, the third is a config file — and the circle says which before the word is
// read, because a reader who is told "unavailable" goes looking for another model.

console.log('')
console.log('--- чей ход: круг говорит, кто должен чинить ---')

{
  const probeAt = 1_790_000_000_000
  const at = (model, code, error, extra = {}) => ({
    provider: 'openrouter', model, status: 'fail', code, error, checkedAt: probeAt, latencyMs: 100, source: 'llm', ...extra,
  })
  const configPayload = payload('ttft', [
    row('openrouter', 'no-key', { lastSeen: probeAt - 120_000, liveness: at('no-key', 'NO_KEY', 'нет ключа для провайдера openrouter') }),
    row('openrouter', 'no-route', { lastSeen: probeAt - 120_000, liveness: at('no-route', 'NO_ROUTE', 'no adapter serves this provider and the configuration declares no endpoint for it') }),
    row('openrouter', 'no-model', { lastSeen: probeAt - 120_000, liveness: at('no-model', 'UNKNOWN_MODEL', 'pi-ai provider "nvidia1" has no configured model "google/gemma-4-31b-it"') }),
    // The phrasings that actually arrive: a model that is gone comes back as a
    // 400 or a 404 with the reason buried in the body.
    row('openrouter', 'gone-model', { lastSeen: probeAt - 120_000, liveness: at('gone-model', 'INVALID_REQUEST', '404: {"code":"model_not_found","message":"The model free-claude-opus-5 does not exist","type":"invalid_request_error"}') }),
    row('openrouter', 'not-available', { lastSeen: probeAt - 120_000, liveness: at('not-available', 'INVALID_REQUEST', '400: {"message":"The model \u0027gpt-image-2\u0027 is not available","type":"invalid_request_error","param":"model","code":"model_not_found"}') }),
    // A 400 that says nothing about a model is not a missing model.
    row('openrouter', 'bad-request', { lastSeen: probeAt - 120_000, liveness: at('bad-request', 'INVALID_REQUEST', '400: {"message":"temperature must be <= 2","type":"invalid_request_error"}') }),
    // A provider having a bad day is nobody's configuration, and "temporarily
    // unavailable" is deliberately not the wording the rule looks for.
    row('openrouter', 'overloaded', { lastSeen: probeAt - 120_000, liveness: at('overloaded', 'SERVER', '503: {"message":"The model \u0027grok-4.20-multi-agent\u0027 is temporarily unavailable"}') }),
    row('openrouter', 'dropped', { lastSeen: probeAt - 120_000, liveness: at('dropped', 'TRANSPORT', 'socket hang up') }),
    row('openrouter', 'slow', { lastSeen: probeAt - 60_000, liveness: at('slow', 'TIMEOUT', 'no answer within 15000 ms') }),
    // A roll-up answers for a whole provider, so a mixture of configuration
    // faults is one word — and a mixture with a real failure is not ours at all.
    row('openrouter', 'rollup-keys', { lastSeen: probeAt - 120_000, liveness: { provider: 'openrouter', model: null, status: 'fail', codes: ['AUTH', 'NO_KEY'], counts: { ok: 0, fail: 3, total: 3 }, checkedAt: probeAt, latencyMs: 100, source: 'llm', rolledUp: true } }),
    row('openrouter', 'rollup-gone', { lastSeen: probeAt - 120_000, liveness: { provider: 'openrouter', model: null, status: 'fail', codes: ['NO_ROUTE', 'UNKNOWN_MODEL'], counts: { ok: 0, fail: 3, total: 3 }, checkedAt: probeAt, latencyMs: 100, source: 'llm', rolledUp: true } }),
    row('openrouter', 'rollup-mixed', { lastSeen: probeAt - 120_000, liveness: { provider: 'openrouter', model: null, status: 'fail', codes: ['AUTH', 'TIMEOUT'], counts: { ok: 0, fail: 3, total: 3 }, checkedAt: probeAt, latencyMs: 100, source: 'llm', rolledUp: true } }),
    // A refusal history has overtaken is stale, exactly like a limit: the key was
    // wrong then and the model answered afterwards.
    row('openrouter', 'key-fixed', { lastSeen: probeAt + 60_000, liveness: at('key-fixed', 'AUTH', '401 Unauthorized: missing or invalid bearer token') }),
    // Nothing to print: a failure that arrived without a code keeps the word,
    // because the rule swaps a word for the status, not for a blank.
    row('openrouter', 'silent', { lastSeen: probeAt - 120_000, liveness: at('silent', '', null) }),
  ])

  const view = mountPanel({ entries: { 'ttft.asc|model|': { at: Date.now(), data: configPayload } }, prefs: { columnsAll: true } })
  const tree = await view.pump()

  const states = nodesWhere(tree, (node) => node.props?.className === 'dsh-ms-live-dot').map((dot) => dot.props['data-state'])
  const labels = nodesWhere(tree, (node) => node.props?.className === 'dsh-ms-live-label').map((node) => textOf(node))
  const labelNodes = nodesWhere(tree, (node) => node.props?.className === 'dsh-ms-live-label')
  const buttons = nodesWhere(tree, (node) => node.props?.className === 'dsh-ms-live-button')

  const cellAt = (index) => `${states[index]}/${labels[index]}`
  check(
    'нет ключа — «нет доступа», а не «недоступна»',
    states[0] === 'denied' && labels[0] === 'нет доступа',
    cellAt(0),
  )
  check(
    'у провайдера не объявлен адрес — «нет маршрута»',
    states[1] === 'missing' && labels[1] === 'нет маршрута',
    cellAt(1),
  )
  check(
    'модели нет в списке провайдера — «нет модели»',
    states[2] === 'missing' && labels[2] === 'нет модели',
    cellAt(2),
  )
  check(
    'провайдер отвечает «does not exist» — «нет модели», а не «недоступна»',
    states[3] === 'missing' && labels[3] === 'нет модели',
    cellAt(3),
  )
  check(
    'провайдер отвечает «is not available» — тоже «нет модели»',
    states[4] === 'missing' && labels[4] === 'нет модели',
    cellAt(4),
  )
  check(
    '400 без слова о модели остаётся красным, и клетка печатает сам статус',
    states[5] === 'down' && labels[5] === 'invalid_request',
    cellAt(5),
  )
  check(
    '503 «temporarily unavailable» — ход провайдера, а не отсутствие модели',
    states[6] === 'down' && labels[6] === 'server',
    cellAt(6),
  )
  check(
    'обрыв связи и таймаут остаются красными и называют себя своим статусом',
    states[7] === 'down' && states[8] === 'down' && labels[7] === 'transport' && labels[8] === 'timeout',
    `${cellAt(7)} ${cellAt(8)}`,
  )
  check(
    'провайдер целиком на ключах — «нет доступа»',
    states[9] === 'denied' && labels[9] === 'нет доступа',
    cellAt(9),
  )
  check(
    'провайдер без маршрута и без модели — «нет маршрута»: маршрут важнее',
    states[10] === 'missing' && labels[10] === 'нет маршрута',
    cellAt(10),
  )
  check(
    'ключ вперемешку с таймаутом — уже не наш ход, и клетка печатает оба статуса',
    states[11] === 'down' && labels[11] === 'auth · timeout',
    cellAt(11),
  )
  check(
    'отказ по ключу, после которого модель отвечала, — зелёный',
    states[12] === 'up' && labels[12] === 'доступна',
    cellAt(12),
  )
  check(
    'отказ вовсе без кода остаётся словом: печатать нечего',
    states[13] === 'down' && labels[13] === 'недоступна',
    cellAt(13),
  )
  // The status is the host's own id, so it is the one string in this cell no
  // language pack owns: handing it to the translator would only let a dictionary
  // turn `timeout` into a word the tooltip does not carry.
  check(
    'напечатанный статус переводить нельзя, а слово панели — можно',
    labelNodes[8].props.translate === 'no' && labelNodes[0].props.translate === undefined,
    `${String(labelNodes[8].props.translate)} / ${String(labelNodes[0].props.translate)}`,
  )
  check(
    'тот же статус остаётся в подсказке и в читалке с экрана заглавными',
    String(buttons[8].props.title).includes('TIMEOUT') && String(buttons[8].props['aria-label']).includes('timeout'),
    `${buttons[8].props.title} || ${buttons[8].props['aria-label']}`,
  )
  check(
    'подсказка называет код и причину и в этих словах',
    String(buttons[3].props.title).includes('model_not_found') &&
      String(buttons[3].props.title).includes('does not exist'),
    buttons[3].props.title,
  )
}

// --- конец проверки: «проверяю…» не переживает саму проверку ------------------
//
// The rows on screen were fetched with a `livenessChecking` flag the host
// computed when it answered. A sweep that finishes must take that flag with it:
// the circle reads the flag, so a model the host has long finished would keep
// saying "checking" — a claim about *now* that is not true — until somebody
// pressed Refresh. Observed live: after a 116-model sweep the whole column said
// "checking" while the host reported nothing in flight.

console.log('')
console.log('--- конец проверки: «проверяю…» не переживает саму проверку ---')

{
  const probeAt = 1_790_000_000_000
  // The table answer the browser kept was fetched while a sweep was running, so
  // its row carries the host's own "checking" flag. That is the live case: the
  // sweep ends, the flag stays, and the column goes on claiming "checking" while
  // nothing is in flight.
  const cached = payload('ttft', [
    row('openrouter', 'glm-5.3-flash', { lastSeen: probeAt - 1000, livenessChecking: true }),
  ])
  const view = mountPanel({ entries: { 'ttft.asc|model|': { at: Date.now(), data: cached } }, prefs: { columnsAll: true } })
  let tree = await view.pump()

  const dotState = (node) => nodesWhere(node, (entry) => entry.props?.className === 'dsh-ms-live-dot')[0]?.props['data-state']
  const tableGets = () => view.requests.filter((entry) => entry.method === 'GET' && entry.url.startsWith('/api/model-stats?'))
  check('строка, помеченная хостом как проверяемая, нарисована «проверяю…»', dotState(tree) === 'checking', dotState(tree))

  // The sweep the flag came from: the host answers at once and keeps working, so
  // the panel has to follow it down `pending`.
  const sweep = nodesWhere(tree, (node) => node.type === 'button').find((node) => textOf(node) === 'Проверить все')
  sweep.props.onClick()
  await view.pump()
  const post = view.requests.find((entry) => entry.method === 'POST')
  check('кнопка проверки отправила запрос', post !== undefined)
  post.answer({ ok: true, running: true, total: 1, done: 0, pending: 1, checking: ['openrouter\u0000glm-5.3-flash'], results: [] })
  tree = await view.pump()

  // The wait is the panel's own poll interval: the sweep ends on the host, and
  // the poll is how the browser hears about it.
  await new Promise((resolve) => setTimeout(resolve, 1300))
  await view.pump()
  const poll = view.requests.filter((entry) => entry.url === '/api/model-stats/liveness').at(-1)
  check('панель спросила хост о ходе проверки', poll !== undefined)

  const before = tableGets().length
  poll.answer({
    ok: true,
    running: false,
    total: 1,
    done: 1,
    pending: 0,
    checking: [],
    results: [{ provider: 'openrouter', model: 'glm-5.3-flash', status: 'ok', code: 'stop', checkedAt: probeAt, latencyMs: 400 }],
  })
  tree = await view.pump()

  check(
    'проверка кончилась — панель перезапрашивает строки, а не держит «проверяю…»',
    tableGets().length === before + 1,
    `GET: ${before} → ${tableGets().length}`,
  )
  check(
    'перезапрос задаёт тот же вопрос, что и раньше',
    tableGets().at(-1).url === tableGets()[0].url,
    `${tableGets()[0].url} → ${tableGets().at(-1).url}`,
  )

  tableGets().at(-1).answer(payload('ttft', [row('openrouter', 'glm-5.3-flash', { lastSeen: probeAt })]))
  tree = await view.pump()
  check('после ответа круг показывает результат, а не «проверяю…»', dotState(tree) === 'up', dotState(tree))
  check(
    'второго перезапроса нет: переход сработал один раз',
    tableGets().length === before + 1,
    `GET всего: ${tableGets().length}`,
  )
}

console.log('')
if (failures === 0) {
  console.log('ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ')
} else {
  console.log(`ПРОВАЛЕНО ПРОВЕРОК: ${failures}`)
  process.exitCode = 1
}
