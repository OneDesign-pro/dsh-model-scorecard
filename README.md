# dsh-model-stats

Historical per-model and per-provider performance analytics for DeepSeek Harness,
folded from the session history the Harness already writes.

The point is to answer one question with data instead of guesswork: **which of my
configured models should I use for this task?** For every `(provider, model)`
pair it reports one 0-100 technical rating, and the readings that rating is made
of — how fast the model responds, how fast it decodes, how much work it did, and
how often it failed.

## What it measures

| Metric | Meaning |
|---|---|
| `rating` | the technical rating of one `(provider, model)` pair, 0-100: streaming throughput, median and p90 first token, with the weight of a measurement halving every 30 days from the pair's newest usable one. `~` = thin evidence, `*` = the newest usable measurement is over 30 days old — the marks never change the number (see *The rating*) |
| `ttft` | time-to-first-token: `step/start` → first non-empty delta fragment. mean / median / min / max / p90 |
| `ttft_clean` | the same median with the time a step spent on failed attempts and backoff removed |
| `tps` | decode throughput in tokens/sec: the provider's own output-token count over the span it was streaming them |
| `e2e_tps` | the same tokens over the *whole* wait for the first answer — prefill included. This is the figure to choose a model by |
| `prefill` | share of that wait spent before the first token; per step, then median |
| `overhead` | time in the step that is neither the wait for the first token nor streaming — the part this host is responsible for |
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

### What a retry costs, and why `delayMs` is not it

`llm/retry` records the failure, the backoff the policy chose (`delayMs`), and
then the next attempt. The time the *failed attempt itself* took is not in
`delayMs`, and on this history it is usually the larger half: Σ`delayMs` over
every retried step is 634 s, while the wall time those steps actually burned is
11 201 s. Quoting the sleep as "retry cost" would understate the real thing by
about 18x.

So the dead time is measured as a difference of two log timestamps:

```
deadMs = time(last `llm/retry-started`) − time(first `llm/retry`)
```

Everything from the first recorded failure until the moment the winning request
actually left is dead by construction — the failed attempts plus every backoff
sleep — and the winning request is excluded, which is what makes
`ttft_clean = ttft − deadMs` a real time-to-first-token rather than the
subtraction of two unrelated quantities. Over the corpus the result is never
negative (0 of 437 recovered retried steps); `node tools/verify-retry.mjs`
re-asserts that over every session log it can find.

Reading the pair is the point. `retry%` says how often the provider made the
harness try again; `ttft_clean` says what the model did once it was allowed to
answer. A high `retry%` with a high `ttft_clean` is a genuinely slow model; a
high `retry%` with a low one is a flaky route. Measured here:

| model | steps | retry% | ttft med | ttft clean | recovered | gave up | dominant code |
|---|---|---|---|---|---|---|---|
| limitdeckai2/glm-5.3-flash | 648 | 19.6% | 8300 ms | 7953 ms | 97% | 4 | `SERVER` ×229 |
| limitdeckai2/deepseek-v4-flash | 1670 | 12.1% | 7730 ms | 7620 ms | 96% | 9 | `SERVER` ×296 |
| tokenator/free-gpt-6-astra | 170 | 5.9% | 17490 ms | 17490 ms | 67% | 5 | `RATE_LIMIT` ×25 |
| nvidia1/z-ai/glm-5.3-flash | 603 | 5.5% | 97953 ms | 97953 ms | 77% | 10 | `TIMEOUT` ×60 |
| deepseek-official/deepseek-flash | 9946 | 0.1% | 1933 ms | 1932 ms | 85% | 2 | `TRANSPORT` ×21 |

Two different faults, and the codes separate them: `SERVER` storms are a
provider-side 5xx that the retry heals (94–97% recovery on `limitdeckai2`),
while `TIMEOUT` is a patience problem and heals worse (75–77%). `nvidia1/z-ai`
retries rarely enough that the dead time does not move its median at all — its
97-second first token is the route, not the backoff.

A step whose retries never produce a message emits no sample, so it is counted
separately as `retryFailedSteps`; that is what gives the recovery rate a
denominator. Its provider is exact (`llm/retry` names it) and its model is
attributed only when that provider had already spoken in the same session —
114 of 994 retry events on 26 exhausted steps stay unattributed rather than
guessed onto a model row.

### An error count is not a verdict

`err` is the total, and it is the wrong number to decide on. The two largest
codes in this history are `FS_EDIT_NOT_FOUND` (239) and `INVALID_ARGS` (233) —
the same order of magnitude, and nothing alike. One is the harness finding the
file changed under it; the other is the model emitting arguments its own schema
rejects. Only the second is fixed by choosing a different model.

So every row carries the breakdown, in two layers: the raw `code` and a coarse
`category` chosen for what a reader can do about it.

| category | means | count | what is in it |
|---|---|---|---|
| `state_race` | the tool found the file changed under it | 452 | `FS_EDIT_NOT_FOUND` 239, `FS_STALE_VERSION` 111, `FS_NOT_OBSERVED` 80, … |
| `bad_call` | the model named a tool or arguments that do not exist | 260 | `INVALID_ARGS` 233, `UNKNOWN_TOOL` 18, … |
| `provider` | the service behind a tool failed | 22 | `WEB_PROVIDER_ERROR` 20, … |
| `code_failed` | the model's own program failed to run | 22 | `CODE_RUN_FAILED` 22 |
| `denied` | the sandbox or a policy refused | 15 | `FS_SANDBOX_DENIED` 15 |
| `harness` | harness bookkeeping | 8 | `TEAM_*` 7, `GOAL_NOT_FOUND` 1 |
| `other` | a code this table has never seen — counted, and named | 4 | `NOT_RESUMABLE` 2, `ABORTED` 1, … |

`err_model` is `bad_call + code_failed`: 282 of 783 errors, 36%. The raw count
and this one do not agree on the size of the gap by any useful margin:

| model | steps | err | err/100 | **err_model** | dominant code |
|---|---|---|---|---|---|
| limitdeckai2/deepseek-v4-flash | 1670 | 321 | 19.2 | **189** (11.3/100) | `INVALID_ARGS` ×160 |
| limitdeckai2/glm-5.3-flash | 648 | 137 | 21.1 | **55** (8.5/100) | `FS_EDIT_NOT_FOUND` ×76 |
| nvidia1/z-ai/glm-5.3-flash | 603 | 28 | 4.6 | **6** (1.0/100) | `FS_STALE_VERSION` ×10 |
| deepseek-official/deepseek-flash | 9946 | 160 | 1.6 | **19** (0.19/100) | `FS_NOT_OBSERVED` ×48 |
| openrouter/stealth/space-bunny-alpha | 2371 | 58 | 2.4 | **2** (0.08/100) | `FS_STALE_VERSION` ×23 |
| nvidia1/deepseek-ai/deepseek-v4.1-flash | 1071 | 31 | 2.9 | **0** | `FS_*` ×31 |

`deepseek-flash` has half the errors of `limitdeckai2/deepseek-v4-flash` — a
factor of two — and one tenth of the model-attributable ones, a factor of ten.
`nvidia1/deepseek-ai/deepseek-v4.1-flash` has 31 errors and **zero** of them
are the model's doing: every one is the filesystem. No model choice would have
moved that row.

The panel prints the breakdown in the `err` cell's tooltip (codes, categories,
and the model-attributable count), and the `model_stats` text report prints it
per model with the same note. Hovering is the right place for it: the total is
a number on screen, and whether it is a fault of the model or of its
surroundings is the question a reader already has when looking at it.

`interrupted` was folded for a long time and displayed by nothing: 9 steps for
`deepseek-flash`, 7 for `nvidia1/z-ai/glm-5.3-flash`, 1 for nine other models.
Not a model error and not a provider refusal — a turn taken over — but in an
agent loop a wasted step, so it earns its own column rather than being folded
into `err`.

### What a tok/s figure is built from

Two halves, and both of them are choices that can be wrong quietly.

**The time is the streaming span, never the whole step.** The official `decode`
interval is `first token → assistant/message`. In an agent loop that interval
also contains harness work between the final token and message assembly, so
dividing output tokens by it yields impossible rates — on a real 78-session
history it produced spikes up to 213 000 tokens/sec. This plugin therefore
reconstructs token arrival times from the recorded delta runs (`time0` +
accumulated `dt`) and measures over the span the provider was actually
streaming.

**The tokens are the provider's own count, never the number of fragments.** A
delta fragment is a transport chunk, not a token, and providers batch them
differently: on this history one fragment carries ~1.1 tokens from
`deepseek-official/deepseek-flash` and ~28 from
`openrouter/stealth/space-bunny-alpha`, which streams 100–270 characters
per chunk. Counting fragments therefore reports chunks per second under a
tokens-per-second label and understates a batching provider by exactly that
factor — it made the second-fastest decoder in this install look 30x slower
than it is. The report names the batching factor when it exceeds 8 tokens per
fragment, and `node tools/verify-tokens-per-fragment.mjs` checks the whole
corpus for it.

A span becomes a throughput sample only when it carries at least 100 ms, at
least 8 tokens and at least 4 fragments — one packed burst is not a rate. A
step the provider streamed without reporting usage has no numerator and
contributes nothing, so a model that never reports a token count shows `-`
rather than a guessed figure.

