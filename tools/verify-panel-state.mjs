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
import { PANEL_SORTS, resolveSelection } from '../lib/collect.js'
// The fold's own map of natural directions, compared below against the copy the
// bundle declares. The two cannot import each other (the client is a browser
// bundle with no module resolution into `lib/`), so they are pinned from here.
import { SORT_DIRECTIONS } from '../lib/fold.js'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

let failures = 0
function check(label, condition, detail) {
  const mark = condition ? 'OK  ' : 'FAIL'
  if (!condition) failures += 1
  console.log(`${mark} ${label}${detail ? ` — ${detail}` : ''}`)
}

// Parse before anything else, and before any fixture exists.
//
// The whole stylesheet is the value of a template literal — `const css = \`…\`` —
// so one backtick inside a CSS comment ends the literal early, the rest of the
// stylesheet is parsed as JavaScript, and `client.js` does not load at all: the
// Plugins page then says only that the plugin did not activate, and this suite
// used to abort deep inside the module loader with whatever case it happened to be
// running left unnamed. One parse of a file this tool is about to load anyway
// names the file and the line instead. It is not a substitute for the checks below
// (nothing else catches this if the file never loads) — it is the one that reports
// it first, in half a second and with no fixtures.
console.log('--- разбор самого файла панели ---')
try {
  new vm.Script(source, { filename: 'client.js' })
  check('client.js разбирается как скрипт', true, `${source.split('\n').length} строк`)
} catch (error) {
  check('client.js разбирается как скрипт', false, error.message)
  console.log('\nПРОВАЛЕНО ПРОВЕРОК: 1')
  process.exit(1)
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

/** The text a sighted reader sees in one cell: the hidden sentences are dropped.
 *
 * The walk is in document order — a node's own text children interleaved with the
 * text inside its element children — because the rating cell mixes the two: the
 * mark is an element and the figure is a bare string. A pre-order walk that
 * emitted a node's strings before descending into its children printed «72,2 ~»
 * for a cell that renders «~ 72,2», so it could not tell the two orders apart —
 * which is the one thing a check about this column has to be able to see.
 *
 * `columnCells` keeps the screen-reader text because most assertions want the
 * whole cell; the rating column is the one that carries a paragraph in a hidden
 * span, and a check about the printed figure has to read the figure. */
const visibleText = (node) => {
  const parts = []
  const collect = (n) => {
    if (n === null || n === undefined || typeof n !== 'object') return
    if (Array.isArray(n)) {
      for (const child of n) collect(child)
      return
    }
    if (String(n.props?.className ?? '').includes('dsh-ms-sr-only')) return
    for (const child of n.props?.children ?? []) {
      if (typeof child === 'string' || typeof child === 'number') parts.push(String(child))
      else collect(child)
    }
  }
  collect(node)
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

/** The model column of every rendered row, in order.
 *
 * It reads the name span and not the whole cell: the identity cell is also where
 * the expanded column set folds the route's own detail under the name, and a
 * helper that returned that paragraph would make every order assertion in this
 * file a comparison of prose. What the assertions mean by "the row" is the label
 * the reader sorts by. */
const rowLabels = (tree) => {
  const table = nodesWhere(tree, (node) => node.type === 'table')[0]
  if (table === undefined) return []
  const body = nodesWhere(table, (node) => node.type === 'tbody')[0]
  return (body?.props.children ?? [])
    .filter((child) => typeof child === 'object' && child?.type === 'tr')
    .map((row) => {
      const cell = row.props.children[0]
      const name = nodesWhere(
        cell,
        (node) => String(node.props?.className ?? '') === 'dsh-ms-model-name',
      )[0]
      return textOf(name ?? cell).replace(/\s+/g, ' ').trim()
    })
}

/** A button anywhere in the panel whose text contains `label`. */
const buttonWithText = (tree, label) =>
  nodesWhere(tree, (node) => node.type === 'button' && textOf(node).includes(label))[0]

/** The legend's own paragraph, the three halves as a reader receives them. */
const legendText = (tree) =>
  textOf(nodesWhere(tree, (node) => node.props?.className === 'dsh-ms-note')[0])

/** One cell as a node, for a check that needs its props and not only its text. */
const cellNode = (tree, key, index = 0) => {
  const head = nodesWhere(tree, (node) => node.type === 'thead')[0]
  const heading = (head?.props.children ?? []).flatMap((row) => row?.props?.children ?? [])
  const column = heading.findIndex((cell) => cell?.props?.key === key)
  if (column === -1) return null
  return bodyRows(tree)[index]?.props.children[column] ?? null
}

/** The `title` a cell offers on hover, which is where a rating's marks are spelled out. */
const cellTitle = (tree, key, index = 0) =>
  String(cellNode(tree, key, index)?.props.children?.[0]?.props?.title ?? '')

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

// --- the selection tree -------------------------------------------------------

const treeNodes = (tree) => nodesWhere(tree, (node) => String(node.props?.className ?? '').startsWith('dsh-ms-tree')) ?? []

/** The controls' summary line: the count, behind which the tree is folded. */
const filterSummary = (tree) => nodesWhere(tree, (node) => node.type === 'summary')[0]

/** The line that says how much of the catalog the table is about, or null. */
const modelsCount = (tree) =>
  nodesWhere(tree, (node) => node.props?.className === 'dsh-ms-models-count')[0] ?? null

/** Every provider row the tree offers, in the order it offers them. */
const treeParents = (tree) =>
  nodesWhere(tree, (node) => node.props?.className === 'dsh-ms-tree-parent')

/** Every model row the tree offers. */
const treeRows = (tree) => nodesWhere(tree, (node) => node.props?.className === 'dsh-ms-tree-row')

/** The name a tree row wears — the provider for a parent, the model for a child. */
const treeName = (node) =>
  (node.props.children.find((child) => String(child?.props?.className ?? '').startsWith('dsh-ms-tree-'))
    ?.props.children ?? []).join('')

const treeParent = (tree, provider) => treeParents(tree).find((node) => treeName(node) === provider)

/** The checkbox of a row — the first child, always. */
const treeCheck = (node) => node?.props.children[0] ?? null

/** The tooltip a tree row's name carries, or undefined when it carries none. */
const treeHint = (node) =>
  node?.props.children.find((child) => String(child?.props?.className ?? '').startsWith('dsh-ms-tree-name'))
    ?.props.title

/** The checkbox of one model, found by its full `provider\0model` value. */
const modelCheck = (tree, provider, model) =>
  treeCheck(treeRows(tree).find((node) => node.props.children[0]?.props?.value === `${provider}\u0000${model}`))

/** Every model checkbox that is ticked, as `provider/model`, sorted. */
const checkedModels = (tree) =>
  treeRows(tree)
    .filter((node) => node.props.children[0].props.checked === true)
    .map((node) => String(node.props.children[0].props.value).replace('\u0000', '/'))
    .sort()

/** The ticked models of one provider — what its own checkbox has to account for. */
const checkedModelsOf = (tree, provider) =>
  checkedModels(tree).filter((name) => name.startsWith(`${provider}/`))

/** The archive's own row in the panel, or null when there is none. */
const archiveRow = (tree) =>
  nodesWhere(tree, (node) => String(node.props?.className ?? '').includes('dsh-ms-filter-archive'))[0] ??
  null

/** Its checkbox — the first child of the row, as for a provider. */
const archiveCheck = (tree) => archiveRow(tree)?.props.children[0] ?? null

/** The tree's own search box. */
const treeSearch = (tree) => nodesWhere(tree, (node) => node.props?.className === 'dsh-ms-tree-search')[0] ?? null

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

// --- what was asked ---------------------------------------------------------------
//
// The panel asks its question in the body of a POST and no longer in the address: a
// selection is a rule document, which does not belong in a query string. So every
// check that used to compare a request line compares the body instead — and it
// compares the whole of it, because the point of these assertions is that one click
// asks one question and asks all of it.
const sentBody = (view, n) => {
  const request = view.requests[n]
  if (request === undefined || request.body === undefined || request.body === null) return null
  // The fake transport parses the body as it records it; a raw string is accepted
  // too, so the helper reads the same request whether it is driven through the fake
  // or through a real `fetch`.
  if (typeof request.body === 'object') return request.body
  try {
    return JSON.parse(request.body)
  } catch {
    return null
  }
}

/** What request `n` was, for the detail line of a failing check. */
const describe = (view, n) => {
  const request = view.requests[n]
  if (request === undefined) return `запроса ${n} нет`
  return `${request.method ?? 'GET'} ${request.url} ${JSON.stringify(request.body ?? null)}`
}

/** Whether request `n` is the panel's own question, asked exactly as `want` says. */
const askedFor = (view, n, want) => {
  const request = view.requests[n]
  if (request === undefined) return false
  if (request.method !== 'POST' || request.url !== '/api/model-scorecard/query') return false
  const body = sentBody(view, n)
  if (body === null) return false
  const expected = { view: 'model', limit: 200, archived: false, ...want }
  if (body.sort !== expected.sort || body.dir !== expected.dir) return false
  if (body.view !== expected.view || body.limit !== expected.limit) return false
  if (body.archived !== expected.archived) return false
  if (
    expected.selection !== undefined &&
    JSON.stringify(body.selection) !== JSON.stringify(expected.selection)
  ) {
    return false
  }
  return true
}

// --- fixtures ---------------------------------------------------------------

/** One panel row, with the fields the visible columns read. */
function row(provider, model, { steps = 1, ttftMedian = null, tpsMedian = null, errors = 0, lastSeen = 0, liveness = null, livenessChecking = false, archived = null, noStats = false, e2eTpsMedian = null, errorRate = null, retryRate = null, prefillShareMedian = null, rating = null, routeMetadata = null } = {}) {
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
    // The two figures the short column set scales beside the response: the
    // end-to-end rate and the errors per 100 steps. Absent from the host's payload
    // before those columns existed, so the fixture spells them out with `null`
    // rather than leaving them undefined — a bar is drawn from a measurement, and
    // "no measurement" is not `0`.
    e2eTpsMedian,
    errorRate,
    // And the two columns that ask for a bar the panel does not draw: they are here
    // so a case can prove the decision holds rather than that the fields are missing.
    retryRate,
    prefillShareMedian,
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
    // The two fields the compact set's verdict column and its disclosure read.
    // `null` on both is the shape a host that predates them sends, so a case that
    // wants a truly old payload deletes the fields instead of passing nothing.
    rating,
    routeMetadata,
  }
}

// The tree's catalog: the three providers of the fixture, one configured model
// nobody has run, and one whole provider the history has never seen. `noStats`
// entries are the reason a selection has to be a rule and not a list of pairs:
// they are in the tree before they are in any answer.
const CATALOG = [
  {
    provider: 'codex',
    models: [
      { model: 'gpt-6-astra', archived: false, noStats: false, steps: 106 },
      { model: 'gpt-6-mini', archived: false, noStats: true, steps: 0 },
    ],
  },
  { provider: 'local-uns', models: [{ model: 'Ornith-9B', archived: false, noStats: false, steps: 28 }] },
  { provider: 'openrouter', models: [{ model: 'glm-5.3-flash', archived: false, noStats: false, steps: 5 }] },
  { provider: 'ollama', models: [{ model: 'llama-local', archived: false, noStats: true, steps: 0 }] },
]

/** The rule a first open uses: measured models, no archive. */
const DEFAULT_SELECTION = {
  live: { base: 'measured', providers: {}, pairs: {} },
  archive: { base: 'none', providers: {}, pairs: {} },
}

/** One rule document, spelled out of the defaults so a case names only its delta. */
function rules({ base = 'measured', providers = {}, pairs = {}, archiveBase = 'none', archivePairs = {} } = {}) {
  return {
    live: { base, providers, pairs },
    archive: { base: archiveBase, providers: {}, pairs: archivePairs },
  }
}

/**
 * The cache key the panel writes for one question.
 *
 * Written out here rather than imported: the verifier drives the shipped client,
 * and a key built by the same function under test would agree with it by
 * construction — including when both are wrong about what a question is.
 */
function cacheKey(sort, dir, view, { selection = DEFAULT_SELECTION, archived = false, whole = false } = {}) {
  const base = `${sort}.${dir}|${view}|${JSON.stringify(selection)}`
  const named = archived === true ? `${base}|archive` : base
  return whole === true ? `${named}|all` : named
}

function payload(
  sort,
  rows,
  { providers = [], archive = null, noStats = null, catalog = CATALOG, selection = DEFAULT_SELECTION, coverage = null, truncated = false } = {},
) {
  return {
    ok: true,
    scanned: rows.length,
    skipped: 0,
    pending: 0,
    snapshotAt: 1_790_549_902_860,
    readNow: 0,
    reused: rows.length,
    totals: { steps: 10, errors: 0, models: rows.length, providers: [...new Set(rows.map((entry) => entry.provider))].length },
    sort,
    view: 'model',
    providers,
    shown: { models: rows.length, steps: rows.reduce((sum, r) => sum + r.steps, 0), errors: 0 },
    // What the archive holds under this filter, or `null` for a host that could
    // not read the configuration. The two are different answers and the panel
    // draws a different control for each.
    archive,
    // And how many rows of this answer come from the configuration with no
    // history behind them — `null` for that same unreadable host, which is the
    // one statement it has no standing to make either.
    noStats,
    // The tree the reader builds their selection in, and the rule document the
    // host applied to answer this question. Both are what the panel draws the
    // controls from, so a fixture that omitted them would test a tree with nothing
    // in it.
    catalog,
    selection,
    coverage,
    truncated,
    rows,
  }
}

/**
 * The payload the host sends for a question about some providers only.
 *
 * The rows are the selected ones and the echoed rule is what selected them: the
 * panel reads the echo, not the rows, to decide whether the table is a subset of
 * the history worth reporting in the footer.
 */
function filtered(sort, rows, names) {
  const providers = {}
  for (const name of names) providers[name] = 'all'
  return payload(sort, rows.filter((entry) => names.includes(entry.provider)), {
    selection: rules({ providers }),
  })
}

const byTtft = payload(
  'ttft',
  [
    row('local-uns', 'Ornith-9B', { steps: 28, ttftMedian: 46, tpsMedian: 0.5, lastSeen: 1000 }),
    row('openrouter', 'glm-5.3-flash', { steps: 5, ttftMedian: 985, tpsMedian: 32.2, lastSeen: 2000 }),
    row('codex', 'gpt-6-astra', { steps: 106, ttftMedian: 3500, tpsMedian: 34.7, lastSeen: 3000 }),
  ],
  {},
)
const bySpeed = payload(
  'speed',
  [
    row('codex', 'gpt-6-astra', { steps: 106, ttftMedian: 3500, tpsMedian: 34.7, lastSeen: 3000 }),
    row('openrouter', 'glm-5.3-flash', { steps: 5, ttftMedian: 985, tpsMedian: 32.2, lastSeen: 2000 }),
    row('local-uns', 'Ornith-9B', { steps: 28, ttftMedian: 46, tpsMedian: 0.5, lastSeen: 1000 }),
  ],
  {},
)

// --- mounting the real panel ------------------------------------------------

/**
 * Loads `client.js` into its own context and renders the bundle page it
 * registers. Every store and transport starts empty, so a case says exactly what
 * the panel already has before it is asked anything.
 *
 * `clock` freezes the panel's own `Date.now()`. It exists for the one rule that is
 * a comparison against the current time — the age mark on a rating — where a case
 * has to sit exactly on the boundary, and a real clock cannot be made to sit
 * anywhere: the fixture's `Date.now()` and the panel's are different instants, so
 * a case one millisecond from the threshold is a coin toss. Only the panel's clock
 * is frozen; the tool's own fixtures stay on the real one.
 */
function mountPanel({ entries = null, legacyStore = null, prefs = null, legacyPrefs = null, renamedPrefs = null, brokenStorage = false, instantDeadline = false, search = '', locale = null, clock = null } = {}) {
  const store = new Map()
  if (entries !== null) store.set('dsh-model-scorecard:v3', JSON.stringify({ entries }))
  // The store the previous build wrote, for the one case that asks what the panel
  // does when it finds one: a v2 entry answers the same question with rows that
  // have no rating in them, and serving it would print a column of dashes off an
  // answer nobody can tell apart from a current one. Never seed both — a panel
  // that found a v3 document would never look at the old key, and a case that
  // seeded both would be testing the other branch.
  if (legacyStore !== null) store.set('dsh-model-scorecard:v2', JSON.stringify(legacyStore))
  // State-machine scenarios exercise every sortable heading. Compact layout
  // has its own assertion below and explicitly opts out of the expanded set.
  // Either a v2 store or the one the previous build wrote — never both: a panel
  // that found a v2 document would never look at the old key, and a case that
  // seeded both would be testing the wrong branch.
  if (legacyPrefs !== null) store.set('dsh-model-scorecard:prefs:v1', JSON.stringify(legacyPrefs))
  // The same document under the name the package had before 2026-10-01, for the
  // one case that asks whether the reader's own sort, column set and selection
  // survive the namespace moving. Seeded alone: a panel that found the current
  // key would never read this one, and a case with both would test nothing.
  if (renamedPrefs !== null) store.set('dsh-model-stats:prefs:v2.selection', JSON.stringify({ version: 2, columnsAll: true, ...renamedPrefs }))
  // Never both a legacy key and the current one: a panel that finds a document
  // under the current key never looks at the others, and a case seeding both
  // would be testing a branch no reader can reach.
  else if (legacyPrefs === null) store.set('dsh-model-scorecard:prefs:v2.selection', JSON.stringify({ version: 2, columnsAll: true, ...prefs }))
  // A browser that refuses to store anything is a real case on a locked-down
  // profile, and the panel has to work in memory and say so.
  const storage = brokenStorage
    ? {
        getItem: () => null,
        removeItem: () => {},
        setItem: () => {
          throw new Error('storage is disabled')
        },
      }
    : {
        getItem: (key) => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => store.set(key, String(value)),
        removeItem: (key) => store.delete(key),
      }

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
    localStorage: storage,
    location: { search, href: `https://host/plugins${search}` },
    history: { replaceState: (_state, _title, url) => addresses.push(String(url)) },
  }
  // A frozen clock, when a case asks for one: `new Date(...)` still works (the
  // proxy only answers `now`), so a panel that formats a timestamp is unaffected.
  if (clock !== null) {
    sandbox.Date = new Proxy(Date, {
      get: (target, property, receiver) => (property === 'now' ? () => clock : Reflect.get(target, property, receiver)),
    })
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
  // The host's locale service, when a case asks for one. It is the smallest thing
  // that satisfies the two calls the panel makes — `register(namespace, tag, dict)`
  // at bind time and `bind(namespace)` for a translator — plus the active tag the
  // panel reads to pick a number format. Without it the panel keeps its own copy,
  // which is the branch every other case exercises.
  const dictionaries = {}
  const localeService =
    locale === null
      ? undefined
      : {
          register(namespace, tag, dict) {
            dictionaries[tag] = { ...(dictionaries[tag] ?? {}), [namespace]: dict }
          },
          bind(namespace) {
            return (key, params) => {
              const template = dictionaries[this.active]?.[namespace]?.[key] ?? key
              if (params === undefined) return template
              return template.replace(/\{(\w+)\}/g, (match, name) =>
                name in params ? String(params[name]) : match,
              )
            }
          },
          active: locale,
          getSnapshot: () => ({ active: locale }),
          subscribe: () => () => {},
        }
  mod.apply({
    get(name) {
      if (name === 'locale') return localeService
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
  if (definition.key !== 'dsh-model-scorecard') {
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
  // The compact set is seven columns wide. The rating was once paid for out of
  // «ош./100», which went behind «все метрики»; the reader's own verdict was that
  // the column had come back, a table that fits not owing a narrower one. Written
  // out as a list, not as a count, because the count is what stays true while a
  // column the reader never asked for replaces one they did.
  const view = mountPanel({ prefs: { columnsAll: false } })
  await view.pump()
  view.requests[0].answer(byTtft)
  const tree = await view.pump()
  check('краткий вид: статус, рейтинг, отклик, e2e и ош./100',
    headings(tree).map((th) => th.props.key).join(',') === 'name,liveness,rating,steps,ttft,e2e,errorRate',
    headings(tree).map((th) => th.props.key).join(','))
  // The compact set is a subset of the groups, not a group of its own: `ош./100`
  // shares its group with three error counts and `tok/s e2e med` shares its with
  // three throughput columns, so "one column of a group came back" must not drag
  // its neighbours out from behind the button with it.
  check('а соседи по группе остались за кнопкой', !headingFor(tree, 'tps') && !headingFor(tree, 'errors'))

  // The column draws its bar in the short set too — the bar is what makes a rate
  // readable down the page, and a scale that appears only after the reader presses
  // the button is a scale they have already looked past.
  const measured = payload('ttft', [
    row('codex', 'gpt-6-astra', { steps: 106, ttftMedian: 3500, errorRate: 8 }),
    row('local-uns', 'Ornith-9B', { steps: 28, ttftMedian: 46, errorRate: 2 }),
  ], {})
  const bars = mountPanel({ prefs: { columnsAll: false } })
  await bars.pump()
  bars.requests[0].answer(measured)
  const withBars = await bars.pump()
  check('и полоска под ош./100 рисуется в кратком виде',
    barsOf(withBars, 'errorRate').join(',') === '100%,25%',
    JSON.stringify(barsOf(withBars, 'errorRate')))
}

// --- рейтинг: колонка, причина «-» и «Подробнее» -------------------------------
//
// The rating is the one column whose figure is a verdict, so what is asserted
// here is that the panel publishes it the way the host wrote it and explains
// every way it can be missing: one decimal through the shared formatter (a raw
// `toFixed` would print `72.2` in a Russian panel), a mark for a score whose
// evidence is thin and a second one for a score whose evidence has aged out, and
// a sentence for each of the four reasons a `-` can have.
console.log('')
console.log('--- рейтинг: одно число, четыре причины и «Подробнее» ---')

/** The width of the bar in each row of one column, or null where none is drawn. */
function barsOf(tree, key) {
  const head = nodesWhere(tree, (node) => node.type === 'thead')[0]
  const cells = (head?.props.children ?? []).flatMap((line) => line?.props?.children ?? [])
  const column = cells.findIndex((cell) => cell?.props?.key === key)
  if (column === -1) return []
  return bodyRows(tree).map((row) => {
    const scale = nodesWhere(
      row.props.children[column],
      (node) => node.props?.className === 'dsh-ms-scale',
    )[0]
    return scale?.props?.children?.[0]?.props?.style?.width ?? null
  })
}
{
  /** A published rating, in the shape `lib/rating.js` returns. */
  const rated = (score, { provisional = false, reason = null, anchor = Date.now() - 86_400_000 } = {}) => ({
    version: 'technical-v1',
    score,
    reason,
    provisional,
    anchor,
    qualifiedSamples: 24,
    answeredSamples: 26,
    excludedRetried: 2,
    excludedInterrupted: 1,
    effectiveSamples: 21.5,
    sessions: 4,
    coverage: 24 / 26,
    inputs: { tpsMedian: 41.25, ttftMedianMs: 3180, ttftP90Ms: 9420 },
    components: { throughput: 0.292, latency: 0.611, tailLatency: 0.614 },
  })
  const withRating = payload('ttft', [
    row('codex', 'gpt-6-astra', { steps: 106, ttftMedian: 3500, rating: rated(72.23415362384071, { provisional: true }) }),
    row('openrouter', 'glm-5.3-flash', { steps: 5, ttftMedian: 985, rating: rated(48.5) }),
    // The real null: a pair the history holds and never qualified a measurement
    // for. It is an object with a reason, not a missing field.
    row('local-uns', 'Ornith-9B', { steps: 28, ttftMedian: 46, rating: rated(null, { reason: 'insufficient_samples' }) }),
    // The other caveat, and the one a reader cannot see in the number: a score
    // whose newest usable measurement is forty days old. It keeps its score —
    // freshness is descriptive — and wears the age mark.
    row('codex', 'gpt-5-old', { steps: 40, ttftMedian: 2000, rating: rated(61, { anchor: Date.now() - 40 * 86_400_000 }) }),
  ], {})

  const view = mountPanel({ prefs: { columnsAll: true } })
  await view.pump()
  view.requests[0].answer(withRating)
  const tree = await view.pump()
  const cells = columnCells(tree, 'rating')
  // The visible figure, not the whole cell: the cell also carries its explanation
  // in a hidden span, which is the sentence a hover and a screen reader get.
  const printed = bodyRows(tree).map((row) => {
    const column = headings(tree).findIndex((th) => th.props.key === 'rating')
    return visibleText(row.props.children[column])
  })

  // 72.23415362384071 through `Intl.NumberFormat('ru', {1,1})` is «72,2»; the raw
  // value would have been «72.2», and the guide's own fixture calls for one digit.
  // The mark is printed before the figure, so a marked row's digits end in the
  // same column as an unmarked row's: this is the assertion that pins the order,
  // and it moved with the cell for that reason.
  check('рейтинг нарисован с одним знаком через форматтер панели', printed[0] === '~ 72,2', JSON.stringify(printed[0]))
  check('оценка без пометки — просто число', printed[1] === '48,5', JSON.stringify(printed[1]))
  check('нет рейтинга — прочерк, а не ноль', printed[2] === '-', JSON.stringify(printed[2]))
  // Forty days is past the 30 the formula's half-life uses, so the score is kept
  // and the age is marked: no freshness multiplier touches it (the host asserts
  // that side), and the reader is told the number describes the past.
  check('старый замер помечен, а оценка осталась', printed[3] === '* 61,0', JSON.stringify(printed[3]))
  check(
    'и подсказка к старому замеру объясняет пометку',
    textOf(bodyRows(tree)[3]).includes('самому новому подходящему замеру больше 30 дней'),
    textOf(bodyRows(tree)[3]).slice(-160),
  )
  check(
    'в «Подробнее» это сказано отдельной строкой',
    textOf(nodesWhere(tree, (node) => node.props?.className === 'dsh-ms-details')[3]).includes(
      'это оценка по истории, а не по свежим данным',
    ),
  )
  check(
    'клетка рейтинга — числовая клетка панели',
    cells.every(([, cls]) => cls === 'dsh-ms-num'),
    cells.map(([, cls]) => cls).join(' | '),
  )
  // The `-` of the third row carries its own sentence: four different facts can
  // put a dash in this column and the cell is the only place they are told apart.
  const third = bodyRows(tree)[2].props.children[headings(tree).findIndex((th) => th.props.key === 'rating')]
  check(
    'прочерк объяснён словами в самом столбце',
    textOf(third).includes('подходящих замеров 24, эффективных 21,5'),
    textOf(third),
  )
  // A bar under this figure would say "the best of the rows on screen", which is
  // not what a 0-100 score says. Asserted so the decision cannot quietly reverse.
  check(
    'под рейтингом полоски нет: 0–100 — его собственная шкала',
    nodesWhere(tree, (node) => node.props?.className === 'dsh-ms-scale').length > 0 &&
      barsOf(tree, 'rating').every((width) => width === null),
    JSON.stringify(barsOf(tree, 'rating')),
  )
  // Where the age mark starts, and not only that it appears. The row above is forty
  // days old; this pins the boundary exactly, because the report draws the same mark
  // from the same rule and the two surfaces cannot disagree about the row that sits
  // on it — the comparison is strict `>`, so a measurement exactly one half-life old
  // is not yet stale. The panel's clock is frozen for these two mounts and the
  // fixture is placed relative to that frozen instant, which is the only way to sit
  // exactly on the boundary: `Date.now()` twice is two different numbers.
  const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000
  const FROZEN = 1_800_000_000_000
  const cellAtAge = async (ageMs) => {
    const view = mountPanel({ prefs: { columnsAll: true }, clock: FROZEN })
    await view.pump()
    view.requests[0].answer(
      payload('ttft', [
        row('codex', 'gpt-6-astra', {
          steps: 10,
          ttftMedian: 2000,
          rating: rated(61, { anchor: FROZEN - ageMs }),
        }),
      ], {}),
    )
    const tree = await view.pump()
    const column = headings(tree).findIndex((th) => th.props.key === 'rating')
    return visibleText(bodyRows(tree)[0].props.children[column])
  }
  const onBoundary = await cellAtAge(HALF_LIFE_MS)
  const oneMsOver = await cellAtAge(HALF_LIFE_MS + 1)
  check(
    'ровно на пороге полураспада замер ещё не помечен',
    onBoundary === '61,0',
    onBoundary,
  )
  check('а на миллисекунду старше — помечен, и оценка та же', oneMsOver === '* 61,0', oneMsOver)
}

{
  // The host has answered this question with a rating in every row since stage 4,
  // but a payload from a build that predates the column has no `rating` at all and
  // a payload that lost the field has `null`. Both are `-`, neither is a crash,
  // and the detail block says which route information it has instead of inventing
  // zeroes for a context window.
  const legacy = (entry) => {
    const copy = { ...entry }
    delete copy.rating
    delete copy.routeMetadata
    return copy
  }
  const old = payload('ttft', [
    legacy(row('codex', 'gpt-6-astra', { steps: 106, ttftMedian: 3500 })),
    row('openrouter', 'glm-5.3-flash', { steps: 5, ttftMedian: 985, rating: null, routeMetadata: null }),
  ], {})
  const view = mountPanel({ entries: { [cacheKey('ttft', 'asc', 'model')]: { at: Date.now(), data: old } }, prefs: { columnsAll: true } })
  let tree = view.render()
  const printed = () =>
    bodyRows(tree).map((row) => {
      const column = headings(tree).findIndex((th) => th.props.key === 'rating')
      return visibleText(row.props.children[column])
    })
  check(
    'старый ответ без поля rating рисует прочерки и не падает',
    hasTable(tree) && printed().length === 2 && printed().every((value) => value === '-'),
    JSON.stringify(printed()),
  )
  check(
    'и «Подробнее» говорит, что о маршруте ничего не известно',
    text(tree).includes('сведения о маршруте недоступны: DSH ничего не отдал об этой паре'),
    text(tree).slice(0, 160),
  )
  // A failed refresh keeps the rows that are on screen — including, now, their
  // rating column — and keeps asking the selection the reader made. The failure
  // case is asserted in full further down; this is the same rule seen from the
  // one column that has to survive it.
  sortButton(tree, 'rating').props.onClick()
  tree = await view.pump()
  check(
    'щелчок по заголовку рейтинга просит порядок по рейтингу начиная с лучших',
    askedFor(view, 1, { sort: 'rating', dir: 'desc', selection: DEFAULT_SELECTION }),
    describe(view, 1),
  )
  view.requests[1].answer({ ok: false, error: 'boom' }, 500)
  tree = await view.pump()
  check(
    'сорванный запрос оставляет строки с их рейтингом на экране',
    hasTable(tree) && rowLabels(tree).length === 2 && printed().every((value) => value === '-'),
    rowLabels(tree).join(' | '),
  )
  check(
    'и панель говорит, что показывает прежний ответ',
    text(tree).includes('Показаны строки прежнего запроса'),
    text(tree).slice(0, 160),
  )
}

{
  // The rating heading is a real control, and the second click is the reversal
  // like every other column's: the host's own direction for this key is `desc`,
  // and the echo of the answer decides which arrow is drawn.
  const ranked = payload('rating', [
    row('codex', 'gpt-6-astra', { steps: 106, ttftMedian: 3500, rating: { version: 'technical-v1', score: 72.2, reason: null, provisional: false, qualifiedSamples: 24, sessions: 4 } }),
    row('openrouter', 'glm-5.3-flash', { steps: 5, ttftMedian: 985, rating: { version: 'technical-v1', score: 48.5, reason: null, provisional: false, qualifiedSamples: 24, sessions: 4 } }),
  ], {})
  const view = mountPanel({ entries: { [cacheKey('ttft', 'asc', 'model')]: { at: Date.now(), data: byTtft } } })
  let tree = await view.pump()
  check('до щелчка столбец рейтинга не сортирует', ariaSort(tree, 'rating') === 'none')
  sortButton(tree, 'rating').props.onClick()
  tree = await view.pump()
  check('рейтинг спрошен по убыванию — сверху лучшие', askedFor(view, 1, { sort: 'rating', dir: 'desc' }), describe(view, 1))
  view.requests[1].answer(ranked)
  tree = await view.pump()
  check('заголовок рейтинга объявляет порядок экрана', ariaSort(tree, 'rating') === 'descending', String(ariaSort(tree, 'rating')))
  sortButton(tree, 'rating').props.onClick()
  tree = await view.pump()
  check('повторный щелчок разворачивает порядок', askedFor(view, 2, { sort: 'rating', dir: 'asc' }), describe(view, 2))
  view.requests[2].answer({ ...ranked, dir: 'asc' })
  tree = await view.pump()
  check('и объявляет обратный', ariaSort(tree, 'rating') === 'ascending', String(ariaSort(tree, 'rating')))
  check(
    'порядок рейтинга сохранён в настройках, как любой другой',
    view.store.get('dsh-model-scorecard:prefs:v2.selection')?.includes('"sort":"rating"') &&
      view.store.get('dsh-model-scorecard:prefs:v2.selection')?.includes('"dir":"asc"'),
    view.store.get('dsh-model-scorecard:prefs:v2.selection'),
  )
}

{
  // «Подробнее» is the table's one disclosure. It is a native `details` with a
  // `summary` as its first child — which is what gives a keyboard Enter and Space
  // for free — and not a click-handled div, because the explanation of the one
  // verdict in the row must not be mouse-only. The route's declared reference data
  // is inside it, and the default output cap is labelled as a default.
  const route = {
    source: 'dsh-adapter',
    checkedAt: Date.now() - 60_000,
    contextWindow: 1_048_576,
    defaultMaxTokens: 8192,
    inputModalities: ['text', 'image'],
    reasoningEfforts: [{ id: 'high', name: 'High' }, { id: 'low', name: 'Low' }],
    defaultReasoningEffort: 'high',
  }
  const enriched = payload('ttft', [
    row('codex', 'gpt-6-astra', {
      steps: 106,
      ttftMedian: 3500,
      rating: {
        version: 'technical-v1', score: 72.23415362384071, reason: null, provisional: true,
        anchor: Date.now() - 3_600_000, qualifiedSamples: 24, answeredSamples: 26,
        excludedRetried: 2, excludedInterrupted: 1, effectiveSamples: 21.5, sessions: 4,
        coverage: 24 / 26,
        inputs: { tpsMedian: 41.25, ttftMedianMs: 3180, ttftP90Ms: 9420 },
        components: { throughput: 0.292, latency: 0.611, tailLatency: 0.614 },
      },
      routeMetadata: route,
    }),
    // The adapter answered and declares nothing: the panel says so per field
    // rather than borrowing the sibling row's context window.
    row('openrouter', 'glm-5.3-flash', {
      steps: 5,
      ttftMedian: 985,
      rating: { version: 'technical-v1', score: 40, reason: null, provisional: false, anchor: null, qualifiedSamples: 12, answeredSamples: 12, excludedRetried: 0, excludedInterrupted: 0, effectiveSamples: 12, sessions: 2, coverage: 1, inputs: {}, components: {} },
      routeMetadata: { source: 'dsh-adapter', checkedAt: Date.now(), contextWindow: null, defaultMaxTokens: null, inputModalities: null, reasoningEfforts: null, defaultReasoningEffort: null },
    }),
  ], {})

  const view = mountPanel({ prefs: { columnsAll: true } })
  await view.pump()
  view.requests[0].answer(enriched)
  const tree = await view.pump()
  const blocks = nodesWhere(tree, (node) => node.props?.className === 'dsh-ms-details')
  check('в развёрнутом наборе у каждой строки один блок «Подробнее»', blocks.length === 2, `${blocks.length}`)
  check(
    'это настоящий details с summary первым ребёнком',
    blocks.every((block) => block.type === 'details' && block.props.children?.[0]?.type === 'summary'),
    blocks.map((block) => `${block.type}/${block.props.children?.[0]?.type}`).join(' | '),
  )
  check(
    'и summary не мышью единой: на нём нет обработчика, его открывает браузер',
    blocks.every((block) => block.props.children[0].props.onClick === undefined),
  )
  check(
    'сводка «Подробнее» видна в обоих языках словаря',
    view.mod.__test__.MESSAGES.ru['details.summary'] === 'Подробнее' &&
      view.mod.__test__.MESSAGES.en['details.summary'] === 'Details',
  )
  // The panel separates a figure from its unit with a non-breaking space on
  // purpose ("820 ms" must not wrap). These assertions are about which words and
  // numbers the block carries, not about that rule, so the separator is folded
  // into an ordinary space before comparing.
  const plain = (node) => textOf(node).replace(/\u00A0/g, ' ')
  const first = plain(blocks[0])
  check('в блоке — версия формулы и оценка', first.includes('рейтинг technical-v1: 72,2 из 100'), first.slice(0, 120))
  check('пометка «предварительная оценка» рядом со счётом', first.includes('предварительная оценка: выборка мала'))
  check(
    'счёт замеров, исключения и сессии',
    first.includes('подходящих замеров 24 из 26 ответов') &&
      first.includes('исключено: 2 с повторами, 1 прерванных (могут пересекаться)') &&
      first.includes('эффективных 21,5') &&
      first.includes('сессий 4'),
    first.slice(0, 220),
  )
  check('измерения, из которых сложился счёт', first.includes('взвешенные квантили, а не медианы столбцов: скорость 41,3 tok/s, отклик 3,2 s, отклик p90 9,4 s'), first.slice(0, 260))
  check('и множители формулы', first.includes('множители: скорость 0,29, отклик 0,61, хвост 0,61'))
  check(
    'объявленные маршрутом данные — с оговоркой про лимит по умолчанию',
    first.includes('контекст: 1 048 576') && first.includes('лимит ответа по умолчанию: 8 192') &&
      first.includes('вход: text, image') && first.includes('reasoning: High, Low — по умолчанию High'),
    first.slice(0, 340),
  )
  check('и пометка источника', first.includes('источник: адаптер DSH, спрошен'), first.slice(0, 380))
  check('цена и квоты названы неизвестными, а не нулём', first.includes('цена и квоты: неизвестны — DSH не отдаёт единых тарифных и квотных данных'))
  check('и оговорка о том, чего измерение не доказывает', first.includes('Отсутствие повторов не доказывает отсутствие сетевой задержки.'))
  const second = plain(blocks[1])
  check(
    'маршрут, объявивший пустоту, говорит «не объявлено» по каждому полю',
    second.includes('контекст: не объявлено') && second.includes('лимит ответа по умолчанию: не объявлено'),
    second.slice(0, 220),
  )
  // A compact table is one line per row, so the disclosure belongs to the column
  // set that has room for it — and the legend is what says where it went.
  const compact = mountPanel({ entries: { [cacheKey('rating', 'desc', 'model')]: { at: Date.now(), data: enriched } }, prefs: { columnsAll: false, sort: 'rating', dir: 'desc' } })
  const compactTree = compact.render()
  check(
    'в кратком наборе блока нет, а легенда говорит, где он',
    nodesWhere(compactTree, (node) => node.props?.className === 'dsh-ms-details').length === 0 &&
      text(compactTree).includes('под названием модели появляется «Подробнее»'),
    text(compactTree).slice(-200),
  )
}

{
  // The panel is written once and rendered in whichever locale the host's service
  // answers, so the new copy is rendered in English too — through a real locale
  // service, not by reading the dictionary: a key the panel asks for through the
  // service and a key it asks for from its own fallback are two different code
  // paths, and only one of them was exercised until now.
  const route = {
    source: 'dsh-adapter', checkedAt: Date.now(), contextWindow: 262_144,
    defaultMaxTokens: 4096, inputModalities: ['text'],
    reasoningEfforts: [{ id: 'medium', name: 'Medium' }], defaultReasoningEffort: 'medium',
  }
  const en = payload('rating', [
    row('codex', 'gpt-6-astra', {
      steps: 106, ttftMedian: 3500,
      rating: { version: 'technical-v1', score: 72.23415362384071, reason: null, provisional: false, anchor: Date.now(), qualifiedSamples: 24, answeredSamples: 26, excludedRetried: 2, excludedInterrupted: 1, effectiveSamples: 21.5, sessions: 4, coverage: 24 / 26, inputs: { tpsMedian: 41.25, ttftMedianMs: 3180, ttftP90Ms: 9420 }, components: { throughput: 0.292, latency: 0.611, tailLatency: 0.614 } },
      routeMetadata: route,
    }),
  ], {})
  const view = mountPanel({ entries: { [cacheKey('rating', 'desc', 'model')]: { at: Date.now(), data: en } }, prefs: { columnsAll: true, sort: 'rating', dir: 'desc' }, locale: 'en' })
  const tree = view.render()
  check('английский рейтинг — с точкой, как в en', columnCells(tree, 'rating')[0]?.[0].startsWith('72.2'), JSON.stringify(columnCells(tree, 'rating')))
  check(
    'и подпись столбца английская',
    textOf(sortButton(tree, 'rating')).replace(/[▲▼]/g, '').trim() === 'rating',
    headingText(headingFor(tree, 'rating')).slice(0, 80),
  )
  const body = text(tree)
  check('и «Подробнее» — «Details»', body.includes('Details'), body.slice(0, 80))
  check('с английскими словами о маршруте и цене', body.includes('default output cap: 4,096') && body.includes('price and quotas: unknown'))
}

// --- легенда называет то, что печатает таблица --------------------------------
//
// Рейтинг — один из семи столбцов краткого набора (`CORE_COLUMNS`), и его клетка
// печатает `~` и `*` рядом с числом. Определения этих двух знаков жили в
// `note.extra` — в той половине легенды, которая читается только с открытыми «все
// метрики», — так что читатель, который эту кнопку ни разу не нажал, видел в
// столбце, с которого таблица начинается, два знака и не встречал ни одного из
// них в легенде. Теперь легенда собирает эту фразу из тех же двух ключей
// словаря, что печатает подсказка самой клетки, и проверяется поэтому на
// тождество, а не на пересказ: половина легенды и есть подсказка.
//
// Три утверждения на язык, и краткий набор проверяется первым: именно его
// половина читается всегда.
{
  const marked = row('codex', 'gpt-6-astra', {
    steps: 12, ttftMedian: 3500,
    rating: {
      version: 'technical-v1', score: 64.2, reason: null, provisional: true,
      // 40 дней назад: старше 30, значит `*` печатается вместе с `~`, и у клетки
      // есть обе фразы, с которыми сравнивается легенда.
      anchor: Date.now() - 40 * 24 * 60 * 60 * 1000,
      qualifiedSamples: 11, answeredSamples: 12, excludedRetried: 1, excludedInterrupted: 0,
      effectiveSamples: 10.5, sessions: 2, coverage: 11 / 12,
      inputs: { tpsMedian: 38, ttftMedianMs: 3500, ttftP90Ms: 9000 },
      components: { throughput: 0.3, latency: 0.6, tailLatency: 0.6 },
    },
  })
  const data = payload('rating', [marked], {})
  const cache = { [cacheKey('rating', 'desc', 'model')]: { at: Date.now(), data } }
  // Легенда свёрнута `hidden`, пока её не попросили, и `legendText` читает ровно то,
  // что читатель получает, нажав «Как читать таблицу».
  const mount = (columnsAll, locale = null) =>
    mountPanel({ entries: cache, prefs: { columnsAll, sort: 'rating', dir: 'desc' }, locale }).render()

  for (const [language, locale, defines] of [
    ['ru', null, 'техническая оценка пары'],
    ['en', 'en', 'technical score'],
  ]) {
    const tree = mount(false, locale)
    // Подсказка клетки — это «{счёт} · {~} · {*}», и последние две части и есть
    // определения знаков на этом языке: сравнивать легенду надо с ними, а не с их
    // копией здесь, — иначе проверка прошла бы, разойдясь с подсказкой.
    const sentences = cellTitle(tree, 'rating').split(' · ').slice(1)
    const compact = legendText(tree)
    const expanded = legendText(mount(true, locale))
    check(`${language}: у клетки рейтинга обе фразы знаков в подсказке`, sentences.length === 2, sentences.join(' | '))
    check(
      `${language}: краткая легенда называет оба знака`,
      compact.includes('~') && compact.includes('*') && sentences.every((sentence) => compact.includes(sentence)),
      compact.slice(-260),
    )
    check(
      `${language}: и расширенная легенда — теми же фразами`,
      sentences.every((sentence) => expanded.includes(sentence)),
      expanded.slice(-260),
    )
    check(
      `${language}: краткая легенда объясняет сам столбец рейтинга`,
      compact.includes(defines),
      compact.slice(-260),
    )
  }
}

// --- полоска под числом ------------------------------------------------------
//
// The bar is the panel's own way of saying "this column is a scale": the largest
// value on screen is the full width and every other row is its share. What is
// asserted here is the rule and not one column's rendering: the metric named by
// the column decides the width, a figure the host did not measure draws nothing,
// and one row alone has nothing to be a share of.
//
// The case runs in the expanded column set because that is where the two columns
// it also asserts on live: `ретраи` and `префилл` are behind the button, and the
// case proves they draw no bar. `ош./100` came back to the compact set, and a
// column's bar is asserted in both sets rather than only in the wider one — the
// short-set case above draws it there.
console.log('')
console.log('--- полоска под числом: доля от наибольшего в столбце ---')
{
  const measured = payload('ttft', [
    row('codex', 'gpt-6-astra', { steps: 106, ttftMedian: 3500, e2eTpsMedian: 40, errorRate: 8 }),
    row('local-uns', 'Ornith-9B', { steps: 28, ttftMedian: 46, e2eTpsMedian: 5, errorRate: 2 }),
    // The slowest response, the fastest end-to-end rate and the worst error rate in
    // one row, so three different columns cannot be read off one another: a bar that
    // used the wrong metric would show up in the widths below.
    row('openrouter', 'glm-5.3-flash', { steps: 5, ttftMedian: 985, e2eTpsMedian: 80, errorRate: 16 }),
  ], {})
  const view = mountPanel({ prefs: { columnsAll: true } })
  await view.pump()
  view.requests[0].answer(measured)
  const tree = await view.pump()

  /** The rendered cell of one column of one row. */
  const cellAt = (key, index) => {
    const head = nodesWhere(tree, (node) => node.type === 'thead')[0]
    const cells = (head?.props.children ?? []).flatMap((line) => line?.props?.children ?? [])
    const column = cells.findIndex((cell) => cell?.props?.key === key)
    if (column === -1) throw new Error(`нет столбца ${key}`)
    return bodyRows(tree)[index].props.children[column]
  }
  /** The width of the bar in one cell, or null when the cell draws none. */
  const barWidth = (key, index) => {
    const scale = nodesWhere(cellAt(key, index), (node) => node.props?.className === 'dsh-ms-scale')[0]
    if (scale === undefined) return null
    const fill = nodesWhere(scale, (node) => node.props?.className === 'dsh-ms-scale-fill')[0]
    return fill?.props?.style?.width ?? null
  }
  const bars = (key) => [0, 1, 2].map((index) => barWidth(key, index))

  check('под откликом полоска осталась', bars('ttft').every((width) => width !== null), JSON.stringify(bars('ttft')))
  check(
    'отклик: самая медленная строка — самая длинная полоска',
    bars('ttft')[0] === '100%' && bars('ttft')[2] === '28%',
    JSON.stringify(bars('ttft')),
  )
  check(
    'под tok/s e2e med полоска появилась',
    bars('e2e').every((width) => width !== null),
    JSON.stringify(bars('e2e')),
  )
  check(
    'e2e: самая быстрая строка — самая длинная полоска',
    bars('e2e')[2] === '100%' && bars('e2e')[1] === '6%',
    JSON.stringify(bars('e2e')),
  )
  check(
    'под ошибками на 100 шагов полоска появилась',
    bars('errorRate').every((width) => width !== null),
    JSON.stringify(bars('errorRate')),
  )
  check(
    'ош./100: худшая строка — самая длинная полоска',
    bars('errorRate')[2] === '100%' && bars('errorRate')[1] === '13%',
    JSON.stringify(bars('errorRate')),
  )
  check(
    'шагов полоски не получил: это объём выборки, а не метрика',
    bars('steps').every((width) => width === null),
    JSON.stringify(bars('steps')),
  )
  check(
    'столбец слов «статус» полоски не получил',
    nodesWhere(cellAt('liveness', 0), (node) => node.props?.className === 'dsh-ms-scale').length === 0,
  )
}

{
  // A figure the host never measured is not a small one: `-` must draw nothing.
  const unmeasured = payload('ttft', [
    row('codex', 'gpt-6-astra', { ttftMedian: 3500 }),
    row('openrouter', 'glm-5.3-flash', { ttftMedian: 985 }),
  ], {})
  const view = mountPanel({ prefs: { columnsAll: false } })
  await view.pump()
  view.requests[0].answer(unmeasured)
  const tree = await view.pump()
  const head = nodesWhere(tree, (node) => node.type === 'thead')[0]
  const cells = (head?.props.children ?? []).flatMap((line) => line?.props?.children ?? [])
  const column = cells.findIndex((cell) => cell?.props?.key === 'e2e')
  const scale = nodesWhere(bodyRows(tree)[0].props.children[column], (node) => node.props?.className === 'dsh-ms-scale')
  check('неизмеренная величина полоски не рисует — «-» это не маленькое число', scale.length === 0, `${scale.length}`)
}

{
  // One row is nothing to be a share of, in every column at once.
  const single = payload('ttft', [
    row('codex', 'gpt-6-astra', { ttftMedian: 3500, e2eTpsMedian: 40, errorRate: 8 }),
  ], {})
  const view = mountPanel({ prefs: { columnsAll: false } })
  await view.pump()
  view.requests[0].answer(single)
  const tree = await view.pump()
  check(
    'одна строка — ни одной полоски ни в одном столбце',
    nodesWhere(tree, (node) => node.props?.className === 'dsh-ms-scale').length === 0,
    `${nodesWhere(tree, (node) => node.props?.className === 'dsh-ms-scale').length}`,
  )
}

{
  // The full column set draws its bars from the same table of maxima, and two
  // columns are deliberately not in that table: `ретраи` and `префилл`. Their cells
  // used to ask for a bar anyway and draw nothing, because the lookup missed — a
  // markup promise the table never kept. The calls are gone now, so this asserts the
  // decision rather than an accident of the lookup, and it stays here so the next
  // reader can tell "not asked for" from "silently stopped working".
  const scaled = payload('ttft', [
    row('codex', 'gpt-6-astra', { steps: 106, ttftMedian: 3500, e2eTpsMedian: 40, errorRate: 8, retryRate: 0.1 }),
    row('openrouter', 'glm-5.3-flash', { steps: 5, ttftMedian: 985, e2eTpsMedian: 80, errorRate: 0.1, retryRate: 0.4 }),
  ], {})
  const view = mountPanel({ prefs: { columnsAll: true } })
  await view.pump()
  view.requests[0].answer(scaled)
  const tree = await view.pump()
  const head = nodesWhere(tree, (node) => node.type === 'thead')[0]
  const cells = (head?.props.children ?? []).flatMap((line) => line?.props?.children ?? [])
  const barIn = (key, index) => {
    const column = cells.findIndex((cell) => cell?.props?.key === key)
    if (column === -1) throw new Error(`нет столбца ${key}`)
    return nodesWhere(bodyRows(tree)[index].props.children[column], (node) => node.props?.className === 'dsh-ms-scale').length
  }
  check(
    'столбец, которого нет в SCALED, полоски не рисует',
    barIn('retry', 0) === 0 && barIn('prefill', 0) === 0,
    `ретраи: ${barIn('retry', 0)}, префилл: ${barIn('prefill', 0)}`,
  )
  check(
    'а объявленные рисуют и в полном наборе',
    barIn('ttft', 0) === 1 && barIn('e2e', 0) === 1 && barIn('errorRate', 0) === 1,
    `ttft: ${barIn('ttft', 0)}, e2e: ${barIn('e2e', 0)}, ош./100: ${barIn('errorRate', 0)}`,
  )
}

console.log('--- переключение сортировки ---')

// --- 1: no cache, the answer arrives, then the sort is switched ---------------
{
  const view = mountPanel()
  let tree = await view.pump()
  check('до первого ответа таблицы нет, показан ход загрузки', !hasTable(tree) && text(tree).includes('Считаю статистику'))
  check('панель спросила сортировку по умолчанию', askedFor(view, 0, { sort: 'ttft', dir: 'asc' }), describe(view, 0))

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
  check('переключение сортировки запрошено у хоста', askedFor(view, 1, { sort: 'speed', dir: 'desc' }), describe(view, 1))
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
  const cached = { [cacheKey('ttft', 'asc', 'model')]: { at: Date.now(), data: byTtft } }
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
    [cacheKey('errors', 'desc', 'model')]: { at: Date.now(), data: { ...bySpeed, sort: 'errors' } },
  }
  const view = mountPanel({ entries, prefs: { sort: 'errors', view: 'model' } })
  const tree = await view.pump()
  check('сохранённая сортировка восстановлена', askedFor(view, 0, { sort: 'errors', dir: 'desc' }), describe(view, 0))
  check('кэшированный ответ отдан без ожидания', hasTable(tree))
  check('сохранённое направление показано стрелкой заголовка', ariaSort(tree, 'errors') === 'descending', headings(tree).map((th) => `${th.props.key}=${th.props['aria-sort']}`).join(' ') || '(заголовков нет)')
}
{
  const view = mountPanel({ prefs: { sort: 'nonsense', view: 'provider' } })
  view.render()
  check('испорченная сортировка не уходит на хост', askedFor(view, 0, { sort: 'ttft', dir: 'asc', view: 'provider' }), describe(view, 0))
}

console.log('\n--- выбор моделей: дерево ---')

// The selection is the same kind of question as the sort — a different answer from
// the host, and a different set of rows — so the contract of section 1 applies to it
// unchanged: a switch must never take the table off the screen, and the notice about
// a stale answer has to name the selection as well as the sort, or a table of every
// measured model is read as a table of the ones the reader asked for.
{
  const view = mountPanel()
  let tree = await view.pump()
  check(
    'первый запрос несёт правило по умолчанию, а не список пар',
    askedFor(view, 0, { sort: 'ttft', dir: 'asc', selection: DEFAULT_SELECTION }),
    describe(view, 0),
  )
  view.requests[0].answer(byTtft)
  tree = await view.pump()
  check('счётчик называет выбранное и весь каталог', textOf(modelsCount(tree)) === '3 из 5', textOf(modelsCount(tree)))
  check(
    'дерево предлагает всех, кого знает каталог, а не только строки таблицы',
    treeParents(tree).map(treeName).join() === 'codex,local-uns,openrouter,ollama',
    treeParents(tree).map(treeName).join(' | '),
  )
  check(
    'отмечены ровно замеренные пары, а настроенные без истории — нет',
    checkedModels(tree).join() === 'codex/gpt-6-astra,local-uns/Ornith-9B,openrouter/glm-5.3-flash',
    checkedModels(tree).join(' | '),
  )
  check(
    'каждая модель подписана полным идентификатором',
    treeRows(tree).every((node) => typeof node.props.children[0].props.value === 'string' && node.props.children[0].props.value.includes('\u0000')),
    treeRows(tree).length + ' строк',
  )
  check('провайдер показывает, сколько его моделей выбрано', textOf(treeParent(tree, 'codex')).includes('1 из 2 моделей'), textOf(treeParent(tree, 'codex')))
}

// --- the tri-state parent ------------------------------------------------------
// A group whose models are partly selected has to say so, and say it in a way that
// survives being read without colour: a real indeterminate control, an
// `aria-checked="mixed"` for a screen reader, a `data-state` a test can read, and
// the number of selected models beside the name.
{
  const view = mountPanel()
  let tree = await view.pump()
  view.requests[0].answer(byTtft)
  tree = await view.pump()
  const codex = treeParent(tree, 'codex')
  check('частичный провайдер помечен indeterminate', treeCheck(codex).props['aria-checked'] === 'mixed' && treeCheck(codex).props['data-state'] === 'partial', JSON.stringify({ aria: treeCheck(codex).props['aria-checked'], state: treeCheck(codex).props['data-state'] }))
  check('и числом выбранных моделей', textOf(codex).includes('1 из 2 моделей'), textOf(codex))
  const complete = treeParent(tree, 'local-uns')
  check('полный провайдер помечен выбранным', treeCheck(complete).props.checked === true && treeCheck(complete).props['data-state'] === 'all')
  const empty = treeParent(tree, 'ollama')
  check('пустой провайдер снят', treeCheck(empty).props.checked === false && treeCheck(empty).props['data-state'] === 'none')

  // The partial group goes to "all": a click has to be able to finish what the
  // reader started, and "all except one" is not a state a parent checkbox has.
  treeCheck(codex).props.onChange({})
  tree = await view.pump()
  check(
    'клик по частичному провайдеру выбирает его целиком правилом, а не перечислением',
    askedFor(view, 1, { sort: 'ttft', dir: 'asc', selection: rules({ providers: { codex: 'all' } }) }),
    describe(view, 1),
  )
  check('ответа ещё нет, а таблица на месте', view.requests[1].settled === false && hasTable(tree))
  view.requests[1].answer(byTtft)
  tree = await view.pump()
  check('и его модель без истории тоже выбрана', checkedModels(tree).includes('codex/gpt-6-mini'), checkedModels(tree).join(' | '))

  treeCheck(treeParent(tree, 'codex')).props.onChange({})
  tree = await view.pump()
  check(
    'второй клик по полному провайдеру снимает его целиком',
    askedFor(view, 2, { sort: 'ttft', dir: 'asc', selection: rules({ providers: { codex: 'none' } }) }),
    describe(view, 2),
  )

  // And from nothing it comes back as the measured part of the provider — the
  // third state, and the one a parent checkbox cannot show with `checked` alone.
  const cleared = treeParent(tree, 'codex')
  check('снятый провайдер читается как пустой, а не как частичный', treeCheck(cleared).props['data-state'] === 'none' && treeHint(cleared) === undefined, JSON.stringify({ state: treeCheck(cleared).props['data-state'], hint: treeHint(cleared) }))
  treeCheck(cleared).props.onChange({})
  tree = await view.pump()
  check(
    'третий клик по пустому провайдеру выбирает только измеренные, правилом, а не перечислением',
    askedFor(view, 3, { sort: 'ttft', dir: 'asc', selection: rules({ providers: { codex: 'measured' } }) }),
    describe(view, 3),
  )
  view.requests[3].answer(byTtft)
  tree = await view.pump()
  const measured = treeParent(tree, 'codex')
  check('измеренная модель выбрана, а модель без истории — нет', checkedModelsOf(tree, 'codex').join(' | ') === 'codex/gpt-6-astra', checkedModelsOf(tree, 'codex').join(' | '))
  check('такое правило названо, а не спрятано в количестве', treeCheck(measured).props['data-state'] === 'measured' && typeof treeHint(measured) === 'string', JSON.stringify({ state: treeCheck(measured).props['data-state'], hint: treeHint(measured) }))
  check('и рамка при этом остаётся настоящей indeterminate-рамкой', treeCheck(measured).props['aria-checked'] === 'mixed' && treeCheck(measured).props.checked === false, JSON.stringify({ aria: treeCheck(measured).props['aria-checked'], checked: treeCheck(measured).props.checked }))

  // The cycle is a loop: from the measured rule the first branch takes over again,
  // because that rule is not "all" and a group held by it is not full.
  treeCheck(measured).props.onChange({})
  tree = await view.pump()
  check(
    'четвёртый клик возвращает провайдера к «все» — цикл замкнут',
    askedFor(view, 4, { sort: 'ttft', dir: 'asc', selection: rules({ providers: { codex: 'all' } }) }),
    describe(view, 4),
  )
}

// --- a provider with no unmeasured model ---------------------------------------
// `measured` and `all` say the same thing about a group whose every model has been
// run, so the third state cannot be told from the first there. That is not a state
// the panel may fake: the cycle has to collapse to the two ends rather than invent
// a difference the reader cannot see.
{
  const view = mountPanel({ prefs: { selection: rules({ providers: { 'local-uns': 'measured' } }) } })
  let tree = await view.pump()
  view.requests[0].answer(byTtft)
  tree = await view.pump()
  const local = treeParent(tree, 'local-uns')
  check('измеренное правило на полностью измеренном провайдере — это «все»', treeCheck(local).props.checked === true && treeCheck(local).props['aria-checked'] === 'true', JSON.stringify({ checked: treeCheck(local).props.checked, aria: treeCheck(local).props['aria-checked'] }))
  check('но оно остаётся названным правилом, а не вычисленным частичным', treeCheck(local).props['data-state'] === 'measured' && typeof treeHint(local) === 'string', treeCheck(local).props['data-state'])
  treeCheck(local).props.onChange({})
  tree = await view.pump()
  check(
    'и клик по нему снимает всё, а не возвращает «все»',
    askedFor(view, 1, { sort: 'ttft', dir: 'asc', selection: rules({ providers: { 'local-uns': 'none' } }) }),
    describe(view, 1),
  )
}

// --- one model under a provider-wide rule --------------------------------------
// The exception is what makes a rule usable: "all of codex except the mini" has to
// be expressible, and expressible as one exception rather than as a list of every
// model of codex.
{
  const view = mountPanel({ prefs: { selection: rules({ providers: { codex: 'all' } }) } })
  let tree = await view.pump()
  view.requests[0].answer(byTtft)
  tree = await view.pump()
  check('правило провайдера восстановлено из настроек', treeCheck(treeParent(tree, 'codex')).props.checked === true)
  modelCheck(tree, 'codex', 'gpt-6-mini').props.onChange({})
  tree = await view.pump()
  check(
    'снятие одной модели записано исключением, а не отменой правила провайдера',
    askedFor(view, 1, {
      sort: 'ttft',
      dir: 'asc',
      selection: rules({ providers: { codex: 'all' }, pairs: { 'codex\u0000gpt-6-mini': 'off' } }),
    }),
    describe(view, 1),
  )
  view.requests[1].answer(byTtft)
  tree = await view.pump()
  check('провайдер снова частичный', treeCheck(treeParent(tree, 'codex')).props['data-state'] === 'partial')
  modelCheck(tree, 'codex', 'gpt-6-mini').props.onChange({})
  tree = await view.pump()
  check(
    'возврат отметки убирает исключение, а не пишет обратное',
    askedFor(view, 2, { sort: 'ttft', dir: 'asc', selection: rules({ providers: { codex: 'all' } }) }),
    describe(view, 2),
  )
}

// --- select all and none ------------------------------------------------------
{
  const view = mountPanel()
  let tree = await view.pump()
  view.requests[0].answer(byTtft)
  tree = await view.pump()
  buttonWithText(tree, 'Выбрать все').props.onClick()
  tree = await view.pump()
  check(
    '«выбрать все» — это правило, а не список из пяти пар',
    askedFor(view, 1, { sort: 'ttft', dir: 'asc', selection: rules({ base: 'all' }) }),
    describe(view, 1),
  )
  view.requests[1].answer(byTtft)
  tree = await view.pump()
  check('и счётчик считает весь каталог', textOf(modelsCount(tree)) === '5 из 5', textOf(modelsCount(tree)))
  buttonWithText(tree, 'Снять все').props.onClick()
  tree = await view.pump()
  check(
    '«снять все» — пустое правило, а не пустая история',
    askedFor(view, 2, { sort: 'ttft', dir: 'asc', selection: rules({ base: 'none' }) }),
    describe(view, 2),
  )
  view.requests[2].answer(payload('ttft', [], { selection: rules({ base: 'none' }) }))
  tree = await view.pump()
  check('пустой выбор объяснён отдельно', text(tree).includes('Модели не выбраны'), text(tree).slice(0, 80))
  check('пустой выбор не зовёт поработать в сессии', !text(tree).includes('Поработайте в сессии'))
  buttonWithText(tree, 'Вернуть выбор по умолчанию').props.onClick()
  tree = await view.pump()
  check(
    'кнопка возврата ставит правило первого открытия',
    askedFor(view, 3, { sort: 'ttft', dir: 'asc', selection: DEFAULT_SELECTION }),
    describe(view, 3),
  )
}

// --- the search is navigation, not selection -----------------------------------
{
  const view = mountPanel()
  let tree = await view.pump()
  view.requests[0].answer(byTtft)
  tree = await view.pump()
  const before = view.requests.length
  treeSearch(tree).props.onChange({ target: { value: 'glm' } })
  tree = await view.pump()
  check('поиск не спрашивает хост заново', view.requests.length === before, `${view.requests.length} против ${before}`)
  check('поиск оставил одну строку', treeRows(tree).map(treeName).join() === 'glm-5.3-flash', treeRows(tree).map(treeName).join(' | '))
  check(
    'поиск не тронул отметку найденной модели',
    checkedModels(tree).join() === 'openrouter/glm-5.3-flash',
    checkedModels(tree).join(' | ') || '(строк в дереве нет)',
  )
  buttonWithText(tree, 'Выбрать все').props.onClick()
  tree = await view.pump()
  check(
    'групповое действие под поиском действует на весь доступный набор',
    askedFor(view, before, { sort: 'ttft', dir: 'asc', selection: rules({ base: 'all' }) }),
    describe(view, before),
  )
}

// --- the stored selection, and the store that was there before it ---------------
{
  const first = mountPanel()
  let tree = await first.pump()
  first.requests[0].answer(byTtft)
  tree = await first.pump()
  buttonWithText(tree, 'Снять все').props.onClick()
  tree = await first.pump()
  const stored = JSON.parse(first.store.get('dsh-model-scorecard:prefs:v2.selection'))
  check('выбор записан под версионированным ключом с версией', stored.version === 2, first.store.get('dsh-model-scorecard:prefs:v2.selection'))
  check(
    'и записанный выбор — правило, а не пары',
    JSON.stringify(stored.selection) === JSON.stringify(rules({ base: 'none' })),
    JSON.stringify(stored.selection),
  )

  // The same document, read back by a second panel: what survives a closed tab is
  // the rule, and the rule is what the next request carries.
  const second = mountPanel({ prefs: { ...stored } })
  second.render()
  check(
    'выбор переживает повторное открытие вкладки',
    askedFor(second, 0, { sort: 'ttft', dir: 'asc', selection: rules({ base: 'none' }) }),
    describe(second, 0),
  )
}
{
  // A v1 store kept a provider filter. It is a choice the reader made, so it is
  // migrated once — and an *empty* filter keeps meaning "no filter", never
  // "nothing selected", which is how a first open would otherwise come up blank for
  // everyone who never touched that control.
  const view = mountPanel({ legacyPrefs: { providers: ['codex', 'openrouter'], sort: 'errors', columnsAll: true } })
  view.render()
  check(
    'старый фильтр провайдеров переехал в правила',
    askedFor(view, 0, {
      sort: 'errors',
      dir: 'desc',
      selection: rules({ providers: { codex: 'all', openrouter: 'all' } }),
    }),
    describe(view, 0),
  )
  check('и записан под новым ключом', JSON.parse(view.store.get('dsh-model-scorecard:prefs:v2.selection')).version === 2)
}
{
  const view = mountPanel({ legacyPrefs: { providers: [] } })
  view.render()
  check(
    'пустой старый фильтр — это «без фильтра», а не «ничего не выбрано»',
    askedFor(view, 0, { sort: 'ttft', dir: 'asc', selection: DEFAULT_SELECTION }),
    describe(view, 0),
  )
}
{
  // The package rename moved the `localStorage` key with it. The document under
  // the old key is the reader's own work — a sort, a column set, a rule about
  // which models the table is about — so it is adopted once and written down
  // under the new key, and the old key is left where it is: a reader who rolls
  // the plugin back must find what they left.
  const view = mountPanel({ renamedPrefs: { sort: 'speed', view: 'provider', selection: rules({ providers: { codex: 'none' } }) } })
  view.render()
  check(
    'состояние панели из старого пространства имён применено',
    askedFor(view, 0, { sort: 'speed', dir: 'desc', view: 'provider', selection: rules({ providers: { codex: 'none' } }) }),
    describe(view, 0),
  )
  const adopted = JSON.parse(view.store.get('dsh-model-scorecard:prefs:v2.selection'))
  check('и переписано под текущим ключом', adopted.sort === 'speed' && adopted.view === 'provider', JSON.stringify(adopted.selection))
  check('старый ключ остался на месте', view.store.get('dsh-model-stats:prefs:v2.selection') !== null)
}
{
  // A corrupt rule document is not a question: only a document this panel can read
  // reaches the host, and what it cannot read falls back to the rule of a first open.
  const view = mountPanel({ prefs: { selection: { live: { base: 'nonsense', pairs: 'twenty' }, archive: 5 } } })
  view.render()
  check(
    'испорченные правила не уходят на хост',
    askedFor(view, 0, { sort: 'ttft', dir: 'asc', selection: DEFAULT_SELECTION }),
    describe(view, 0),
  )
}
{
  // The cache is keyed by the whole question, so an answer about one selection is
  // never shown for another one.
  const entries = { [cacheKey('ttft', 'asc', 'model')]: { at: Date.now(), data: byTtft } }
  const view = mountPanel({ entries, prefs: { selection: rules({ base: 'none' }) } })
  const tree = view.render()
  check('кэш чужого выбора не отдан', !hasTable(tree), rowLabels(tree).join(' | ') || '(таблицы нет)')
}
{
  const entries = { [cacheKey('ttft', 'asc', 'model')]: { at: Date.now(), data: byTtft } }
  const view = mountPanel({ entries })
  const tree = view.render()
  check('а кэш своего выбора отдан сразу, без ожидания', hasTable(tree) && rowLabels(tree).length === 3, rowLabels(tree).join(' | '))
}
{
  // The response cache is versioned, the preferences are not. A v2 entry is a full
  // answer about the same pairs with no rating in any row, so it must not be
  // served — while the selection the reader built under v2 comes back exactly as
  // it was, because that is their decision and not a cache.
  const legacyStore = {
    entries: { [cacheKey('ttft', 'asc', 'model', { selection: rules({ base: 'none' }) })]: { at: Date.now(), data: byTtft } },
  }
  const view = mountPanel({ legacyStore, prefs: { selection: rules({ base: 'none' }) } })
  let tree = view.render()
  check('кэш прежней версии не отдан', !hasTable(tree), rowLabels(tree).join(' | ') || '(таблицы нет)')
  check(
    'и панель спрашивает заново, с тем же выбором',
    askedFor(view, 0, { sort: 'ttft', dir: 'asc', selection: rules({ base: 'none' }) }),
    describe(view, 0),
  )
  view.requests[0].answer(byTtft)
  tree = await view.pump()
  check('а ответ записан уже под новым ключом', Object.keys(JSON.parse(view.store.get('dsh-model-scorecard:v3')).entries).length === 1)
  check(
    'и старый документ панель не переписала',
    JSON.parse(view.store.get('dsh-model-scorecard:v2')).entries !== undefined,
  )
}

// --- the two views -------------------------------------------------------------
// The provider view does not drop the selection: a provider aggregate computed over
// every model of a provider would be an answer to a question the reader did not ask,
// and the plan's own case — one provider, two selected models — is exactly that.
{
  const view = mountPanel({ prefs: { selection: rules({ providers: { openrouter: 'all' } }) } })
  let tree = await view.pump()
  check('сохранённый выбор отправлен при открытии', askedFor(view, 0, { sort: 'ttft', dir: 'asc', selection: rules({ providers: { openrouter: 'all' } }) }), describe(view, 0))
  view.requests[0].answer(byTtft)
  tree = await view.pump()
  buttonWithText(tree, 'по моделям').props.onClick()
  tree = await view.pump()
  check(
    'в виде по провайдерам выбор уходит на хост, а не сбрасывается',
    askedFor(view, 1, { sort: 'ttft', dir: 'asc', view: 'provider', selection: rules({ providers: { openrouter: 'all' } }) }),
    describe(view, 1),
  )
  view.requests[1].answer({
    ...byTtft,
    view: 'provider',
    coverage: [{ provider: 'codex', selected: 1, total: 2 }],
    rows: [row('codex', null, { steps: 106, ttftMedian: 3500, tpsMedian: 34.7 })],
  })
  tree = await view.pump()
  check(
    'провайдерская строка говорит, сколько моделей в ней участвовало',
    text(tree).includes('1 из 2 моделей'),
    text(tree).slice(0, 120),
  )
  // A provider row has no single pair to rate, and the disclosure under its name
  // says exactly that instead of showing the components of a score that does not
  // exist. It is the same sentence the `-` in the rating column carries.
  check(
    'провайдерская строка объясняет, что рейтинг — про пару, а не про неё',
    text(tree).includes('Рейтинг считается для пары провайдер–модель, а эта строка — провайдер целиком'),
    text(tree).slice(-240),
  )
  buttonWithText(tree, 'по провайдерам').props.onClick()
  tree = await view.pump()
  check(
    'возврат к моделям вернул тот же выбор',
    askedFor(view, 2, { sort: 'ttft', dir: 'asc', selection: rules({ providers: { openrouter: 'all' } }) }),
    describe(view, 2),
  )
}

// What the panel keeps, read back out of the store the harness fakes: the entries
// by key, and how many bytes they are worth. Both are used by the two sections
// below, which are about one question being answered from another one's entry.
const padTo = (data, bytes) => ({ ...data, filler: 'x'.repeat(bytes) })
const cacheEntries = (view) => JSON.parse(view.store.get('dsh-model-scorecard:v3')).entries
const cacheBytes = (entries) =>
  Object.values(entries).reduce((sum, entry) => sum + JSON.stringify(entry).length, 0)

// --- the page the selection does not fit in ------------------------------------
// A table that shows part of the selection must say so, and must let the reader ask
// for the rest — a truncated answer read as the whole one is the failure this notice
// exists to prevent.
{
  const view = mountPanel()
  let tree = await view.pump()
  view.requests[0].answer(payload('ttft', byTtft.rows, { truncated: true, shown: { models: 9, steps: 40, errors: 0 } }))
  tree = await view.pump()
  check('усечение названо явно', text(tree).includes('Показаны'), text(tree).slice(0, 120))
  buttonWithText(tree, 'Показать все').props.onClick()
  tree = await view.pump()
  check('и есть чем попросить весь набор', askedFor(view, 1, { sort: 'ttft', dir: 'asc', limit: 2000 }), describe(view, 1))

  // The page is part of the question. Two thousand rows stored under the key for
  // two hundred would be served to the next open as that question's answer, and the
  // refresh behind it would take them away again — rows appearing and disappearing
  // from a table the reader never touched.
  // Six rows against the page's three, so the two entries are distinguishable by
  // what they hold: the harness builds `shown` from the rows, so a payload cannot
  // claim a count it does not carry.
  const everything = payload('ttft', [
    ...byTtft.rows,
    row('bulk', 'm-1', { steps: 3, ttftMedian: 1200, tpsMedian: 20 }),
    row('bulk', 'm-2', { steps: 4, ttftMedian: 1300, tpsMedian: 21 }),
    row('bulk', 'm-3', { steps: 5, ttftMedian: 1400, tpsMedian: 22 }),
  ])
  view.requests[1].answer(everything)
  tree = await view.pump()
  const entries = cacheEntries(view)
  const paged = entries[cacheKey('ttft', 'asc', 'model')]
  const whole = entries[cacheKey('ttft', 'asc', 'model', { whole: true })]
  check(
    'ответ «все» лежит рядом с ответом страницы, а не поверх него',
    // Identity is not available here — the harness round-trips an answer through
    // JSON on the way in — so the two entries are told apart by what they hold: the
    // page carries three rows and calls itself truncated, the whole answer six.
    paged !== undefined &&
      whole !== undefined &&
      paged.data?.shown?.models === 3 &&
      paged.data?.truncated === true &&
      whole.data?.shown?.models === 6 &&
      whole.data?.truncated === false,
    `${Object.keys(entries).join(' | ')} — на странице ${paged?.data?.shown?.models ?? '—'} строк, в «все» ${whole?.data?.shown?.models ?? '—'}`,
  )

  // And a store that holds only the whole answer cannot open the ordinary question.
  const onlyWhole = mountPanel({ entries: { [cacheKey('ttft', 'asc', 'model', { whole: true })]: { at: Date.now(), data: everything } } })
  const again = await onlyWhole.pump()
  check(
    'следующее открытие не рисует ответ на другой вопрос',
    rowLabels(again).length === 0,
    rowLabels(again).join(' | ') || '(пусто)',
  )
  check('и спрашивает обычную страницу', askedFor(onlyWhole, 0, { sort: 'ttft', dir: 'asc', limit: 200 }), describe(onlyWhole, 0))
}

// --- what the panel is willing to draw -----------------------------------------
//
// The answer may carry the whole selection — that is what the truncation notice and
// «Показать все» are for — and the table draws one page of it at a time. Measured in
// this tree, a row of the expanded set is 21 cells and ~55 element nodes, so 200 rows
// are ~11 200 nodes and 59 ms and the 2000 the host will send are ~110 200 and 302 ms
// before the browser has styled anything; `content-visibility` was measured as the
// alternative and buys ~2% of the layout. The window is what keeps the DOM a function
// of what the reader asked to look at.
{
  const bulk = (count) =>
    payload(
      'ttft',
      Array.from({ length: count }, (_, index) =>
        row('bulk', `m-${index}`, { steps: index + 1, ttftMedian: 900 + index, tpsMedian: 30 + index }),
      ),
      {},
    )
  const view = mountPanel()
  let tree = await view.pump()
  view.requests[0].answer(bulk(450))
  tree = await view.pump()
  check('таблица рисует страницу, а не весь ответ', rowLabels(tree).length === 200, `строк: ${rowLabels(tree).length}`)
  check(
    'и говорит, сколько из чего нарисовано',
    text(tree).includes('На экране первые 200 из 450 строк'),
    text(tree).slice(text(tree).indexOf('На экране'), text(tree).indexOf('На экране') + 60),
  )

  buttonWithText(tree, 'Ещё 200').props.onClick()
  tree = await view.pump()
  check('по кнопке дорисовывается следующая страница', rowLabels(tree).length === 400, `строк: ${rowLabels(tree).length}`)

  buttonWithText(tree, 'Ещё 50').props.onClick()
  tree = await view.pump()
  check('и последняя добирается остатком, а не целой страницей', rowLabels(tree).length === 450, `строк: ${rowLabels(tree).length}`)
  check('когда нарисовано всё, надписи нет', !text(tree).includes('На экране первые'), text(tree).slice(text(tree).indexOf('На экране'), text(tree).indexOf('На экране') + 40))

  // The window belongs to the question, not to the panel: another sort is another
  // answer, and it opens on its first page rather than on the previous one's depth.
  sortButton(tree, 'tps').props.onClick()
  tree = await view.pump()
  view.requests[1].answer(bulk(450))
  tree = await view.pump()
  check('другой вопрос начинается с первой страницы', rowLabels(tree).length === 200, `строк: ${rowLabels(tree).length}`)

  // Both languages, because the notice is the only thing that tells a reader their
  // table is short: a string that exists in one dictionary and not the other is a
  // reader looking at a bare key. The other half of the pair is the button, which is
  // the only way to see the rest.
  const english = mountPanel({ locale: 'en' })
  let en = await english.pump()
  english.requests[0].answer(bulk(450))
  en = await english.pump()
  check(
    'the notice and its control exist in English too',
    text(en).includes('The first 200 of 450 rows are drawn') &&
      buttonWithText(en, '200 more rows') !== undefined &&
      buttonWithText(en, '200 more rows') !== null,
    text(en).slice(text(en).indexOf('The first'), text(en).indexOf('The first') + 70),
  )
}

// --- what the browser may be asked to keep -------------------------------------
//
// The store is trimmed by bytes, not by keys: four keys was a policy when an entry
// was ~60 KB, and this panel's own answer measures 183 KB for 141 rows, so the page
// the reader can raise makes one entry ~2.5 MB where the default page makes ~260 KB.
// The answers below are padded rather than built from thousands of rows — what the
// panel measures is `JSON.stringify` of the entry, and the padding is what the
// policy is about.
{
  // Three old entries of 800 KB each: 2.4 MB, over the 2 MB budget before the new
  // answer is counted. The oldest must go first and the newest must stay.
  const old = {}
  // Three sorts, none of them the one the panel opens on: the answer below writes
  // `ttft`, so seeding it too would overwrite the padded entry under its own key and
  // leave the budget with nothing to decide.
  for (const [index, sort] of ['tps', 'errors', 'rating'].entries()) {
    old[cacheKey(sort, 'asc', 'model')] = {
      at: 1_700_000_000_000 + index * 1000,
      data: padTo(payload(sort, byTtft.rows), 800 * 1024),
    }
  }
  const view = mountPanel({ entries: old })
  await view.pump()
  view.requests[0].answer(payload('ttft', byTtft.rows))
  await view.pump()
  const entries = cacheEntries(view)
  check(
    'старый ответ вытесняется, а новый остаётся',
    entries[cacheKey('ttft', 'asc', 'model')] !== undefined &&
      entries[cacheKey('tps', 'asc', 'model')] === undefined &&
      entries[cacheKey('errors', 'asc', 'model')] !== undefined,
    Object.keys(entries).join(' | '),
  )
  check('и хранилище осталось в бюджете', cacheBytes(entries) <= 2 * 1024 * 1024, `${Math.round(cacheBytes(entries) / 1024)} KB`)
}
{
  // An answer larger than the whole budget is not stored at all — which is the
  // intended outcome, not a failure: it is asked for again, and the panel renders
  // without a cached one. The entry that was already there is left alone.
  const view = mountPanel({ entries: { [cacheKey('ttft', 'asc', 'model')]: { at: Date.now(), data: byTtft } } })
  let tree = await view.pump()
  view.requests[0].answer(payload('ttft', byTtft.rows, { truncated: true, shown: { models: 400, steps: 4000, errors: 0 } }))
  tree = await view.pump()
  buttonWithText(tree, 'Показать все').props.onClick()
  tree = await view.pump()
  view.requests[1].answer(padTo(payload('ttft', byTtft.rows), 3 * 1024 * 1024))
  tree = await view.pump()
  const entries = cacheEntries(view)
  check(
    'ответ больше бюджета не хранится вовсе',
    entries[cacheKey('ttft', 'asc', 'model', { whole: true })] === undefined &&
      entries[cacheKey('ttft', 'asc', 'model')] !== undefined,
    `${Object.keys(entries).join(' | ') || '(пусто)'} — ${Math.round(cacheBytes(entries) / 1024)} KB`,
  )
  check('и то, что поместилось, осталось целым', cacheBytes(entries) <= 2 * 1024 * 1024, `${Math.round(cacheBytes(entries) / 1024)} KB`)
  check('а таблица показана — кэш ей не нужен', rowLabels(tree).length === 3, rowLabels(tree).join(' | '))
}

console.log('\n--- архив: модели вне текущей конфигурации ---')

// The archive is a filter with one control, one default and one word. The host
// sends what it holds (`archive`) and grades every row it sends (`archived`); the
// panel's job is to keep the three honest — the default is off, the control is
// offered only where the host could grade at all, and a row that came back with
// the flag says out loud which kind it is.
const RETIRED = row('codex', 'gpt-6-astra', { steps: 106, ttftMedian: 3500, tpsMedian: 34.7, lastSeen: 3000, archived: true })
const withArchive = (rows, archive) => payload('ttft', rows, { archive })
{
  const view = mountPanel()
  let tree = await view.pump()
  view.requests[0].answer(withArchive(byTtft.rows, { rows: 1, steps: 106, shown: false }))
  tree = await view.pump()
  check('архив — отдельная отметка, а не место в дереве', archiveCheck(tree) !== null && treeParents(tree).length === 4, String(treeParents(tree).length))
  check('по умолчанию она снята', archiveCheck(tree)?.props.checked === false)
  check('в ней посчитано, что лежит в архиве', textOf(archiveRow(tree)).includes('штук: 1'), textOf(archiveRow(tree)))
  check('сводка про архив молчит, пока он выключен', !textOf(filterSummary(tree)).includes('архив'), textOf(filterSummary(tree)))
  check('подвал говорит, сколько строк держит архив', text(tree).includes('в архиве: 1'), text(tree).match(/в архиве[^·]*/)?.[0])
  check('ни одна строка не помечена архивной', nodesWhere(tree, (node) => node.props?.className === 'dsh-ms-archive').length === 0)

  archiveCheck(tree).props.onChange({})
  tree = await view.pump()
  check(
    'отметка уходит на хост одним флагом, не трогая выбор',
    askedFor(view, 1, { sort: 'ttft', dir: 'asc', archived: true, selection: DEFAULT_SELECTION }),
    describe(view, 1),
  )
  check('ТАБЛИЦА ОСТАЛАСЬ НА ЭКРАНЕ, пока ответ на архив в пути', hasTable(tree))
  check('уведомление называет и архив, а не только провайдеров', text(tree).includes('(архив)'), text(tree).slice(text(tree).indexOf(NOTICE), text(tree).indexOf(NOTICE) + 60))

  view.requests[1].answer(withArchive([RETIRED, ...byTtft.rows], { rows: 1, steps: 106, shown: true }))
  tree = await view.pump()
  check('ответ с архивом показан целиком', rowLabels(tree).length === 4, rowLabels(tree).join(' | '))
  check('архивная строка помечена словом', nodesWhere(tree, (node) => node.props?.className === 'dsh-ms-archive').length === 1)
  check('и только она', textOf(bodyRows(tree)[0]).includes('архив'), textOf(bodyRows(tree)[0]).slice(0, 60))
  check('сводка называет архив', textOf(filterSummary(tree)).includes('архив'), textOf(filterSummary(tree)))
  check('подвал не считает архив скрытым, когда он показан', !text(tree).includes('в архиве:'), text(tree).match(/в архиве[^·]*/)?.[0])
  check(
    'отметка записана в настройки панели',
    JSON.parse(view.store.get('dsh-model-scorecard:prefs:v2.selection')).archived === true,
    view.store.get('dsh-model-scorecard:prefs:v2.selection'),
  )
  // The question is no longer written into the address: a selection is a rule
  // document, and a rule document in a query string is either truncated or visible
  // to the host's page. The archive went with it, so one surface has one place to
  // remember what it asked.
  check('панель не трогает адрес', view.addresses.length === 0, view.addresses.join(' | ') || '(адрес не менялся)')
  check(
    'и кэш — под своим ключом, а не под ключом таблицы без архива',
    Object.keys(JSON.parse(view.store.get('dsh-model-scorecard:v3')).entries).some((key) => key.endsWith('|archive')),
    Object.keys(JSON.parse(view.store.get('dsh-model-scorecard:v3')).entries).join(' | '),
  )

  archiveCheck(tree).props.onChange({})
  tree = await view.pump()
  check('снятие отметки убирает архив из запроса', askedFor(view, 2, { sort: 'ttft', dir: 'asc' }), describe(view, 2))
}

// --- a provider that kept a model and retired another -------------------------
//
// One group, one row, one count — and a catalog whose models are in both scopes.
// The count beside the checkbox is the host's own over the whole group
// (`coverage`), so the click has to reach the whole group too. It used to guess one
// scope from the first archived model it found and write the rule there: the click
// changed fewer rows than the checkbox promised, and a second click started from a
// rule the reader had not set. Each model's own row had the same guess, so ticking
// one live model of such a group wrote an exception into a scope that never governs
// it and nothing happened.
const MIXED_CATALOG = [
  {
    provider: 'codex',
    models: [
      { model: 'gpt-6-astra', archived: false, noStats: false, steps: 106 },
      { model: 'gpt-6-retired', archived: true, noStats: false, steps: 40 },
      { model: 'gpt-6-mini', archived: false, noStats: true, steps: 0 },
    ],
  },
  { provider: 'openrouter', models: [{ model: 'glm-5.3-flash', archived: false, noStats: false, steps: 5 }] },
]
const MIXED_RETIRED = row('codex', 'gpt-6-retired', {
  steps: 40,
  ttftMedian: 4100,
  tpsMedian: 30.1,
  lastSeen: 900,
  archived: true,
})
/**
 * An answer to a mixed-catalog question, with the count the host would send.
 *
 * `coverage` is not written by hand: the panel reads the number beside a provider
 * straight out of it, so a fixture that pinned it would make the whole cycle — a
 * click, a count, the next click — test a number the case invented. The host's own
 * `resolveSelection` is asked instead, which is also the point of using it here:
 * the group action and the count it must satisfy are the same resolution read from
 * two sides, and the fixture reads it from the same side the host does.
 */
const mixedPayload = (rows, selection = DEFAULT_SELECTION) =>
  payload('ttft', rows, {
    archive: { rows: 1, steps: 40, shown: true },
    catalog: MIXED_CATALOG,
    selection,
    coverage: resolveSelection(selection, MIXED_CATALOG).providers,
  })
{
  const view = mountPanel()
  let tree = await view.pump()
  view.requests[0].answer(mixedPayload([...byTtft.rows, MIXED_RETIRED]))
  tree = await view.pump()
  // The archive is off for this case, so the host answers as if the group were
  // live-only — the mixed catalog only reaches the panel with the archive on, and
  // that is asserted next.
  check('смешанная группа нарисована одной строкой', treeParents(tree).length === 2, treeParents(tree).map(treeName).join(' | '))
  check(
    'и её счётчик — один на всю группу',
    textOf(treeParent(tree, 'codex')).includes('1 из 3 моделей'),
    textOf(treeParent(tree, 'codex')),
  )

  // With the archive on, the group spans both scopes: the click must write the same
  // rule into both, and the next request must say so.
  archiveCheck(tree).props.onChange({})
  tree = await view.pump()
  view.requests[1].answer(mixedPayload([...byTtft.rows, MIXED_RETIRED]))
  tree = await view.pump()
  check(
    'архивная половина появилась в дереве',
    checkedModelsOf(tree, 'codex').length === 1 && treeRows(tree).length === 4,
    checkedModelsOf(tree, 'codex').join(' | ') + ` (строк: ${treeRows(tree).length})`,
  )

  treeCheck(treeParent(tree, 'codex')).props.onChange({})
  tree = await view.pump()
  const written = view.requests[2]?.body?.selection ?? null
  check(
    'клик по группе пишет правило в обе половины',
    written?.live?.providers?.codex === 'all' && written?.archive?.providers?.codex === 'all',
    JSON.stringify(written),
  )
  view.requests[2].answer(mixedPayload([...byTtft.rows, MIXED_RETIRED], view.requests[2].body.selection))
  tree = await view.pump()
  check(
    'и группа после клика полная с обеих сторон',
    textOf(treeParent(tree, 'codex')).includes('3 из 3 моделей'),
    textOf(treeParent(tree, 'codex')),
  )

  // The next click reads the rule standing on the group, which is now in both
  // scopes: a cleared group must come back as its measured models, not as "all".
  treeCheck(treeParent(tree, 'codex')).props.onChange({})
  tree = await view.pump()
  view.requests[3].answer(mixedPayload([...byTtft.rows, MIXED_RETIRED], view.requests[3].body.selection))
  tree = await view.pump()
  const cleared = view.requests[3]?.body?.selection ?? null
  check('снятие группы пишет «ничего» в обе половины', cleared?.live?.providers?.codex === 'none' && cleared?.archive?.providers?.codex === 'none', JSON.stringify(cleared))
}

// --- a model's own row inside a mixed group ------------------------------------
{
  const view = mountPanel()
  let tree = await view.pump()
  view.requests[0].answer(mixedPayload([...byTtft.rows, MIXED_RETIRED]))
  tree = await view.pump()
  archiveCheck(tree).props.onChange({})
  tree = await view.pump()
  view.requests[1].answer(mixedPayload([...byTtft.rows, MIXED_RETIRED]))
  tree = await view.pump()

  const liveRow = modelCheck(tree, 'codex', 'gpt-6-mini')
  check('у своей строки есть чем щёлкнуть', liveRow !== null && liveRow !== undefined)
  liveRow?.props.onChange({})
  tree = await view.pump()
  const after = view.requests[2]?.body?.selection ?? null
  check(
    'отметка живой модели уходит в живую половину, а не в архивную',
    after?.live?.pairs?.['codex\u0000gpt-6-mini'] === 'on' &&
      after?.archive?.pairs?.['codex\u0000gpt-6-mini'] === undefined,
    JSON.stringify(after),
  )
  view.requests[2].answer(mixedPayload([...byTtft.rows, MIXED_RETIRED], view.requests[2].body.selection))
  tree = await view.pump()
  check(
    'и строка действительно отметилась',
    checkedModelsOf(tree, 'codex').includes('codex/gpt-6-mini'),
    checkedModelsOf(tree, 'codex').join(' | '),
  )
}

// --- a host that cannot grade at all ------------------------------------------
// `null` from a host that read no configuration and nothing at all from a host
// that predates the field are one answer to the panel: there is no archive to
// offer. A checkbox that could only ever read zero would be a claim about the
// configuration this host is in no position to make.
for (const [label, answer] of [
  ['хост до появления поля', payload('ttft', byTtft.rows, {})],
  ['хост без каталога', payload('ttft', byTtft.rows, { archive: null })],
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
  view.requests[0].answer(payload('ttft', [], { archive: { rows: 3, steps: 12, shown: false } }))
  tree = await view.pump()
  check('пустая таблица объясняет архив, а не историю', text(tree).includes('вне текущей конфигурации'), text(tree).slice(0, 90))
  check('и называет, сколько строк там лежит', text(tree).includes('3'), text(tree).slice(0, 90))
  check('и не зовёт поработать в сессии', !text(tree).includes('Поработайте в сессии'))
  check('отметка остаётся под рукой', archiveCheck(tree) !== null)
}

// --- the archive in the stored question, and the address that no longer holds one -
{
  // The keys this panel used to write are read no longer: a selection is a rule
  // document, and a rule document in a query string is either truncated or visible
  // to the host's page. A panel that still honoured `msArchived` would open on a
  // question nobody can see the source of.
  const view = mountPanel({ search: '?msView=provider&msArchived=1&msSort=errors&keep=1' })
  view.render()
  check(
    'старые ключи в адресе больше не вопрос панели',
    askedFor(view, 0, { sort: 'ttft', dir: 'asc' }),
    describe(view, 0),
  )
  check('и адрес не переписывается', view.addresses.length === 0, view.addresses.join(' | ') || '(адрес не менялся)')
}
{
  const view = mountPanel({ prefs: { archived: true } })
  view.render()
  check('сохранённый архив отправлен при открытии', askedFor(view, 0, { sort: 'ttft', dir: 'asc', archived: true }), describe(view, 0))
}
{
  // A broken preference must not turn the filter on: the archive is the one
  // filter whose default decides what the reader is shown.
  const view = mountPanel({ prefs: { archived: 'yes please' } })
  view.render()
  check('испорченное значение не включает архив', askedFor(view, 0, { sort: 'ttft', dir: 'asc' }), describe(view, 0))
}
{
  // The reset button restores the selection and leaves the archive alone: the
  // archive is a scope switch with its own visible control, not one of the reader's
  // marks, and a button named "back to the default selection" that also turned the
  // archive off would be doing something its name does not say.
  const view = mountPanel({ prefs: { archived: true, selection: rules({ providers: { codex: 'all' } }) } })
  let tree = await view.pump()
  view.requests[0].answer(withArchive(byTtft.rows, { rows: 1, steps: 106, shown: true }))
  tree = await view.pump()
  buttonWithText(tree, 'Вернуть выбор по умолчанию').props.onClick()
  tree = await view.pump()
  check(
    'сброс возвращает правило по умолчанию и не гасит архив',
    askedFor(view, 1, { sort: 'ttft', dir: 'asc', archived: true, selection: DEFAULT_SELECTION }),
    describe(view, 1),
  )
  check(
    'и записан в настройки',
    JSON.stringify(JSON.parse(view.store.get('dsh-model-scorecard:prefs:v2.selection')).selection) === JSON.stringify(DEFAULT_SELECTION),
    view.store.get('dsh-model-scorecard:prefs:v2.selection'),
  )
}

// --- a catalog the host could not read ----------------------------------------
// `archive: null` from the host is not "nothing is archived": it is "this process
// cannot see the configuration". The tree then holds the history alone, and the panel
// has to say so — a configured pair and a retired one look exactly alike in that tree,
// and a reader who is not told will tick the wrong one.
{
  // The catalog such a host would send: the history alone, every entry graded `null`
  // rather than `false`, because "not in the configuration" is a statement it is not
  // in a position to make.
  const historyOnly = [...new Set(byTtft.rows.map((entry) => entry.provider))]
    .sort()
    .map((provider) => ({
      provider,
      models: byTtft.rows
        .filter((entry) => entry.provider === provider)
        .map((entry) => ({ model: entry.model, archived: null, noStats: false, steps: entry.steps })),
    }))
  const view = mountPanel()
  let tree = await view.pump()
  view.requests[0].answer(
    payload('ttft', byTtft.rows, { archive: null, catalog: historyOnly }),
  )
  tree = await view.pump()
  check('неизвестный каталог объяснён', text(tree).includes('Каталог этой установки'), text(tree).slice(0, 140))
  check('и дерево собрано из одной истории', treeParents(tree).map(treeName).join() === 'codex,local-uns,openrouter', treeParents(tree).map(treeName).join(' | '))
  check('архивная отметка не предлагается', archiveRow(tree) === null)
  check('и ни одна модель не помечена архивной', nodesWhere(tree, (node) => node.props?.className === 'dsh-ms-archive').length === 0)
}

// --- the marks under the archive come back with it -----------------------------
// The archive is a scope of the same selection: turning the archive off does not
// throw away what the reader marked under it, because a switch that edited a scope
// nobody can see would be silently rewriting the answer for the moment it is turned
// back on.
{
  // A catalog with one retired pair in it, which is the only kind of entry the
  // archive scope can be about: the scope applies to the entries the answer grades
  // as archived, and an answer with the archive off carries none.
  const withRetired = [
    ...CATALOG,
    { provider: 'codex', models: [{ model: 'gpt-5-old', archived: true, noStats: false, steps: 12 }] },
  ]
  const saved = rules({ archiveBase: 'all' })
  const view = mountPanel({ prefs: { archived: true, selection: saved } })
  let tree = await view.pump()
  check('обе области сохранённого выбора уходят на хост', askedFor(view, 0, { sort: 'ttft', dir: 'asc', archived: true, selection: saved }), describe(view, 0))
  const answer = payload('ttft', byTtft.rows, {
    catalog: withRetired,
    archive: { rows: 1, steps: 12, shown: true },
  })
  view.requests[0].answer(answer)
  tree = await view.pump()
  check(
    'архивная область собрана: три замеренные модели и архивная',
    textOf(modelsCount(tree)) === '4 из 6',
    textOf(modelsCount(tree)),
  )
  archiveCheck(tree).props.onChange({})
  tree = await view.pump()
  check('выключение архива не стирает его отметки', askedFor(view, 1, { sort: 'ttft', dir: 'asc', selection: saved }), describe(view, 1))
  // The answer with the archive off: it holds the same rows and says the archive
  // still holds one, so the control stays where the reader left it.
  view.requests[1].answer(
    payload('ttft', byTtft.rows, { archive: { rows: 1, steps: 12, shown: false } }),
  )
  tree = await view.pump()
  check('и счётчик считает только доступную область', textOf(modelsCount(tree)) === '3 из 5', textOf(modelsCount(tree)))
  archiveCheck(tree).props.onChange({})
  tree = await view.pump()
  check('а возвращение архива возвращает и отметки', askedFor(view, 2, { sort: 'ttft', dir: 'asc', archived: true, selection: saved }), describe(view, 2))
  view.requests[2].answer(answer)
  tree = await view.pump()
  check('и архивная модель снова отмечена', checkedModels(tree).includes('codex/gpt-5-old'), checkedModels(tree).join(' | '))
}

// --- a request that fails keeps the table, and names the question --------------
{
  const view = mountPanel()
  let tree = await view.pump()
  view.requests[0].answer(byTtft)
  tree = await view.pump()
  buttonWithText(tree, 'Снять все').props.onClick()
  tree = await view.pump()
  view.requests[1].answer({ ok: false, error: 'boom' }, 500)
  tree = await view.pump()
  check('сорванный запрос не убирает таблицу', hasTable(tree) && rowLabels(tree).length === 3, rowLabels(tree).join(' | '))
  // The failure sentence names the sort and the selection together, because those
  // are the two halves of the question that did not come back — and a table of the
  // previous selection shown without them would read as the answer to this one.
  const stale = 'Показаны строки прежнего запроса'
  check('и панель говорит, что показывает прежний ответ', text(tree).includes(stale), text(tree).slice(0, 120))
  check(
    'называя при этом выбор, о котором спросила',
    text(tree).includes('выбрано моделей: 0 из 5'),
    text(tree).slice(text(tree).indexOf(stale), text(tree).indexOf(stale) + 120),
  )
}

// --- an answer to a question nobody is asking any more -------------------------
// A late answer to the previous selection must not be passed off as the current one:
// the rows stay on screen with a notice naming the wait, and the heading keeps the
// host's own word for the order it actually sent.
{
  const view = mountPanel()
  let tree = await view.pump()
  view.requests[0].answer(byTtft)
  tree = await view.pump()
  buttonWithText(tree, 'Снять все').props.onClick()
  tree = await view.pump()
  check('новый выбор спрошен заново', view.requests.length === 2 && view.requests[1].settled === false, String(view.requests.length))
  view.requests[0].answer(byTtft)
  tree = await view.pump()
  check('ответ на прежний выбор не выдан за ответ на новый', text(tree).includes(NOTICE), text(tree).slice(0, 90))
  check('и таблица прежняя, а не пустая', hasTable(tree) && rowLabels(tree).length === 3, rowLabels(tree).join(' | '))
}

// --- a browser that refuses to store anything ----------------------------------
// The panel works in memory and says so once: a reader whose marks disappear on the
// next visit deserves to be told before they make a hundred of them.
{
  const view = mountPanel({ brokenStorage: true })
  let tree = await view.pump()
  view.requests[0].answer(byTtft)
  tree = await view.pump()
  check('без хранилища панель работает', hasTable(tree) && rowLabels(tree).length === 3, rowLabels(tree).join(' | '))
  check('и предупреждает, что выбор не сохранится', text(tree).includes('не разрешает сохранять'), text(tree).slice(0, 120))
  buttonWithText(tree, 'Снять все').props.onClick()
  tree = await view.pump()
  check(
    'выбор всё равно действует в этой вкладке',
    askedFor(view, 1, { sort: 'ttft', dir: 'asc', selection: rules({ base: 'none' }) }),
    describe(view, 1),
  )
}

// --- the words the panel promises to have -------------------------------------
{
  // Every key the panel asks for has to be in both dictionaries. The panel is written
  // once and rendered in whichever locale the host's service answers, so a key that
  // exists only in Russian is an English reader looking at a bare key name — and the
  // check has to read the source to see it, because a missing key renders as a
  // fallback rather than as an error.
  const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const requested = [...new Set([...clientSource.matchAll(/\bt\('([a-zA-Z][\w.]*)'/g)].map((m) => m[1]))]
  const mod0 = mountPanel().mod
  const ruKeys = mod0.__test__.MESSAGES.ru
  const enKeys = mod0.__test__.MESSAGES.en
  const missingRu = requested.filter((key) => typeof ruKeys[key] !== 'string')
  const missingEn = requested.filter((key) => typeof enKeys[key] !== 'string')
  check(
    `все ${requested.length} запрошенных строк есть в обоих словарях`,
    missingRu.length === 0 && missingEn.length === 0,
    `ru: ${missingRu.join(', ') || '-'} / en: ${missingEn.join(', ') || '-'}`,
  )
  // The reverse direction as well, but read off the whole source rather than off the
  // `t('literal')` calls: half the keys arrive through a variable — `t(column.labelKey)`,
  // a template for the direction of an order — so a scan that only saw literals would
  // report the whole column set as dead copy.
  const orphans = Object.keys(ruKeys).filter((key) => !clientSource.includes(key))
  check(
    'и в словарях не осталось ключей, которых никто не спрашивает',
    orphans.length === 0,
    orphans.slice(0, 12).join(', ') || '(все ключи востребованы)',
  )
}

// --- the map of natural directions: the panel's copy against the fold's own -----
{
  // The panel draws a heading's arrow before the first answer arrives, so it has to
  // know which way each order opens without asking the host — and it cannot import
  // the fold, because the client is a browser bundle with no module resolution into
  // `lib/`. The map is a restatement, and two copies of one fact are what let eight
  // orders (`retry` through `interrupted`) go missing from the panel's copy and open
  // ascending on their first click while the host opened them descending. Neither
  // side can import the other, so this is where they are held together: key for key
  // and direction by direction. It is a different question from the sort contract
  // checked below — that one asks whether the host *accepts* the key a heading
  // sends, and this one asks which end it starts at.
  const panelDirs = mountPanel().mod.__test__.SORT_DIRS
  const panelKeys = Object.keys(panelDirs).sort()
  const foldKeys = Object.keys(SORT_DIRECTIONS).sort()
  const onlyPanel = panelKeys.filter((key) => !foldKeys.includes(key))
  const onlyFold = foldKeys.filter((key) => !panelKeys.includes(key))
  check(
    `копия направлений знает те же ${foldKeys.length} порядков, что и фолд`,
    onlyPanel.length === 0 && onlyFold.length === 0,
    `панель ${panelKeys.length}, фолд ${foldKeys.length}; только в панели: ${onlyPanel.join(', ') || '-'}; только в фолде: ${onlyFold.join(', ') || '-'}`,
  )
  for (const key of foldKeys) {
    check(
      `порядок ${key} открывается так же, как его открывает хост`,
      panelDirs[key] === SORT_DIRECTIONS[key],
      `панель ${panelDirs[key] ?? '—'}, фолд ${SORT_DIRECTIONS[key]}`,
    )
  }
}

{
  const mod = mountPanel().mod
  const placeholders = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join()
  const ru = mod.__test__.MESSAGES.ru
  const en = mod.__test__.MESSAGES.en
  check(
    'слова об архиве есть в обоих словарях',
    [
      'models.open',
      'models.count',
      'models.group',
      'models.search',
      'models.selectAll',
      'models.selectNone',
      'models.reset',
      'models.resetDefault',
      'models.empty',
      'models.providerCount',
      'models.note',
      'models.truncated',
      'models.showAll',
      'models.storage',
      'empty.selection',
      'empty.selected',
      'announce.selection.reset',
      'filter.archive',
      'filter.archive.short',
      'filter.archive.count',
      'footer.archive',
      'empty.archived',
      'hint.archive',
      'archive.badge',
    ].every((key) => typeof ru[key] === 'string' && typeof en[key] === 'string'),
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
      noStats: { rows: 1 },
    }),
  )
  tree = await view.pump()

  check('строка конфигурации без замеров нарисована как строка', rowLabels(tree).length === 4, rowLabels(tree).join(' | '))
  // Scoped to the table: the tree marks the same kind of row for its own reason —
  // a pair the configuration serves and no session has run is exactly the entry a
  // reader ticks — and a check that counted both would never see one of them.
  const marks = nodesWhere(nodesWhere(tree, (node) => node.type === 'table')[0], (node) => node.props?.className === 'dsh-ms-nostats')
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
  view.requests[0].answer(payload('ttft', byTtft.rows, { noStats: null }))
  tree = await view.pump()
  check('хост без каталога о таких строках молчит', !text(tree).includes('без статистики'))
  check(
    'и ни одна строка таблицы не помечена',
    nodesWhere(nodesWhere(tree, (node) => node.type === 'table')[0], (node) => node.props?.className === 'dsh-ms-nostats').length === 0,
  )
}
{
  // What the host answers on a fresh install: no history at all, and the
  // configured models as the whole table. The panel draws it rather than telling
  // the reader to go and work in a session.
  const view = mountPanel()
  let tree = await view.pump()
  view.requests[0].answer(
    payload('ttft', [NEVER_USED], { noStats: { rows: 1 } }),
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
  const view = mountPanel({ entries: { [cacheKey('ttft', 'asc', 'model')]: { at: Date.now(), data: byTtft } } })
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
  const view = mountPanel({ entries: { [cacheKey('ttft', 'asc', 'model')]: { at: Date.now(), data: single } } })
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
  const view = mountPanel({ entries: { [cacheKey('ttft', 'asc', 'model')]: { at: Date.now(), data: unmeasured } } })
  const tree = view.render()
  const ttft = columnCells(tree, 'ttft')
  const tps = columnCells(tree, 'tps')
  check('нет замера — «-» без цвета', ttft[2]?.[0] === '-' && ttft[2]?.[1] === 'dsh-ms-num', JSON.stringify(ttft))
  check('нет замера — «-» без цвета', tps[0]?.[0] === '-' && tps[0]?.[1] === 'dsh-ms-num', JSON.stringify(tps))
  check('худший из замеренных отмечен, а не незамеренный', ttft[1]?.[1] === 'dsh-ms-worst' && tps[1]?.[1] === 'dsh-ms-worst', `${JSON.stringify(ttft)} ${JSON.stringify(tps)}`)
}

console.log('\n--- сортировка по клику на заголовок столбца ---')
{
  const cached = { [cacheKey('ttft', 'asc', 'model')]: { at: Date.now(), data: byTtft } }
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
    askedFor(view, 1, { sort: 'steps', dir: 'desc' }),
    describe(view, 1),
  )
  check('колонка шагов получила aria-sort=descending', ariaSort(tree, 'steps') === 'descending')
  check('колонка отклика вернулась в aria-sort=none', ariaSort(tree, 'ttft') === 'none')
  check('в настройках сохранён порядок steps.desc', view.store.get('dsh-model-scorecard:prefs:v2.selection')?.includes('"sort":"steps"') && view.store.get('dsh-model-scorecard:prefs:v2.selection')?.includes('"dir":"desc"'))

  // Click on "steps" heading again to flip direction
  sortButton(tree, 'steps').props.onClick()
  tree = await view.pump()

  check(
    'повторный клик развернул направление на steps.asc',
    askedFor(view, 2, { sort: 'steps', dir: 'asc' }),
    describe(view, 2),
  )
  check('колонка шагов получила aria-sort=ascending', ariaSort(tree, 'steps') === 'ascending')
  check('в настройках сохранён порядок steps.asc', view.store.get('dsh-model-scorecard:prefs:v2.selection')?.includes('"dir":"asc"'))
}

{
  // Test restoring arbitrary column sort and direction from prefs
  const view = mountPanel({
    prefs: { sort: 'cache', dir: 'desc', columnsAll: true },
  })
  await view.pump()
  check(
    'восстановление сортировки по глубокой метрике (cache) и направлению из prefs',
    askedFor(view, 0, { sort: 'cache', dir: 'desc' }),
    describe(view, 0),
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
  const cached = { [cacheKey('ttft', 'asc', 'model')]: { at: Date.now(), data: byTtft } }
  const view = mountPanel({ entries: cached, prefs: { columnsAll: true } })
  const tree = await view.pump()
  const tableHeadings = headings(tree)
  check('полный вид группирует однотипные метрики',
    tableHeadings.map((th) => th.props.key).join(',') ===
      'name,liveness,rating,steps,lastSeen,ttft,ttftP90,ttftClean,retry,e2e,tps,tpsMax,confidence,errorRate,modelErrors,errors,interrupted,llm,prefill,overhead,cache')
  // The count is derived from PANEL_SORTS rather than written down, so adding a
  // column cannot leave a stale literal here that only fails on the next person
  // to run the tool. One heading per sort key, and every heading is one.
  //
  // This used to carry `ACCEPTED_NOT_YET_DRAWN = ['rating']`, the one gap the
  // stage split allowed: the host accepted an order (`SORTS` in stage 4) before
  // the panel drew the column that asks for it (stage 7). The column is drawn, so
  // the allowance is gone rather than narrowed — and the check is once again
  // symmetric, which is what it was for: a key whose column nobody drew and a
  // column whose key the host would refuse both fail here.
  check(
    `развёрнутая таблица показывает все ${PANEL_SORTS.length} колонок`,
    tableHeadings.length === PANEL_SORTS.length,
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
    keys.push(sentBody(subView, 1)?.sort)
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
    'и у каждого принимаемого ключа хоста есть свой заголовок',
    PANEL_SORTS.every((k) => keys.includes(k)),
    PANEL_SORTS.filter((k) => !keys.includes(k)).join(', ') || '(все нарисованы)',
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
  const cached = { [cacheKey('ttft', 'asc', 'model')]: { at: Date.now(), data: byTtft } }
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
  const cached = { [cacheKey('ttft', 'asc', 'model')]: { at: Date.now(), data: byTtft } }
  const view = mountPanel({ entries: cached })
  let tree = await view.pump()

  sortButton(tree, 'liveness').props.onClick()
  tree = await view.pump()
  check(
    'клик по заголовку статуса просит хост порядок по статусу, худшим сверху',
    askedFor(view, 1, { sort: 'liveness', dir: 'desc' }),
    describe(view, 1),
  )
  check('колонка статуса получила aria-sort=descending', ariaSort(tree, 'liveness') === 'descending')
  check(
    'в настройках сохранён порядок liveness.desc',
    view.store.get('dsh-model-scorecard:prefs:v2.selection')?.includes('"sort":"liveness"') &&
      view.store.get('dsh-model-scorecard:prefs:v2.selection')?.includes('"dir":"desc"'),
  )

  sortButton(tree, 'liveness').props.onClick()
  tree = await view.pump()
  check(
    'повторный клик перевернул направление на liveness.asc',
    askedFor(view, 2, { sort: 'liveness', dir: 'asc' }),
    describe(view, 2),
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
  const view = mountPanel({ entries: { [cacheKey('ttft', 'asc', 'model')]: { at: Date.now(), data: byTtft } } })
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
  ], {})
  const view = mountPanel({
    entries: { [cacheKey('liveness', 'desc', 'model')]: { at: Date.now(), data: hostVerdict } },
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
  const withLiveness = (rows) => payload('ttft', rows, {})

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

  const view = mountPanel({ entries: { [cacheKey('ttft', 'asc', 'model')]: { at: Date.now(), data: livePayload } }, prefs: { columnsAll: true } })
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
  const view = mountPanel({ entries: { [cacheKey('ttft', 'asc', 'model')]: { at: Date.now(), data: cached } }, prefs: { columnsAll: true } })
  const tree = await view.pump()

  const circle = nodesWhere(tree, (node) => node.props?.className === 'dsh-ms-live-button')[0]
  circle.props.onClick()
  await view.pump()

  const post = view.requests.find((entry) => entry.method === 'POST' && entry.url === '/api/model-scorecard/liveness/check')
  check('клик по кружку отправляет POST на маршрут проверки', post?.url === '/api/model-scorecard/liveness/check', post?.url)
  check(
    'клик проверяет одну модель, а не весь каталог',
    post?.body?.provider === 'openrouter' && post?.body?.model === 'glm-5.3-flash' && post?.body?.all !== true,
    JSON.stringify(post?.body),
  )

  // The host answers a sweep immediately and keeps working, so the panel has to
  // follow the work down its own count rather than treat the first answer as the
  // last one.
  const buttons = () => nodesWhere(tree, (node) => node.type === 'button')
  const sweep = buttons().find((node) => textOf(node) === 'Проверить все')
  check('есть кнопка проверки всех моделей', sweep !== undefined)
  check(
    'у кнопки проверки всех есть подсказка про её охват',
    typeof sweep?.props.title === 'string' && sweep.props.title.includes('все настроенные модели'),
    sweep?.props.title?.slice(0, 60),
  )

  // The second half of the probe pair names its scope instead of naming a
  // freshness window nobody can see: the models the reader ticked. That is the
  // whole point of the rename — the old button said "the stale ones", and what
  // counted as stale was a five-minute rule inside the host.
  const selected = buttons().find((node) => textOf(node) === 'Проверить выбранные')
  check('есть кнопка проверки выбранных, а кнопки «только устаревшие» больше нет',
    selected !== undefined && buttons().every((node) => textOf(node) !== 'Только устаревшие'))
  check(
    'у кнопки проверки выбранных есть подсказка про её охват',
    typeof selected?.props.title === 'string' && selected.props.title.includes('отмечены в дереве'),
    selected?.props.title?.slice(0, 60),
  )

  // The catalog this answer carried has four measured pairs over four providers,
  // and the default rule selects exactly those — so the button is live here, and
  // what it sends is the selection and nothing else.
  check('выбор по умолчанию не пуст, кнопка активна', selected?.props['aria-disabled'] === false, String(selected?.props['aria-disabled']))
  selected.props.onClick()
  await view.pump()
  const chosen = view.requests
    .filter((entry) => entry.method === 'POST' && entry.url === '/api/model-scorecard/liveness/check')
    .at(-1)
  const sentPairs = chosen?.body?.pairs
  check(
    'кнопка проверки выбранных отправляет список пар, а не вопрос о каталоге',
    Array.isArray(sentPairs) && chosen?.body?.all !== true && chosen?.body?.pairs !== undefined,
    JSON.stringify(chosen?.body)?.slice(0, 120),
  )
  check(
    'список — ровно отмеченные измеренные пары, и он упорядочен',
    JSON.stringify(sentPairs) === JSON.stringify([
      { provider: 'codex', model: 'gpt-6-astra' },
      { provider: 'local-uns', model: 'Ornith-9B' },
      { provider: 'openrouter', model: 'glm-5.3-flash' },
    ]),
    JSON.stringify(sentPairs),
  )
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

  const view = mountPanel({ entries: { [cacheKey('ttft', 'asc', 'model')]: { at: Date.now(), data: limitPayload } }, prefs: { columnsAll: true } })
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
  const short = mountPanel({ entries: { [cacheKey('ttft', 'asc', 'model')]: { at: Date.now(), data: limitPayload } }, prefs: { columnsAll: false } })
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

  const view = mountPanel({ entries: { [cacheKey('ttft', 'asc', 'model')]: { at: Date.now(), data: configPayload } }, prefs: { columnsAll: true } })
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
  const view = mountPanel({ entries: { [cacheKey('ttft', 'asc', 'model')]: { at: Date.now(), data: cached } }, prefs: { columnsAll: true } })
  let tree = await view.pump()

  const dotState = (node) => nodesWhere(node, (entry) => entry.props?.className === 'dsh-ms-live-dot')[0]?.props['data-state']
  const tableGets = () => view.requests.filter((entry) => entry.method === 'POST' && entry.url === '/api/model-scorecard/query')
  check('строка, помеченная хостом как проверяемая, нарисована «проверяю…»', dotState(tree) === 'checking', dotState(tree))

  // The sweep the flag came from: the host answers at once and keeps working, so
  // the panel has to follow it down `pending`.
  const sweep = nodesWhere(tree, (node) => node.type === 'button').find((node) => textOf(node) === 'Проверить все')
  sweep.props.onClick()
  await view.pump()
  const post = view.requests.find((entry) => entry.method === 'POST' && entry.url.startsWith('/api/model-scorecard/liveness'))
  check('кнопка проверки отправила запрос', post !== undefined)
  post.answer({ ok: true, running: true, total: 1, done: 0, pending: 1, checking: ['openrouter\u0000glm-5.3-flash'], results: [] })
  tree = await view.pump()

  // The wait is the panel's own poll interval: the sweep ends on the host, and
  // the poll is how the browser hears about it.
  await new Promise((resolve) => setTimeout(resolve, 1300))
  await view.pump()
  const poll = view.requests.filter((entry) => entry.url === '/api/model-scorecard/liveness').at(-1)
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
    `запросов таблицы: ${before} → ${tableGets().length}`,
  )
  check(
    'перезапрос задаёт тот же вопрос, что и раньше',
    JSON.stringify(sentBody(view, view.requests.indexOf(tableGets().at(-1)))) === JSON.stringify(sentBody(view, view.requests.indexOf(tableGets()[0]))),
    `${JSON.stringify(sentBody(view, view.requests.indexOf(tableGets()[0])))} → ${JSON.stringify(sentBody(view, view.requests.indexOf(tableGets().at(-1))))}`,
  )

  tableGets().at(-1).answer(payload('ttft', [row('openrouter', 'glm-5.3-flash', { lastSeen: probeAt })]))
  tree = await view.pump()
  check('после ответа круг показывает результат, а не «проверяю…»', dotState(tree) === 'up', dotState(tree))
  check(
    'второго перезапроса нет: переход сработал один раз',
    tableGets().length === before + 1,
    `запросов таблицы всего: ${tableGets().length}`,
  )
}

console.log('')
if (failures === 0) {
  console.log('ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ')
} else {
  console.log(`ПРОВАЛЕНО ПРОВЕРОК: ${failures}`)
  process.exitCode = 1
}

