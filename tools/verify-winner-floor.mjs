// The 20-sample floor applies to every winner line, not just one of them.
//
// This tool exists because of the shape of D-010, not its value: the floor was
// invented at the one line where the failure first showed up (`fastest end to
// end` — a one-step model topped it), and the other three winner lines went on
// naming models with one or two steps, confidently, with nothing on the line
// saying the pick rested on that few samples. A rule applied in one place and
// remembered in none is a rule that decays: the next winner line gets born
// unguarded, and no test can tell, because the test that existed only spoke of
// the line where the floor happened to live.
//
// So the contract asserted here is the class, not the instance:
//
//   1. structurally — there is exactly one place a winner line can be written:
//      the `WINNER_LINES` table, printed by `winnerLines()`, which is the only
//      caller of `pickWinner` and of `winnerNote`. The renderer holds no winner
//      label of its own and calls the helper once, so a fifth line is a fifth
//      entry rather than a fifth block that could be written without its
//      denominator. Every entry is walked here and every one of them must carry
//      its denominator on a fixture tuned so that every shortcut is tempting;
//   2. behaviourally — on that fixture the floor holds on all four lines: a
//      one-step model is the true fastest first token, a nineteen-sample row the
//      true fastest decode;
//   3. honestly — a pick under the floor is *said*, not suppressed or
//      polished: the line stays in the report marked "under the floor" (the
//      e2e line used to go silent there, which a reader cannot tell apart
//      from "no model here is the fastest"), a lone row above it is marked as
//      one, and the count printed is the count the statistic really holds.
//
// Usage: node tools/verify-winner-floor.mjs

import { aggregate } from '../lib/fold.js'
import { MIN_WINNER_SAMPLES, WINNER_LINES, renderReportText } from '../lib/collect.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(label, condition, detail = '') {
  const mark = condition ? 'OK  ' : 'FAIL'
  if (!condition) failures += 1
  console.log(`${mark} ${label}${detail ? ` — ${detail}` : ''}`)
}

const lineWith = (text, prefix) => text.split('\n').find((line) => line.startsWith(prefix))
const allLinesWith = (text, prefix) => text.split('\n').filter((line) => line.startsWith(prefix))

console.log('--- статически: строку-победителя пишет только winnerLines ---')

const source = readFileSync(
  new URL('../lib/collect.js', import.meta.url),
  'utf8',
)
/** The body of one top-level declaration, bounded by the next one. */
const bodyOf = (marker) => {
  const start = source.indexOf(marker)
  if (start === -1) return ''
  const rest = source.slice(start + marker.length)
  const end = rest.search(/\n(?:export )?(?:function|const) [\w$]+/)
  return source.slice(start, start + marker.length + (end === -1 ? rest.length : end))
}
const renderer = bodyOf('export function renderReportText')
const writer = bodyOf('function winnerLines(')
// The table declaration, from `WINNER_LINES` to the `]` that closes it.
const tableStart = source.indexOf('export const WINNER_LINES = [')
const tableEnd = source.indexOf('\n]\n', tableStart)
const table = source.slice(tableStart, tableEnd)

