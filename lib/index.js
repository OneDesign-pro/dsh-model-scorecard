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

import {
  configuredIndex,
  createCollector,
  providerFilter,
  renderReportText,
  PANEL_SORTS,
  SORTS,
  sortDirection,
  toPanelPayload,
} from './collect.js'
import { createLiveness } from './liveness.js'
import { rollUp, statusRanker } from './status.js'

const name = 'dsh-model-stats'
// Every declared dependency is one `apply` must actually have, and the
// difference is not cosmetic:
//   `webServer`    — without it the panel route silently never registers and the
//                    panel sees HTTP 404 (this happened).
//   `sessionQuery` — without it the background warm pass starts against an empty
//                    service and folds nothing, so the panel pays the cold cost.
//   `llm`          — without it every liveness probe fails the moment it reads
//                    `ctx.llm`, with `cannot get property "llm" without inject`
//                    (this also happened: the panel showed "Ошибка проверки"
//                    for every model at 0 ms, which is what a missing service
//                    declaration looks like from the outside).
// Both halves keep `ctx.get` guards, so a missing service degrades loudly rather
// than throwing.
const inject = ['tools', 'webServer', 'sessionQuery', 'llm']

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
      description:
        'Restrict the table to these providers by exact name: one name, several names separated by commas, or a JSON array of names. Omit for every provider. `view: "provider"` already groups by provider, so a filter there can only ever leave one row.',
    },
    sinceMs: {
      type: 'number',
      description: 'Only count steps at or after this epoch-milliseconds timestamp.',
    },
    archived: {
      type: 'boolean',
      description:
        'Include models that are absent from the current configuration (they are listed in the archive). They are hidden by default: a model the harness no longer serves is not one to pick. Ignored when the live llm catalog is unreadable, in which case no row is graded and the report says `archive: unknown`.',
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
  const liveness = createLiveness(ctx)
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
        'Historical per-model and per-provider performance analytics for DSH, folded from session logs: time-to-first-token (mean/median/min/max/p90), decode speed in tokens per second, model wall time, token totals, cache hit rate, peak context, and error counts. Models absent from the current configuration are listed in the archive and hidden by default; `archived: true` includes them. Use it to decide which configured model fits a task. Read-only, cache-backed, and adds nothing to the request path.',
      parameters: PARAMETERS,
      output: OUTPUT,
      async execute(args) {
        const raw = args === null || typeof args !== 'object' ? {} : args
        const options = {
          sort: SORTS.includes(raw.sort) ? raw.sort : 'steps',
          limit: Number.isInteger(raw.limit) && raw.limit > 0 ? Math.min(50, raw.limit) : 15,
          view: raw.view === 'provider' ? 'provider' : 'model',
          provider: providerFilter(raw.provider),
          sinceMs: Number.isFinite(raw.sinceMs) ? raw.sinceMs : null,
          includeArchived: raw.archived === true,
          // One question about the configuration per call, and the same one the
          // panel asks: both surfaces grade their rows against `ctx.llm` plus
          // the configuration files, so neither can call a model archived that
          // the other still offers.
          configured: await liveness.configured(),
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
    tools.register({
      name: 'model_liveness',
      description:
        'Check whether configured models answer right now, through the same ctx.llm route a real request uses. Records the moment of each check and persists the result. A plain call probes only models with no fresh answer; `all: true` re-probes everything. Use it before starting work with a model whose health is in doubt.',
      parameters: {
        type: 'object',
        properties: {
          provider: {
            type: 'string',
            description:
              'Restrict the check to these providers by exact name: one name, several separated by commas, or a JSON array. Omit to check every configured model.',
          },
          model: {
            type: 'string',
            description:
              'Check exactly this model. Requires `provider`, and probes that one pair and nothing else.',
          },
          staleOnly: {
            type: 'boolean',
            description:
              'Explicitly ask for only models without a fresh answer. This is already what a plain call does; `all` is the opposite.',
          },
          all: {
            type: 'boolean',
            description:
              'Re-probe every selected model even when a fresh result exists.',
          },
        },
        additionalProperties: false,
      },
      output: OUTPUT,
      async execute(args) {
        const raw = args === null || typeof args !== 'object' ? {} : args
        try {
          const snapshot = await liveness.check({
            provider: raw.provider,
            model: raw.model,
            staleOnly: raw.staleOnly === true,
            all: raw.all === true,
          })
          return renderLivenessText(snapshot)
        } catch (error) {
          return `model_liveness error: ${String(error?.message ?? error)}`
        }
      },
    })
    ctx.logger?.info?.('dsh-model-stats: registered tool "model_stats" and "model_liveness"')
  }

  // The panel's data route. Same collector, so panel and tool never disagree.
  const webServer = ctx.get('webServer')
  if (webServer !== undefined) {
    // Liveness is two routes because the two halves have different costs. A GET
    // answers from the store in microseconds; a POST starts probes and answers
    // at once, because a sweep over every configured model outlives any HTTP
    // request the browser will wait for. The panel follows the sweep down its
    // own `pending` count over the GET.
    ctx.effect(() =>
      webServer.register({
        kind: 'exact',
        path: '/api/model-stats/liveness',
        handler: async (_req, res) => {
          try {
            sendJson(res, 200, { ok: true, ...(await liveness.get()) })
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      }),
    )
    ctx.effect(() =>
      webServer.register({
        kind: 'exact',
        path: '/api/model-stats/liveness/check',
        handler: async (req, res) => {
          try {
            if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
              sendJson(res, 405, { ok: false, error: 'POST required' })
              return
            }
            const body = await readJsonBody(req)
            sendJson(res, 200, { ok: true, ...(await liveness.start(body)) })
          } catch (error) {
            sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
          }
        },
      }),
    )
    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/api/model-stats',
        handler: async (req, res) => {
          try {
            const url = new URL(req.url ?? '/', 'http://localhost')
            // The panel's table has a heading per column and each heading is a
            // sort control, so the route takes every order the table can show —
            // `?sort=cache&dir=asc` is a question about the cache column. An
            // order nobody knows falls back to the tool's default rather than
            // erroring: a stale bookmark should still open a table.
            const sortParam = url.searchParams.get('sort')
            const sort = PANEL_SORTS.includes(sortParam) ? sortParam : 'steps'
            const dir = sortDirection(url.searchParams.get('dir'))
            const view = url.searchParams.get('view') === 'provider' ? 'provider' : 'model'
            // `?provider=a,b` and `?provider=a&provider=b` are the same question,
            // and the panel sends the first while a hand-written URL tends to use
            // the second, so both are read here rather than only one of them.
            const provider = providerFilter(url.searchParams.getAll('provider'))
            const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '', 10)
            const sinceRaw = Number.parseInt(url.searchParams.get('sinceMs') ?? '', 10)
            const sinceMs = Number.isFinite(sinceRaw) ? sinceRaw : null
            // The archive is off unless it is asked for by name, so a URL written
            // before this filter existed — and a panel that predates it — keeps
            // asking exactly the question it asked before, and gets the same
            // table: the two spellings a link or a checkbox can produce are the
            // only ones that turn it on.
            const archivedRaw = (url.searchParams.get('archived') ?? '').toLowerCase()
            // The configuration every row is graded against, read once per
            // request from the same live catalog the status column is probed by —
            // `ctx.llm` plus the provider routes the configuration files declare.
            // It is read before the fold rather than after it, because the
            // archive decides which rows reach the limit, and that decision
            // cannot be made from a page that was already cut.
            const configured = (await liveness.configured()).pairs

            // One read of the probe store per request, for both halves of the
            // status column: the verdict every cell draws, and — when the order
            // asked for is that column's — the rank the rows are sorted by. It
            // is the one order the fold cannot answer from the session log, so
            // the lookup is built here and handed down rather than the host
            // ordering the rows after it had already cut them to the limit.
            const probes = await liveness.get()
            const order = {
              sort,
              dir,
              sinceMs,
              statusOf: sort === 'liveness' ? statusRanker(probes) : undefined,
            }
            const payloadOptions = {
              sort,
              dir,
              view,
              provider,
              limit: Number.isFinite(limitRaw) ? limitRaw : 50,
              includeArchived: archivedRaw === '1' || archivedRaw === 'true',
              configured,
              // Handed to the payload as well as to the fold, because the
              // payload adds a row the fold never saw: a configured model with
              // no history has no rank of its own, and a status order that left
              // it unranked would file the broken ones at the bottom of the one
              // order a reader uses to ask what is broken right now.
              statusOf: order.statusOf,
            }

            // Phase 1: this process already folded the corpus, so the table can
            // be answered from memory. Nothing is read; the refresh below runs
            // afterwards instead of in front of the first paint.
            const inMemory = await collector.snapshotSummary(order)
            if (inMemory !== null) {
              sendJson(res, 200, addLiveness(toPanelPayload(inMemory, payloadOptions), probes))
              scheduleSave()
              return
            }

            // Phase 2: a snapshot from an earlier process, validated against one
            // corpus listing. Unchanged logs are served without being read.
            const fromDisk = await collector.snapshotReport(order)
            if (fromDisk !== null) {
              sendJson(res, 200, addLiveness(toPanelPayload(fromDisk, payloadOptions), probes))
              scheduleSave()
              return
            }

            // Phase 3: fold what the snapshot could not cover, within a budget
            // that keeps the answer prompt; the background pass finishes the rest.
            const result = await collector.collect({
              ...order,
              budgetMs: PANEL_BUDGET_MS,
              records: fromDisk?.records ?? undefined,
            })
            sendJson(res, 200, addLiveness(toPanelPayload(result, payloadOptions), probes))
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

/**
 * Attach the liveness fact to every row of the panel's table.
 *
 * A row of the historical table and a probed pair are different questions asked
 * of overlapping keys: history knows a model the probe has never run for, and a
 * configured pair may have no steps at all. The join therefore only adds — a
 * model with no probe keeps `liveness: null`, and one with a probe is never
 * dropped for having no history.
 *
 * The provider view needs a roll-up rather than a join, because a provider row
 * has no model of its own: its status is what its models said, counted. The
 * roll-up is {@link rollUp} — the same one the status order is ranked by, so a
 * provider row is drawn and sorted by one rule — and the probe store has already
 * stamped every result with the state it means, so this function only places
 * those results on their rows.
 *
 * The snapshot arrives already read: the route reads the probe store once per
 * request, and a status order needs that read before the fold rather than after
 * it, because the limit cuts the rows before the join would have seen them.
 */
function addLiveness(payload, snapshot) {
  if (!Array.isArray(payload.rows)) return payload
  const results = Array.isArray(snapshot.results) ? snapshot.results : []
  const byKey = new Map(
    results.map((entry) => [`${entry.provider}\u0000${entry.model}`, entry]),
  )
  const checking = new Set(snapshot.checking ?? [])
  const rollUps = new Map()

  return {
    ...payload,
    liveness: {
      running: snapshot.running === true,
      total: snapshot.total ?? 0,
      done: snapshot.done ?? 0,
      pending: snapshot.pending ?? 0,
      checked: results.length,
    },
    rows: payload.rows.map((row) => {
      if (row.model === null || row.model === undefined) {
        if (!rollUps.has(row.provider)) rollUps.set(row.provider, rollUp(results, row.provider))
        const anyChecking = [...checking].some((key) => key.startsWith(`${row.provider}\u0000`))
        return { ...row, liveness: rollUps.get(row.provider) ?? null, livenessChecking: anyChecking }
      }
      const key = `${row.provider}\u0000${row.model}`
      return { ...row, liveness: byKey.get(key) ?? null, livenessChecking: checking.has(key) }
    }),
  }
}

/**
 * The tool's plain-text table.
 *
 * A probe answers one question with one word, so the table leads with the word
 * and keeps the timing beside it — a model that answered in 200 ms and one that
 * answered in 12 s are both "yes", and the difference is what the reader is
 * about to decide with.
 */
function renderLivenessText(snapshot) {
  const results = [...(snapshot.results ?? [])].sort(
    (a, b) =>
      a.provider.localeCompare(b.provider) ||
      String(a.model).localeCompare(String(b.model)),
  )
  if (results.length === 0) {
    // A probe is given its route's own patience, and a slow free tier answers in
    // minutes; the tool call itself does not wait that long, so "nothing yet"
    // and "nothing" must not read the same.
    const pending = snapshot.pending ?? 0
    return pending > 0
      ? `model_liveness: no probe has answered yet; ${pending} still checking`
      : 'model_liveness: no probe result recorded yet'
  }
  const pad = (value, width) => String(value).padEnd(width)
  const width = (key, header) =>
    results.reduce((max, row) => Math.max(max, String(key(row)).length), header.length)
  const providerWidth = width((row) => row.provider, 'provider')
  const modelWidth = Math.min(52, width((row) => row.model, 'model'))
  const path = (row) =>
    `${row.provider}/${String(row.model).length > modelWidth ? `${String(row.model).slice(0, modelWidth - 1)}…` : row.model}`

  const header = `${pad('status', 6)}${pad('provider', providerWidth + 2)}${pad('model', modelWidth + 2)}${pad('ms', 8)}source`
  const lines = results.map((row) => {
    const status = row.status === 'ok' ? 'OK' : 'FAIL'
    const ms = Number.isFinite(row.latencyMs) ? String(row.latencyMs) : '-'
    const detail = row.status === 'ok' ? '' : `  ${row.code ?? ''} ${row.error ?? ''}`.trimEnd()
    return `${pad(status, 6)}${pad(row.provider, providerWidth + 2)}${pad(path(row), modelWidth + 2)}${pad(ms, 8)}${row.source ?? '-'}${detail}`
  })

  const ok = results.filter((row) => row.status === 'ok').length
  const checking = snapshot.checking?.length ?? 0
  const summary = [
    `OK ${ok}/${results.length}`,
    snapshot.running === true ? `still checking ${snapshot.pending ?? 0}` : null,
    checking > 0 && snapshot.running !== true ? `in flight ${checking}` : null,
  ].filter((part) => typeof part === 'string')

  return `${[header, ...lines].join('\n')}\n\n${summary.join(' · ')}`
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body
  let text = ''
  for await (const chunk of req) text += chunk
  return text ? JSON.parse(text) : {}
}

function sendJson(res, code, value) {
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}
