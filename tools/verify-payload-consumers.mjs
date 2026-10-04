// What the panel actually reads out of the answer.
//
// Every other tool here asks whether a figure is right. This one asks whether the
// payload is read at all — and it exists because the answer was once wrong in a
// way every other tool here would have called a pass. `toPanelPayload` emitted
// `providerList`, `complete`, `fromSnapshot` and `generatedAt`; `client.js` named
// none of them; and `tools/verify-provider-filter.mjs` spent thirteen lines
// asserting the dead one. Nothing failed. The panel rendered, the figures were
// right, and four fields rode on every answer to nobody. It is the same shape as
// D-031 and D-036 before it — a contract kept alive by the test that names it
// rather than by the thing that uses it.
//
// So the inventory is computed, not declared:
//
//   1. the key set is what `toPanelPayload` really returns, built by calling it
//      over a fixture that exercises each branch — a selection, an archive, an
//      empty history, the provider view — and unioning the keys, so a field
//      emitted only on one path is still seen;
//   2. the reader set is what `client.js` really touches, taken from its source
//      with comments and string literals stripped out, so a key named only in a
//      translation dictionary (`'models.empty'`) does not count as a reader —
//      that mistake is what made `empty` look alive when it was not;
//   3. every key in one set and not the other is named here.
//
// A key with no reader is a failure, and the fix is always the same one of two:
// delete the field, or name the consumer that reads it. There is no third option
// of leaving it and adding a note, because a note is what the last four fields
// had.
//
// Two exceptions are declared rather than discovered, each with the reason it is
// a real answer and not a second name for something else:
//
//   * `rows` is read, but as `data.rows` in three places and as the argument of a
//     helper in more — it is listed here only to say it is not an exception.
//   * `sinceMs` is never sent by the panel, but the route accepts `?sinceMs=` on
//     a hand-written URL and `tools/verify-rating-paths.mjs` asserts the echo
//     matches the scope that was asked for. Its reader is a URL, not this file.
//
// Usage: node tools/verify-payload-consumers.mjs

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { aggregate } from '../lib/fold.js'
import { configuredIndex, resolveSelection, selectionCatalog, toPanelPayload } from '../lib/collect.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
function check(label, condition, detail = '') {
  const mark = condition ? 'OK  ' : 'FAIL'
  if (!condition) failures += 1
  console.log(`${mark} ${label}${detail ? ` — ${detail}` : ''}`)
}

/** Source with its comments and string literals removed: prose names nothing. */
function codeOnly(source) {
  let out = ''
  let index = 0
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index)
      index = end === -1 ? source.length : end
      continue
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2)
      index = end === -1 ? source.length : end + 2
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      index += 1
      while (index < source.length) {
        if (source[index] === '\\') {
          index += 2
          continue
        }
        if (source[index] === char) {
          index += 1
          break
        }
        index += 1
      }
      out += ' '
      continue
    }
    out += char
    index += 1
  }
  return out
}

/**
 * Every property name `client.js` reads, however it reads it.
 *
 * Both spellings count and they are not interchangeable: `data.rows` and
 * `data?.rows` are the same read, `data['rows']` is the same read written by a
 * machine, and `{ rows } = data` is the same read written by a human. A key the
 * panel takes apart on the way in has a reader just as much as one it reaches
 * through.
 */
