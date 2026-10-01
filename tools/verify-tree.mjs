// What would actually be published.
//
// Every other tool here answers a question about behaviour: a figure, a sort
// order, a contract. This one answers a question about the package itself, and
// it exists because the answer was once wrong in a way no behavioural tool can
// see. `lib/liveness.js.backup` and `lib/liveness_orig.js` were two older copies
// of the liveness layer, tracked, and *inside* `package.json`'s `files` list, so
// the tarball carried three implementations of a module the README tells the
// reader there is one of. A grep for the liveness layer returned two files, and
// both were plausible. Nothing failed: the panel worked, the numbers were right,
// and the two copies were simply never loaded.
//
// So the debt survived an inventory that read the tree carefully enough to find
// three of the four leftovers and missed the fourth. This file is that inventory,
// run every time, by a machine:
//
//   1. every relative import resolves to a file that exists;
//   2. every module under `lib/` is reachable from the two entry points, so a
//      second copy of anything cannot sit there unpublished-into-use;
//   3. no editor leftover is in the tree at all, whatever its name;
//   4. no file is empty;
//   5. no module sits at the root but `client.js`;
//   6. the two entry points `package.json#exports` promises are on disk.
//
// Each of the four files that were here is caught by one of these, and each by
// the rule that fits it rather than by the rule that happened to see it.
//
// Reachability is computed over the static and dynamic `import` forms by
// scanning source with comments stripped out. A module that nothing names cannot
// ship a behaviour, and one that something does name is a dependency this file
// has no opinion about.
//
// Usage: node tools/verify-tree.mjs

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
function check(label, condition, detail = '') {
  const mark = condition ? 'OK  ' : 'FAIL'
  if (!condition) failures += 1
  console.log(`${mark} ${label}${detail ? ` — ${detail}` : ''}`)
}

/** Directories that are not part of the package and are not read. */
const SKIP = new Set(['.git', 'node_modules', 'Plans', 'coverage', 'dist'])

/** Every file under `dir`, relative to the repository root, forward slashes. */
function walk(dir = root) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...walk(full))
    else if (entry.isFile()) found.push(relative(root, full).split(/[\\/]/).join('/'))
  }
  return found
}

/** Source without its comments: a specifier named in prose names nothing. */
const uncommented = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

/** Every relative module one file names, however it names it. */
function specifiers(source) {
  const found = []
  for (const pattern of [/(?:from|import)\s*['"](\.[^'"]+)['"]/g, /import\(\s*['"](\.[^'"]+)['"]/g]) {
    for (const match of uncommented(source).matchAll(pattern)) found.push(match[1])
  }
  return found
}

const files = walk()
const modules = files.filter((file) => file.endsWith('.js'))
const sources = new Map()
const read = (file) => {
  if (!sources.has(file)) sources.set(file, readFileSync(join(root, file), 'utf8'))
  return sources.get(file)
}

/** The two files the package answers on: the agent's tool and the panel. */
const ENTRY = ['lib/index.js', 'client.js']
for (const entry of ENTRY) check(`входная точка на месте: ${entry}`, existsSync(join(root, entry)))

// 1. A rename that leaves an import behind is the same class of damage as a
//    duplicate: the tree stops describing itself. This resolves each name.
{
  const broken = []
  for (const file of modules) {
    for (const specifier of specifiers(read(file))) {
      const target = relative(root, resolve(dirname(join(root, file)), specifier)).split(/[\\/]/).join('/')
      if (!existsSync(join(root, target))) broken.push(`${file} -> ${specifier}`)
    }
  }
  check('каждый относительный импорт ведёт в существующий файл', broken.length === 0, broken.join(', '))
}

// 2. The rule that would have caught both copies of the liveness layer: a module
//    under `lib/` that nothing imports is not a version of anything, and
//    `package.json` ships the whole directory either way.
{
  const reached = new Set()
  const walkFrom = (file) => {
    const key = relative(root, file).split(/[\\/]/).join('/')
    if (reached.has(key) || !existsSync(join(root, key))) return
    reached.add(key)
    for (const specifier of specifiers(read(key))) {
      walkFrom(join(dirname(join(root, key)), specifier))
    }
  }
  for (const entry of ENTRY) walkFrom(entry)
  const orphans = files.filter((file) => file.startsWith('lib/') && !reached.has(file))
  check(
    'каждый модуль lib/ импортируется откуда-то',
    orphans.length === 0,
    orphans.length === 0 ? `${reached.size} модулей достижимы` : `без импортов: ${orphans.join(', ')}`,
  )
}

// 3. The leftovers, whatever this editor or that one called them. Checked over
//    the whole tree and not only over `lib/`, because two of the four that were
//    here sat at the root and are not packaged at all — they were still tracked.
{
  const LEFTOVER = /(^|[._-])(backup|bak|orig|old|copy|tmp|temp|swp)([._-]|$)/
  const left = files.filter((file) => LEFTOVER.test(file) || file.endsWith('~'))
  check('в дереве нет редакторских огрызков', left.length === 0, left.length === 0 ? `${files.length} файлов` : left.join(', '))
}

// 4. An empty file is never an intent: here it was `error.txt` at the root, which
//    no rule above can name, and a reader of the tree sees only a hole.
{
  const empty = files.filter((file) => statSync(join(root, file)).size === 0)
  check('в дереве нет пустых файлов', empty.length === 0, empty.join(', '))
}

// 5. A module outside `lib/` and `tools/` is `client.js` and nothing else. The
//    scratch script that shared the root with it (`test_liveness.js`, 59 lines,
//    `require`-free but reachable by nobody) matched no name pattern, and reachability
//    could not see it either: it was at the root, where nothing imports from.
{
  const stray = modules.filter(
    (file) => !file.startsWith('lib/') && !file.startsWith('tools/') && file !== 'client.js',
  )
  check('модуль вне lib/ и tools/ — только client.js', stray.length === 0, stray.join(', '))
}

console.log(failures === 0 ? '\nALL OK' : `\nFAILED: ${failures}`)
process.exitCode = failures === 0 ? 0 : 1
