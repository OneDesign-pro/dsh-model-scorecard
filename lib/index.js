// dsh-model-stats - Host half.
//
// Historical per-model / per-provider analytics for DSH, folded from the durable
// session event log the Harness already writes. The plugin registers no hook on
// the LLM request or stream path: cost is paid only when a report is requested.
//
// Two consumers share one collector (`lib/collect.js`):
//   - the agent-facing `model_stats` tool (plain-text table)
//   - `GET /api/model-stats` behind the settings panel (compact JSON)
//
// Opening the panel is answerable in three phases, cheapest first, so the table
// is never blocked behind a cold fold:
//
//   1. the in-memory snapshot, written by an earlier pass in this process;
//   2. the on-disk snapshot, written by an earlier process, validated against
//      one corpus listing (revisions only — no log is read);
//   3. the folding pass itself, bounded, with a revision probe so an unchanged
//      log is never read twice.
//
// Import-free by design apart from this package's own modules, so module
// resolution can never break activation.

import { createCollector, renderReportText, SORTS, toPanelPayload } from './collect.js'

const name = 'dsh-model-stats'
// Every declared dependency is one `apply` must actually have, and the
// difference is not cosmetic:
//   `webServer`    — without it the panel route silently never registers and the
//                    panel sees HTTP 404 (this happened).
//   `sessionQuery` — without it the background warm pass starts against an empty
//                    service and folds nothing, so the panel pays the cold cost.
// Both halves keep `ctx.get` guards, so a missing service degrades loudly rather
// than throwing.
const inject = ['tools', 'webServer', 'sessionQuery']

const PANEL_BUDGET_MS = 2500
const TOOL_BUDGET_MS = 20000
const WARM_BUDGET_MS = 120000
const WARM_MAX_PASSES = 40

const PARAMETERS = {
  type: 'object',
  properties: {
    sort: {
      type: 'string',
      enum: SORTS,
      description:
        'Row order: steps (most used), ttft (fastest median first token), speed (fastest median decode tok/s), errors (least stable first, ties by fastest median first token), lastSeen (most recent). Ordering uses the median, the figure the ttft_med/tps_med columns show.',
    },
    limit: {
      type: 'integer',
      description: 'Maximum rows to return, 1..50. Default 15.',
    },
    provider: {
      type: 'string',
      description: 'Restrict the table to one provider (exact match).',
    },
    sinceMs: {
      type: 'number',
      description: 'Only count steps at or after this epoch-milliseconds timestamp.',
    },
    view: {
      type: 'string',
      enum: ['model', 'provider'],
      description: 'Group rows by model (default) or by provider.',
    },
  },
  additionalProperties: false,
}

const OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

export { name, inject }

