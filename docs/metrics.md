# How each number is measured

`README.md` is the authoritative table of what a column means. This file is the
argument behind it: how each figure is constructed, which choices could have
gone the other way, and the measurement that settled them.

Everything here is derived from events the harness has already committed to the
session log. The plugin registers no hook on the request or stream path, so
every number below is a replay of recorded history rather than an
instrumentation of live traffic.

`ttft` and `llm` reproduce the official `@deepseek-ai/dsh-session-stats`
`sessionStats` fold exactly, to the millisecond;
`tools/verify-official.mjs` asserts it field by field. A new timing figure is a
*new field*, never a redefinition of one of these.

## One step, three intervals

A single assistant turn — one **step** — is measured three ways, and the three
disagree on purpose:

| Interval | From | To |
|---|---|---|
| time to first token | `step/start` | the first non-empty delta fragment |
| streaming span | that first fragment | the last one |
| model wall time | `step/start` | `assistant/message` |

`ttft` is the first, `tps` is computed over the second, `llm` is the third, and
the space between the end of the second and the end of the third is `overhead`.

## Why the streaming span is not the decode interval

The official `decode` interval is `first token → assistant/message`. In an agent
loop that interval also contains harness work between the final token and
message assembly, so dividing output tokens by it yields impossible rates — on a
real 78-session history it produced spikes up to 213 000 tok/s.

This plugin therefore reconstructs token arrival times from the recorded delta
runs (`time0` + accumulated `dt`) and measures over the span the provider was
actually streaming.

## Why the numerator is tokens and not fragments

A delta fragment is a transport chunk, not a token, and providers batch them
differently. On this machine's history one fragment carries ~1.1 tokens from
`deepseek-official/deepseek-flash` and ~28 from
`openrouter/stealth/space-bunny-alpha`, which streams 100–270 characters per
chunk. Counting fragments therefore reports *chunks* per second under a
*tokens*-per-second label and understates a batching provider by exactly that
factor — it made the second-fastest decoder in this install look 30x slower than
it is.

The report names the batching factor when it exceeds 8 tokens per fragment, and
`tools/verify-tokens-per-fragment.mjs` checks the whole corpus for it.

## When a span counts as a rate

A span becomes a throughput sample only when it carries at least 100 ms, at
least 8 tokens **and** at least 4 fragments: one packed burst is not a rate.
A step the provider streamed without reporting usage has no numerator and
contributes nothing, so a model that never reports a token count shows `-`
rather than a guessed figure. `speed_conf` is the share of streamed steps that
cleared the floor — the figure that tells you how much of a `-` does not apply.

The three floors live in one shared definition, `lib/eligibility.js`, re-exported
by the fold, so the rating and the `tps` column cannot drift apart about which
steps count. Measured on this history the floor is cheap where a model streams
normally and decisive where it does not: it drops 425 of 9926 eligible
`deepseek-official/deepseek-flash` steps (4.3%) and 402 of 2370 for
`openrouter/stealth/space-bunny-alpha` (17%), but 1419 of 1468 for
`limitdeckai2/deepseek-v4-flash` (96.7%) — and the fastest of the steps it
removes there is 5454 tok/s, which is a flush being divided by a span, not a
decode. That is also why a coverage column of 3.2% is a fact about a route
rather than a defect in the table.

## `e2e_tps`: the figure to choose a model by

`tps` answers "how fast does this model print". The question behind the plugin
is "which model should I use", and the answer is "how fast do I get tokens" —
which is `e2e_tps`: the same numerator over `ttft + stream` instead of over
`stream` alone. The same eligibility gates both, deliberately not repeated on
the wider span: a prefill can only make the denominator larger, and the failure
the guard prevents is an implausibly *high* rate.

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

## What a retry costs, and why `delayMs` is not it

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

## An error count is not a verdict

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

`interrupted` is counted on its own rather than folded into `err`: a turn taken
over is not a model error and not a provider refusal, but in an agent loop it is
a wasted step.

## `overhead`: the one column that points at this host

`overhead = llm − ttft − stream`, i.e. the gap between the last recorded delta
and the `assistant/message` that closed the step. Everything else in the table
belongs to the provider; this part does not.

It is small in total — **7 574 s of 382 446 s, about 2% of model time** — and
not spread evenly. Median 20 ms corpus-wide, p90 57 ms; but `codex/gpt-6-astra`
pays 387 ms a step, `codex/gpt-5.6-sol` 220 ms, `clinebot/cline-pass/kimi-k3`
216 ms, and `splash/incoai/Qwen3.8-27B-Splash` 1 ms. Left unclamped: measured
over 16 037 corpus steps it is never negative, and a log that broke that
assumption should show a negative number rather than have it hidden.

## `maxContextTokens`: observed, not declared

The largest observed per-step sum of input, cache-read and cache-write tokens —
**not** the model's supported context-window limit. Missing usage currently
contributes zero, so zero does not establish an observed empty context. What a
route *declares* about its window is a different source and a different
question; see *What the route declares* in `README.md`.

## Tool time: what the agent loop spends between two model calls

`toolMs` is one step's wall time waiting for the tools it called, `tool/call` →
`tool/result` paired by `callId` — the official `tool` projection, and the reason
this figure was not a redefinition of anything. It is folded onto the *sample of
the step that raised the calls*, joined by the `(turn, step)` the log's own event
carries, and it is joined after the walk rather than during it: the log records
`assistant/message`, then `tool/call`, then `tool/result`, then `step/end`, so a
sample stamped as it is pushed would always read zero. Doing it afterwards also
makes the join independent of that order.

