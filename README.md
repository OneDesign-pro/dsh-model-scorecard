# dsh-model-scorecard

**English** · [Русский](README_ru.md)

A scorecard for every model you have configured in DeepSeek Harness. For each
`(provider, model)` pair it answers three separate questions: **how fast does it
work**, **how often does it fail**, and **does it answer at all right now**.

The point is to replace a guess with a measurement: *which of my configured
models should I use for this task?*

It answers from three sources, kept apart rather than blended into one number:

- **History.** DeepSeek Harness already writes a log of every session — which
  provider and model produced which answer, and when. This plugin folds those logs
  into per-model figures: time to first token, decode speed, token counts, tool
  errors, retries. Nothing is measured on the fly; the numbers are a replay of
  what already happened, and the plugin registers **no hook** on the request or
  stream path.
- **What the adapter declares.** Each provider's adapter can say what its model
  is — the context window, the default output cap, the accepted input types, the
  reasoning modes. Shown under **Подробнее** in the panel.
- **One live request, only when you ask.** A single tiny request through the same
  `ctx.llm` route a real request takes, to find out whether the provider answers
  right now. Nothing is polled on a timer.

A row the harness has never run is still a row: it wears «нет статистики» / **no
statistics**, every figure unmeasured, and the status circle that makes it
testable. A model the configuration no longer serves is hidden behind the
**archive** switch, so the table never recommends something nobody can run.

## Install

```bash
dsh plugin --profile web add link:/path/to/dsh-model-scorecard
```

Or through the plugin manager, pointing `install_bundle` at this directory. There
are no runtime dependencies and no build step.

The name is a dependency, because the install is a `link:`: pnpm resolves the
package from the key in the profile's `package.json` and the `id:` of the
composition row in `cordis.patch.yml`, and both have to say `dsh-model-scorecard`
for the plugin to be there at all. A key that says anything else is not a
degraded install — the Plugins page shows the row with nothing under it.

```bash
# ~/.dsh/profiles/web/package.json
#      "dsh-model-scorecard": "link:/path/to/dir",
#      ...                       "dsh-model-scorecard",     (dsh.profile.bundles)
# ~/.dsh/profiles/web/cordis.patch.yml — the id *is* the package name, no `name:` key
#      - id: model-scorecard
cd ~/.dsh/profiles/web && pnpm install
# restart DSH, and reload the browser tab completely
```

The link path does not have to match the name: pnpm installs a `link:` under
whatever key the profile gives it and reads the package's own `name` from
`package.json`. Renaming the directory to match is still worth doing, but it is
a separate step and not a condition of the install.

## Where to find it

Three surfaces, one collector, so they can never disagree:

1. **The panel** — Plugins → the `dsh-model-scorecard` bundle → its own page. A
   sortable table of every configured model, with the status circle and the rating
   in the first three columns; click any heading to sort by it, click again to
   reverse. The tree above the table selects which models the table is about, the
   filter narrows it to some providers, and **Подробнее** under a name explains
   that row in full.
2. **The `model_stats` tool** — the same numbers as plain text, for the agent.
3. **The `model_liveness` tool** — the availability check, from the agent's side.

The two tool names are global to DSH, not to this package, and are the same on
every plugin that provides them: that is why a tool called `model_stats` is how
you ask a *scorecard* a question. The panel's own bundle, its routes and its
cache all carry the package name instead.

`docs/panel.md` describes the panel in full: every column, the status circle, the
selection rule, the archive and the saved state.

## What it measures

Every figure below is folded from the recorded session history of one exact
`(provider, model)` pair.

