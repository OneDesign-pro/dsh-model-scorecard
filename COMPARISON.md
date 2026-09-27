# dsh-usage-vendor-stats vs dsh-model-stats

Comparison run on the same real history: **78 session logs, 55 112 events,
8 229 timed steps, 9 providers, 20 model identities** (cached, 27 Sept 2026).

Both are installed and active in the `web` profile. `dsh-model-health` is
installed as the secondary on-demand probe.

## 1. Metric coverage

| Metric | dsh-usage-vendor-stats 0.2.0 | dsh-model-stats 0.1.0 |
|---|---|---|
| Columnar tokens by vendor → model | yes | yes |
| Heatmap / trends / CSV | yes | no |
| **`ttft` per model** | **no — one global figure** | **yes** (mean/median/min/max/p90) |
| **`tok/s` per model** | **no — one global figure** | **yes** (median/mean/min/max + n) |
| **`llm` wall time per model** | **no** | **yes** |
| Error count | global + per vendor | per model + per provider |
| Tool-failure attribution | no | yes, by model |
| Peak context | global | per model |
| Reliability indicator for the rate | no | `speed_conf` |

The decisive gap: in `dsh-usage-vendor-stats/lib/index.js` the `health` object
(lines 566–576) is built from a single `perf` accumulator that carries **no
provider or model dimension** — `avgTtftMs` and `genTokensPerSec` are computed
once for the entire installation. `errorsByVendor` is the only health figure that
is broken down at all. So "which model responds faster?" is not answerable from
its health card.

`dsh-model-stats` never produces a blended figure: every row keys on
`message.source.{provider,model}`.

## 2. Throughput correctness

`dsh-usage-vendor-stats` follows the official `sessionStats` semantics:

```js
genTokensPerSec: perf.decodeMs > 0 ? (perf.decodeTokens / (perf.decodeMs / 1000)) : null
```

`sessionStats.decodeMs` spans **first token → `assistant/message`**. In an agent
loop that interval also contains harness work between the last streamed token and
message assembly, so dividing tokens by it is not a rate.

Measured against the same history, decode-based vs streaming-span-based tok/s:

| model | decode tok/s | span tok/s | inflation |
|---|---|---|---|
| limitdeckai/gpt-5.6-luna | 4125.1 | 28.3 | **146.0x** |
| openrouter/stealth/space-bunny-alpha | 149.2 | 4.3 | 34.3x |
| clinebot/cline-pass/minimax-m3 | 146.4 | 8.7 | 16.9x |
| nvidia1/z-ai/glm-5.3 | 28.7 | 6.0 | 4.8x |
| codex/gpt-5.6-sol | 142.9 | 34.8 | 4.1x |
| clinebot/cline-pass/kimi-k3 | 48.2 | 43.1 | 1.1x |
| deepseek-official/deepseek-flash | 266.4 | 257.1 | 1.0x |
| splash/incoai/Qwen3.8-27B-Splash | 18.5 | 19.8 | 0.9x |

The inflation is **not a constant factor**, so it cannot be corrected by
calibration — it depends on how much non-streaming work each model does. Across
the whole history the blended inflation is only 1.2x because `deepseek-flash`
dominates the sum, which is exactly why a single global figure hides the problem.

`dsh-model-stats` reconstructs token arrival times from the recorded delta runs
(`time0` + accumulated `dt`) and measures throughput over the span the provider
was actually streaming. A span counts only when it carries ≥ 100 ms and ≥ 8
tokens, and `speed_conf` reports what share of streamed steps qualified.

## 3. Correctness of the shared metrics

`dsh-model-stats` reproduces the official `sessionStats` fold exactly. Verified
field-by-field against the projection unit itself
(`@deepseek-ai/dsh-session-stats`) on one real session log:

| field | official | dsh-model-stats | diff |
|---|---|---|---|
| `llmMs` | 67 225 | 67 225 | 0 |
| `ttftMs` | 32 541 | 32 541 | 0 |
| `ttftSteps` | 24 | 24 | 0 |
| `decodeMs` | 34 684 | 34 684 | 0 |
| `decodeTokens` | 9 761 | 9 761 | 0 |
| `steps` (step/end) | 23 | 24 (assembled messages) | 1 |

The step-count difference is intentional: rows are per assembled assistant
message, because a step that assembled no message carries no timing to report.

## 4. Load on the Harness

| | dsh-usage-vendor-stats | dsh-model-stats |
|---|---|---|
| Hook on the request/stream path | none | none |
| Background timers | none (backfill once at boot) | none |
| Data source | official `sessionStats` projection, re-folded per session | own fold over the same committed events |
| Caching | per-session, incremental | per-session, keyed on `sessionPersistence` revision |
| Dependencies | none | none |
| Measured cold call | (background backfill at boot) | ~30–40 ms |
| Measured cached call | — | ~10 ms |
| Idle cost | 0 | 0 |

Both honour the "minimal overhead" requirement: neither instruments the stream.
The difference is that `dsh-usage-vendor-stats` re-folds the official projection
over session events, while `dsh-model-stats` folds the raw events directly in one
pass — which is what lets it attribute every figure to a model.

## 5. Verdict

- **Keep `dsh-usage-vendor-stats` for the token/cache/cost dashboard** — heatmap,
  trends, monthly rollups and CSV are real value there.
- **Use `dsh-model-stats` for the decision "what should I run this on"** — it is
  the only one of the two that can answer it, and the only one whose throughput
  figure survives contact with the data.
- **Ignore the health card of `dsh-usage-vendor-stats`** for model selection: the
  `avgTtftMs` is blended across all models and `genTokensPerSec` can be off by two
  orders of magnitude.
- `dsh-model-health` stays as the secondary on-demand probe, untouched by both.

## Reproduce

```bash
node model_stats/tools/harness.mjs      # drive the plugin against real logs
node model_stats/tools/verify-official.mjs   # cross-check against sessionStats
node model_stats/tools/per-model-speed.mjs   # decode vs span throughput per model
```
