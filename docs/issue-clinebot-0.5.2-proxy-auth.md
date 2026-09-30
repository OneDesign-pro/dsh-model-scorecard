# 0.5.2: the local proxy token never reaches the proxy through DSH 0.1.7-rc.2 — every ClineBot route fails with `AUTH 401`

## Environment

| | |
|---|---|
| DSH | `0.1.7-rc.2` (`@deepseek-ai/dsh`), adapter `@deepseek-ai/dsh-llm-pi-ai@0.1.7-rc.2` |
| Profile | `web`, proxy mode default (`proxyMode: true`) |
| Plugin | `@goodandready/dsh-clinebot@0.5.2` (installed 2026-09-28 12:59 MSK; previous version had no bearer check) |
| Probe endpoint | `http://127.0.0.1:3080/dsh-clinebot/v1` |
| System | macOS (darwin), Node from the DSH bundle, single default account |

## Summary

After upgrading to **0.5.2** (Issue #145, local bearer auth on the loopback proxy), **every** request routed through the provider fails:

```
FAIL clinebot/cline-pass/<any-model>   AUTH 401 "Unauthorized: missing or invalid bearer token"   1–3 ms
```

All 12 configured `cline-pass/*` models, from `ctx.llm` (i.e. exactly the path a real chat uses), in 1–3 ms — so it is rejected locally by the proxy before any upstream call.

The token itself is fine. The bug is **which field carries it into DSH**: 0.5.2 writes the generated token as a literal `apiKey` on the provider entry, while DSH's `llm-pi-ai` adapter resolves a request's credential **only from `apiKeyEnv`** and never reads a literal `apiKey` on the streaming path. `apiKeyEnv` still points at the account variable (`CLINEBOT_API_KEY`), so the proxy receives the real ClinePass key, compares it with `CLINEBOT_LOCAL_PROXY_TOKEN`, and refuses it.

This is not a diagnostics-only problem: before 0.5.2 the same route answered (the 2026-09-27 probe files contain real upstream answers — `500 empty response content`, `404 model not found`, produced with the account key), so with 0.5.2 the provider is unusable through DSH.

## Steps to reproduce

1. Install 0.5.2 with a valid `CLINEBOT_API_KEY` and proxy mode on (`proxyMode` default), then boot the host.
2. Look at what the plugin registered in `llm-pi-ai.providers.clinebot` (`~/.dsh/profiles/web/cordis.patch.yml`):

```yaml
clinebot:
  displayName: ClineBot (ClinePass)
  api: openai-completions
  baseURL: http://127.0.0.1:3080/dsh-clinebot/v1
  apiKeyEnv: CLINEBOT_API_KEY                 # ← the real ClinePass key, this is what the adapter sends
  apiKey: <the generated proxy token>         # ← this is what the proxy expects
```

3. Send anything through the provider (a normal chat, or a liveness probe through `ctx.llm`) → `AUTH 401` above.

## Evidence

### The proxy accepts the token and refuses the account key

Same payload as DSH (`ping`, `max_tokens: 16`, non-streaming), against the live endpoint:

| `Authorization: Bearer …` | Result |
|---|---|
| `CLINEBOT_LOCAL_PROXY_TOKEN` | **200**, 1.81 s, content `Pong! 🏓 How can I help you today?` |
| `CLINEBOT_API_KEY` (the account key) | **401**, 1.25 ms, `{"ok":false,"error":"Unauthorized: missing or invalid bearer token"}` |
| *(no header)* | **401**, 1.02 ms, same body |

`/dsh-clinebot/v1/models` has the same check (`lib/routes/proxy.js:349`), `chat/completions` at `:74`.

### Isolated reproduction against the real DSH stack

The same profile patch, the real `LlmRuntime` + credentials + `llm-pi-ai` adapter, only `apiKeyEnv` changed (`--probe clinebot/cline-pass/minimax-m3`):

```
before, apiKeyEnv: CLINEBOT_API_KEY            → FAIL clinebot/cline-pass/minimax-m3   56 ms   llm  AUTH 401 "Unauthorized: missing or invalid bearer token"
after,  apiKeyEnv: CLINEBOT_LOCAL_PROXY_TOKEN  → OK   clinebot/cline-pass/minimax-m3 1652 ms   llm
```

So the token is the whole difference; the route, the key and the models are healthy.

### Telemetry

`~/.dsh/clinebot-stats.json`, window 13:03:21 → 14:31:51 MSK (since the upgrade): `requests: 27`, `successful: 0`, `failed: 27`, `promptTokens: 0`, `completionTokens: 0`. Only requests that actually presented the token get that far (the 401 returns before usage recording), so the counters contain the manual token-carrying calls; requests coming from DSH's provider entry never reach them at all.

## Root cause

1. `lib/routes/proxy.js:46-51,74` — the proxy requires `Bearer <getLocalProxyToken()>`, i.e. `process.env.CLINEBOT_LOCAL_PROXY_TOKEN` (`lib/proxy-token.js:19`).
2. `lib/provider-sync.js:207-221` — in proxy mode the plugin saves the token as a credential and builds the entry:

```js
const localToken = isProxy ? getLocalProxyToken() : undefined
if (isProxy && localToken) await saveCredentialKey(ctx, LOCAL_PROXY_KEY_ENV, localToken)
…
const providerObj = buildPiAiProvider({
  baseUrl: effectiveBaseUrl,
  apiKeyEnv: activeAcc?.apiKeyEnv || pub.apiKeyEnv,   // ← CLINEBOT_API_KEY
  apiKey: localToken,                                 // ← the token, ignored by the host
  …
})
```

3. `@deepseek-ai/dsh-llm-pi-ai@0.1.7-rc.2/lib/index.js` — the stream path resolves the request credential **only** from `profile.apiKeyEnv`:

```js
// streamWithSnapshot()
const apiKey = await this.config.resolveApiKey(options.provider, profile)   // :1848
…
const resolveApiKey = async (provider, profile) => {                        // :2559
  const ref = profile.apiKeyEnv
  if (ref === void 0) return void 0
  …
}
```

The literal `apiKey` of a route survives profile resolution (`:1130-1135`) but is not read for streams, so the generated token has no effect.

Note for anyone tempted to hand-edit the profile: `lib/index.js:109` calls `syncProviderState(live())` on every start, so a manual `apiKeyEnv` fix in `cordis.patch.yml` is overwritten by the next boot — the change has to live in the plugin.

## Suggested fix (plugin side, one line)

`LOCAL_PROXY_KEY_ENV` is already imported in `lib/provider-sync.js:24` and the token is already stored as that credential at `:208`, so proxy mode can simply name it:

```js
const providerObj = buildPiAiProvider({
  baseUrl: effectiveBaseUrl,
  apiKeyEnv: isProxy ? LOCAL_PROXY_KEY_ENV : (activeAcc?.apiKeyEnv || pub.apiKeyEnv),
  apiKey: localToken,
  models: modelsToRegister.length ? modelsToRegister : allModels,
  …
})
```

The account key stays in the account pool (used for upstream calls), the route gets the token, and the literal `apiKey` can stay for hosts that do honour it. If instead the design is "the literal `apiKey` wins", that precedence has to come from DSH itself — as of `0.1.7-rc.2` it does not exist for streaming requests.

## Workarounds until then

- Set `proxyMode: false` in the plugin config: the entry is registered as `https://api.cline.bot/api/v1` + `apiKeyEnv: CLINEBOT_API_KEY`, which works, but the loopback-proxy features (multi-account failover, sticky session routing, proxy-side telemetry) are lost.
- Local hotfix of the one line above in `lib/provider-sync.js` (works, but the next plugin update reverts it).

## Separate observation (not the auth bug)

A **non-streaming, 16-token** probe is a hostile shape for ClinePass reasoning models — the whole budget goes to `reasoning`, the `content` field comes back empty, and the proxy's non-streaming aggregator turns that into an error. With the token in hand, `ping`/`max_tokens: 16`:

| model | non-streaming |
|---|---|
| `cline-pass/minimax-m3` | 200, `Pong! 🏓` |
| `cline-pass/kimi-k3` | 200, **empty content** |
| `cline-pass/qwen3.7-max` | 200, **empty content** |
| `cline-pass/deepseek-v4-pro` | 500 `{"error":"empty response content"}` |
| `cline-pass/glm-5.3` | 500 `{"error":"empty response content"}` |
| `cline-pass/mimo-v2.5` | 500 `{"error":"empty response content"}` |
| `cline-pass/deepseek-v4.1-flash` | 500 `{"error":"empty response content"}` |

Streaming the same request returns `200` with `delta.reasoning` chunks, so `ctx.llm`, the agent and `smokeChat` (150 tokens) are fine — but any minimal **non-streaming** health check will report such models as dead even after the auth fix. Worth a line in the docs.

## Verification after the fix

Any request through the provider should answer instead of `AUTH 401`: a normal chat, or a liveness probe through `ctx.llm` (`model_liveness` with `provider: clinebot`, `model: cline-pass/minimax-m3` on our side).

The report above was produced with an isolated run of the real host stack — the same profile patch mounted with the real `LlmRuntime`, credential store and `llm-pi-ai`, changing nothing but `apiKeyEnv` (`node tools/verify-liveness.mjs --probe clinebot/cline-pass/minimax-m3` under a sandbox `DSH_HOME`) — plus direct `curl` calls against the live proxy endpoint.