### Why the streaming rate is the wrong column to choose a model by

`tps` answers "how fast does this model print". The question behind the plugin
is "which model should I use", and the answer is "how fast do I get tokens" —
which is `e2e_tps`: the same numerator over `ttft + stream` instead of over
`stream` alone. The same `SPEED_QUALIFICATION` gates both, deliberately not
repeated on the wider span: a prefill can only make the denominator larger, and
the failure the guard prevents is an implausibly *high* rate.

`prefill` is that ratio read as a share, computed per step and then medianed —
never as a ratio of two medians, which would describe two different sample sets
and lie. Over the 14 808 corpus steps that qualify as a rate, its median is
**0.56**: more than half the wait for a first answer is spent before the first
token, and no streaming rate shows that.

| model | steps | stream tok/s | **e2e tok/s** | survives prefill | prefill share |
|---|---|---|---|---|---|
| deepseek-official/deepseek-flash | 9512 | 288.9 | **128.5** | 0.44 | 0.55 |
| openrouter/stealth/space-bunny-alpha | 1969 | 161.5 | **78.6** | 0.49 | 0.48 |
| clinebot/cline-pass/deepseek-v4-pro | 40 | 82.8 | **60.7** | 0.73 | 0.25 |
| limitdeckai2/deepseek-v4-flash | 59 | 129.7 | **46.4** | 0.36 | 0.61 |
| nvidia1/deepseek-ai/deepseek-v4.1-flash | 1071 | 40.7 | **9.3** | 0.23 | 0.74 |
| nvidia1/moonshotai/kimi-k3 | 39 | 24.3 | **2.0** | 0.08 | 0.91 |

The ranking moves: `nvidia1/moonshotai/kimi-k3` is mid-table by the streaming
rate and last by the useful one, because 91% of its wait is prefill.
`limitdeckai2/deepseek-v4-flash` decodes 3.2x slower than `deepseek-flash` and
is 2.8x slower in use. Conversely `clinebot/cline-pass/deepseek-v4-pro` decodes
half as fast as `nvidia1/deepseek-ai/deepseek-v4.1-flash` and is **6.5x** faster
in use.

### `overhead`: the one column that points at this host

`overhead = llm − ttft − stream`, i.e. the gap between the last recorded delta
and the `assistant/message` that closed the step. Everything else in the table
belongs to the provider; this part does not.

It is small in total — **7 574 s of 382 446 s, about 2% of model time** — and
not spread evenly. Median 20 ms corpus-wide, p90 57 ms; but `codex/gpt-6-astra`
pays 387 ms a step, `codex/gpt-5.6-sol` 220 ms, `clinebot/cline-pass/kimi-k3`
216 ms, and `splash/incoai/Qwen3.8-27B-Splash` 1 ms. Left unclamped: measured
over 16 037 corpus steps it is never negative, and a log that broke that
assumption should show a negative number rather than have it hidden.

### The rating: 0-100, and what it is not

Every other column here is one reading, and the reader is left to weigh them.
The rating is the one figure that weighs them: a single 0-100 number for one
exact `(provider, model)` pair, computed from committed history alone — no
clock, no I/O, no DSH import — and published under a version (`technical-v1`),
so a later revision is a new formula rather than a silent drift of this one.

```
S = V50 / (V50 + 100)      generation throughput, half credit at 100 tok/s
L = 1 / (1 + T50 / 5000)   typical response,        half credit at 5 s
P = 1 / (1 + T90 / 15000)  slow response,           half credit at 15 s

score = 100 * S^0.45 * L^0.35 * P^0.20
```

**The arithmetic, on this machine's largest row.**
`deepseek-official/deepseek-flash` has 9946 answered steps across 84 sessions,
of which 9501 qualify (95.5%; 11 retried and 9 interrupted steps are excluded,
and those two counts may overlap — a step can be both). Its weighted medians
are 289.0 tok/s, 1917 ms and a p90 of 2763 ms:

```
S = 289.01 / (289.01 + 100)  = 0.7429
L = 1 / (1 + 1917 / 5000)    = 0.7229
P = 1 / (1 + 2763 / 15000)   = 0.8445

100 * 0.7429^0.45 * 0.7229^0.35 * 0.8445^0.20 = 75.4938   ->  75.5
```

Each factor is a saturating utility in (0, 1], so a route sitting on all three
anchors scores exactly 50 and the product is monotonic: faster delivery with the
rest held fixed can never lower the score. The weights and the anchors are
product choices, not fitted constants — they decide what "good" means here — and
they live in one frozen `RATING_POLICY` that the report quotes rather than
restates, so a change to a weight changes the sentence under the table with it.

**Throughput is the streaming rate, not `e2e`.** `e2e` contains the first-token
wait, so scoring it would count that wait twice: once inside `T50` and again
inside a deflated rate. And `P` is an absolute tail utility rather than a
p90/p50 ratio, because a ratio rewards slowing an already-fast median — the
table would then show a worse route above a better one.

**The population is narrower than the table's.** A retried step measures the
retry policy and the network as much as the route; an interrupted step never
delivered a whole answer; a span flushed as one packet measures log packing. A
step that cannot produce a rate does not get to contribute its latency either,
so all three factors describe the same steps — a latency-only fallback when
usage is missing would compare one route's ttft against another's under a shared
score. The three floors (100 ms, 8 tokens, 4 fragments) are a single shared
definition in `lib/eligibility.js`, re-exported by the fold, so the rating and
the `tps` column cannot drift apart about which steps count.

**Weight is recency, and there is no cutoff.** A measurement 30 days older than
the pair's newest usable one counts half, 60 days a quarter, and older keeps
decaying instead of disappearing — a fixed seven-day window was measured first
and discards most pairs' evidence entirely. The anchor is that newest usable
sample and never the wall clock, which is what keeps a score invariant when
another model is used, a selection changes, or time passes with no new evidence.

**What withholds a score, and what marks one.** Publication needs 10 qualified
*and* 10 effective (Kish) samples. The two are separate thresholds on purpose:
ten samples inside one pair of hours are worth less than ten spread out, and
`nEffective` is what says so. A published score carries `~` while it is
provisional — fewer than 30 effective samples, or fewer than 3 sessions. Four
null reasons are data rather than sentences (`no_samples`,
`no_qualified_samples`, `insufficient_samples`, `pair_only`), so each surface
owns the wording, and the agent's report counts them in one bounded line
(wrapped here to fit the page):

```
rating technical-v1 (0-100): 45% streaming throughput, 35% median first token,
20% slow (p90) first token; weights halve every 30 days from the pair's newest
usable step, retried and interrupted steps are excluded, and a score needs 10
qualified and 10 effective samples. 10 of 10 shown row(s) rated; no score: none.
provisional (5, marked ~: fewer than 30 effective samples or fewer than 3
sessions): tokenator/deepseek-v4.1-flash, clinebot/cline-pass/minimax-m3, ...
```

**The quantiles are published beside a withheld score.** A reader asking why a
route is unrated deserves to see that it was three samples of a fast route
rather than silence: `clinebot/typesafe/jev-router` on this machine is
`insufficient_samples` with 3 qualified samples, while its own weighted medians
read 109.0 tok/s and 1993 ms.

**`*` is a caveat, never a re-reading.** A score whose newest usable measurement
is older than 30 days is marked `*` — in the cell, and named in the line under
the table on the agent's side. Nothing is recomputed from the age, no bar is
drawn against it, and no tone is applied: the number a reader compares is the
number that was computed, and its age is a sentence about the evidence. Moving
the display clock cannot change a score. On this machine's history the mark
fires on no row at all — the oldest anchor is 11.5 days old, on
`limitdeckai2/gemini-3.8-flash` — so today it is proven by fixtures and by a
shifted clock rather than by a live row, and the first honest appearance will be
when that pair crosses 30 days.

Measured over the same corpus the report above came from (183 sessions /
18 637 timed steps / 37 model rows over 13 providers; a cold fold and aggregate
of it takes 113 ms): 25 rows carry a score, 10 are withheld for
`insufficient_samples` and 2 for `no_qualified_samples`, and 8 of the 25 are
provisional.

| model | rating | steps | qualified / answered | rating sessions | what the cell says |
|---|---|---|---|---|---|
| tokenator/deepseek-v4.1-flash | **78.0~** | 15 | 14 / 15 | 1 | `~` — one session is under the 3-session floor |
| deepseek-official/deepseek-flash | **75.5** | 9946 | 9501 / 9946 | 84 | — |
| openrouter/stealth/space-bunny-alpha | **70.0** | 2371 | 1968 / 2371 | 20 | — |
| limitdeckai2/glm-5.3-flash | **53.1~** | 648 | 21 / 648 (3.2%) | 8 | `~` — 3.2% of its steps qualify; 21.0 effective |
| clinebot/typesafe/jev-router | — | 3 | 3 / 3 | 1 | no score: 3 of 10 qualified samples needed |

Sorted by steps, the table leads with `deepseek-official/deepseek-flash` (9946
answered steps) and `openrouter/stealth/space-bunny-alpha` (2371). Sorted by
rating it leads with a 15-step session, and `limitdeckai2/glm-5.3-flash` falls to
53.1 on 21 qualified steps. That disagreement is the reason the column exists,
and the coverage column is what keeps it honest: of that route's 648 answered
steps, 127 are retried and only 21 clear the span, token and fragment floors —
the remaining 500 streamed too briefly, or too small, to be a rate at all.