**It does not overlap `llm` or `overhead`, and that is measured, not argued.**
Every one of the **32 080** paired calls on this history answers *after* the
`assistant/message` that closed its step, so the two figures are disjoint by
construction — the step's LLM span is closed before any of its tools run.
`tools/verify-tool-timing.mjs` asserts it over the corpus, because a result that
ever landed first would mean `overhead` had been counting tool time under another
name and this column would be publishing a second copy of it.

### The two halves, and why they are two columns

`toolCallsPerStep` is `toolCalls / steps` over **every** step the pair took, so a
step that called nothing is a measured `0` and a model whose steps need no help
reads as zero rather than as missing. `toolMs` is summarised over the steps that
**did** call something, and a pair with none shows `-`: a median over mostly-zero
steps is not what a reader is asking for. On this history, over the 40 of 49 rows
that called anything, the two ranges are 0.50–1.76 calls a step, and 9 ms to
1 728 ms of median tool time per step.

### The number is the tool's, and the breakdown is what makes it readable

This is the part that had to be measured before the column could be designed.
Total tool time on this history is **128 060 s** over 32 080 calls — mean 3 992 ms,
median **38 ms**, p90 535 ms, p99 57.6 s, max 7 h. The distribution is not the
model's; it is the tools the model happened to reach for:

| tool | calls | ms/call | total |
|---|---|---|---|
| `ask_user_question` | 125 | 519 005 | 64 876 s |
| `bash` | 15 929 | 2 764 | 44 033 s |
| `edit` | 5 222 | 1 786 | 9 326 s |
| `write` | 492 | 6 872 | 3 381 s |
| `read` | 5 817 | 20 | 115 s |

`ask_user_question` is **a person thinking**, and it is 76 of the busiest pair's
20 315 calls and 28 328 s of its 64 922 s. So the column publishes `toolCallsTop`
beside the median: a row that looks slow can name the tool that made it slow, and
nothing is silently excluded — a hidden exclusion list would make the column
mean "time minus the tools I decided to discount", which is a number no reader can
check.

The tail carries the same caveat as `retryDeadMs` (see *What a retry costs*): a
wall-clock difference includes a suspended machine. `gpt-5.6-luna` has a p90 of
**284 712 ms** from five `write` calls, which is a sleep and not a tool. Medians
are what the panel shows and they are unaffected.

### What a changed log must not do to this column

The plugin never asks the Harness to publish anything, so it reads whatever the
log says and has to stay honest when that changes. Three shapes a future release
could plausibly produce, and what each one costs here:

- **`tool/call` without `turn`/`step`.** The step the call belongs to is then
  unknown, and a call is not attributed to whoever spoke last — that is the rule
  a retry record follows too. The call is counted and left out, and every step of
  that session reads `toolSpans: null` — *unknown*, not the empty array that
  means "this step called nothing". The row publishes `toolStepsUnknown`.
- **No step identity anywhere.** The same null, and the reason it is not the same
  as above: interpolated, every call in a session lands on the key
  `undefined:undefined` and the first sample to claim it inherits the whole
  session's tool time. `stepKey` returns `null` for anything that is not a pair
  of integers, so that key is never issued.
- **A different spelling of the call id.** `source.callId` and the flat
  `toolCallId` both appear on every result in this corpus — 7 630 of 7 630 in the
  80 logs sampled — and both are read, the official one first. Reading one means
  a Harness that drops it zeroes the whole column silently.

Each of the three is asserted against a synthetic event stream in
`tools/verify-tool-timing.mjs`, and each was checked by removing the guard and
watching the tool go red: the middle one hands one step 500 ms of another step's
tool time, which is the shape this plugin treats as worse than no figure at all.

## `turns`: how the conversation ended, not how a step did

`turn/end` carries `reason.kind`, and the fold used to parse it and drop it. It is
a separate record set — like `errors` and `retries`, and for the same reason: a
turn spans many steps, so the outcome has nowhere to live on a sample.

The vocabulary measured on this history is **five** kinds, not the four the debt
note guessed when it was written: `completed` 729, `error` 129, `aborted` 73,
`max-tokens` 8, `interrupted` 2. The kind is carried through as a name and never
as a flag, so a sixth kind is counted and names itself without a code change.

A turn is attributed to the model that last spoke in it, through a speaker
variable that is **cleared at `turn/end`** rather than the session-wide one the
tool-error and retry attributions use. **111 of the 941** turns here ended without
a model in them; carrying the previous turn's speaker forward would have filed
every one of them under a model that never answered. They reach no row.

`tools/verify-turn-ends.mjs` asserts the three things that can go wrong here: one
turn produces one record and only if a model spoke in it, the kinds add up to
`turns` and `turnsUnclean` plus the completed count is `turns` again, and the
corpus exercises more than one kind — a fold that recorded `kind` and only ever
saw `completed` would pass everything else and publish a column of zeroes.

There is no panel column for it, and the reason is the population: 941 turns over
39 rows, so most rows carry a handful. The figures are in the payload, the
breakdown is where the rest of them are, and a heading a reader clicks for a
per-step figure is the wrong place for a per-conversation one.

## Unmeasured is `null`, never `0`

Every figure the plugin cannot derive is `null`, and every cell renders `-` for
it. A `0` is a measurement, so the plugin never manufactures a number to fill a
cell — a cell that looks measured is read as measured. The panel's formatters
(`ctx.fmt.*`) guard with `finite(value)` rather than formatting the value
directly, which is what makes a column added after a row was built render `-`
instead of throwing and taking the table down.