# Load, cache and storage

## No hook on the request or stream path

**This plugin registers no hook on the LLM request or stream path.** It only
reads history: once in the background after activation, and then on demand.
Nothing runs on a timer and the panel never polls — the client only re-asks
while the host reports work still moving. A metric that seemed to need live
instrumentation was the wrong metric for this plugin; the one sanctioned
exception is the liveness probe, and it goes through `ctx.llm` so a real request
path is exercised.

## Three phases, cheapest first

Opening the panel is answered in three phases, cheapest first, so the table is
never held behind a cold fold:

1. **The in-memory fold.** This process has folded the whole corpus, so the route
   answers from memory in milliseconds without touching the store. A session
   counts as folded here when this process read it, or accepted its snapshot
   entry after comparing that entry's revision against the listing this process
   made — which is how a host that restarts onto a complete snapshot answers the
   whole corpus at once instead of only the handful of logs it had to re-read. A
   process that has not finished such a pass declines and phase 2 serves it, so
   neither an unchecked disk snapshot nor a delta can become the fast answer.
2. **The on-disk snapshot.** A fold written by an earlier process is validated
   against **one** corpus listing — revisions only, no log is read — and unchanged
   logs are served from it as they are. A snapshot that cannot vouch for every
   session still answers with the ones it can, names the rest, and hands their ids
   to the next phase.
3. **The folding pass.** Exactly those sessions are read, bounded, reusing the
   listing phase 2 already made. One listing decides for every session whether its
   snapshot entry may be reused, so a repeat pass reads nothing at all, and a
   changed log is the only log read.

## What the progress fields count

Phase 3 is the phase that can misreport itself. It is asked for the handful of
sessions phase 2 could not vouch for, reads those, and then re-gathers **every
listed session** from the cache — because the caller is replacing an answer
computed from exactly that cache. So one pass has two honest sizes, and the panel
footer's first part prints only one of them:

- **`scanned`** — the sessions whose fold is in *this answer*, which on the
  follow-up pass is the whole listing it could gather and not the ids it was asked
  for. Measured on the phase-chain fixture as 41 sessions in the answer against a
  2-log read, and on this machine's store as **548 of 552** with `readNow=1`: a
  footer printing the ask there says "sessions in report: 1" under a table folded
  from nearly five hundred, which is what it did before the recount.
- **`readNow`** — what the pass took off disk. This is the field that says how
  expensive the request was, and it is the one the client uses to decide whether
  work is still moving.
- **`skipped`** — sessions the pass tried and could not fold, and **`pending`** —
  the ones a deadline left for the next pass. On the run above the three account
  for the listing exactly: 548 folded + 4 unreadable logs = 552.

`tools/verify-budget.mjs` asserts the first of these on the follow-up path. The
label is the contract: a footer that says "sessions in report" and counts the ask
is invisible in every other figure on the screen, so nothing but that check ties
the two together.

## What counts as "changed"

One log's own file identity — `dev:ino:size:mtime:ctime` — and nothing else.
Older log generations also carry a corpus-wide hash behind it, computed over
*every* old-format log on the machine, so it moves as soon as any one of them is
written; measured against this machine's store on 2026-10-01, comparing whole
revisions made **195 of 483 sessions** read as changed while not one of their own
logs had been written, and the hash moved again between two measurements taken
minutes apart. That hash is stripped on the way in, which is why a snapshot
written before this rule existed still hydrates into the same keys.

## Bounds

- **Every request is bounded**, so a first-ever run on a large store never blocks
  an HTTP request for minutes: the panel's route is capped at 2.5 s and the tool
  at 20 s, and both return what is folded so far plus a `pending` count.
- One background warm pass folds the whole corpus right after activation and then
  writes the snapshot.
- Each session is folded once per process and cached against its persistence
  revision; the revision comes from the corpus listing rather than a per-session
  `stat`, which is what keeps a cold pass linear instead of quadratic.
- All services are injected (`tools`, `webServer`, `sessionQuery`), and every read
  failure is contained and reported as a skipped session.
- Zero runtime dependencies, import-free host half apart from this package's own
  modules.

## Measured

With `tools/harness-real.mjs` against this machine's real store (**483 sessions /
34 586 steps / 70 model identities**, ~22 % of logs still in the legacy v3
format), on 2026-10-01:

| | |
|---|---|
| cold full corpus (first pass, no snapshot) | 33.2 s, 479 logs read |
| repeat pass, nothing changed | 0.48 s, 0 logs read |
| fresh process, snapshot status check | 0.18 s |
| fresh process, answer from snapshot | 0.15 s, 0 logs read, 478 of 483 sessions |
| fresh process, **the whole phase chain** | **0.70 s, 1 log read** |
| same, before the phase chain was fixed | 32.7 s, 479 logs re-read |

The last two rows are the same question — what the panel shows a host that has
just started — and the difference is the point: five sessions were missing or
changed, and the answer now costs one read instead of re-reading everything.

## What the snapshot stores, and where

The snapshot lives in `~/.dsh/cache/dsh-model-scorecard/fold-snapshot.json`
(override with `DSH_MODEL_SCORE_CARD_CACHE_DIR`). It holds folded samples only —
never events — and is replaced atomically, so a crash mid-write cannot leave a
half snapshot behind.

`snapshotStatus()` names what it could not vouch for, rather than only counting
it: the payload carries `covered`, `stale`, `uncovered`, `fresh`, and up to eight
`mismatches` of `{ id, reason, stored, current }` with `reason` one of `uncovered`
(never seen), `no-entry` or `changed`, plus `mismatchesOmitted` for the rest. On
the run above it answered `covered: 478, stale: 1, uncovered: 4` and named all
five — one session still being written and four the backend cannot decode
(`subagent/descriptor … unsupported descriptor version 2`, which the fold reports
as skipped sessions rather than as missing ones).

Probe results are written to `liveness.json` next to the fold snapshot and
survive a restart.

## The browser's own budget

The browser keeps the last answer per question in `localStorage`, so the table
appears instantly after a reload and refreshes behind the first paint. The store
is trimmed by **bytes**, not by a number of keys: this panel's own answer measures
183 KB for 141 rows, so a row is ~1.3 KB, a default page is ~260 KB and the 2000
rows «Показать все» may buy are ~2.5 MB — against a 5 MB origin quota shared with
the rest of the GUI. The budget is 2 MB, newest first, and an answer larger than it
is not stored at all rather than evicting the answers that fit.

## How long a fold takes

Over the same corpus the rating report came from (183 session logs read, of which
174 carry a timed step, 18 637 timed steps, 37 model rows over 13 providers), a
cold fold and aggregate of the whole corpus takes 87 ms — the median of five fresh
processes, and 78 ms for the same measurement before the rating existed. The
rating itself is 6.7 ms of that, measured alone over the same 18 637 samples in 37
pairs; the rest is the fold's eligibility pass and the panel payload carrying the
new object (45.0 KB → 65.2 KB of JSON).