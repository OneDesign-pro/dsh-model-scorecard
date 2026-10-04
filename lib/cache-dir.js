// dsh-model-scorecard - where the folded snapshot and the probe store live.
//
// One resolution for both writers. The path used to be spelled twice, once in
// `collect.js` and once in `liveness.js`, under the same two rules: an
// environment override, otherwise `~/.dsh/cache/<package name>`. Two copies of
// one path is exactly the shape a rename turns into two half-renamed copies, so
// it is one function here and the two importers hold no path of their own.
//
// The directory is `~/.dsh/cache/dsh-model-scorecard` and nothing moves it.
// This plugin answered to another name once, and the `rename` that carried the
// store across was for one release. Keeping it would have meant a silent move
// of 15 MB the first time anything activated, in exchange for a reader who no
// longer exists; the honest version of the same care is a smaller module.

import { homedir } from 'node:os'
import { join } from 'node:path'

/** The cache directory's own name: the package's. */
export const CACHE_DIR_NAME = 'dsh-model-scorecard'

/** The variable that redirects the cache, for a test or a sandboxed home. */
const CACHE_DIR_ENV = 'DSH_MODEL_SCORE_CARD_CACHE_DIR'

/**
 * The override if one is set and non-empty, or null.
 *
 * Empty is unset: a shell that exports `VAR=` has not chosen a place, and
 * treating it as `~/.dsh` would write somewhere the caller did not mean.
 */
function override() {
  const value = process.env[CACHE_DIR_ENV]
  return typeof value === 'string' && value !== '' ? value : null
}

function defaultDir() {
  return join(homedir(), '.dsh', 'cache', CACHE_DIR_NAME)
}

/**
 * The directory both writers read and write.
 *
 * Pure on the filesystem: it resolves a path and does nothing else. Nothing in
 * the plugin creates it, removes it, or moves what is inside it.
 */
export function cacheDir() {
  return override() ?? defaultDir()
}