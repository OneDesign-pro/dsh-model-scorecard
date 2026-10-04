# Verification

Every figure and every contract in this plugin is asserted by a file under
`tools/`. They are plain ESM with zero dependencies and no test framework: run
them with `node`.

```bash
node tools/verify-rating.mjs    # the formula: the anchors, the weights, the population gate, the nulls
node tools/verify-rating-paths.mjs  # one pair, one score: cold fold, snapshot, selection and sinceMs agree; the marks match the panel's
node tools/verify-metadata.mjs  # route metadata: bounded, cached, unknown is null, and no probe behind it
node tools/verify-cache-dir.mjs  # the cache directory: the one-time move out of the previous name, and both variable names
node tools/verify-budget.mjs     # collection contract: bounds, one read per session, snapshot reuse
node tools/verify-sort-order.mjs # row order: median basis, error tie-break, missing metrics last, per-column keys, direction, the status order
node tools/verify-provider-filter.mjs  # the provider filter: one reading of it everywhere
node tools/verify-selection.mjs       # the selection: rules, catalog, and aggregates from selected steps only
node tools/verify-configured-rows.mjs  # rows built from the configuration: what a pair with no history is, and in what order
node tools/verify-panel-state.mjs # panel: a query switch never takes the rows off the screen, what the status circle may claim, and what it may not
node tools/verify-liveness.mjs   # liveness against the real LLM stack: a probe reaches a provider and reports what it found
node tools/verify-probe-budget.mjs  # the probe's deadline: the route's own declaration, else the host's default
node tools/verify-probe-shape.mjs   # the probe's shape and scope: through ctx.llm, and the pairs a reader named
node tools/harness-real.mjs      # the same collector driven against this machine's real store
node tools/verify-official.mjs   # field-by-field cross-check against sessionStats
node tools/verify-retry.mjs      # dead time is never negative, over every retry event in the corpus
node tools/per-model-speed.mjs   # decode vs streaming-span throughput per model
node tools/verify-tokens-per-fragment.mjs  # tok/s is tokens, not stream fragments
node tools/verify-tree.mjs   # what the package ships: a reachable lib/, an import that resolves, no leftover
node tools/verify-payload-consumers.mjs  # every field of the answer has a reader, and every reader a field
node tools/verify-winner-floor.mjs  # every winner line is picked on one shared floor and says what it decided over
node/tools/verify-readme-parity.mjs  # README.md and README_ru.md are still one document
node tools/harness.mjs           # end-to-end drive through the plugin's real apply()
```

Counts as they stand on 2026-10-03, all nineteen green (`exit=0`):

| tool | what it counts | checks |
|---|---|---|
| `verify-panel-state.mjs` | panel behaviour, driven through the shipped `client.js`: the answer's page, the cache budget, a group that spans both scopes | 374 |
| `verify-selection.mjs` | rules, catalog, an independent recomputation of the aggregate, and the deprecated route alias | 124 |
| `verify-sort-order.mjs` | every order is total, stable and discriminating | 87 |
| `verify-provider-filter.mjs` | one reading of the filter on every surface | 62 |
| `verify-rating.mjs` | the formula's arithmetic, exclusions, weighting, nulls | 60 |
| `verify-metadata.mjs` | bounded lookups, TTL, dedup, disposal, the whitelist | 60 |
| `verify-budget.mjs` | the collection contract, and the panel's phase chain | 54 |
| `verify-rating-paths.mjs` | the same pair scored identically down every path | 41 |
| `verify-winner-floor.mjs` | that every winner line is picked on one shared floor and prints what it decided over | 32 |
| `verify-configured-rows.mjs` | what a pair with no history is | 31 |
| `verify-payload-consumers.mjs` | that every field of the answer has a reader, and every reader a field | 23 |
| `verify-liveness.mjs` | the catalog join and the state classification; a live walk, so its count moves with what the stack answers | 20 |
| `verify-cache-dir.mjs` | the one-time move of the cache directory, and both variable names | 16 |
| `verify-probe-shape.mjs` | probe shape, named pairs, the cap | 14 |
| `verify-probe-budget.mjs` | the deadline rule, and the body the fallback posts | 14 |
| `verify-tree.mjs` | what the package ships: imports, orphans, leftovers, empty files | 7 |

That is 1 019 counted assertions in the sixteen tools that print a count, and 20 of
them are the live walk of `verify-liveness.mjs` — it prints one check per probed pair
until one answers and three more once one does, so that row reads 20, 21 or 22
depending on the run (20 on 2026-10-03, which is why the number here is dated). The
other three assert by exhaustive comparison instead — `verify-official.mjs` field by
field against the official projection, `verify-retry.mjs` over every retry event
in the corpus, and `verify-tokens-per-fragment.mjs` over 21 715 folded steps of
20 models. `verify-retry.mjs` reads a real corpus and takes its path as its first
argument, defaulting to `/tmp/dshcorpus` (183 sessions here) — a missing corpus
is an inability to run, never a pass.

## The panel test

