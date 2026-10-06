#!/usr/bin/env node
// Rebuild the machine-local corpus the corpus verifiers fold.
//
// Usage: node tools/make-corpus.mjs [--out <dir>] [--sessions <dir>] [--clean]
//
// Why this is a tool and not a shell line: the corpus lives at `/tmp/dshcorpus`,
// `/tmp` is emptied by a reboot, and it has been emptied twice in this
// repository's history. The last manual rebuild on 2026-10-06 was wrong twice
// before it was right — a word-split `find` loop, then a `basename` that made
// two sessions of one workspace collide — and produced 26 files where 553
// belonged, which is a corpus that folds to no error and passes every assertion
// the three tools have. Every figure in `docs/verification.md`, in the comments
// of `lib/fold.js` and in `Plans/TECH-DEBT.md` is a claim about this directory,
// so building it has to be one command that says what it did and fails loudly
// when there is nothing to build.
//
// The rule, measured on this store on 2026-10-06:
//
//   * one log per session directory, and it is the *newest generation* in it;
//   * a generation is `session.jsonl.zstd` (the unversioned, older spelling) or
//     `session.vN.jsonl.zstd`, and the highest N wins. Fourteen directories hold
//     both spellings, and in all fourteen the numbered file is the newer one by
//     mtime, so the unversioned name is treated as version 0 and never beats a
//     numbered generation. This matters: 127 of the 563 session directories on
//     this store have only the unversioned spelling, and a rebuild that looked
//     for `session.v*.jsonl.zstd` alone would skip every one of them — 141 of
//     587 logs;
//   * the output name keeps both path components that identify a session,
//     `<workspace-slug>__<session-dir>.jsonl`, because the tools read the file
//     name back as the session id and a bare session directory collides: the
//     slug is what tells two `session-<uuid>` directories of different projects
//     apart. Uncompressed: this store's 563 logs are 906 MiB.
//
// The default output is the path all three corpus tools default to, so the
// common case is the bare command.

import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(name)
  return index === -1 || args[index + 1] === undefined ? fallback : args[index + 1]
}

const SESSIONS = resolve(flag('--sessions', join(homedir(), '.dsh', 'sessions')))
const OUT = resolve(flag('--out', '/tmp/dshcorpus'))
const CLEAN = args.includes('--clean')
const USAGE = 'usage: node tools/make-corpus.mjs [--out <dir>] [--sessions <dir>] [--clean]'

// The two spellings, and the unversioned one's version number. `session.lock`
// sits beside them and is not a log.
const LOG = /^session(?:\.v(\d+))?\.jsonl\.zstd$/

if (!existsSync(SESSIONS)) {
  console.error(`no session store at ${SESSIONS}`)
  console.error(USAGE)
  process.exit(1)
}

/** One log per session directory: the highest generation, and where it came from. */
const logs = new Map()
const versions = new Map()
for (const slug of readdirSync(SESSIONS)) {
  const slugPath = join(SESSIONS, slug)
  let sessions
  try {
    if (!statSync(slugPath).isDirectory()) continue
    sessions = readdirSync(slugPath)
  } catch {
    // A workspace directory the process cannot read is one session lost, not a
    // reason to abandon the other 562; the count printed at the end is what
    // makes the loss visible.
    continue
  }
  for (const session of sessions) {
    const dir = join(slugPath, session)
    let files
    try {
      if (!statSync(dir).isDirectory()) continue
      files = readdirSync(dir)
    } catch {
      continue
    }
    let best = null
    for (const file of files) {
      const match = LOG.exec(file)
      if (match === null) continue
      const version = match[1] === undefined ? 0 : Number(match[1])
      if (best === null || version > best.version) best = { version, file }
    }
    if (best === null) continue
    logs.set(`${slug}__${session}`, join(dir, best.file))
    versions.set(best.version, (versions.get(best.version) ?? 0) + 1)
  }
}

if (logs.size === 0) {
  // The failure the three tools already refuse to call a pass, said one step
  // earlier and with the path: a corpus of nothing satisfies every assertion
  // and reads as green.
  console.error(`no session logs under ${SESSIONS}`)
  console.error(USAGE)
  process.exit(1)
}

if (CLEAN && existsSync(OUT)) {
  // Resolved and checked *before* the delete, not after: a mistyped `--out`
  // would otherwise take a real directory with it.
  if (OUT === SESSIONS || OUT === homedir() || OUT === '/' || OUT.length < 5) {
    console.error(`refusing to clean ${OUT}`)
    process.exit(1)
  }
  rmSync(OUT, { recursive: true, force: true })
}
mkdirSync(OUT, { recursive: true })

let bytes = 0
for (const [name, source] of logs) {
  const target = join(OUT, `${name}.jsonl`)
  const fd = openSync(target, 'w')
  try {
    execFileSync('zstd', ['-dc', source], { stdio: ['ignore', fd, 'inherit'] })
  } finally {
    closeSync(fd)
  }
  bytes += statSync(target).size
}

const histogram = [...versions]
  .sort((a, b) => a[0] - b[0])
  .map(([version, count]) => `${version === 0 ? 'unversioned' : `v${version}`}×${count}`)
  .join(', ')
console.log(`sessions  : ${logs.size} log(s) from ${SESSIONS}`)
console.log(`generation: ${histogram}`)
console.log(`corpus    : ${OUT} (${logs.size} file(s), ${(bytes / 1048576).toFixed(0)} MiB)`)
console.log('next      : node tools/verify-retry.mjs')