export function apply(ctx) {
  const collector = createCollector(ctx)
  ctx.effect(() => () => collector.clearCache())

  // The snapshot is rewritten at most this often, so a burst of panel requests
  // cannot turn into a burst of disk writes.
  let lastSaveAt = 0
  let saving = null
  function scheduleSave() {
    const now = Date.now()
    if (saving !== null || now - lastSaveAt < 5000) return
    lastSaveAt = now
    saving = collector
      .saveSnapshot()
      .catch(() => false)
      .finally(() => {
        saving = null
      })
  }

  // Fold the whole corpus once, in the background, right after activation, then
  // persist the result so the next process start needs no cold pass at all.
  //
  // The pass is bounded per iteration rather than run as one long call: a
  // bounded pass checkpoints its work, so an interrupted warm-up still leaves
  // most of the corpus folded and on disk. Failures are contained — a failed
  // warm pass only means the panel's own request does the work instead.
  const warmStarted = Date.now()
  void (async () => {
    let folded = 0
    for (let pass = 0; pass < WARM_MAX_PASSES; pass += 1) {
      const result = await collector.collect({ budgetMs: WARM_BUDGET_MS, sort: 'steps' })
      if (result.error !== undefined) throw new Error(result.error)
      folded = result.scanned
      if (result.pending === 0) break
    }
    await collector.saveSnapshot()
    lastSaveAt = Date.now()
    ctx.logger?.info?.(
      `dsh-model-stats: warm pass folded ${folded} session(s) in ${Date.now() - warmStarted} ms`,
    )
  })().catch((error) => {
    ctx.logger?.warn?.(`dsh-model-stats: warm pass failed: ${String(error?.message ?? error)}`)
  })

  const tools = ctx.get('tools')
  if (tools === undefined) {
    ctx.logger?.warn?.('dsh-model-stats: tools service missing, report tool not registered')
  } else {
    tools.register({
      name: 'model_stats',
      description:
        'Historical per-model and per-provider performance analytics for DSH, folded from session logs: time-to-first-token (mean/median/min/max/p90), decode speed in tokens per second, model wall time, token totals, cache hit rate, peak context, and error counts. Use it to decide which configured model fits a task. Read-only, cache-backed, and adds nothing to the request path.',
      parameters: PARAMETERS,
      output: OUTPUT,
      async execute(args) {
        const raw = args === null || typeof args !== 'object' ? {} : args
        const options = {
          sort: SORTS.includes(raw.sort) ? raw.sort : 'steps',
          limit: Number.isInteger(raw.limit) && raw.limit > 0 ? Math.min(50, raw.limit) : 15,
          view: raw.view === 'provider' ? 'provider' : 'model',
          provider: typeof raw.provider === 'string' && raw.provider !== '' ? raw.provider : null,
          sinceMs: Number.isFinite(raw.sinceMs) ? raw.sinceMs : null,
        }
        const result = await collector.collect({
          sort: options.sort,
          sinceMs: options.sinceMs,
          // Keep one tool call bounded too; the warm pass completes the rest.
          budgetMs: TOOL_BUDGET_MS,
        })
        scheduleSave()
        return renderReportText(result, options)
      },
    })
    ctx.logger?.info?.('dsh-model-stats: registered tool "model_stats"')
  }

  // The panel's data route. Same collector, so panel and tool never disagree.
  const webServer = ctx.get('webServer')
  if (webServer !== undefined) {
    ctx.effect(() =>
      webServer.register({
        kind: 'exact',
        path: '/api/model-stats',
        handler: async (req, res) => {
          try {
            const url = new URL(req.url ?? '/', 'http://localhost')
            const sortParam = url.searchParams.get('sort')
            const sort = SORTS.includes(sortParam) ? sortParam : 'steps'
            const view = url.searchParams.get('view') === 'provider' ? 'provider' : 'model'
            const provider = url.searchParams.get('provider')
            const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '', 10)
            const sinceRaw = Number.parseInt(url.searchParams.get('sinceMs') ?? '', 10)
            const sinceMs = Number.isFinite(sinceRaw) ? sinceRaw : null
            const payloadOptions = {
              sort,
              view,
              provider,
              limit: Number.isFinite(limitRaw) ? limitRaw : 50,
            }

            // Phase 1: this process already folded the corpus, so the table can
            // be answered from memory. Nothing is read; the refresh below runs
            // afterwards instead of in front of the first paint.
            const inMemory = await collector.snapshotSummary({ sort, sinceMs })
            if (inMemory !== null) {
              sendJson(res, 200, toPanelPayload(inMemory, payloadOptions))
              scheduleSave()
              return
            }

            // Phase 2: a snapshot from an earlier process, validated against one
            // corpus listing. Unchanged logs are served without being read.
            const fromDisk = await collector.snapshotReport({ sort, sinceMs })
            if (fromDisk !== null) {
              sendJson(res, 200, toPanelPayload(fromDisk, payloadOptions))
              scheduleSave()
              return
            }

            // Phase 3: fold what the snapshot could not cover, within a budget
            // that keeps the answer prompt; the background pass finishes the rest.
            const result = await collector.collect({
              sort,
              sinceMs,
              budgetMs: PANEL_BUDGET_MS,
              records: fromDisk?.records ?? undefined,
            })
            sendJson(res, 200, toPanelPayload(result, payloadOptions))
            scheduleSave()
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      }),
    )
    ctx.logger?.info?.('dsh-model-stats: registered route GET /api/model-stats')
  } else {
    // Loud, because silence here is exactly what produced a bare 404 in the panel.
    ctx.logger?.warn?.(
      'dsh-model-stats: webServer service is unavailable; GET /api/model-stats was NOT registered ' +
        'and the settings panel will fail with HTTP 404',
    )
  }
}

function sendJson(res, code, value) {
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}