**What it is not.** Not intelligence, not correctness, not answer quality, not
price, not context capacity, not current reachability. Each of those either has
its own column or has no authoritative source in this release, and folding them
in would make one number that means five different things. A failed liveness
probe is deliberately *not* an input: VPN state is the reader's to control, so a
route that cannot be reached right now keeps the score its history earned, and
the status column is where "right now" is answered. The disclosure under each
row ends with the same caution the rest of this file keeps making — measurements
depend on request size, reasoning mode and network, and the absence of retries
does not prove the absence of network delay.

**What does and does not move a score.** Adding an unrelated provider or model,
changing the selected pairs, filtering by provider, and moving the display clock
all leave it exactly where it was. So does everything about liveness, retry
failures, tool errors, cache hit rate and observed context. Adding a newer
*eligible* measurement does move it; adding a newer excluded one — retried,
interrupted, or a span below the floors — does not, and neither does a score's
own age. The same pair produces the same figure through a cold fold, a hydrated
snapshot, a selection and a `sinceMs`-scoped report, and that is asserted rather
than assumed.

## Where to find it

Two surfaces, one collector, so they can never disagree:

1. **Plugins → the `dsh-model-stats` bundle** — the visual panel, on the bundle's
   own page in the Plugins section, between its description and its rows. It is
   registered in the `plugins.bundle.config` slot that page declares, keyed by
   the bundle's package name, so the page draws the title, the icon and the crumb
   and the entry contributes the table alone. That page is the reason for the
   move: the Settings dialog this panel used to be a section of is a narrow
   overlay, and a table of `white-space: nowrap` numbers had no width to stand
   in. The table is bounded and scrolls both ways inside its wrapper, under a
   header pinned to the top and a name column pinned to the left: at twenty-one
   `nowrap` columns a row's identity is the first thing to leave the screen, and
   a table of numbers that no longer says whose numbers they are is not one to
   sort. The table itself is unchanged — a sortable row per model (or provider),
   and every column heading is an interactive sort control (`aria-sort`, focus
   ring, keyboard accessible, ▲/▼ indicator): click any heading to order the
   table by that figure, and click it again to reverse the direction
   (unmeasured rows stay at the bottom in both directions); sorting lives
   entirely in the headings, so the toolbar holds only the filter, the probe
   buttons and the two view toggles, each group under its own caption. The
   **статус** column stands second, beside the name it belongs to: it is the one
   cell a reader acts on, the one column that is always shown, and the one
   heading that orders by a verdict rather than by a figure — click it and the
   rows come back by what is broken, at the bottom of the table (see *Is the
   model answering now*). The **рейтинг** column stands third, next to the status
   it pairs with: those two are the whole answer to "which of these should I
   use", and every other figure in the row is the evidence behind them. By
   default the table is six columns wide — name, status, rating, steps, median
   response time and median end-to-end throughput (`tok/s e2e med`, including
   the first-token wait) — and it was six before the rating existed: `ош./100`
   moved behind «все метрики» to pay for it, because a rate of errors per 100
   steps is a diagnostic to consult, while a score that already folds throughput
   and latency together is what a route is picked by. Streaming throughput,
   absolute errors and the rest of the twenty-one columns stay one click away.
   Errors per 100 steps normalize activity, not task difficulty or blame, and
   neither they nor the rating measure answer quality.

   The rating is drawn with one decimal, **no bar and no tone**. A bar is a
   share of the largest value in its column, and this figure is already 0-100 on
   its own scale, so a bar would say "best of five" where the number says
   something else; green and red in this panel mean "best and worst value in the
   table", and a rating may not be graded by the company it keeps. A `~` or a `*`
   rides in the cell after the number (see *The rating*), and the cell's tooltip
   and its screen-reader sentence are one string — which is how a `-`, standing
   for four different reasons, stays readable without a mouse.

   In the expanded set every name cell carries one disclosure, **Подробнее**:
   what the score is made of — version, qualified and effective samples, both
   exclusion counts, sessions, the age of the anchor, the three measured inputs
   and the three factors — then what the route declares about itself (see *What
   the route declares* below), and a closing caution. It is a native `<details>`
   rather than a popover, because this is the explanation of the one figure in
   the row that is a verdict and the browser gives a `<summary>` keyboard access
   for free; it is drawn only in the expanded set and only in the model view,
   since the compact table is one line per row and a disclosure under every name
   would spend that line on rows nobody asked about. The expanded order groups
   identity and availability, sample size and recency, response latency and
   retries, throughput and its measurement coverage, errors and interruptions,
   then duration and input diagnostics. Thin dividers mark the groups without
   another sticky header.
   Under the three rate medians — response, `tok/s e2e med` and `ош./100`, all
   three of them in the expanded set now — every
   figure carries a hairline bar: its share of the largest value in that column, so
   a column can be read down the page without reading the digits. Which columns are
   scaled is the `SCALED` map in `client.js`: a cell draws a bar only for a metric
   that pass measured, so `шагов` (a sample size, not a figure about the model) and
   the two columns whose metric is deliberately absent (`ретраи`, `префилл` — see
   D-028 in the local tech-debt list) draw none. `статус` is a column of words and
   never had one. Best median response and best median decode are
   highlighted green, the worst of the shown rows red — the two ends come out of
   one ranking, so a row is never marked both ways, and a model with no
   measurement («-») is never marked as the slowest. The table lists what the
   configuration serves and not only what the history holds: a model nothing has
   ever run is a row too, marked «нет статистики», with the status circle that
   tests it (see *Models the configuration serves and the history has not seen*).
   Every column heading
   explains its own figure on hover, and carries the same sentence as hidden text
   so it reaches a screen reader too; the legend that spells all of this out sits
   folded under the table. The last answer is kept in the browser, so reopening
   the panel paints the table first and refreshes behind it, and the chosen sort,
   direction, view, selected models, archive and column set are remembered — in
   `localStorage`, not in the address (see *The question the panel asks* below).
   There is a refresh button; no timer polls once the numbers are still.
2. **The `model_stats` tool** — the same numbers as plain text for the agent.
3. **The `model_liveness` tool** — the availability check, from the agent's side.

### Is the model answering *now*

History answers how a model behaved. It cannot answer whether the provider is up
this minute, which is the question that decides what to run next. That is what
the **статус** column is: one probe per model, run when you ask for it.

A probe is the smallest possible call, sent **through `ctx.llm`** — the same
route, protocol, credentials, adapter and request shape a real request uses, and
no parameter of its own. That last part is not decoration: the probe used to cap
its answer with `maxTokens: 16` and pin it with `temperature: 0`, and the Codex
backend refuses both by name (`400 Unsupported parameter: max_output_tokens`,
`400 Unsupported parameter: temperature`) — the harness sends neither, so all
seven codex models read as broken while the fold held 335 codex steps that
answered. A shape only this plugin sends measures this plugin. That choice is the
feature: a green circle means the harness itself reached the model, not that some
second HTTP client inside this plugin happened to manage it. A raw HTTP transport
exists only for a route `ctx.llm` does not serve at all (a provider switched off
in the configuration), and each stored result names the transport it used in its
own `source` field.

| Circle | Meaning |
|---|---|
| green | the model answered |
| grey | never probed |
| pulsing (accent) | a probe is running for this model right now |
| amber | the provider refused on a limit — the allowance is spent (*лимит исчерпан*) or the account is being throttled (*слишком часто*) |
| solid red | the check failed with nobody to answer it: a timeout, a dropped connection, a provider error. The cell prints the failure's own status when the panel has no word for it — *timeout*, *server*, *http_500*, *transport* |
| filled red square | the row is not configured, and the fix is on this side: *нет доступа* (the key was refused or is missing), *нет маршрута* (no endpoint is declared for the provider), *нет модели* (the provider does not know this model) |

**The circle says whose move it is.** A failed check has three very different
meanings — the provider did not answer, the provider refused the account, or the
row was never configured — and a single red word for all of them sends the reader
looking for another model in two cases out of three. So the tone splits by whose
fix it is: amber is the account (a pause or a top-up), a filled square is this
side (a key, an endpoint, a model list), solid red is theirs (wait or route
around). The fill carries the simplest half of that — filled means somebody else
has to answer — and the shape carries the rest, because at eight pixels a fill
difference alone is just a paler dot. The candidates were rendered side by side at
1× and 4.5× in the live panel before one was chosen: a *ring* was the incumbent and
reads as a fainter dot; a *triangle* loses half its box to empty space and is the
universal warning sign, in the one column where amber already means a warning; a
*diamond* is the lightest of the outlines because its shape is inscribed in the
box; a *blue* square reads as informational and the host does have a fourth state
hue for it (`--dsw-alias-state-business-primary`), but that family is deliberately
unused here — a row you cannot run is not information. A square and not a circle,
because corners are what survive being drawn this small. It is filled, which makes
it the loudest mark in the column — more ink than the circle that means “the
provider did not answer” — and that is the point: a row that cannot be run at all,
and cannot be made to run by waiting, is louder news than a route that may answer
again. These two words are also the rarest, so the column can afford it; the
outlined variant is one line away (drop the fill, keep an inset 1.5px ring) if the
hierarchy ever matters more than the alarm.