function readersIn(source) {
  const code = codeOnly(source)
  const names = new Set()
  for (const match of code.matchAll(/\??\.\s*([A-Za-z_$][\w$]*)/g)) names.add(match[1])
  for (const match of code.matchAll(/\[\s*['"]([A-Za-z_$][\w$]*)['"]\s*\]/g)) names.add(match[1])
  // Destructuring: `{ rows, shown }` out of an answer. Taken per brace group, so
  // the names a helper takes as arguments are not mistaken for reads of it.
  for (const match of code.matchAll(/\{([^{}]*)\}\s*=[^=]/g)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().match(/^[A-Za-z_$][\w$]*/)
      if (name !== null) names.add(name[0])
    }
  }
  return { names, code }
}

// --- the key set, from the function rather than from a list ------------------

let clock = 1_700_000_000_000
const sample = (provider, model, ttftMs) => {
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

const samples = [
  ...Array.from({ length: 3 }, (_, index) => sample('a', 'a-fast', 100 + index)),
  sample('a', 'a-second', 900),
  sample('b', 'b-slow', 5000),
  sample('c', 'c-rare', 10),
]

const result = () => ({
  report: aggregate(samples, { sort: 'ttft' }),
  scanned: 1,
  skipped: 0,
  pending: 0,
  provenance: { snapshotAt: null, readNow: 1, reused: 0 },
})
const emptyResult = () => ({
  empty: true,
  scanned: 2,
  skipped: 0,
  pending: 0,
  provenance: { snapshotAt: null, readNow: 0, reused: 0 },
})

const CONFIGURED = {
  live: true,
  pairs: [
    { provider: 'a', model: 'a-second' },
    { provider: 'b', model: 'b-slow' },
  ],
}

// One payload per branch that emits a different set of keys. A key emitted only
// when an archive is on, or only when a selection resolved, is exactly the kind
// that is added and never checked, so each of those paths is folded in.
const BRANCHES = {
  'модели, вся история': () => toPanelPayload(result(), { view: 'model', limit: 50 }),
  'вид по провайдерам': () => toPanelPayload(result(), { view: 'provider', limit: 50 }),
  'фильтр по провайдеру': () => toPanelPayload(result(), { view: 'model', limit: 50, provider: 'a' }),
  'архив выключен': () => toPanelPayload(result(), { view: 'model', limit: 50, configured: CONFIGURED }),
  'архив включён': () => toPanelPayload(result(), { view: 'model', limit: 50, configured: CONFIGURED, includeArchived: true }),
  'с выбором': () => {
    // `selectionCatalog` grades against the index the route builds, not the raw
    // catalog document: `configuredIndex` is what turns `{ live, pairs }` into
    // the pair set the grade is asked about, and it answers `null` for a shape
    // it does not recognize.
    const catalog = selectionCatalog(result().report, configuredIndex(CONFIGURED), false)
    return toPanelPayload(result(), {
      view: 'model',
      limit: 50,
      configured: CONFIGURED,
      selection: resolveSelection({ live: { base: 'all' } }, catalog).pairs,
    })
  },
  'с областью': () => toPanelPayload(result(), { view: 'model', limit: 50, sinceMs: 1_699_999_000_000 }),
  'пустая история': () => toPanelPayload(emptyResult(), { view: 'model', limit: 50, configured: CONFIGURED }),
  'пустой результат фильтра': () => toPanelPayload(result(), { view: 'model', provider: 'nope' }),
  'страница обрезана': () => toPanelPayload(result(), { view: 'model', limit: 1 }),
}

// `sinceMs` is read off the answer by the route's own URL contract and asserted
// in `tools/verify-rating-paths.mjs`; the panel sends no scope and needs none.
const EXTERNAL_READERS = new Map([['sinceMs', '?sinceMs= на маршруте, tools/verify-rating-paths.mjs']])

const keys = new Set()
const emittedBy = new Map()
for (const [name, build] of Object.entries(BRANCHES)) {
  const payload = build()
  for (const key of Object.keys(payload)) {
    keys.add(key)
    if (!emittedBy.has(key)) emittedBy.set(key, [])
    emittedBy.get(key).push(name)
  }
}

const { names: readers, code } = readersIn(readFileSync(join(root, 'client.js'), 'utf8'))

console.log(`--- поля payload, которые читает client.js ---\n`)
console.log(`ключей в payload: ${keys.size}, имён в client.js: ${readers.size}\n`)

const dead = []
for (const key of [...keys].sort()) {
  if (readers.has(key)) {
    console.log(`OK   ${key}${emittedBy.get(key).length === 1 ? ` (только «${emittedBy.get(key)[0]}»)` : ''}`)
    continue
  }
  const external = EXTERNAL_READERS.get(key)
  if (external !== undefined) {
    console.log(`OK   ${key} — читает не панель: ${external}`)
    continue
  }
  dead.push(key)
  console.log(`FAIL ${key} — панель этого поля не читает (шлёт: ${emittedBy.get(key).join(', ')})`)
}

check(
  'у каждого поля ответа есть читатель',
  dead.length === 0,
  dead.length === 0 ? `${keys.size} полей` : `без читателя: ${dead.join(', ')}`,
)

// The opposite direction, because a key the panel asks for and the host never
// sends is the same defect from the other side: `data.X` reads `undefined` from
// the day the field is renamed, and nothing fails — the cell renders a dash.
//
// The receiver is named rather than every property in the file, because that is
// what makes the check exact instead of noisy: `state.data` is the answer, and
// `data` is the answer wherever the panel threads it through a helper
// (`footerSummary(data, …)`). `row.score` is a figure, not a field of the
// answer, and `ctx.fmt` is not the answer either.
const asked = new Set()
for (const match of code.matchAll(/\b(?:state\.)?data\??\.([A-Za-z_$][\w$]*)/g)) asked.add(match[1])

// `error` is not a field of a table answer: the route answers `{ ok: false,
// error }` when it refuses, and the panel reads that one line and throws.
const ROUTE_ANSWER = new Set(['error'])

const unknown = [...asked].sort().filter((name) => !keys.has(name) && !ROUTE_ANSWER.has(name))

console.log('\n--- чего панель ждёт, а ответа нет ---')
console.log(`панель читает с ответа: ${[...asked].sort().join(', ')}`)
check(
  'панель не читает с ответа поля, которого в нём нет',
  unknown.length === 0,
  unknown.length === 0 ? `${asked.size} имён, все — поля ответа` : `нет таких: ${unknown.join(', ')}`,
)

console.log('')
if (failures === 0) {
  console.log('ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ')
} else {
  console.log(`ПРОВАЛЕНО ПРОВЕРОК: ${failures}`)
  process.exitCode = 1
}