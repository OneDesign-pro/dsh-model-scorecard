# Renamed from `dsh-model-stats` (2026-10-01)

The plugin answered one question with numbers and now answers three, so the name
names what a row holds: a configured `(provider, model)` route carrying what the
history measured, what the adapter declared about itself, and whether the route
answers right now. `stats` described the first of the three and the other two
grew underneath it — the probe, the 0-100 rating, the declared metadata — and it
collided with the official `@deepseek-ai/dsh-session-stats`, whose projection
this plugin reproduces to the millisecond.

| | before | now | on upgrade |
|---|---|---|---|
| package | `dsh-model-stats` | `dsh-model-scorecard` | the profile dependency and the composition row are keyed by it — see *Install* in `README.md` |
| routes | `/api/model-stats…` | `/api/model-scorecard…` | the old four still answer for one release, from the same handler objects |
| cache | `~/.dsh/cache/dsh-model-stats/` | `~/.dsh/cache/dsh-model-scorecard/` | moved by a `rename` on first activation: the folded snapshot and every stored probe result come with it, and the activation log says which way it went |
| env var | `DSH_MODEL_STATS_CACHE_DIR` | `DSH_MODEL_SCORE_CARD_CACHE_DIR` | the old name still redirects the cache; the new one wins when both are set |
| panel state | `dsh-model-stats:prefs:…` | `dsh-model-scorecard:prefs:…` | read once from the old keys and written under the new one; the old keys are left where they are |

The alias is the same function object as the live path, not a second handler, so
the two cannot answer different questions — and it is the reason the rename is
safe at all: a browser tab holding the panel bundle from before the upgrade still
asks `/api/model-stats/query`, and without the alias that table would simply stop
refreshing. It is dropped in the next release.

What did **not** move, on purpose:

- **The tool names.** `model_stats` and `model_liveness` are global to DSH and
  independent of the package name; each names its own question, and both are what
  a model reaches for by habit. Renaming them would change the request path of
  every session that never asked to be migrated.
- **The CSS prefix `dsh-ms-`.** 291 uses in `client.js` and 58 assertions in
  `tools/verify-panel-state.mjs` buy nothing a reader can see.
- **The payload shape.** Every field, route contract and status code is the one
  it was; the rename moved names, not answers.

The title and the summary a reader sees come from `locale/<lang>.json` rather
than from the package name, and were rewritten with it: **Model Scorecard** /
**Таблица моделей**, with a description that names all three sources.