// A winner line is one that names a winner. There are four, and the point of
// the table is that a fifth is a fifth *entry*: the renderer cannot write one
// because it holds no such string at all, and every entry is printed by the one
// loop in `winnerLines()`.
//
// Three matches, because "a label" can hide in three places and the old guard
// only looked at one of them. `declared` is the table's own `label:` field;
// `inline` is a hand-written line, a template literal that opens with the label;
// `mentioned` is the label as a bare string, which is where a line written as
// `` const l = 'fastest cache' `` keeps it — the shape that prints a fifth
// winner line with no denominator while every literal-search stays green.
const declared = (text) => [...text.matchAll(/label:\s*'((?:fastest|slowest) [\w ]+)'/g)].map((m) => m[1])
const inline = (text) => [...text.matchAll(/`((?:fastest|slowest) [\w ]+):/g)].map((m) => m[1])
const mentioned = (text) => [...text.matchAll(/'((?:fastest|slowest) [\w ]+)'/g)].map((m) => m[1])
const tableLabels = declared(table)
check(
  'в рендерере нет ни одной метки-победителя',
  declared(renderer).length === 0 && inline(renderer).length === 0 && mentioned(renderer).length === 0,
  [...declared(renderer), ...inline(renderer), ...mentioned(renderer)].join(' | ') || 'ни одной',
)
check(
  'рендерер зовёт winnerLines ровно один раз',
  (renderer.match(/winnerLines\(/g) ?? []).length === 1,
  `winnerLines( в рендерере: ${(renderer.match(/winnerLines\(/g) ?? []).length}`,
)
check(
  'ни pick(, ни pickWinner( в рендерере',
  !/(^|[^a-zA-Z])pick\(/.test(renderer) && !renderer.includes('pickWinner('),
)
// Every bare mention of a winner label in the file has to be inside the table —
// the table's own `skipIfSameRowAs` points at one, and that is the only other
// mention a correct file has. This is the check that fails on a label smuggled
// into the renderer as a variable, because a variable is exactly a bare string.
const strays = [...source.matchAll(/'(?:fastest|slowest) [\w ]+'/g)].filter(
  (m) => m.index < tableStart || m.index > tableEnd,
)
check(
  'ни одна метка-победитель не живёт вне таблицы',
  strays.length === 0,
  strays.length === 0 ? `все в таблице: ${mentioned(table).join(' | ')}` : strays.map((m) => m[0]).join(' | '),
)
check(
  'в таблице ровно четыре строки, и это те же, что экспортированы',
  tableLabels.length === 4 &&
    WINNER_LINES.length === 4 &&
    tableLabels.join('|') === WINNER_LINES.map((line) => line.label).join('|'),
  tableLabels.join(' | '),
)
check(
  'метки в таблице не повторяются',
  new Set(WINNER_LINES.map((line) => line.label)).size === WINNER_LINES.length,
)
check(
  'у каждой строки есть фигура, правило и статистика',
  WINNER_LINES.every(
    (line) =>
      typeof line.figure === 'function' &&
      typeof line.better === 'function' &&
      typeof line.stat === 'string' &&
      typeof line.label === 'string',
  ),
  WINNER_LINES.map((line) => `${line.label}←${line.stat}`).join(' | '),
)
check(
  'у winnerLines один pickWinner и один winnerNote, и он не трогает lines',
  (writer.match(/pickWinner\(/g) ?? []).length === 1 &&
    (writer.match(/winnerNote\(/g) ?? []).length === 1 &&
    !/\blines\b/.test(writer),
  `pickWinner( ${(writer.match(/pickWinner\(/g) ?? []).length}, winnerNote( ${(writer.match(/winnerNote\(/g) ?? []).length}`,
)
check(
  'pick( недостижим и из winnerLines',
  !/(^|[^a-zA-Z])pick\(/.test(writer),
)
check(
  'пол определён ровно один раз',
  (source.match(/const MIN_WINNER_SAMPLES/g) ?? []).length === 1 &&
    source.includes(`export const MIN_WINNER_SAMPLES = ${MIN_WINNER_SAMPLES}`),
)
// The inline form of the old bug: a count gate written at a call site instead
// of in the helper. One remains, and it is the helper's own. Both spellings of
// the zero-default are counted, because `|| 0` is the same gate written a
// different way, and a guard that knows one spelling is a guard that can be
// walked past by retyping it.
const gates = [...source.matchAll(/\.count\s*(?:\?\?|\|\|)\s*0\)\s*>=\s*[A-Za-z\d_]+/g)]
check(
  'счётный пол в коде ровно один',
  gates.length === 1 && source.indexOf(gates[0][0]) > source.indexOf('function pickWinner'),
  `вхождений: ${gates.length}${gates.length === 1 ? ` (${gates[0][0]})` : ''}`,
)
check(
  'старого имени нет',
  !source.includes('MIN_RATE_SAMPLES'),
  'D-010 закрыт переопределением, а не наложением',
)
check(
  'пол в тексте строки — из константы, а не литерала',
  source.includes('${MIN_WINNER_SAMPLES}-sample floor'),
)

console.log('\n--- поведение: пол держится на всех четырёх строках ---')

let clock = 1_700_000_000_000
/**
 * One folded step sample. `streamMs` below 100 keeps the step out of the speed
 * and e2e populations while still producing a first token, which is how the
 * per-figure gate (ttft-qualified does not imply rate-qualified) gets tested.
 */
function sample(provider, model, ttftMs, streamMs = 400, streamTokens = 100) {
  clock += 1000
  return {
    sessionId: 's1',
    time: clock,
    provider,
    model,
    llmMs: ttftMs + streamMs,
    ttftMs,
    decodeMs: null,
    streamMs,
    streamTokens,
    streamFragments: 8,
    outputTokens: streamTokens,
    inputTokens: 10,
    cacheReadTokens: 5,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    interrupted: false,
  }
}
const run = (samples) => {
  const report = aggregate(samples, { sort: 'ttft' })
  return renderReportText(
    { report, scanned: 1, skipped: 0, pending: 0, provenance: { snapshotAt: null, readNow: 1, reused: 0 } },
    { limit: 50 },
  )
}
const many = (provider, model, count, ttft, streamMs, tokens) =>
  Array.from({ length: count }, (_, i) => sample(provider, model, ttft + i, streamMs, tokens))

// The tempting-history fixture. Every line has a row that would win *without*
// the floor and must not: `b/one` is the true fastest first token on one step;
// `c/rush` is the fastest decode on nineteen samples, one under the floor;
// `e/short` has 25 first tokens but no step long enough to be a rate. The two
// qualified rows decode at different rates on purpose — `a-big` fast, `a-slow`
// slow — so the prefill comparison has a real answer instead of a tie broken
// by row order, which a test must never assert on.
const mixed = run([
  ...many('a', 'a-big', 25, 100, 400, 100),
  ...many('a', 'a-slow', 21, 2000, 400, 10),
  sample('b', 'b-one', 5),
  ...many('c', 'c-rush', 19, 40, 400, 300),
  ...many('e', 'e-short', 25, 100, 50),
])
const t1 = lineWith(mixed, 'fastest first token:')
check(
  'пол называет модель с 25 шагами, а не с одним',
  (t1 ?? '').includes('a/a-big') && !(t1 ?? '').includes('b-one') && !(t1 ?? '').includes('c-rush'),
  t1,
)
check(
  '«over N sample(s)» печатается на строке победителя',
  (t1 ?? '').includes(`— over ${MIN_WINNER_SAMPLES + 5} sample(s)`) && !t1.includes('floor'),
  t1,
)
const t2 = lineWith(mixed, 'fastest median decode:')
check(
  'декод фильтрует по своему собственному счёту: 19-шаговая модель не побеждает',
  (t2 ?? '').includes('a/a-big') && !(t2 ?? '').includes('c-rush'),
  t2,
)
check(
  'и строка декода несёт свой знаменатель',
  /— over \d+ sample\(s\)/.test(t2 ?? ''),
  t2,
)
const t3 = lineWith(mixed, 'fastest end to end:')
check(
  'e2e берёт победителя из пула над полом и называет его знаменатель',
  (t3 ?? '').includes('a/a-big') &&
    (t3 ?? '').includes(`— over ${MIN_WINNER_SAMPLES + 5} sample(s)`) &&
    !(t3 ?? '').includes('under the'),
  t3,
)
check(
  'самая медленная строка — над полом и не повторяет победителя',
  (lineWith(mixed, 'slowest first token:') ?? '').includes('a/a-slow'),
  lineWith(mixed, 'slowest first token:'),
)
// The prefill comparison divides two medians of the same figure, so it may only
// compare rows inside the pool the winner came from: naming a tempting
// under-floor row here would be the floor leaking through the side door.
check(
  '«Most of the wait» сравнивает только пул над полом',
  (t3 ?? '').includes('Most of the wait before the first token: a/a-slow'),
  t3,
)
check(
  'пол на месте: 25 ttft-шагов не делают модель пригодной для скорости',
  (t2 ?? '').includes('e-short') === false,
  t2,
)
// The class, walked over the table rather than over four known labels: every
// line `WINNER_LINES` declares is printed by `winnerLines()` and every one of
// them says what it decided over, exactly once — a line that printed two
// denominators or a hand-written one inside its `figure` would be claiming
// something the statistic never said. A fifth entry is therefore covered by this
// loop on the day it is written, which is the whole point of the table; the
// four hand-written checks above stay as a readable account of what each line is
// *for*, and this one is what would fail if a new entry arrived without it.
const counted = WINNER_LINES.map((line) => [
  line.label,
  (lineWith(mixed, `${line.label}:`) ?? '').match(/over \d+ sample\(s\)/g)?.length ?? 0,
])
check(
  'каждая строка из таблицы печатается и несёт ровно один знаменатель',
  counted.every(([, times]) => times === 1),
  counted.map(([label, times]) => `${label}×${times}`).join(' | '),
)

console.log('\n--- честность: под полом — сказано, а не промолчано ---')

// The old e2e line went silent when nothing cleared the floor; the reader could
// not tell "no e2e line" from "you are not the fastest". The line stays, marked.
const under = run([...many('x', 'x-three', 3, 100), sample('y', 'y-one', 5)])
check(
  'под полом строка остаётся и помечена',
  allLinesWith(under, 'fastest end to end:').length === 1 &&
    (lineWith(under, 'fastest end to end:') ?? '').includes(`under the ${MIN_WINNER_SAMPLES}-sample floor`),
  lineWith(under, 'fastest end to end:'),
)
check(
  'помечены все четыре строки, когда над полом никого нет',
  ['fastest first token:', 'slowest first token:', 'fastest median decode:', 'fastest end to end:'].every(
    (p) => (lineWith(under, p) ?? '').includes('floor'),
  ),
  ['fastest first token:', 'slowest first token:', 'fastest median decode:', 'fastest end to end:']
    .map((p) => lineWith(under, p) ?? '(нет)')
    .join(' | '),
)
check(
  'и счёт под полом — настоящий счёт статистики, а не пола',
  (lineWith(under, 'fastest median decode:') ?? '').includes('over 1 sample(s)'),
  lineWith(under, 'fastest median decode:'),
)

const alone = run([...many('a', 'a-alone', 20, 100), sample('b', 'b-fresh', 3)])
check(
  'ровно 20 шагов — это над полом: строгость «>=» зафиксирована',
  (lineWith(alone, 'fastest first token:') ?? '').includes('a/a-alone') &&
    !(lineWith(alone, 'fastest first token:') ?? '').includes('under the'),
  lineWith(alone, 'fastest first token:'),
)
check(
  'единственная строка над полом названа единственной',
  (lineWith(alone, 'fastest first token:') ?? '').includes('the only row above the floor'),
  lineWith(alone, 'fastest first token:'),
)
check(
  'slowest не дублирует solitary-победителя',
  lineWith(alone, 'slowest first token:') === undefined,
  lineWith(alone, 'slowest first token:'),
)
check(
  'e2e с одним рядом над полом показан с той же оговоркой',
  (lineWith(alone, 'fastest end to end:') ?? '').includes('the only row above the floor'),
  lineWith(alone, 'fastest end to end:'),
)

console.log('\n--- фигура решает, строка не решает ---')

// A row qualified for the ttft line (25 first tokens) but with no step long
// enough to be a rate must not be picked by the decode line, and the row that
// *is* rate-qualified must be picked there even though its first token is
// slower. Per-figure gating is what the D-010 gate had to become; a shared
// "row has enough steps" test would pass this fixture and still be wrong.
const figures = run([
  ...many('e', 'e-short', 25, 100, 50),
  ...many('f', 'f-qualified', 20, 1000),
])
check(
  'ttft-строка смотрит на ttft: 25 коротких шагов побеждают',
  (lineWith(figures, 'fastest first token:') ?? '').includes('e/e-short'),
  lineWith(figures, 'fastest first token:'),
)
check(
  'декод-строка смотрит на декод: только 20 шагов f дают ей право выбора',
  (lineWith(figures, 'fastest median decode:') ?? '').includes('f/f-qualified'),
  lineWith(figures, 'fastest median decode:'),
)
check(
  'e2e знает только про f и говорит, что он один над полом',
  (lineWith(figures, 'fastest end to end:') ?? '').includes('f/f-qualified') &&
    (lineWith(figures, 'fastest end to end:') ?? '').includes('the only row above the floor'),
  lineWith(figures, 'fastest end to end:'),
)

console.log('')
if (failures === 0) {
  console.log('ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ')
} else {
  console.log(`ПРОВАЛЕНО ПРОВЕРОК: ${failures}`)
  process.exitCode = 1
}