**A refusal on a limit is an answer, not a breakdown.** A probe that comes back
`RATE_LIMIT`, `QUOTA` / `ACCOUNT_QUOTA` or a bare `HTTP_429` / `HTTP_402` reached
the provider, was accepted as a request and was declined on the account — so the
circle is amber. The same goes for a refused credential (`AUTH`,
`INVALID_CREDENTIAL`, `MISSING_CREDENTIAL`, `NO_KEY`, `HTTP_401/403`) and for a
route or a model that was never configured (`NO_ROUTE`, `NO_ADAPTER`,
`NO_BASE_URL`, `UNSUPPORTED_API`, `UNKNOWN_MODEL`, `HTTP_404`) — none of those is
the model being slow or dead, and the codes are `dsh-llm`'s own machine-routable
failure classes. One failure of another kind (a timeout, a dropped connection, a
5xx) makes the row — or the whole provider, in the provider view — down, not
merely refused: a roll-up only wears a refusal's circle when *every* model in it
was refused the same way, and when route and model faults are mixed, the route
wins, because a missing route makes the model question moot.

The code decides the state; the word needs more than the code, in two places.
`dsh-llm` folds a spent daily allowance and a momentary throttle into the same
`RATE_LIMIT`, because its quota classifier looks for the wordings it knows and
falls through to the status code for the rest — a free tier answering `429` with
“Daily free limit reached … tokens used … resets at 00:00 UTC” is stored as
`RATE_LIMIT`. And a model that does not exist arrives from several providers as a
plain `INVALID_REQUEST`, with the reason only in the body. So the panel also reads
the provider's own sentence, and only ever to choose between words: an explicit
quota code settles it, wording that says the account has to be *paid* before it
answers again (“Free models are for active keys … the last top-up on this key was
2026-09-21, which is more than 7 days ago. Top it up to use free models again”,
*recharge*, *add credits*, *balance too low*, *the key expired*) outranks even the
retry promise — that one arrives as the same `429` a throttle does, and a reader
told to wait for it is being told to do the only thing that cannot help, a
promise of a retry in seconds (“try again in 1.2s”, `retry-after`, *per minute*)
outranks the word “limit” in the same sentence,
spent-allowance wording (“limit reached”, “quota exceeded”, “tokens used”,
“remaining: 0”, “insufficient balance”) settles the other way, a bare `429` stays
the throttle its code is named after, and “does not exist” / “model_not_found” /
“has no configured model” / “is not available” inside a rejected request is the
one thing that moves a row out of plain red without a code saying so. Deliberately
not “temporarily unavailable”: that is a provider having a bad day. Nothing here
routes, retries or decides anything — it is a label, and a miss costs a word, not
behaviour.

**A failure with no word of its own prints its status.** Every other word in that
column is a claim the panel can stand behind — whose move it is, what has to
change. Red is the one state left, and *недоступна* says only what every red circle
has in common: nobody answered. For a timeout, a `500` and a dropped socket that is
the status restated in Russian, while the fact that tells those three apart waits
one hover away. So a cell that cannot classify the failure prints what it is: the
host's own machine-routable status, as it arrived, in lower case and without the
shouting — `timeout`, `server`, `http_500`, `transport`. An id and not a sentence,
because this panel does not own that vocabulary and a Russian guess would sit in
the cell next to the real one in the tooltip. A provider roll-up has no status of
its own and prints the list it counted, deduped (`auth · timeout`). With no status
at all there is nothing to print, and the word stands. Only that cell does this: a
green circle, a key, a route and a model all keep the word they are decided by, and
so does a failure that any family claimed — a status printed over a word the panel
had would be a downgrade, not a fallback.

**A failure is dated, and history can outrank it.** `виден` is when the model
last answered in the recorded history; a probe result carries its own `checkedAt`.
When the history time is *later* than the check, the failure is older than the
evidence and the circle is green — marked *по истории* so the reader knows the
model was not proved live just now, it was proved live at some other time. That
holds for a limit too: a model that answered after a 429 is throttled no longer,
and a model that answered after a refused key does not have a key problem now. A
failure with no later evidence keeps its own mark — amber, filled red or a red
square — which is the half of that rule that keeps a dead model from being painted
alive.

**The status column is a sort control too.** Clicking its heading orders the rows
by the verdict, in the same hierarchy the column draws: the filled square first —
a row that cannot be run at all, and cannot be made to run by waiting — then a
provider that did not answer, then an account out of allowance, then the models
that are fine. At the very bottom sit the rows nobody has checked, and that is
the rule worth stating: a row with no probe has no rank at all, so an absence is
held at the bottom in **both** directions instead of being promoted to "worst".
A second click reverses the order, so "available first" is one click away, and a
failure the history has overtaken sorts with the available rows — that is the
circle it is drawn as.

It is the one order the fold cannot read off the session log, because a probe
result lives in `liveness.json` and not in the log: the route reads that store
once per request and hands the rank to the aggregate (`lib/status.js`), which
never sees a probe and never guesses one. The classification runs **once, on the
host**, and travels with every result as its `state`, so the circle a reader looks
at and the order the rows are in cannot be two verdicts about one model — the one
failure this control must not have. Rows sharing a state are ordered by steps and
then by name, because every available model shares a rank and a whole green
column would otherwise come out in whatever order the fold happened to build it
in. A caller with no probe store — the agent's tool, whose five orders do not
include this one — degrades to busiest-first rather than to an arbitrary order.

The evidence — last request, check time and latency, the failure's code and
message — is printed under the circle in the «все метрики» column set. In the
short one the status cell is the circle and its word alone, and the same sentence
moves into the cell's tooltip; the button's accessible name carries it either way,
so nothing is lost without a mouse.

Ways to run one:

| Where | What it probes |
|---|---|
| the circle in a row | that one model |
| **Проверить все** | every configured model, re-probing even a fresh answer |
| **Проверить выбранные** | the models ticked in the «Модели» tree, re-probing even a fresh answer |
| a provider row in the provider view | that provider's models |

The two buttons name their *scope* and each says what it costs in its own tooltip,
because the difference between them is one real request per model. They used to be
named for a *window* — «Только устаревшие», meaning "models with no answer, or one
older than five minutes" — and that was the worse of the pair: the five-minute rule
lives inside the host, so the button neither said what it would check nor let the
reader predict the result, and pressing it on a table where everything was fresh
did nothing at all. The scope of the second button is the reader's own selection,
resolved over the catalog the host sent — the same resolution the tree's checkboxes
are drawn from, so the button and the marks cannot disagree — and it is disabled
while nothing is ticked. It travels as the pairs themselves rather than as the rule
document, because a check is a question about models that exist: the host probes a
named pair whether or not the catalog still lists it, and answers `NO_ROUTE` rather
than dropping it, which would look like a green row. `POST /api/model-stats/liveness/check`
takes `pairs: [{ provider, model }]` for that, capped at 1024 pairs, and keeps
`provider` / `model` / `all` for the agent's own tool.

A sweep is not one HTTP request. The host answers `POST` immediately, keeps
probing in the background at four at a time, and the panel follows `pending`
down to zero over the ordinary `GET` — so a check over a hundred models never
becomes a request the browser gives up on. Results are written to `liveness.json`
next to the fold snapshot and survive a restart. The five-minute freshness window
still governs a *plain* catalog click — the agent's `model_liveness()` with no
arguments, which is why its `staleOnly` parameter is documented as naming what a
plain call already does — but no panel button depends on it any more.

**A probe gets the patience its route has, not one this plugin invented.** The
budget is resolved per model: the provider profile's own `timeoutMs` if it
declares one, else its `streamIdleTimeoutMs` — the gap the host tolerates
between chunks — and only a route that declares neither falls back to the host's
own default, five minutes of silence before a stream is abandoned. A flat 15 s
for every route was a deadline the host does not have, and it is wrong in the one
direction that matters: a slow free tier answers in 20-200 s, so every model on
NVIDIA's was recorded as a timeout with the provider perfectly reachable. What
the profile declares is what the probe waits, in both directions: a route that
sets a short deadline of its own is judged by that, and a route that takes two
minutes to first token is not called dead while it is still thinking.

Nothing here probes on a timer, and the plugin still registers nothing on the
request or stream path: a probe happens because someone asked for one.

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

### What the route declares

The rating answers how fast a pair has been. A reader deciding what to run next
also wants what the route *declares* about itself: its context window, the
output cap it applies by default, the input modalities it accepts and the
reasoning modes it offers. DSH exposes exactly one call that reads that, and it
validates and detaches the adapter's answer before returning it —
`ctx.llm.resolveModelInfo(provider, model, signal)`.

It is shown in the **Подробнее** disclosure of the expanded set (see *Where to
find it*), one line per row, and only these fields ever reach a row:

| Field | What the adapter declares |
|---|---|
| `contextWindow` | the model's context window |
| `defaultMaxTokens` | the **default** output cap a request gets when it names none — *not* a maximum capacity: the model may emit more under an explicit cap, and the field name carries that distinction to every consumer |
| `inputModalities` | what the route accepts (text, image, …) |
| `reasoningEfforts` + `defaultReasoningEffort` | the reasoning modes on offer, with the one a request that names none gets named beside them |
| `source`, `checkedAt` | `dsh-adapter`, and when it was asked |

