// The cache directory: one resolution rule, and nothing that touches the disk.
//
// This module is what `collect.js` and `liveness.js` both write the folded
// snapshot and the probe store through, so a mistake here is a plugin that
// keeps two answers, or one that writes somewhere the reader will not find.
// What it must *not* do is move anything: it used to rename a 15 MB directory
// out of the package's previous name on first activation, which was correct for
// exactly the readers who had that name and is a silent filesystem write for
// every reader after them. So the assertions here are two halves — the path is
// resolved the way the rules say, and resolving it leaves the filesystem
// exactly as it was found.
//
// Each case gets a fresh module instance, because a module that remembered its
// first answer could only ever prove the first case.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label, condition, detail = '') {
  const mark = condition ? 'OK  ' : 'FAIL'
  if (!condition) failures += 1
  console.log(`${mark} ${label}${detail ? ` — ${detail}` : ''}`)
}

let instance = 0
/** A fake `$HOME`, a fresh copy of the module, and the environment it saw. */
function scenario({ env = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'scorecard-home-'))
  const cache = join(home, '.dsh', 'cache')
  const saved = { HOME: process.env.HOME, NEW: process.env.DSH_MODEL_SCORE_CARD_CACHE_DIR }
  process.env.HOME = home
  delete process.env.DSH_MODEL_SCORE_CARD_CACHE_DIR
  for (const [key, value] of Object.entries(env)) process.env[key] = value
  instance += 1
  return {
    home,
    cache,
    mod: import(`../lib/cache-dir.js?case=${instance}`),
    restore() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(home, { recursive: true, force: true })
    },
  }
}

// 1. The default, and the two properties that make it usable by both writers:
//    it is under the caller's home rather than the process's idea of one, and
//    it is named after the package, so a reader can find it without this file.
{
  const s = scenario()
  const { cacheDir, CACHE_DIR_NAME } = await s.mod
  const dir = cacheDir()
  check('the default is the package-named directory', dir === join(s.cache, 'dsh-model-scorecard'), dir)
  check('the exported name is the one on disk', dir.endsWith(CACHE_DIR_NAME), CACHE_DIR_NAME)
  check('resolving it creates nothing', !existsSync(s.cache))
  check('resolving it twice answers the same path', cacheDir() === dir)
  s.restore()
}

// 2. The override: a test or a sandboxed home chooses the place, and both
//    writers have to land in it. This is also what stops a tool from writing
//    into the reader's real cache.
{
  const s = scenario({ env: { DSH_MODEL_SCORE_CARD_CACHE_DIR: '/tmp/scorecard-override' } })
  const { cacheDir } = await s.mod
  const dir = cacheDir()
  check('the variable redirects the cache', dir === '/tmp/scorecard-override', dir)
  s.restore()
}

// 3. An override wins over the default even when the default would be usable.
{
  const s = scenario({ env: { DSH_MODEL_SCORE_CARD_CACHE_DIR: '/tmp/scorecard-override' } })
  const { cacheDir } = await s.mod
  check('the override is not merged with the default', !cacheDir().startsWith(s.home), cacheDir())
  s.restore()
}

// 4. An empty variable is an unset one — a shell that exports `VAR=` has not
//    chosen a place, and treating it as `~/.dsh` would write elsewhere silently.
{
  const s = scenario({ env: { DSH_MODEL_SCORE_CARD_CACHE_DIR: '' } })
  const { cacheDir } = await s.mod
  const dir = cacheDir()
  check('an empty variable falls through to the default', dir === join(s.cache, 'dsh-model-scorecard'), dir)
  s.restore()
}

// 5. Nothing is moved, whatever is already on disk. An existing store is used
//    as it stands: this module resolves a path, and a resolver that also
//    rearranges the filesystem is a second, silent writer in a plugin that has
//    no other one.
{
  const s = scenario()
  const cache = join(s.cache, 'dsh-model-scorecard')
  mkdirSync(cache, { recursive: true })
  writeFileSync(join(cache, 'fold-snapshot.json'), '{"snapshot":1}')
  const { cacheDir } = await s.mod
  const dir = cacheDir()
  check('an existing store is used where it is', dir === join(s.cache, 'dsh-model-scorecard'), dir)
  check('resolving moved nothing', readFileSync(join(cache, 'fold-snapshot.json'), 'utf8') === '{"snapshot":1}')
  check('and left no second directory behind', readdirSync(s.cache).length === 1, readdirSync(s.cache).join(' | '))
  s.restore()
}

console.log(failures === 0 ? '\nALL OK' : `\nFAILED: ${failures}`)
process.exitCode = failures === 0 ? 0 : 1