// The cache directory's one-time move, asserted against a fake home.
//
// The module under test is the only thing in the plugin that renames or moves
// anything a reader owns, and it does it once, silently, on the way to the first
// answer. That combination is what this file exists for: there is no other
// moment at which a mistake shows up, and a mistake here costs a 15 MB re-fold
// and a probe store that has to be rebuilt with real provider traffic.
//
// Each case gets a fresh module instance, because the one-time flag and the note
// are per-process state and a single instance could only ever prove the first
// case.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label, condition, detail = '') {
  const mark = condition ? 'OK  ' : 'FAIL'
  if (!condition) failures += 1
  console.log(`${mark} ${label}${detail ? ` — ${detail}` : ''}`)
}

let instance = 0
/** A fake `$HOME` and a fresh copy of the module, with the env cleared. */
function scenario({ env = {}, legacyDir = true, current = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'scorecard-home-'))
  const cache = join(home, '.dsh', 'cache')
  if (legacyDir) {
    mkdirSync(join(cache, 'dsh-model-stats'), { recursive: true })
    writeFileSync(join(cache, 'dsh-model-stats', 'fold-snapshot.json'), '{"legacy":true}')
    writeFileSync(join(cache, 'dsh-model-stats', 'liveness.json'), '{"probes":1}')
  }
  if (current) {
    mkdirSync(join(cache, 'dsh-model-scorecard'), { recursive: true })
    writeFileSync(join(cache, 'dsh-model-scorecard', 'fold-snapshot.json'), '{"current":true}')
  }
  const saved = { HOME: process.env.HOME, NEW: process.env.DSH_MODEL_SCORE_CARD_CACHE_DIR, OLD: process.env.DSH_MODEL_STATS_CACHE_DIR }
  process.env.HOME = home
  delete process.env.DSH_MODEL_SCORE_CARD_CACHE_DIR
  delete process.env.DSH_MODEL_STATS_CACHE_DIR
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

// 1. Nothing to move: the default is the current name, and a reader who never
//    had the old one is told nothing.
{
  const s = scenario({ legacyDir: false })
  const { cacheDir, takeMigrationNote } = await s.mod
  const dir = cacheDir()
  const note = takeMigrationNote()
  check('default is the current cache directory', dir === join(s.cache, 'dsh-model-scorecard'), dir)
  check('a first run says nothing', note === null, String(note))
  s.restore()
}

// 2. The real upgrade: the old directory is renamed, both files come with it, and
//    the note names the move. A copy would have doubled 15 MB; a re-fold would
//    have cost the corpus.
{
  const s = scenario()
  const before = readFileSync(join(s.cache, 'dsh-model-stats', 'liveness.json'), 'utf8')
  const { cacheDir, takeMigrationNote } = await s.mod
  const dir = cacheDir()
  const note = takeMigrationNote()
  check('the old directory is gone', !existsSync(join(s.cache, 'dsh-model-stats')))
  check('the new one exists', existsSync(join(dir, 'liveness.json')))
  check('the probe store arrived byte for byte', readFileSync(join(dir, 'liveness.json'), 'utf8') === before)
  check('the note says which way it went', typeof note === 'string' && note.includes('->'), String(note))
  check('the note is taken once', takeMigrationNote() === null)
  s.restore()
}

// 3. Both directories exist — two versions of the plugin have both been run. The
//    new one wins, the old one is left alone, and nothing is merged: a merged
//    probe store would attribute one version's results to the other.
{
  const s = scenario({ current: true })
  const { cacheDir, takeMigrationNote } = await s.mod
  const dir = cacheDir()
  const note = takeMigrationNote()
  check('the current directory is used', dir === join(s.cache, 'dsh-model-scorecard'))
  check('the old one is left in place', existsSync(join(s.cache, 'dsh-model-stats', 'liveness.json')))
  check('the current snapshot is the one served', readFileSync(join(dir, 'fold-snapshot.json'), 'utf8') === '{"current":true}')
  check('the note names both', typeof note === 'string' && note.includes('both'), String(note))
  s.restore()
}

// 4. An override is a place the caller chose: nothing is moved, whatever is on
//    disk. This is also what keeps a test from renaming the reader's real cache.
{
  const s = scenario({ env: { DSH_MODEL_STATS_CACHE_DIR: '/tmp/scorecard-override' } })
  const { cacheDir, takeMigrationNote } = await s.mod
  const dir = cacheDir()
  check('the previous variable name still redirects the cache', dir === '/tmp/scorecard-override', dir)
  check('an override suppresses the move', existsSync(join(s.cache, 'dsh-model-stats', 'liveness.json')))
  check('an override says nothing', takeMigrationNote() === null)
  s.restore()
}

// 5. Both variables set: the current name wins, and the order is not left to a
//    reader of the source to remember.
{
  const s = scenario({
    env: { DSH_MODEL_STATS_CACHE_DIR: '/tmp/old-override', DSH_MODEL_SCORE_CARD_CACHE_DIR: '/tmp/new-override' },
  })
  const { cacheDir } = await s.mod
  const dir = cacheDir()
  check('the current variable wins over the previous one', dir === '/tmp/new-override', dir)
  s.restore()
}

// 6. An empty variable is an unset one — a shell that exports `VAR=` has not
//    chosen a place, and treating it as `~/.dsh` would silently write elsewhere.
{
  const s = scenario({ env: { DSH_MODEL_SCORE_CARD_CACHE_DIR: '', DSH_MODEL_STATS_CACHE_DIR: '' } })
  const { cacheDir } = await s.mod
  const dir = cacheDir()
  check('an empty variable falls through to the default', dir === join(s.cache, 'dsh-model-scorecard'), dir)
  s.restore()
}

console.log(failures === 0 ? '\nALL OK' : `\nFAILED: ${failures}`)
process.exitCode = failures === 0 ? 0 : 1