**Two unknowns are kept apart.** `routeMetadata: null` means DSH was not asked
or did not answer — no adapter for the provider, no `resolveModelInfo` on an
older runtime, a throw, a budget spent. An object full of nulls means the
adapter answered and declares nothing about that field. Inside that line a
missing field is printed as *«не объявлено»* and not as the panel's `-`,
because the line makes a claim about the route ("it declares") and a dash
inside it would read as the other fact — *we did not look*. A context window of
0 is not a small window; it is not a window, which is why the unknown is `null`
and never a zero.

**Every lookup is bounded,** because the panel's own fold budget is 2.5 s and
this is decoration: 1 h for a positive answer (a context window is a property of
the adapter's configuration, not of a request) and 5 min for a negative one (a
failure is usually a route this install does not serve, and retrying it on every
refresh is wasted work), 1 s per lookup and 1 s per enrichment, four at a time,
and at most 64 *new* pairs per answer. Past that cap the pairs already asked
about stay cached, so a page wider than 64 fills in over successive refreshes
instead of queueing an unbounded sweep onto one request. Two rows naming the
same pair share one lookup, a late answer cannot overwrite a newer one, and a
pre-aborted `AbortSignal` is only a courtesy — an adapter that ignores
cancellation is a route the panel must not wait on, so the timeout is a local
race.

**This is a configuration read, not a request.** Nothing here probes, and
nothing here infers: the two layers are separate on purpose, because folding a
lookup into a probe (or the reverse) would make one out of the other. A route
may well declare a million-token window and be unreachable from this machine
because a VPN is off — the status column is where *right now* is answered, and
it costs one real request. The rating is computed before rows are cut and the
caller enriches after it, so a route whose metadata is unknown still has its
score, and a route that answers a probe badly keeps the score its history
earned.

Measured on the installed runtime (2026-09-30, profile `web`, 75 configured
pairs, ~0 ms per call, no network), `resolveModelInfo` answered for all 75:
`contextWindow` and `inputModalities` on every one, `defaultMaxTokens` on 36,
`reasoning` on 31, `name` on every one and `description` on none. Everything
outside the table above is dropped at the boundary — `name`, `description` and
whatever an adapter keeps beside them — because this object is serialized to a
browser and only the display fields belong in it; the identity check is
repeated there too, since a context window is only meaningful for the route it
was declared for. The optional half being the common case is the whole reason a
missing field has to read as unknown rather than as a zero.

### Filtering by provider

Both surfaces can answer about some providers instead of all of them. The names
are exact, and several of them at once: `?provider=openrouter,codex` in a URL and
the same string (or a JSON array) as the tool's `provider`. A filter that matched
nothing is a question with an answer, not a reason to return the whole table: the
text report names the names it was asked for, and the answer keeps every provider
the report knows. The panel no longer has a provider checkbox list — the selection
below replaced it, because "which providers" and "which models" are one question
and the panel was asking it twice.

### Choosing the models the table is about

The panel's table is about the models the reader selected, and the selection is a
**rule**, not a list of pairs. The difference shows the morning after: under "all
of this provider" a model the configuration gained overnight appears in the next
answer, while a list of names captured yesterday would not name it and would leave
it out of a provider the reader had marked as complete. What the panel sends to the
host is the rule document, and what the host does with it is resolve it against the
catalog only the host can see in full.

A rule has two scopes, `live` and `archive`, and each scope three levels:

| Level | What it says |
|---|---|
| `base` | `measured` (every model with history), `all`, or `none` |
| `providers[name]` | `all`, `measured` or `none` for one provider |
| `pairs["provider\u0000model"]` | `on` or `off` for one model — the exception that outranks both |

Precedence is exactly that order, top to bottom: an explicit pair first, then the
provider's rule, then the scope's base. A first open uses
`{ live: { base: 'measured' }, archive: { base: 'none' } }` — every model that has
history and no retired one, which is the set the table showed before a selection
existed, so nothing changes for a reader who never opens the tree.

`providers[name]: "measured"` says *everything of this provider that the history has
run*, and it is a rule rather than the list of the pairs that happen to be measured
for the same reason the rest of the document is: a model the provider gains and that
is run for the first time joins it by itself. A provider whose every model has been
run resolves it to `all`, so on such a provider it is the same set twice and the tree
says so with a `data-state="measured"` and a tooltip rather than with a difference
the reader cannot see.

Two scopes are one statement about two kinds of item: a model outside the
configuration is not a model inside it, and a reader's marks about each are kept
apart. While the archive is off its scope is stored and not applied, so switching
the archive on brings the marks back instead of resetting them — and switching it on
marks nothing by itself, because a scope nobody could see is not a scope a switch
may edit.

The tree is one compact line above the table — `Модели 3 из 5` — and the tree behind
a disclosure: a search box, **Выбрать все** and **Снять все**, then one row per
provider with its own checkbox and `N из M моделей` beside it, and its models
indented under it, each labelled with its full id. Altogether the control has to
answer four questions:

- **What is selected now.** The count in the line, and the count beside each
  provider row. A group whose models are partly selected is a real `indeterminate`
  control *and* an `aria-checked="mixed"` *and* a number — the state is never
  carried by colour alone, and a reader who cannot see a dash sees the number.
- **What a click on a group means.** One click, three steps, and it is a cycle rather
  than a descent. A group that is not full goes to *all* — a click has to be able to
  finish what the reader started, and "all except the ones I excluded" is not a state
  a parent checkbox can offer. A full group goes to *none*, which is the ordinary
  meaning of clicking a ticked box. And a group the reader has just emptied comes
  back as *only the models that have history*, which is the step a plain
  "not all → all" cycle cannot reach: "nothing selected" is both "not all selected"
  and "cleared", and only the rule says which of the two the reader last asked for.
  From there the first step takes over again, so a provider whose models are half
  measured walks *partial → all → none → measured-only → all* and stops being
  ambiguous. A click on a group writes a rule about the provider, not a list of its
  models, so a model it gains later follows it — including under the measured rule,
  which is why the third step is one word in the document rather than a snapshot of
  the pairs that were measured today.
- **What a click on one model means.** An exception, written only where the reader's
  wish differs from what the rules already say about that pair. Unticking one model
  under "all of codex" stores one `off` exception; unticking it under "nothing
  selected" stores nothing at all, because the entry would say what the rules
  already say. Returning the tick removes the exception rather than writing the
  opposite one, which is what keeps a saved policy readable.
- **What the mass buttons act on.** Every item available under the current archive
  state — and the search does not narrow that: the search hides rows to find a name
  in, and a group action that silently acted on the visible subset would select a set
  the reader cannot see. Searching changes no mark.

**An empty selection is a state of its own.** The table says «Модели не выбраны»
and offers the way back — «Вернуть выбор по умолчанию», which restores the rule a
first open would have used. Clearing marks is «Снять все», and a button that says
"back to the default" means the default. The reset is visible whenever the rules are
not the default and inert while they are, and it does not turn the archive off: the
archive is a scope switch with its own visible control, not one of the marks.

**A selection larger than a page says so.** The panel asks for 200 rows, the host
answers with `truncated: true` when the selection has more, and the panel prints how
many rows were shown of how many and offers **Показать все** — which raises the page
to the host's ceiling of 2000. A truncated table read as the whole selection is the
one thing a table that lists what the reader chose must not do, so the notice is not
optional and the limit is never silently applied.

**The provider view does not drop the selection.** A provider row is a roll-up of
the models the reader chose, and it says so: `1 из 2 моделей` beside the provider.
That matters because the aggregate is computed from the selected raw measurements
and not from ready model rows — see *A provider row is an aggregate of steps, not an
average of medians* below — so a provider whose slowest model was left out reads
faster than the provider, honestly and visibly.

A switch to another selection is the same kind of question as a switch to another
sort, and it has the same contract: it never takes the table off the screen, the
footer adds what the selection left of the history (the totals beside it are the
whole history by design), and the notice about a stale answer names the selection as
well as the sort, so a table of every measured model is not read as a table of the
selected ones.

#### A provider row is an aggregate of steps, not an average of medians

The selection is applied to the **raw measurements** — the folded steps, the error
records and the retry records — *before* anything is aggregated. That is not an
implementation detail; it is what a provider row means. An aggregate buckets what it
is handed, so a selection that filtered ready model rows and then averaged them would
compute a provider figure that is an average of medians: a model with one fast step
would weigh as much as a model with a thousand, and the row would describe a
distribution nothing ever measured.

The fixture in `tools/verify-selection.mjs` is built so the two answers cannot be
confused. One provider, two models: `one` has four steps around 100 ms, `two` has two
around 900 ms. Selecting `two` alone gives a provider row of **2 steps and a 905 ms
median** — its own measurements, the same numbers its model row shows. Averaging the
two ready rows would have said **504 ms over two models**, a figure belonging to
neither model and to no run of steps.

The same rule decides what a *retry* counts as. A retry record folded from a step
that never produced an answer carries the provider and no model of its own, because
the fold refuses to guess a model across providers: it lands on the provider row,
where the attribution is exact. Under a selection it follows its provider — it is a
measurement of a provider whose models the reader is looking at — and it is dropped
when none of that provider's models is selected, exactly as it is when no selection
is on.