| Metric | Meaning |
|---|---|
| `rating` | the technical rating of one `(provider, model)` pair, 0-100: streaming throughput, median and p90 first token, with the weight of a measurement halving every 30 days from the pair's newest usable one. `~` = thin evidence, `*` = the newest usable measurement is over 30 days old — the marks never change the number (see *The rating*) |
| `ttft` | time-to-first-token: `step/start` → first non-empty delta fragment. mean / median / min / max / p90 |
| `ttft_clean` | the same median with the time a step spent on failed attempts and backoff removed |
| `tps` | decode throughput in tokens/sec: the provider's own output-token count over the span it was streaming them |
| `e2e_tps` | the same tokens over the *whole* wait for the first answer — prefill included. This is the figure to choose a model by |
| `prefill` | share of that wait spent before the first token; per step, then median |
| `overhead` | time in the step that is neither the wait for the first token nor streaming — the part this host is responsible for |
| `tools/step` | tool calls per step, counted over *every* step the pair took — how much loop its work involves. A step that called nothing is a measured `0` |
| `tool_ms/step` | median wall time a step spent waiting for the tools it called, `tool/call` → `tool/result`, over the steps that called at least one; a pair whose steps need no tool shows `-`. It is the tool's time and not the model's, and the per-tool breakdown travels with the row |
| `turns` | how the conversation ended: `completed`, `error`, `aborted`, `max-tokens`, `interrupted`, and the share that did not complete |
| `llm_mean` | model wall time per step (`step/start` → `assistant/message`) |
| `cache%` | cache-read share of total input tokens |
| `out_tok` | total provider-reported output tokens |
| `err` | failed tool results, attributed to the model that raised them |
| `err/100` | the same, per 100 steps — a rate, so it measures quality rather than session length |
| `err_model` | the subset caused by the model's own output: a malformed tool call, or code that failed to run |
| `interrupted` | steps taken over or cancelled part-way |
| `retry%` | share of steps that needed a retry before they produced an answer |
| `speed_conf` | share of streamed steps long enough to be a reliable rate |
| `maxContextTokens` (JSON) | largest observed per-step sum of input, cache-read and cache-write tokens; not the model's supported context-window limit. Missing usage currently contributes zero, so zero does not establish an observed empty context |

`ttft` and `llm` reproduce the official `@deepseek-ai/dsh-session-stats`
`sessionStats` fold exactly. Verified field-by-field against the official
projection unit on a real log — identical to the millisecond.

`docs/metrics.md` is the argument behind the table: how each figure is
constructed, which choices could have gone the other way, and the measurement
that settled them.

### Reading the numbers

- **A `-` means "not measured", never "zero".** A model whose provider reports no
  token count shows `-`, not `0`. A step too short or too small to be a rate is
  excluded rather than guessed at.
- **Choose a model by `e2e_tps`, not by `tps`.** `tps` answers "how fast does it
  print"; `e2e_tps` answers "how fast do I get tokens". Over the corpus the median
  `prefill` share is **0.56** — more than half the wait for a first answer happens
  before the first token, and no streaming rate shows that.
- **An error count is not a verdict.** `err` includes every failed tool result,
  including the harness finding a file changed under it. `err_model` is the
  subset a different model choice would actually fix — on this history 282 of 783
  errors. Hover the cell for the per-code breakdown.
- **Read `retry%` together with `ttft_clean`.** A high `retry%` with a high
  `ttft_clean` is a genuinely slow model; a high `retry%` with a low one is a
  flaky route. The pair separates a provider having a bad day from a provider
  being unable to answer.
- **`overhead` is the only figure about this host**, not the provider. It is small
  in total — about 2% of model time — and it is the column to look at if the
  harness itself, rather than the model, is what feels slow.
- **Tool time belongs to the loop, not to the model.** `tool_ms/step` measures the
  tool, and the tool is whatever this model reached for: on this history a `bash`
  call averages **2.8 s** and an `ask_user_question` **519 s**, and the busiest
  pair spends **28 328 s** of its 64 922 s of tool time on the second one. Read the
  column as "what this model's tool usage costs an agent loop", and read the
  breakdown before reading anything else into it. It does not overlap `overhead`
  or `llm_mean`: the log closes a step at the model's message and the tool answers
  after it.
