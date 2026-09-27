# dsh-model-stats

Historical per-model and per-provider performance analytics for DeepSeek Harness,
folded from the session history the Harness already writes.

The point is to answer one question with data instead of guesswork: **which of my
configured models should I use for this task?** For every `(provider, model)`
pair it reports how fast the model responds, how fast it decodes, how much work
it did, and how often it failed.

## What it measures

| Metric | Meaning |
|---|---|
| `ttft` | time-to-first-token: `step/start` → first non-empty delta fragment. mean / median / min / max / p90 |
| `tps` | decode throughput in tokens/sec, measured over the provider's token-streaming span only |
| `llm_mean` | model wall time per step (`step/start` → `assistant/message`) |
| `cache%` | cache-read share of total input tokens |
| `out_tok` | total provider-reported output tokens |
| `err` | failed tool results, attributed to the model that raised them |
| `speed_conf` | share of streamed steps long enough to be a reliable rate |

`ttft` and `llm` reproduce the official `@deepseek-ai/dsh-session-stats`
`sessionStats` fold exactly. Verified field-by-field against the official
projection unit on a real log — identical to the millisecond.

### Why throughput is measured over the streaming span

The official `decode` interval is `first token → assistant/message`. In an agent
loop that interval also contains harness work between the final token and message
assembly, so dividing output tokens by it yields impossible rates — on a real
78-session history it produced spikes up to 213 000 tokens/sec.

This plugin therefore reconstructs token arrival times from the recorded delta
runs (`time0` + accumulated `dt`) and measures the throughput over the span the
provider was actually streaming. A span counts only when it carries at least 100 ms
and 8 tokens, so a single packed tool-call burst cannot inflate a model's average.

## Where to find it

Two surfaces, one collector, so they can never disagree:

1. **Settings → «Скорость моделей»** — the visual panel. A sortable table of every
   model (or provider). By default it shows steps, median response time, median
   decode rate and errors; the deeper figures (p90, max decode rate, measurement
   confidence, model wall time, cache-hit rate, last seen) are one click away
   behind «все метрики». Best median response and best median decode are
   highlighted green. The last answer is kept in the browser, so reopening the
   panel paints the table first and refreshes behind it, and the chosen sort,
   view and column set are remembered. There is a refresh button; no timer polls
   once the numbers are still.
2. **The `model_stats` tool** — the same numbers as plain text for the agent.

The panel follows the GUI's language. Its copy ships as `ru` and `en`
dictionaries registered under the `dsh-model-stats` locale namespace, so the
Settings language switcher (and any language pack) applies to it, including the
section label and the number and date formats. On a host without the `locale`
client service the panel falls back to its built-in Russian copy.

The plugin's own row in the plugin list gets its name and summary the same way,
but from files rather than from the running client: the Host reads
`locale/<language>.json` (`{ "meta": { "title": …, "description": … } }`) through
the module resolver, which is why `package.json` has to export
`./locale/*.json`. With no dictionary the Host falls back to the package name and
its `description` field, so an English `locale/en.json` is what gives those two
fields a human name at all — a `meta` object in `package.json` is not part of the
package manifest and nothing reads it. Like every other host-side change here,
this one appears in the plugin list only after DSH restarts.

The panel has no URL of its own: the settings dialog is an overlay that does not
put the open section into the address bar, so its state lives in `localStorage`
(`dsh-model-stats:prefs:v1`) rather than in a query parameter. A deep link would
have to be the host shell's, not this plugin's.

The panel's data comes from `GET /api/model-stats` (`?sort=&view=&provider=&limit=`)
on the same host as the GUI.

> The client half is registered when the page boots: after the plugin is first
> installed or its `dsh.client` manifest changes, do a full browser reload (not a
> soft HMR reload) to pick up the panel.

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
- The browser keeps the last answer per sort/view in `localStorage`, so the table
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

## Usage

**Panel:** Settings → «Скорость моделей» (see *Where to find it* above).

**Agent tool** — registered globally:

```
model_stats(sort: "ttft")            # fastest median first token
model_stats(sort: "speed")           # fastest median decode
model_stats(sort: "errors")          # least stable first
model_stats(view: "provider")        # aggregate by provider
model_stats(provider: "deepseek-official", sinceMs: <epoch-ms>)
```

Output is a plain-text table plus summary lines naming the fastest first token,
the fastest decode, and every model that produced errors.

### Reading the output

- `sort: "ttft"` and `sort: "speed"` order rows by the same median the panel
  shows in `ttft_med` / `tps_med`, so the first row of the table is the model the
  arrow points at.
- Prefer `tps_med` over `tps_mean`: throughput distributions are skewed.
- A `-` for `tps` means no steps carried a usable stream span — the provider
  recorded no stream timing for that model, not that it was slow.
- The p90 and max `ttft` columns include retries and long tool-call steps, so a
  high `ttft_max` alongside a low `ttft_med` means occasional stalls, not an
  overall slow model.

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
node tools/verify-budget.mjs     # collection contract: bounds, one read per session, snapshot reuse
node tools/verify-sort-order.mjs # row order: median basis, error tie-break, missing metrics last
node tools/harness-real.mjs      # the same collector driven against this machine's real store
node tools/verify-official.mjs   # field-by-field cross-check against sessionStats
node tools/per-model-speed.mjs   # decode vs streaming-span throughput per model
node tools/harness.mjs           # end-to-end drive through the plugin's real apply()
```

`harness-real.mjs` mounts the shipped `session-persistence-jsonl` and
`session-query` plugins the way the composition does, so the numbers it prints
include the cost that lives inside them. It writes its snapshot to a temp
directory and only ever reads the real store.