### Models outside the current configuration

A model the harness no longer serves is still in the history, and a table that
listed it beside the live ones would be recommending something nobody can run.
Every row is therefore graded against the **current configuration** — the catalog
of `(provider, model)` pairs the live `ctx.llm` serves, union the provider routes
the configuration files declare — and a row the configuration does not know is
**archived**: hidden by default, listed on request.

`archived: true` on the tool, `?archived=1` on the route, `"archived": true` on the
panel's own route, and the **archive** checkbox inside the panel's model tree bring
those rows back. A row that is in the archive
wears the word `архив` / `archive` in the name column, so a table with the filter
on says which of its rows are which; the filter chip and the footer count what the
archive holds, and the empty state names it when the archive is why the table is
empty. The tool prints one `archive:` line naming the rows and steps it left out —
with the argument that brings them back — and its summary lines ("fastest first
token") answer about the rows the table shows, so a retired model cannot be named
the fastest model while being hidden from the table.

That count is over the **whole history**, and not over the rows the selection kept.
It is the number that tells a reader what switching the archive on would show, and
the selection's first-open policy is `live: measured, archive: none` — a count
taken off the selected rows therefore reads zero on a first open and keeps reading
zero with the archive switched on and its models sitting in the tree unticked. The
provider filter still narrows it, because that is a question about the history; the
selection is a question about the table, and `archive.shown` is the half that
follows the table.

In the provider view a row is a provider, so it is graded as one: archived while
the configuration serves no model of it at all. One configured model is all a row
of provider totals needs to be reachable.

The grade is made only when it can be made honestly. A catalog whose live half did
not answer (`listProviders` threw, or there is no `ctx.llm` at all) is not a
configuration that serves nothing — it is one this process cannot see — so the
route sends `archive: null`, and the panel offers no control, marks no row and
hides nothing. Measured on this machine, that distinction is the whole table: the
configuration files declare 113 pairs over 10 providers, while the live `ctx.llm`
additionally serves `deepseek-official`, `codex`, `limitdeckai`, `anxb`,
`dsh-provider-qoder` and `local-uns`. Graded by the files alone, 28 of 64 model
rows and 15932 of 26600 steps — 60% of the history — would be archived, among them
`deepseek-official/deepseek-flash` (10617 steps), which is this harness's own
default model and is served by `dsh-llm-deepseek` without any provider block
listing it. With the live catalog, 4 rows and 10 steps are.

The panel's **tree catalog** is graded by the same rule, because it is the list of
what can be selected. A provider the configuration serves no model of has nothing
but archived rows, so with the archive off its group could only ever answer an
empty table; it leaves the tree with the rows that arm it, and the archive checkbox
brings it back beside them. Measured on this machine against a catalog of 142 pairs
over 16 providers, one name of the history's 16 is in that position: `wormsoft` (1
model row, 3 steps, against those same 4 rows and 10 steps), which the tree offers
again — 16 names without the archive, 17 with it.
`local-uns` is the case that stays although two of its three rows are retired:
`Ornith-1.5-9B-MLX-8bit` is configured, so the provider is reachable, and a
provider the history has never seen keeps its place for the same reason — the
configuration serves it (`ollama`, 22 configured pairs, no history at all).
Nothing was graded under `archive: null`, so nothing left the list either.

Like the selection, the archive is applied over the whole selected set and before
the limit, so a page of fifteen rows is fifteen rows the reader can use; `shown` in
the payload counts the rows the grade kept, and `archive` says what that cost
(`{ rows, steps, shown }`).

### Models the configuration serves and the history has not seen

The archive is one half of a statement about one row; this is the other half. A
model the live catalog serves and no session has ever run has no history to fold,
and a fold cannot invent a row it has no sample for — so it used to be in no table
at all: not in the history, not in the archive, and therefore invisible on exactly
the question the status column exists to answer. It is now a row: `steps: 0` (a
measurement — no step was ever recorded for that pair) with every other figure
unmeasured (`-`), `archived: false` by construction, and the status circle that
makes it testable, because the liveness join looks a pair up by name and does not
care where its row came from. It wears **нет статистики** / **no statistics** in
the name column, so a table of dashes says which kind of row it is looking at, and
the footer counts them (`без статистики: 92`) over the filtered set, exactly as it
counts the archive. Three properties of it are deliberate:

- **The rows are sorted, not appended.** Placing them "after the measured ones"
  would be a second order: under `steps` ascending, or under `name`, an unmeasured
  row belongs *between* two measured ones, and a table whose order contradicts its
  own heading is worse than one that leaves rows out. The union is re-sorted with
  the fold's own comparator (`comparatorFor`, exported for this), which already
  knows what a missing figure means: it stays at the bottom in both directions.
- **The status order ranks them too.** A probe's rank is not in the session log,
  and the catalog is what a sweep walks, so these rows are the ones a probe store
  is most likely to know. The route hands the same `statusOf` lookup to the fold
  and to the payload, or the one order a reader uses to ask "what is broken right
  now" would file every row this feature adds at the bottom.
- **A page is asked for that can hold them.** The panel used to leave `limit` to
  the route's default of 50. That was right while the table was the history and is
  wrong now that it lists the configuration: the unmeasured rows sort last, so a
  50-row page held five of the 92. The panel asks for the route's maximum
  (`limit=200`) and the table scrolls.

`noStats: { rows }` carries the count, and it is `null` — like `archive` — when
the host could not read the live catalog: how many rows a configuration holds that
the history never saw is a claim that needs a configuration. The provider list the
filter draws is extended the same way: a provider whose every model is configured
and unused (`ollama` here: 22 pairs, no history at all) is offered with zero steps,
because a filter that cannot name a provider cannot reach its rows.

Measured on this machine by driving the shipped host half (`apply()` and the real
route handler) against its own snapshot, with the probe store standing in for the
live catalog: the history holds 64 model rows over 16 providers, 19 of them
outside the configuration; the probe store — the catalog past sweeps were given —
names 137 pairs over 16 providers; and the answer is **141 rows, 60 of them with
history and 81 without**, of which 77 carry a probe result (27 `denied`, 37
`down`, 6 `up`, 4 `missing`, 3 `limited`, 4 never checked). It is 183 KB of JSON,
answered in 73 ms. At the old page size the same answer carried **none** of those
81: `limit=50` returned 50 rows, every one with history, because the measured rows
fill the page first — which is exactly what their sort says they should, and why
the panel asks for the route's maximum instead.

The agent's text table is deliberately **not** extended. It is a plain-text table
with a 15-row default limit, and 92 unmeasured rows would push measured ones out
of it without giving the agent a decision it can make from them; the agent's route
to finding out whether such a model works is `model_liveness`, which already walks
the whole configured catalog. The two surfaces disagree about *what is listed*,
never about a figure: every number the tool prints comes from the same fold the
panel's rows do.

The panel follows the GUI's language. Its copy ships as `ru` and `en`
dictionaries registered under the `dsh-model-stats` locale namespace, so the
Settings language switcher (and any language pack) applies to it, including the
panel's own heading and the number and date formats. On a host without the
`locale` client service the panel falls back to its built-in Russian copy. The
bundle page around it is the Plugins page's own chrome, so its title and
description come from `locale/*.json` below, not from this dictionary.

The plugin's own row in the plugin list gets its name and summary the same way,
but from files rather than from the running client: the Host reads
`locale/<language>.json` (`{ "meta": { "title": …, "description": … } }`) through
the module resolver, which is why `package.json` has to export
`./locale/*.json`. With no dictionary the Host falls back to the package name and
its `description` field, so an English `locale/en.json` is what gives those two
fields a human name at all — a `meta` object in `package.json` is not part of the
package manifest and nothing reads it. Like every other host-side change here,
this one appears in the plugin list only after DSH restarts.

The icon on that row and on the bundle page is the one field of the three that
does *not* live in a locale file: `package.json` declares `"icon": "icon.svg"`, a
path relative to the package root that the Host reads, contains within the package
after `realpath` resolution, caps at 256 KiB and inlines as a data URL — the
manifest field is documented in `@deepseek-ai/dsh-package-manifest`'s
`DshPackageManifest.icon`, and SVG, PNG, JPEG and WebP are all accepted. A package
without it draws the Host's generic glyph instead, which is what this plugin did
until the mark was added. `icon.svg` is the panel's own signature at 36 px: three
ascending rounded bars, the figure the table draws a bar under, so the list row and
the table say the same thing. It is listed in `files` so a packed tarball carries it.
Unlike the two locale fields the icon was picked up without restarting DSH, because
the plugin metadata is re-read with the package.

The panel is a contribution to a slot the Plugins page owns, not a section of its
own: `@deepseek-ai/dsh-client-ui-plugin-manager` is listed in `dsh.client.inject`
in `package.json`, so that page's browser half arrives first, and
`ctx.slots.inject('plugins.bundle.config', …)` waits for the page to declare the
slot rather than racing its boot. The key it registers under is the bundle's
package name, `dsh-model-stats` — the same name the profile installed — and the
page renders the entry only while the bundle is on, so switching the bundle off
takes the table with it.

The Plugins page keeps its navigation in the shell rather than the address bar,
so the panel has no route of its own.