- **`maxContextTokens` is observed, not declared.** What a route *says* about its
  context window, its default output cap, its input types and its reasoning modes
  is a separate source, shown under **Подробнее** in the panel (see
  [`docs/panel.md`](docs/panel.md)).
- **Measurements depend on request size, reasoning mode and network.** The
  absence of retries does not prove the absence of network delay.

## The rating

Every other column is one reading, and the reader is left to weigh them. The
rating is the one figure that weighs them: a single 0-100 number for one exact
`(provider, model)` pair, computed from committed history alone — no clock, no
I/O, no DSH import — and published under a version (`technical-v1`), so a later
revision is a new formula rather than a silent drift of this one.

```
S = V50 / (V50 + 100)      generation throughput, half credit at 100 tok/s
L = 1 / (1 + T50 / 5000)   typical response,        half credit at 5 s
P = 1 / (1 + T90 / 15000)  slow response,           half credit at 15 s

score = 100 * S^0.45 * L^0.35 * P^0.20
```

A route sitting on all three anchors scores exactly 50, and the score is
monotonic: faster delivery, everything else held fixed, never lowers it.

| Mark | Means | Effect on the number |
|---|---|---|
| `~` | provisional: fewer than 30 effective samples, or fewer than 3 sessions | none |
| `*` | the newest usable measurement is older than 30 days | none |
| `-` | no score — one of `no_samples`, `no_qualified_samples`, `insufficient_samples`, `pair_only` | n/a |

Publication needs 10 qualified **and** 10 effective samples. A step whose span is
too short, too small or too fragmented to be a rate contributes to all three
factors or to none of them, so the factors always describe the same steps.

**What the rating is not.** Not intelligence, not correctness, not answer quality,
not price, not context capacity, not current reachability. A failed liveness probe
is deliberately not an input: a route you cannot reach right now keeps the score
its history earned, and the status column is where "right now" is answered.

`docs/rating.md` has the full policy — the anchors, the recency weighting, the
population, and what does and does not move a score.

## Is the model answering *now*

History answers how a model behaved. It cannot answer whether the provider is up
this minute, which is the question that decides what to run next. That is what
the **статус** column is: one probe per model, run when you ask for it.

A probe is the smallest possible call, sent **through `ctx.llm`** — the same
route, protocol, credentials, adapter and request shape a real request uses, and
no parameter of its own. A shape only this plugin sends would measure only this
plugin; a green circle here means the harness itself reached the model.

| Circle | Meaning |
|---|---|
| green | the model answered |
| grey | never probed |
| pulsing (accent) | a probe is running for this model right now |
| amber | the provider refused on a limit — the allowance is spent (*лимит исчерпан*) or the account is being throttled (*слишком часто*) |
| solid red | the check failed with nobody to answer it: a timeout, a dropped connection, a provider error. The cell prints the failure's own status when the panel has no word for it — *timeout*, *server*, *http_500*, *transport* |
| filled red square | the row is not configured, and the fix is on this side: *нет доступа* (the key was refused or is missing), *нет маршрута* (no endpoint is declared for the provider), *нет модели* (the provider does not know this model) |

The tone splits by **whose move it is**: amber is the account (a pause or a
top-up), a filled square is this side (a key, an endpoint, a model list), solid
red is theirs (wait or route around). A model that answered in the history *after*
a failed check is painted green and marked *по истории* — the failure is older
than the evidence.

| Where | What it probes |
|---|---|
| the circle in a row | that one model |
| **Проверить все** | every configured model, re-probing even a fresh answer |
| **Проверить выбранные** | the models ticked in the «Модели» tree, re-probing even a fresh answer |
| a provider row in the provider view | that provider's models |

A sweep over a hundred models is not one HTTP request: the host answers `POST`
immediately, keeps probing in the background four at a time, and the panel
follows `pending` down to zero over the ordinary `GET`. Results are stored
beside the fold snapshot and survive a restart.

```js
model_liveness()                            // every model with no fresh answer
model_liveness({ provider: 'openrouter' })  // one provider's models
model_liveness({ model: 'gemini-3.8-flash', provider: 'openrouter' })  // exactly one
model_liveness({ all: true })               // re-probe everything
```

