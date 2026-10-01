# AGENTS.md — working agreements for dsh-model-scorecard

Read this before changing anything in this repository.

## Language

**Answer this user in Russian, always.** The repository itself stays in English —
code, comments, README, commit messages — because that is cheaper in tokens.
The prose *to the person* is Russian; the artifacts are not. Do not translate
code comments into Russian to "match" the conversation.

## What this plugin is

A scorecard for every configured `(provider, model)` route, from three sources
that must not be confused with one another: what the DSH session event log says
the route delivered here, what its adapter declares about itself
(`lib/metadata.js`), and whether it answers right now (`lib/liveness.js`, only on
request). It exists to answer one question with data: **which of my configured
models should I use for this task?**

Three surfaces, one collector, so they cannot disagree:

| Surface | File | Consumer |
|---|---|---|
| Agent tool `model_stats` | `lib/index.js` → `collect.js` | the model |
| Panel route `GET /api/model-scorecard` | `client.js` → `collect.js` | the user |
| Liveness tool `model_liveness` | `lib/liveness.js` | the model |

The name moved with the package on 2026-10-01 (`dsh-model-stats` →
`dsh-model-scorecard`). The old route prefix is still mounted from the same
handler objects for one release, the old cache directory is renamed rather than
rebuilt, and the old `localStorage` key is read once — see *Renamed from
`dsh-model-stats`* in `README.md` before changing any of the four.

`README.md` is the authoritative metric table. A new metric is not done until
README documents it.

## Non-negotiables

1. **Zero runtime dependencies.** `lib/fold.js` in particular must stay
   dependency-free — it is imported by the verification tools and by anything
   that wants to fold a log without the plugin.
2. **No hook on the request or stream path.** Every figure is derived from
   events already committed to the log. If a metric seems to need live
   instrumentation, it is the wrong metric for this plugin — the liveness
   probe (`lib/liveness-http.js`) is the one sanctioned exception, and it goes
   through `ctx.llm` so a real request path is exercised.
3. **`ttft` and `llm` are not ours to redefine.** They reproduce the official
   `@deepseek-ai/dsh-session-stats` projection to the millisecond, and
   `tools/verify-official.mjs` asserts it. A new timing figure is a *new
   field*, never a redefinition of an existing one.
4. **Unmeasured is `null`, never `0`.** The panel renders `-`. A `0` is a
   measurement.
5. **A column that can be clicked must be sortable by the host.** Every panel
   heading needs a `SORT_KEYS` entry (`lib/fold.js`), a `PANEL_SORTS` entry
   (`lib/collect.js`), and a matching assertion in
   `tools/verify-panel-state.mjs`. Miss one and the host answers 400.
6. **Change the sample shape → bump `SNAPSHOT_VERSION`** (`lib/collect.js`).
   Without it an old snapshot serves rows that lack the new field, and a missing
   field reads as a zero.

## Non-critical problems go to the tech debt file

**While working, if you find a defect that is not the task you were given and
fixing it would cost more than the wrongness does, do not fix it and do not
ignore it — write one entry to `Plans/TECH-DEBT.md` and carry on.**

Format, newest first:

```
## D-NNN · `path:line` — one-line title

**What.** the defect, precisely enough that someone else can confirm it
**Why it is still here.** the cost of fixing it now
**Cost of leaving it.** what it costs while it stays — `-` if none
**To close it.** the concrete change that closes it
```

Rules for deciding:

- **Tech debt** — wrong but harmless, or right-but-ugly, or a latent sharp edge
  with no user-visible symptom today. A dead branch, an unused field, a
  fallback that is nearly always unnecessary, a measurement with a documented
  caveat.
- **Plan** — the defect changes a number the user reads, or blocks the task.
  Add it to `Plans/implementation-plan.md` as a numbered item with its
  measurement, and fix it.
- **Fix now** — it corrupts a figure, throws, or breaks a contract. Fix it and
  say so in the summary.

A default to tech debt is correct more often than it feels like it should be.
Recording the problem at full precision is what makes deferring it legitimate;
vagueness is what makes it rot.

`Plans/` is gitignored on purpose: it is local working state, not a deliverable.
The one thing that belongs in the repository is the conclusion — fold it into
the code comment, `README.md`, or `AGENTS.md` when the debt is closed.

## Style

- Comments explain **why**, and the measurement that decided it. "The official
  projection does X, so we do X" beats "matches the official projection".
  "A fragment is not a token: ~1.1 tokens per fragment for `deepseek-flash`
  and ~28 for `space-bunny-alpha`" beats "do not count fragments".
- No new dependencies, no build step, no framework. Plain ESM.
- **A cell renders through `ctx.fmt.*`, never through a raw `toFixed`/`Math`.**
  The formatters guard with `finite(value)`, so a missing field renders `-`. A
  hand-rolled `row.x.toFixed(1)` throws on `undefined` and takes the whole panel
  down — which is exactly what a host that predates the column sends. This is
  not hypothetical: it happened the first time a new column was added.
- Keep `fold.js` pure: no I/O, no clock, no `Date.now()`.
- Match the surrounding comment density. This codebase explains its
  decisions in the code; a new feature that arrives without that explanation is
  unfinished.
- User-facing strings exist in both `ru` and `en` (`client.js` holds both
  dictionaries inline; `locale/*.json` holds only plugin meta).

## Verify before you claim

```sh
node tools/verify-official.mjs        # ttft/llm == official projection, exact
node tools/verify-sort-order.mjs      # every order is total and stable
node tools/verify-panel-state.mjs     # every heading's sort key is host-accepted
node tools/verify-budget.mjs          # a bounded pass is still bounded
node tools/verify-provider-filter.mjs # a filter reaches the summary lines
node tools/verify-retry.mjs           # retry identity never goes negative
node tools/verify-configured-rows.mjs # a pair with no history is a row, and is ordered as one
```

A change that alters a number is not done until the tools that assert the old
numbers have been re-run and the new ones are in the summary. Quote real
figures, not round ones.
