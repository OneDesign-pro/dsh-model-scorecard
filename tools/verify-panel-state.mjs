// Drives the settings panel the way the browser drives it.
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
// registered section — its hooks, its effects, its request — and not a copy of
// its logic. The one contract under test:
//
//   rows already on screen are never replaced by a message.
//
// Usage: node tools/verify-panel-state.mjs

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

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

const chips = (tree) => {
  const group = nodesWhere(tree, (node) => node.props?.['aria-label'] === 'Сортировка')[0]
  if (group === undefined) return []
  return group.props.children.filter((child) => typeof child === 'object' && child?.type === 'button')
}

const chip = (tree, label) => {
  const found = chips(tree).find((entry) => textOf(entry).includes(label))
  if (found === undefined) throw new Error(`кнопка сортировки «${label}» не найдена`)
  return found
}

const pressed = (tree) => chips(tree).filter((entry) => entry.props['aria-pressed'] === true).map(textOf)

const NOTICE = 'Показан прежний ответ'

// --- fixtures ---------------------------------------------------------------

/** One panel row, with the fields the visible columns read. */
function row(provider, model, { steps = 1, ttftMedian = null, tpsMedian = null, errors = 0, lastSeen = 0 } = {}) {
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
  }
}

function payload(sort, rows) {
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
    totals: { steps: 10, errors: 0, models: rows.length, providers: rows.length },
    sort,
    view: 'model',
    rows,
  }
}

// The two orders share no row in first place, so a table that failed to follow
// the sort cannot pass by accident.
const byTtft = payload('ttft', [
  row('local-uns', 'Ornith-9B', { steps: 28, ttftMedian: 46, tpsMedian: 0.5, lastSeen: 1000 }),
  row('openrouter', 'glm-5.3-flash', { steps: 5, ttftMedian: 985, tpsMedian: 32.2, lastSeen: 2000 }),
  row('codex', 'gpt-6-astra', { steps: 106, ttftMedian: 3500, tpsMedian: 34.7, lastSeen: 3000 }),
])
const bySpeed = payload('speed', [
  row('codex', 'gpt-6-astra', { steps: 106, ttftMedian: 3500, tpsMedian: 34.7, lastSeen: 3000 }),
  row('openrouter', 'glm-5.3-flash', { steps: 5, ttftMedian: 985, tpsMedian: 32.2, lastSeen: 2000 }),
  row('local-uns', 'Ornith-9B', { steps: 28, ttftMedian: 46, tpsMedian: 0.5, lastSeen: 1000 }),
])

// --- mounting the real panel ------------------------------------------------

/**
 * Loads `client.js` into its own context and renders the section it registers.
 * Every store and transport starts empty, so a case says exactly what the panel
 * already has before it is asked anything.
 */
function mountPanel({ entries = null, prefs = null, instantDeadline = false } = {}) {
  const store = new Map()
  if (entries !== null) store.set('dsh-model-stats:v1', JSON.stringify({ entries }))
  if (prefs !== null) store.set('dsh-model-stats:prefs:v1', JSON.stringify(prefs))

  const requests = []
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
    const entry = { url: String(url), settled: false }
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
          if (slot === 'settings.section') register()
        },
        register: (definition, render) => sections.push({ definition, render }),
      }
    },
  })
  if (sections.length !== 1) throw new Error('панель не зарегистрировала секцию настроек')

  const { render, definition } = sections[0]
  // The registered renderer returns `h(Panel, props)`: the element names the
  // panel and carries the props the slot would have supplied.
  const element = render({})
  i18n = element.props.i18n
  const mounted = panel.mount(element.type, element.props)

  return {
    definition,
    mod,
    requests,
    store,
    i18n,
    render: () => mounted.render(),
    pump: () => pump(mounted),
  }
}

console.log('--- переключение сортировки ---')