```
status provider           model                        ms      source
OK     nvidia1            z-ai/glm-5.3-flash           130863  llm
OK     openrouter         google/gemini-3.8-flash      1501    llm
FAIL   openrouter         google/gemma-4-31b-it:free   526     llm  RATE_LIMIT 429: Rate limit exceeded: free-models-per-day
```

`docs/panel.md` has the classification in full: how a code becomes a state, how
the provider's own sentence is read, and how the status column sorts.

## The HTTP API

Two routes, for any client that is not the panel. `GET` is the older one and
still answers exactly as it did:

```
GET /api/model-scorecard?sort=&dir=&view=&provider=&archived=&limit=
```

`dir` is `asc` or `desc`, `provider` is a comma-separated list and may also be
repeated, `archived=1` asks for the archive and `limit` bounds the page at 200
rows. Anything else, including its absence, is the default of hiding the archive
and of a 50-row page.

`POST /api/model-scorecard/query` is the one that takes the selection. Its body is
a JSON object:

```json
{
  "sort": "ttft", "dir": "asc", "view": "model", "limit": 200, "archived": false,
  "selection": {
    "live":    { "base": "measured", "providers": { "codex": "all" }, "pairs": { "codex\u0000gpt-6-mini": "off" } },
    "archive": { "base": "none", "providers": {}, "pairs": {} }
  }
}
```

`selection` is `null` for "no policy at all" (the question `GET` answers) and a
rule document otherwise. A body that is not a JSON object, an unknown `sort`, a
`dir` outside `asc`/`desc`, a `limit` outside 1-2000, a non-boolean `archived`, a
malformed selection, a body over one megabyte or a method other than `POST` is
**refused with 400/405/413** rather than answered with a different question — a
host that half-reads a selection answers a question nobody asked.

### The selection is a rule, not a list

The panel's table is about the models you selected, and the selection is a
**rule**. The difference shows the morning after: under "all of this provider" a
model the configuration gained overnight appears in the next answer, while a list
of names captured yesterday would not name it.

A rule has two scopes, `live` and `archive`, and each scope three levels:

| Level | What it says |
|---|---|
| `base` | `measured` (every model with history), `all`, or `none` |
| `providers[name]` | `all`, `measured` or `none` for one provider |
| `pairs["provider\u0000model"]` | `on` or `off` for one model — the exception that outranks both |

Precedence is exactly that order, top to bottom: an explicit pair first, then the
provider's rule, then the scope's base. A first open uses
`{ live: { base: 'measured' }, archive: { base: 'none' } }` — every model that has
history and no retired one.

Four fields of the answer exist for the selection:

| Field | What it is |
|---|---|
| `selection` | the rule document the host applied, canonical — `null` when the question carried none |
| `catalog` | every model in scope with `{ model, archived, noStats, steps }`, for the tree |
| `coverage` | per provider, `{ selected, total }` — what "N of M models" is read from |
| `truncated` | `true` when the selection is larger than the page: the table is not the whole answer |

Both routes accept every column key of the table (`rating`, `steps`, `ttft`,
`speed`, `errors`, `lastSeen`, `name`, `ttftP90`, `tpsMax`, `confidence`, `llm`,
`cache`, `retry`, `ttftClean`, `e2e`, `prefill`, `overhead`, `errorRate`,
`modelErrors`, `interrupted`, `liveness`), while the agent tool `model_stats` uses
its curated six-order enum — the five it always had plus `rating`, with `steps`
still the default. An order nobody knows falls back to `steps` rather than
failing the request, and the answer echoes the order it really applied.

### Filtering by provider

Both surfaces can answer about some providers instead of all of them. The names
are exact, and several of them at once: `?provider=openrouter,codex` in a URL and
the same string (or a JSON array) as the tool's `provider`. A filter that matched
nothing is a question with an answer, not a reason to return the whole table: the
text report names the names it was asked for, and the answer keeps every provider
the report knows.