**The question the panel asks lives in `localStorage`, not in the address.** It
used to be in the address, under five namespaced keys (`msSort`, `msDir`, `msView`,
`msProvider`, `msArchived`), which made a table shareable as a link. The selection
is what ended that: it is a *rule document* — "all of codex except the mini" — and a
rule document in a query string is either truncated or spelled out in a place the
host's page can read. Rather than have one surface remember half its question in
one place and half in another, the whole question moved into the store: the sort,
the direction, the view, the archive and the rules are one document under one
versioned key, `dsh-model-stats:prefs:v2.selection`. Every parameter of the host's
page is left exactly as it was found — the panel never writes the address at all,
and a leftover `msSort` in a bookmark is ignored rather than half-honoured.

The key carries its version because the shape changed: v1 held a flat list of
provider names, which is not a rule and cannot say "everything of this provider
except one model". A v1 store is migrated **once**, explicitly, when it is first
read — its provider names become "all of this provider" rules under the default
base, which is the same set of rows the old filter showed — and the old key is left
where it is. An *empty* v1 list keeps meaning "no filter" and never "nothing
selected": the panel that read it as an empty selection would open blank for
everyone who never touched that control. A store the browser refuses (a locked-down
profile) is not a reason to lose the panel: the selection lives in memory for the
tab, and the panel says so beside the count.

The panel's data comes from `POST /api/model-stats/query` on the same host as the
GUI, with a JSON body:

```json
{
  "sort": "ttft", "dir": "asc", "view": "model", "limit": 200, "archived": false,
  "selection": {
    "live":    { "base": "measured", "providers": { "codex": "all" }, "pairs": { "codex\u0000gpt-6-mini": "off" } },
    "archive": { "base": "none", "providers": {}, "pairs": {} }
  }
}
```

`selection` is `null` for "no policy at all" (the question `GET` answers) and a rule
document otherwise; a body that is not a JSON object, an unknown `sort`, a `dir`
outside `asc`/`desc`, a `limit` outside 1-2000, a non-boolean `archived`, a
malformed selection, a body over one megabyte or a method other than `POST` is
**refused with 400/405/413** rather than answered with a different question — a
host that half-reads a selection answers a question nobody asked, and the panel
draws that answer under the reader's own controls.

`GET /api/model-stats` (`?sort=&dir=&view=&provider=&archived=&limit=`, where `dir`
is `asc` or `desc`, `provider` is a comma-separated list and may also be repeated,
`archived=1` asks for the archive and `limit` bounds the page at 200 rows —
anything else, including its absence, is the default of hiding the archive and of a
50-row page) stays exactly as it was, for any client that predates the selection.
The panel always names `limit=200` because its table is the configured set and not
only the history: see *Models the configuration serves and the history has not
seen*. Both routes accept every column key of the table (`rating`, `steps`,
`ttft`, `speed`, `errors`, `lastSeen`, `name`, `ttftP90`, `tpsMax`,
`confidence`, `llm`, `cache`, `retry`, `ttftClean`, `e2e`, `prefill`,
`overhead`, `errorRate`, `modelErrors`, `interrupted`, `liveness`), while the
agent tool `model_stats` uses its curated six-order enum — the five it always
had plus `rating`, with `steps` still the default. An order nobody knows falls
back to `steps` rather than failing the request, and the answer echoes the order
it really applied — the panel draws its arrow from that echo, so a host that
predates a column cannot end up with a heading claiming an order its rows are
not in. A rating with no score is not a zero: under either direction the
unrated rows stay at the bottom, in the order every other missing figure uses.

Four fields of the answer exist for the selection:

| Field | What it is |
|---|---|
| `selection` | the rule document the host applied, canonical — `null` when the question carried none |
| `catalog` | every model in scope with `{ model, archived, noStats, steps }`, for the tree |
| `coverage` | per provider, `{ selected, total }` — what "N of M models" is read from |
| `truncated` | `true` when the selection is larger than the page: the table is not the whole answer |

`catalog` is built from the **unfiltered** report and the whole configuration, so it
names the models the reader has not marked as well as the ones they have: a catalog
read off the rows being sent could only ever offer what is already ticked. `totals`
and `providerList` stay whole-history figures for the same reason — a total that
moved with the selection would no longer be a total — while `shown` counts what the
selection kept, before the page cut it.

> The client half is registered when the page boots: after the plugin is first
> installed or its `dsh.client` manifest changes — the `inject` list included —
> do a full browser reload (not a soft HMR reload) to pick up the panel.

## Load on the Harness

**This plugin registers no hook on the LLM request or stream path.** It only reads
history: once in the background after activation, and then on demand.

Opening the panel is answered in three phases, cheapest first, so the table is
never held behind a cold fold:

1. **The in-memory fold.** This process already folded the corpus, so the route
   answers from memory in milliseconds without touching the store.
2. **The on-disk snapshot.** A fold written by an earlier process is validated
   against **one** corpus listing — revisions only, no log is read — and unchanged
   logs are served from it as they are.
3. **The folding pass.** Whatever the snapshot could not cover is read, bounded.
   One listing decides for every session whether its snapshot entry may be reused,
   so a repeat pass reads nothing at all, and a changed log is the only log read.

- One background warm pass folds the whole corpus right after activation and then
  writes the snapshot. Nothing runs on a timer, and the panel never polls — the
  client only re-asks while the host reports work still moving.
- **Every request is bounded**, so a first-ever run on a large store never blocks
  an HTTP request for minutes: the panel's route is capped at 2.5 s and the tool
  at 20 s, and both return what is folded so far plus a `pending` count.
- Each session is folded once per process and cached against its persistence
  revision; the revision comes from the corpus listing rather than a per-session
  `stat`, which is what keeps a cold pass linear instead of quadratic.
- The browser keeps the last answer per sort/direction/view in `localStorage`, so
  the table
  appears instantly after a reload and refreshes behind the first paint.
- All services are injected (`tools`, `webServer`, `sessionQuery`), and every read
  failure is contained and reported as a skipped session.
- Zero runtime dependencies, import-free host half apart from this package's own modules.

The snapshot lives in `~/.dsh/cache/dsh-model-stats/fold-snapshot.json`
(override with `DSH_MODEL_STATS_CACHE_DIR`). It holds folded samples only — never
events — and is replaced atomically, so a crash mid-write cannot leave a half
snapshot behind.

Measured with `tools/harness-real.mjs` against this machine's real store
(**374 sessions / 21 645 timed steps / 62 model identities**, ~22 % of logs still
in the legacy v3 format):

| | |
|---|---|
| cold full corpus (first pass, no snapshot) | 22.4 s |
| repeat pass, nothing changed | 0.31 s, 0 logs read |
| fresh process, snapshot status check | 0.12 s |
| fresh process, answer from snapshot | 55 ms, 0 logs read |
| fresh process, in-memory answer | 21 ms |
| same pass before this change | 23.6 s, whole corpus re-read every call |

Contract tests live in `tools/verify-budget.mjs`: they assert that a bounded call
returns promptly and partial, that repeated calls converge, that **a session is
read exactly once per collector**, that a restart reuses the snapshot without
reading a log, that a moved legacy corpus revision re-reads only legacy sessions,
and that a long-budget warm pass completes the corpus.

Row order has its own contract test in `tools/verify-sort-order.mjs`. A fixture
can only catch a wrong sort basis if the two candidate bases disagree on it, so
every discriminating fixture is also asserted to disagree: each of `ttft`, `speed`
and the `errors` tie-break carries a case whose mean and median pick different
winners, and the test fails if that stops being true rather than passing quietly.
The same file now also holds the grouping half of the provider report — it was
bucketed by `(provider, model)` like the model report, so a provider with two
models came out as two rows and `providers` counted models.

The provider filter has its own contract test in `tools/verify-provider-filter.mjs`:
one reading of it through the query string, the panel payload and the agent's
text, plus the three properties it rests on — that `providerList` names the whole
history rather than the rows on screen, that it drops the providers whose every
row the archive holds and offers them again with the archive on, and that `shown`
counts what the filter left rather than the page the limit cut.

The selection has the other half of that, in `tools/verify-selection.mjs`. It is
built on a corpus with the two shapes a selection is easy to get wrong about — two
models of one provider, and one model id under two providers — and it asserts the
aggregate against an **independent recomputation** from the raw samples and error
records, medians included: a provider row for one selected model of a two-model
provider reads 905 ms, which is that model's own median, where averaging the ready
rows would have said 504 ms. Alongside it: the same model id under two providers
stays two rows and selecting one leaves the other out; a provider-level retry record
(with no model of its own) follows its provider while any of its pairs is selected
and disappears when none is; an empty selection is an empty table and never the
whole one; a rule about a provider picks up a model the configuration gained later
while a narrow manual set does not; the catalog is complete whatever the sort and
the limit; `shown` counts the selection and not the page; `coverage` marks a partial
provider; and both routes are driven end to end for their schemas — `GET` unchanged,
`POST` refusing a wrong selection with 400 rather than answering with the full
table, and 405/413 for a wrong method and an oversize body.