// --- 1: no cache, the answer arrives, then the sort is switched ---------------
{
  const view = mountPanel()
  let tree = await view.pump()
  check('до первого ответа таблицы нет, показан ход загрузки', !hasTable(tree) && text(tree).includes('Считаю статистику'))
  check('панель спросила сортировку по умолчанию', view.requests[0]?.url === '/api/model-stats?sort=ttft&view=model', view.requests[0]?.url)

  view.requests[0].answer(byTtft)
  tree = await view.pump()
  check('после ответа таблица построена', hasTable(tree))
  check('первым идёт лидер по отклику', rowLabels(tree)[0]?.startsWith('Ornith-9B'), rowLabels(tree)[0])
  check('нажата кнопка «быстрый отклик»', pressed(tree).some((label) => label.includes('быстрый отклик')), pressed(tree).join(', '))

  chip(tree, 'скорость').props.onClick()
  tree = await view.pump()
  check('переключение сортировки запрошено у хоста', view.requests[1]?.url === '/api/model-stats?sort=speed&view=model', view.requests[1]?.url)
  check('ответа ещё нет', view.requests[1]?.settled === false)
  check('ТАБЛИЦА ОСТАЛАСЬ НА ЭКРАНЕ, пока ответ в пути', hasTable(tree), text(tree).slice(0, 80))
  check('на экране те же строки, а не пустота', rowLabels(tree).join('|').startsWith('Ornith-9B'), rowLabels(tree).join(' | '))
  check('панель говорит, что это прежний ответ', text(tree).includes(NOTICE))
  check('нажата «скорость», а не прежняя сортировка', pressed(tree).some((label) => label.includes('скорость')), pressed(tree).join(', '))

  view.requests[1].answer(bySpeed)
  tree = await view.pump()
  check('после ответа порядок сменился на новый', rowLabels(tree)[0]?.startsWith('gpt-6-astra'), rowLabels(tree)[0])
  check('предупреждение о прежнем ответе снято', !text(tree).includes(NOTICE))
}

// --- 2: a switch whose request fails ----------------------------------------
{
  const cached = { 'ttft|model': { at: Date.now(), data: byTtft } }
  const view = mountPanel({ entries: cached })
  let tree = await view.pump()
  check('кэш отдан сразу, без ожидания', hasTable(tree) && rowLabels(tree)[0]?.startsWith('Ornith-9B'))

  chip(tree, 'нестабильные').props.onClick()
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
  const entries = { 'lastSeen|model': { at: Date.now(), data: bySpeed } }
  const view = mountPanel({ entries, prefs: { sort: 'lastSeen', view: 'model' } })
  const tree = view.render()
  check('сохранённая сортировка восстановлена', view.requests[0]?.url === '/api/model-stats?sort=lastSeen&view=model', view.requests[0]?.url)
  check('кэшированный ответ отдан без ожидания', hasTable(tree))
  check('нажата сохранённая кнопка', pressed(tree).some((label) => label.includes('недавние')), pressed(tree).join(', '))
}
{
  const view = mountPanel({ prefs: { sort: 'nonsense', view: 'provider' } })
  view.render()
  check('испорченная сортировка не уходит на хост', view.requests[0]?.url === '/api/model-stats?sort=ttft&view=provider', view.requests[0]?.url)
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
  const previous = { phase: 'ready', data: byTtft, dataQuery: 'ttft|model', warning: null, error: null }
  const switched = querySwitched(previous, null, 'speed|model')
  check('смена сортировки сохраняет прежние строки', switched.data === byTtft && switched.dataQuery === 'ttft|model')
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
  // release reaches the user.
  const asked = new Set([
    ...[...source.matchAll(/\bt\('([^']+)'/g)].map((match) => match[1]),
    ...[...source.matchAll(/labelKey:\s*'([^']+)'/g)].map((match) => match[1]),
  ])
  const missing = [...asked].filter((key) => !(key in MESSAGES.ru) || !(key in MESSAGES.en))
  check(`все ${asked.size} ключей интерфейса переведены`, missing.length === 0, missing.join(', '))
}

console.log('')
if (failures === 0) {
  console.log('ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ')
} else {
  console.log(`ПРОВАЛЕНО ПРОВЕРОК: ${failures}`)
  process.exitCode = 1
}