## Configuration

`cordis.patch.yml` inserts one row:

```yaml
- insert:
    - id: model-scorecard
      name: dsh-model-scorecard
      config: {}
```

The folded snapshot and every probe result live in
`~/.dsh/cache/dsh-model-scorecard/` — `fold-snapshot.json` and `liveness.json`.
Override the location with `DSH_MODEL_SCORE_CARD_CACHE_DIR`. The snapshot holds
folded samples only, never events, and is replaced atomically.

The panel's title, description and copy come from `locale/ru.json` and
`locale/en.json`, and its icon from `icon.svg`. The panel follows the GUI's own
language setting.

## Load on the Harness

**This plugin registers no hook on the LLM request or stream path.** It only reads
history: once in the background after activation, and then on demand.

Opening the panel is answered in three phases, cheapest first — the in-memory
fold, then the on-disk snapshot, then a bounded pass over only the sessions that
changed — so the table is never held behind a cold fold. **Every request is
bounded**: the panel's route at 2.5 s and the tool at 20 s, each returning what is
folded so far plus a `pending` count.

Measured on a real store (483 sessions / 34 586 steps), a fresh process answers
the whole corpus in **0.70 s with one log read**, against 33.2 s for a cold pass
with no snapshot.

`docs/load-and-cache.md` has the phase chain, the snapshot contract and the
browser-side budget in full.

## Verification

```bash
node tools/verify-rating.mjs    # the formula: the anchors, the weights, the population gate, the nulls
node tools/verify-rating-paths.mjs  # one pair, one score: cold fold, snapshot, selection and sinceMs agree; the marks match the panel's
node tools/verify-metadata.mjs  # route metadata: bounded, cached, unknown is null, and no probe behind it
node tools/verify-cache-dir.mjs  # the cache directory: the default, the override, and that resolving it touches nothing
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
node tools/verify-readme-parity.mjs  # README.md and README_ru.md are still one document
node tools/harness.mjs           # end-to-end drive through the plugin's real apply()
```

`docs/verification.md` lists what each tool actually asserts and how the suite
grew out of defects that no behavioural check could see.

## Using the `model_stats` tool

Registered globally, so it is available in every session:

```
model_stats(sort: "ttft")            # fastest median first token
model_stats(sort: "speed")           # fastest median decode
model_stats(sort: "errors")          # least stable first
model_stats(sort: "rating")          # the 0-100 technical rating, best first
model_stats(view: "provider")        # one row per provider, all its models folded together
model_stats(provider: "openrouter,codex")   # these providers only
model_stats(provider: ["openrouter"], sinceMs: <epoch-ms>)
model_stats(archived: true)          # plus the models the configuration no longer serves
```

Output is a plain-text table plus summary lines naming the fastest first token,
the fastest decode, and every model that produced errors. Every winner line
prints what it decided over — `fastest first token: … (46 ms) — over 28 sample(s)`
— and picks its winner only among rows carrying at least 20 samples of that
line's own figure.

## Further reading

| File | What it answers |
|---|---|
| [`docs/metrics.md`](docs/metrics.md) | how each column is measured, and which choice could have gone the other way |
| [`docs/rating.md`](docs/rating.md) | the rating policy: anchors, weights, population, marks, and what moves a score |
| [`docs/panel.md`](docs/panel.md) | the panel: columns, the status circle, the selection rule, the archive, saved state |
| [`docs/load-and-cache.md`](docs/load-and-cache.md) | the phase chain, the snapshot, the budgets, what is stored where |
| [`docs/verification.md`](docs/verification.md) | what each tool under `tools/` asserts, and the checks that took real traffic |
| [`COMPARISON.md`](COMPARISON.md) | against `dsh-usage-vendor-stats`, on the same real history |

These files are English-only by design: `README.md` and `README_ru.md` are the
two editions a reader gets, and everything below them is kept in the language
that keeps them cheapest to maintain.