`tools/verify-panel-state.mjs` drives the shipped panel through the tree itself:
a first open asking for the default rule and nothing else, a partial provider
drawn as an indeterminate control with a number beside it, a group click written
as a rule and not as a list, one model under a provider-wide rule written as a
single exception and removed again when the tick comes back, the mass buttons
independent of the search, an empty selection and the way back from it, the
selection surviving a closed tab, a v1 provider filter migrating into rules while
an *empty* one keeps meaning "no filter", the archive returning the marks it
holds, a request that failed keeping the table, an answer to the previous
selection not being passed off as the current one, the truncation notice and the
page it raises, and a browser that refuses to store anything still working in
memory and saying so.

The client half is browser-only and has no build step or importer, so the test
runs `client.js` in a context whose module loader, `localStorage`, `fetch`, timers
and React are replaced with the smallest fakes that can drive the registered
section: it clicks the column headings and the provider checkboxes and asserts
what the tree contains — including that every heading's sort key is one the
host's route actually accepts, checked against the imported `PANEL_SORTS`.

Its contract is one line — **rows already on screen are never replaced by a
message**. Switching the sort used to blank the table and, when that request was
slow or was aborted by the next click, the rows did not come back on their own.
The test fails on ten checks if that behaviour returns.

## Two tests exist because a defect was invisible

**`tools/verify-tree.mjs`** answers what would actually be published. Every other
tool answers a question about behaviour; this one answers a question about the
package itself, because the answer was once wrong in a way no behavioural check
can see. Two older copies of the liveness layer sat in `lib/`, and
`package.json`'s `files` list ships that whole directory, so the tarball carried
three implementations of a module the README says there is one of — while the
panel worked, the numbers were right, and a grep for the liveness layer returned
two plausible files. The test resolves every relative import, requires every
module under `lib/` to be reachable from the two entry points, and refuses an
editor leftover, an empty file and a module at the root other than `client.js`.

**`tools/verify-payload-consumers.mjs`** answers the same question about the
answer. `toPanelPayload` emitted `providerList`, `complete`, `fromSnapshot`,
`generatedAt` and `empty`; `client.js` named none of the five; and
`tools/verify-provider-filter.mjs` spent thirteen lines asserting the first, which
is what kept it alive — the test was its only reader, and a test asserting a field
nobody reads passes forever. The test calls `toPanelPayload` over a fixture for
each branch and fails on any key the panel does not name, then runs the other way
and fails on any name the panel reads that the payload never had. Both directions
strip comments and string literals first, so a key that survives only inside a
translation dictionary does not count as a reader.

## Tests that mount the real thing

`tools/harness.mjs` and `tools/harness-real.mjs` mount the shipped
`session-persistence-jsonl` and `session-query` plugins the way the composition
does, so the numbers they print include the cost that lives inside them. The real
one writes its snapshot to a temp directory and only ever reads the real store.

`tools/verify-liveness.mjs` is the one test that spends provider traffic — one
short probe request per probed model, stopping at the first model that answers. It
mounts the real `LlmRuntime`, the real credential store and the real provider
adapter rather than stubbing `ctx.get`, and that is the whole point: the bug this
file exists to catch was `ctx.llm` being read while the plugin never declared
`llm` among its injected services, so every probe failed in zero milliseconds with
`cannot get property "llm" without inject`. A test that hands the plugin the
service the host refuses cannot see that class of failure at all. Its first
assertion is therefore the contract itself — every service the code reads is a
service the plugin declares.

`tools/verify-probe-budget.mjs` proves the deadline rule without spending provider
traffic: a local server answers just past the 15 s deadline the probe used to have
and the probe still records an answer, a route that declares a 400 ms deadline of
its own is aborted at exactly that, and a caller's explicit `timeoutMs` still wins.
It also records every request body the local server is sent and asserts what the
fallback posts — the model, one short turn, no stream — and that it posts **no
token cap of its own**. That cap was the same defect the `ctx.llm` probe had one
transport over: `max_tokens` is a field name each model spells for itself
(`max_completion_tokens` against `max_tokens`), reasoning models of the gpt-5
family refuse it by name, and a route that answers every real request was read as
refused. A `ping` is short whatever ceiling the route chooses.

## A pass has to state its own volume

`verify-official.mjs` picks its own session and holds it to the same rule. It
compares the largest settled log that contains a completed step, and when no
candidate does it prints `FAIL: no candidate session contains a completed step`
and exits 1. An exact comparison of two zeros is not a parity result: before that
rule the tool took whichever log `readdirSync` returned first, and on 2026-10-01
that was a five-event session with no step in it, so every field was 0, every
diff was 0, and the tool printed OK. A pass now states its own volume —
`684 timed step(s), 6932919 ms of time-to-first-token` — so a hollow run cannot
be filed as evidence. The `steps` row stays outside the equality check, because
the official counter counts assembled messages and this one counts `step/end`; in
the log compared on 2026-10-01 — 4 581 events, 684 timed steps, 6 932 919 ms of
time-to-first-token, 8 867 157 ms in a model call — the two step counters differ by
3 out of 687, and every timing total is equal to the millisecond.