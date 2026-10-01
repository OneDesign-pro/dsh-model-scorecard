// dsh-model-scorecard - where the folded snapshot and the probe store live.
//
// One resolution for both writers. The path used to be spelled twice, once in
// `collect.js` and once in `liveness.js`, under the same three rules: an
// environment override, otherwise `~/.dsh/cache/<package name>`. Two copies of
// one path is exactly the shape a rename turns into two half-renamed copies, so
// it is one function here and the two importers hold no path of their own.
//
// The directory moves with the package. It held 15 MB of folded samples and
// every probe result this installation has, so the move is a `rename`: leaving
// the old directory behind would cost a cold fold of the whole corpus (22.4 s
// measured on this machine) and a re-sweep that spends real provider traffic to
// rediscover what the store already knows. A rename reads no file and deletes
// none — the bytes keep their content and only the directory's name changes.
//
// Three cases, all of which leave the user's data exactly where it was:
//   - the new directory already exists — it is used, the old one is left alone
//     and the note says so. Two versions of the plugin have both been run; the
//     new one's store is the live one and nothing is merged, because a merged
//     probe store would attribute one version's results to the other.
//   - an environment override is set — nothing is moved. The override is a place
//     the caller chose, and a test that redirects the cache must not be able to
//     rename the real one.
//   - neither — the old directory is renamed into place and reported.

import { existsSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The cache directory's own name: the package name, unchanged since. */
export const CACHE_DIR_NAME = 'dsh-model-scorecard'

/** The name this plugin answered to before 2026-10-01, and where its cache is. */
const LEGACY_CACHE_DIR_NAME = 'dsh-model-stats'
/** Renamed with the package. The old variable still redirects the whole cache. */
const CACHE_DIR_ENV = 'DSH_MODEL_SCORE_CARD_CACHE_DIR'
const LEGACY_CACHE_DIR_ENV = 'DSH_MODEL_STATS_CACHE_DIR'

/** The first non-empty of the two variables, or null when neither is set. */
function override() {
  for (const key of [CACHE_DIR_ENV, LEGACY_CACHE_DIR_ENV]) {
    const value = process.env[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return null
}

function defaultDir() {
  return join(homedir(), '.dsh', 'cache', CACHE_DIR_NAME)
}

let moved = false
let note = null

/**
 * The directory both writers read and write, migrating the previous name's
 * directory once per process on the way.
 */
export function cacheDir() {
  if (!moved) migrate()
  return override() ?? defaultDir()
}

/**
 * What the migration did, once, for the activation log.
 *
 * The move is not an event a reader needs, but a *failed* move is: the plugin
 * then re-folds the corpus from scratch and re-probes every model the reader
 * had already checked, and the reason is not visible anywhere else. The note is
 * taken rather than logged from here because this module is imported by the
 * verification tools, which have no logger.
 */
export function takeMigrationNote() {
  const taken = note
  note = null
  return taken
}

function migrate() {
  moved = true
  if (override() !== null) return
  const from = join(homedir(), '.dsh', 'cache', LEGACY_CACHE_DIR_NAME)
  const to = defaultDir()
  if (!existsSync(from)) return
  if (existsSync(to)) {
    note =
      `${CACHE_DIR_NAME}: both ${from} and ${to} exist; the new one is used and the old ` +
      'directory is left in place. Nothing was merged — delete it yourself once you are ' +
      'sure the old version is gone.'
    return
  }
  try {
    renameSync(from, to)
    note = `${CACHE_DIR_NAME}: moved the cache directory ${from} -> ${to}`
  } catch (error) {
    note =
      `${CACHE_DIR_NAME}: could not move ${from} -> ${to} (${String(error?.message ?? error)}). ` +
      'The corpus will be folded again into the new directory, and every stored probe ' +
      'result is gone, so a status sweep will have to re-check the models.'
  }
}