The last section of that file exists for a specific failure: the panel resolves the
stored rules itself, over the catalog of its last answer, because a checkbox has to
be drawn before the next answer arrives — and the host resolves the same rules over
the catalog only it can see in full. Two implementations of one precedence is a
drift this repository cannot afford, so the two are pinned against each other over
one catalog and six rule documents, pairs and per-provider coverage both. That
cross-check is what found the one place the two disagreed about a document missing
its maps.

`tools/verify-panel-state.mjs` drives the shipped panel through the tree itself: a
first open asking for the default rule and nothing else, a partial provider drawn as
an indeterminate control with a number beside it, a group click written as a rule
and not as a list, one model under a provider-wide rule written as a single
exception and removed again when the tick comes back, the mass buttons independent
of the search, an empty selection and the way back from it, the selection surviving
a closed tab, a v1 provider filter migrating into rules while an *empty* one keeps
meaning "no filter", the archive returning the marks it holds, a request that failed
keeping the table, an answer to the previous selection not being passed off as the
current one, the truncation notice and the page it raises, and a browser that
refuses to store anything still working in memory and saying so.

Rows built from the configuration rather than from the log have their own test in
`tools/verify-configured-rows.mjs`: that a pair with no history is a row of the
same shape as a measured one with every figure but the step count unmeasured
(never a zero standing in for "not measured"), that the merge is a re-sort and not
a splice — under `steps` ascending and under `name` the unmeasured rows belong
*between* measured ones, and the test asserts exactly that order — that the status
order ranks them, that the archive and the configuration are two halves of one
statement over one table, that a provider with no history gets its row and its
place in the filter list, and that an unreadable catalog produces no rows at all.
It also pins the scope: the agent's text report is the history, and the test fails
if a configured row ever appears in it.

The panel's own state machine has a test too, `tools/verify-panel-state.mjs`. The
client half is browser-only and has no build step or importer, so the test runs
`client.js` in a context whose module loader, `localStorage`, `fetch`, timers and
React are replaced with the smallest fakes that can drive the registered section:
it clicks the column headings and the provider checkboxes and
asserts what the tree contains — including that every heading's sort key is one
the host's route actually accepts, checked against the imported `PANEL_SORTS`.
Its contract is one line — **rows already on screen are never replaced
by a message**. Switching the sort used to blank the table and, when that request
was slow, failed or was aborted by the next click, the rows did not come back on
their own. The test fails on ten checks if that behaviour returns.

## Usage

**Panel:** Plugins → the `dsh-model-stats` bundle → its page (see *Where to find
it* above).

**Agent tool** — registered globally:

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
the fastest decode, and every model that produced errors.

### Reading the output

- `sort: "ttft"` and `sort: "speed"` order rows by the same median the panel
  shows in `ttft_med` / `tps_med`, so the first row of the table is the model the
  arrow points at.
- Prefer `tps_med` over `tps_mean`: throughput distributions are skewed.
- A `-` for `tps` means no step produced a usable rate — either the provider
  recorded no stream timing for that model, or it reported no token count, or
  every span was a single packed burst. Not that it was slow.
- `speed_conf` says how much of the row that `-` does not apply to: a low share
  means most steps were too short to be a rate.
- The p90 and max `ttft` columns include retries and long tool-call steps, so a
  high `ttft_max` alongside a low `ttft_med` means occasional stalls, not an
  overall slow model.
- A `provider` filter reaches the summary lines too: *fastest first token* names
  the fastest model **of the filtered set**, not of the whole history. The
  unfiltered set counts, not the page the limit cut off, so raising `limit` never
  changes which model is the fastest.
- `sort: "rating"` orders by the technical score and puts the unrated rows at
  the bottom in both directions, like every other missing figure. The `~` and `*`
  marks ride in the cell, and the line under the table names both what they
  mean and which rows carry them; a `-` is one of four reasons, counted in that
  same line (`no_samples`, `no_qualified_samples`, `insufficient_samples`,
  `pair_only`).
- The rating is not answer quality, not price and not reachability, and a `*`
  on it does not lower it: the mark says the evidence is old, and the number is
  the number its history earned (see *The rating*).
- A model that is not in the current configuration is not printed: the archive is
  off by default, so the table names models you can run. It is not silence — one
  `archive:` line reports how many rows and steps were left out, and says that
  `archived: true` brings them back. That line reads `archive: unknown` when the
  live catalog could not be read, because then nothing was graded at all.

## Install

```bash
dsh plugin --profile web add link:/path/to/dsh-model-stats
```

Or through the plugin manager, pointing `install_bundle` at this directory.

## Composition

`cordis.patch.yml` inserts one row:

```yaml
- insert:
    - id: model-stats
      name: dsh-model-stats
      config: {}
```

## Verification

```bash
node tools/verify-rating.mjs    # the formula: the anchors, the weights, the population gate, the nulls
node tools/verify-rating-paths.mjs  # one pair, one score: cold fold, snapshot, selection and sinceMs agree; the marks match the panel's
node tools/verify-metadata.mjs  # route metadata: bounded, cached, unknown is null, and no probe behind it
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
node tools/per-model-speed.mjs   # decode vs streaming-span throughput per model
node tools/verify-tokens-per-fragment.mjs  # tok/s is tokens, not stream fragments
node tools/harness.mjs           # end-to-end drive through the plugin's real apply()
```

Counts as they stand on 2026-10-01, all fifteen green (`exit=0`):

| tool | what it counts | checks |
|---|---|---|
| `verify-panel-state.mjs` | panel behaviour, driven through the shipped `client.js` | 338 |
| `verify-selection.mjs` | rules, catalog, and an independent recomputation of the aggregate | 122 |
| `verify-sort-order.mjs` | every order is total, stable and discriminating | 87 |
| `verify-rating.mjs` | the formula's arithmetic, exclusions, weighting, nulls | 60 |
| `verify-metadata.mjs` | bounded lookups, TTL, dedup, disposal, the whitelist | 60 |
| `verify-provider-filter.mjs` | one reading of the filter on every surface | 58 |
| `verify-rating-paths.mjs` | the same pair scored identically down every path | 41 |
| `verify-configured-rows.mjs` | what a pair with no history is | 31 |
| `verify-budget.mjs` | the collection contract | 26 |
| `verify-liveness.mjs` | the catalog join and the state classification | 20 |
| `verify-probe-shape.mjs` | probe shape, named pairs, the cap | 14 |
| `verify-probe-budget.mjs` | the deadline rule | 12 |

That is 869 counted assertions in the twelve tools that print a count; the other
three assert by exhaustive comparison instead — `verify-official.mjs` field by
field against the official projection, `verify-retry.mjs` over every retry event
in the corpus, and `verify-tokens-per-fragment.mjs` over 21 576 folded steps of
20 models. `verify-retry.mjs` reads a real corpus and takes its path as its first
argument, defaulting to `/tmp/dshcorpus` (183 sessions here) — a missing corpus
is an inability to run, never a pass.

Two of the rating's properties can only be tested with a frozen clock, and both
are pinned on the two surfaces rather than asserted once. The panel test mounts
`client.js` with an injected `Date.now()` and requires `61,0` at exactly one
half-life and `61,0 *` one millisecond later; the report test does the same
against the text report and the panel's cell side by side. Flipping either `>`
to `>=` fails exactly one check and nothing else, which is the evidence that the
assertion is aimed at that comparison and not at the code around it.

`harness-real.mjs` mounts the shipped `session-persistence-jsonl` and
`session-query` plugins the way the composition does, so the numbers it prints
include the cost that lives inside them. It writes its snapshot to a temp
directory and only ever reads the real store.

`verify-liveness.mjs` is the one test that spends provider traffic — one short
probe request per probed model, stopping at the first model that answers. It mounts the
real `LlmRuntime`, the real credential store and the real provider adapter rather
than stubbing `ctx.get`, and that is the whole point: the bug this file exists to
catch was `ctx.llm` being read while the plugin never declared `llm` among its
injected services, so every probe failed in zero milliseconds with
`cannot get property "llm" without inject`. A test that hands the plugin the
service the host refuses cannot see that class of failure at all. Its first
assertion is therefore the contract itself — every service the code reads is a
service the plugin declares.

`verify-probe-budget.mjs` proves the deadline rule without spending provider
traffic: a local server answers just past the old 15 s deadline and the probe
still records an answer, a route that declares a 400 ms deadline of its own is
aborted at exactly that, and a caller's explicit `timeoutMs` still wins.

`lib/liveness-http.js` is the config-reading fallback and carries its own rules:
it resolves keys through `$DSH_HOME/.credentials.yaml` and never returns, logs or
embeds one; a configuration it cannot parse costs it the fallback rather than the
request; it refuses a wire protocol it does not implement instead of guessing
one; and it reads each route's declared `timeoutMs` / `streamIdleTimeoutMs` for
the probe's budget, so the fallback is no harsher on a slow route than the live
adapter is.

`lib/status.js` is the one classification in the plugin, and it is where the
status column's order comes from: what a probe's codes and its own sentence mean
as one of the panel's five states, the rule that a later request outranks a stale
check, the rank each state sorts by, and the provider roll-up. It is pure and
imports nothing, and the panel bundle cannot import it — so the host stamps its
verdict onto every probe result as `state` and the panel reads that, keeping its
own copy of the rule only for the word it prints and for a host that predates the
field. Two copies of a classifier would be two verdicts, which is the one thing a
column whose cells double as a sort key cannot afford.
