// dsh-model-scorecard - Host half.
//
// A scorecard for every configured `(provider, model)` route, built from three
// sources that cannot be confused with one another:
//
//   - what the durable session event log the Harness already writes says the
//     route has *delivered here* — response time, end-to-end throughput, errors,
//     retries (`lib/fold.js`, `lib/collect.js`);
//   - what the route *declares about itself* through its adapter, with no
//     request behind it (`lib/metadata.js`);
//   - whether the route *answers right now*, probed through `ctx.llm` only when
//     someone asks (`lib/liveness.js`, `lib/status.js`).
//
// Three consumers share one collector (`lib/collect.js`):
//   - the agent-facing `model_stats` tool (plain-text table)
//   - the `model_liveness` tool (the availability check)
//   - `GET /api/model-scorecard` behind the panel (compact JSON)
//
// The plugin registers no hook on the LLM request or stream path: the first two
// sources cost nothing until a report is asked for, and the third costs one
// request per model, and only on request.
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
  createCollector,
  MAX_PANEL_ROWS,
  normalizeSelectionRules,
  providerFilter,
  renderReportText,
  PANEL_SORTS,
  SORTS,
  sortDirection,
  toPanelPayload,
} from './collect.js'
import { createLiveness } from './liveness.js'
import { createMetadata } from './metadata.js'
import { takeMigrationNote } from './cache-dir.js'
import { rollUp, statusRanker } from './status.js'

const name = 'dsh-model-scorecard'

/**
 * The URL namespace, and the one it replaced.
 *
 * Renamed with the package on 2026-10-01, and the old prefix is still mounted
 * for one release. The reason is a browser, not a client library: a tab that
 * loaded the panel bundle before the upgrade still asks
 * `/api/model-stats/query`, and a 404 there is a table that cannot refresh, on
 * a page whose own bundle is served from this same package. The alias is the
 * same function object as the live path rather than a second copy of the
 * handler, so the two cannot answer different questions — an alias that drifted
 * would be worse than either a 404 or the new name, because the panel draws
 * whatever arrives under its own controls.
 */
const API_NS = 'model-scorecard'
const LEGACY_API_NS = 'model-stats'

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
        'Row order: steps (most used), ttft (fastest median first token), speed (fastest median decode tok/s), errors (least stable first, ties by fastest median first token), lastSeen (most recent), rating (best technical score first). Ordering uses the median, the figure the ttft_med/tps_med columns show. `rating` is a 0-100 historical technical verdict per exact pair, over a narrower population than the other columns - not answer quality, intelligence, price or reachability, and an unrated row sorts last either way. Default remains steps.',
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
      description:
        'Only count steps at or after this epoch-milliseconds timestamp. It restricts the whole answer, not just the table: errors, retries and the technical rating are folded over the same scope, and the rating re-anchors on the newest in-scope step - so a scoped rating is not the all-history rating of the same pair.',
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

export { name, inject, PARAMETERS }

export function apply(ctx) {
  const collector = createCollector(ctx)
  const liveness = createLiveness(ctx)
  // Declared route metadata for the panel's rows, read from the adapters through
  // `ctx.llm` and bounded by its own policy. It is decoration attached to an
  // already-assembled answer, so it lives beside the collector rather than in it:
  // the fold is pure, and a route whose metadata is unknown is still a scored row.
  const metadata = createMetadata(ctx)
  // The cache directory was resolved by the collector, which is the first thing
  // that touches it. If that move was the rename out of the previous package
  // name, or a move that failed, this is the one place it can be said out loud:
  // a re-fold and a re-sweep are both invisible otherwise, and a reader would
  // see an empty status column and a slow first paint and no reason for either.
  const migrationNote = takeMigrationNote()
  if (migrationNote !== null) ctx.logger?.info?.(migrationNote)
  ctx.effect(() => () => collector.clearCache())
  ctx.effect(() => () => metadata.dispose())

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
      `dsh-model-scorecard: warm pass folded ${folded} session(s) in ${Date.now() - warmStarted} ms`,
    )
  })().catch((error) => {
    ctx.logger?.warn?.(`dsh-model-scorecard: warm pass failed: ${String(error?.message ?? error)}`)
  })

  const tools = ctx.get('tools')
  if (tools === undefined) {
    ctx.logger?.warn?.('dsh-model-scorecard: tools service missing, report tool not registered')
  } else {
    tools.register({
      name: 'model_stats',
      description:
        'Historical per-model and per-provider performance analytics for DSH, folded from session logs: time-to-first-token (mean/median/min/max/p90), decode speed in tokens per second, model wall time, token totals, cache hit rate, peak context, and error counts. Each exact provider-model pair also carries a 0-100 technical rating - streaming throughput, typical and slow first token, recency-weighted over the whole history, with retried and interrupted steps excluded - which is a historical performance figure and never answer quality, intelligence, price or current reachability. A `~` in that cell marks a score standing on thin evidence and a `*` one whose newest usable measurement is older than the 30-day half-life: the age never changes the score, and the line under the table explains both marks and names the rows. Models absent from the current configuration are listed in the archive and hidden by default; `archived: true` includes them. Use it to decide which configured model fits a task. Read-only, cache-backed, and adds nothing to the request path.',
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
    ctx.logger?.info?.('dsh-model-scorecard: registered tool "model_stats" and "model_liveness"')
  }

  // The panel's data route. Same collector, so panel and tool never disagree.
  const webServer = ctx.get('webServer')
  if (webServer !== undefined) {
    // One handler, mounted under both namespaces. See `API_NS` for why the old
    // one is still answered; the `label` is the live path, because that is the
    // one a reader will type into a fetch and the one a future release deletes.
    const registerRoute = (suffix, handler, label) => {
      for (const ns of [API_NS, LEGACY_API_NS]) {
        ctx.effect(() =>
          webServer.register({ kind: 'exact', path: `/api/${ns}${suffix}`, handler }),
        )
      }
      ctx.logger?.info?.(`${name}: registered route ${label} (+ /api/${LEGACY_API_NS} alias)`)
    }

    // Liveness is two routes because the two halves have different costs. A GET
    // answers from the store in microseconds; a POST starts probes and answers
    // at once, because a sweep over every configured model outlives any HTTP
    // request the browser will wait for. The panel follows the sweep down its
    // own `pending` count over the GET.
    registerRoute(
      '/liveness',
      async (_req, res) => {
        try {
          sendJson(res, 200, { ok: true, ...(await liveness.get()) })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
      'GET /api/model-scorecard/liveness',
    )
    registerRoute(
      '/liveness/check',
      async (req, res) => {
        try {
          if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'POST required' })
            return
          }
          // Bounded, because the panel now sends the models the reader selected
          // and a check over a hundred-odd pairs is a real body. The same limit
          // and the same 413 the query route uses: one rule for what this host
          // will read into memory, whatever the route.
          let body
          try {
            body = await readJsonBody(req, MAX_QUERY_BODY_BYTES)
          } catch (error) {
            if (error?.code === 'BODY_TOO_LARGE') {
              sendJson(res, 413, { ok: false, error: String(error.message) })
              return
            }
            sendJson(res, 400, { ok: false, error: 'body is not valid JSON' })
            return
          }
          sendJson(res, 200, { ok: true, ...(await liveness.start(body)) })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
      },
      'POST /api/model-scorecard/liveness/check',
    )
    registerRoute(
      '',
      async (req, res) => {
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
          //
          // The whole answer travels, `{ live, pairs }`, and not its `pairs`
          // half: `configuredIndex` grades nothing without the `live` flag and
          // answers `null` for a bare array, so unwrapping here silently
          // emptied the archive — every row was graded against no
          // configuration at all, the panel lost its "not configured" rows and
          // the archive banner, and a host that could not read the catalog
          // became indistinguishable from one that read it and serves nothing.
          const configured = await liveness.configured()

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
            // The scope travels to the payload as well as to the fold: the
            // collector scopes the figures, and the payload is the only place
            // that can tell the reader those figures are scoped. A payload that
            // answered `sinceMs: null` while its rows were folded under a
            // `?sinceMs=` would label a scoped number as an all-history one.
            sinceMs,
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
          //
          // The GET route answers without a selection policy, which is the
          // question every client that predates the selection tree asks — and
          // it is the same question the panel asks on a first open, so an old
          // panel and a new one agree about what "no marks yet" means.
          const payload = await answerPanel(collector, order, payloadOptions, metadata)
          sendJson(res, 200, addLiveness(payload, probes))
          scheduleSave()
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
      'GET /api/model-scorecard',
    )

    // The panel's own route: the same question as the GET above, plus the models
    // the reader selected. It is a POST because a selection rule document is a
    // body and not a URL: a query string that carried 137 pairs would exceed what
    // a browser or a proxy will pass, and one that carried the *rules* would have
    // to spell names that are nobody's business in a log. It is read-only in the
    // one sense that matters — it costs a fold that the GET also costs, and it
    // changes nothing on disk that a fold does not already change.
    //
    // The GET stays registered beside it, unchanged, for a client that does not
    // know about a selection.
    registerRoute(
      '/query',
      async (req, res) => {
        try {
          if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'POST required' })
            return
          }
          let body
          try {
            body = await readJsonBody(req, MAX_QUERY_BODY_BYTES)
          } catch (error) {
            if (error?.code === 'BODY_TOO_LARGE') {
              sendJson(res, 413, { ok: false, error: String(error.message) })
              return
            }
            sendJson(res, 400, { ok: false, error: 'body is not valid JSON' })
            return
          }
          const query = queryFromBody(body)
          if (query.error !== undefined) {
            sendJson(res, 400, { ok: false, error: query.error })
            return
          }

          // The configuration the rules are resolved against, read once: the
          // archive scope is a statement about which pairs the configuration
          // dropped, and `measured` is a statement about the history, so both
          // are needed before a single pair can be resolved.
          const configured = await liveness.configured()
          const probes = await liveness.get()
          const order = {
            sort: query.sort,
            dir: query.dir,
            selectionRules: query.selectionRules,
            configured,
            includeArchived: query.includeArchived,
            statusOf: query.sort === 'liveness' ? statusRanker(probes) : undefined,
          }
          const payloadOptions = {
            sort: query.sort,
            dir: query.dir,
            view: query.view,
            limit: query.limit,
            includeArchived: query.includeArchived,
            configured,
            statusOf: order.statusOf,
          }
          const payload = await answerPanel(collector, order, payloadOptions, metadata)
          sendJson(res, 200, addLiveness(payload, probes))
          scheduleSave()
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
      'POST /api/model-scorecard/query',
    )
  } else {
    // Loud, because silence here is exactly what produced a bare 404 in the panel.
    ctx.logger?.warn?.(
      `${name}: webServer service is unavailable; GET /api/model-scorecard was NOT registered ` +
        'and the panel will fail with HTTP 404',
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

/**
 * The largest query body the panel route will read.
 *
 * A selection is a rule document, not a list of pairs, so it is small — the
 * measured catalog is 137 pairs over 16 providers and its rules are smaller than
 * its catalog. The limit exists so a malformed or hostile body cannot turn into
 * memory, and one megabyte is far past the largest real selection while still
 * being a bound: a body past it is refused rather than parsed.
 */
const MAX_QUERY_BODY_BYTES = 1_048_576

async function readJsonBody(req, maxBytes = Number.POSITIVE_INFINITY) {
  if (req.body && typeof req.body === 'object') return req.body
  let text = ''
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) {
      const error = new Error(`request body is larger than ${maxBytes} bytes`)
      error.code = 'BODY_TOO_LARGE'
      throw error
    }
    text += chunk
  }
  return text ? JSON.parse(text) : {}
}

function sendJson(res, code, value) {
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

/**
 * One panel question, answered cheapest-first.
 *
 * Shared by both routes on purpose: the query the panel asks with a selection and
 * the one an older client asks over GET differ in the question, never in how it
 * is answered. Three phases, cheapest first, so the table is never blocked behind
 * a cold fold — the in-memory snapshot of this process, then the snapshot an
 * earlier process left on disk plus a bounded fold of exactly the sessions that
 * snapshot could not vouch for, then the folding pass itself, bounded, with the
 * rest finished in the background.
 *
 * Metadata is attached here, once, rather than in either route: both routes must
 * answer the same question, and this is the last point at which the rows exist in
 * their final form — selected, filtered and cut to the limit — so no lookup is
 * spent on a row the reader never receives. It comes after the phase choice
 * deliberately: the fold decides which rows there are, metadata only decorates
 * them, and `enrich` never rejects, so a slow or absent adapter cannot turn a
 * good table into a 500.
 */
async function answerPanel(collector, order, payloadOptions, metadata) {
  const payload = await panelPayload(collector, order, payloadOptions)
  return metadata.enrich(payload)
}

/**
 * The cheapest-first phase choice, without the metadata pass that decorates it.
 *
 * Exported for the same reason {@link queryFromBody} is: the three phases and the
 * conditions under which the second one hands its leftovers to the third are a
 * contract nothing else can reach, and `tools/verify-budget.mjs` drives them
 * against a corpus whose read count is exact.
 */
export async function panelPayload(collector, order, payloadOptions) {
  const inMemory = await collector.snapshotSummary(order)
  if (inMemory !== null) return toPanelPayload(inMemory, payloadOptions)

  const fromDisk = await collector.snapshotReport(order)
  if (fromDisk !== null) {
    if (fromDisk.complete) return toPanelPayload(fromDisk, payloadOptions)
    // The snapshot holds a fold of most of the corpus but cannot vouch for the
    // rest — sessions started since it was written, or whose own log moved. Fold
    // exactly those, reusing the listing the snapshot phase already made, and
    // answer again from everything the collector now holds. The alternative, which
    // this replaced, was falling through to a full fold whenever a single new log
    // existed anywhere: 30+ seconds over 477 real logs to answer a question the
    // snapshot had already answered for 475 of them.
    const rest = await collector.collect({
      ...order,
      budgetMs: PANEL_BUDGET_MS,
      records: fromDisk.records,
      onlyIds: fromDisk.skippedIds,
    })
    // A follow-up that could not finish is not a reason to serve a knowingly
    // partial table in its place: the snapshot answer carries its own
    // `complete: false` and its own pending count, and says so in the footer.
    if (rest.error === undefined && rest.complete === true) {
      return toPanelPayload(rest, payloadOptions)
    }
    return toPanelPayload(fromDisk, payloadOptions)
  }

  const result = await collector.collect({ ...order, budgetMs: PANEL_BUDGET_MS })
  return toPanelPayload(result, payloadOptions)
}

/**
 * A query body as the order and payload options both routes need.
 *
 * Every field is optional and every field that is present is checked. An absent
 * field takes the same default the GET route gives it, so `{}` is the default
 * table; a field that is present and unusable is a 400 rather than a silent
 * fallback, because a body the host half-reads answers a question nobody asked —
 * and the panel draws that answer under the reader's own controls.
 *
 * The selection is the one field whose *absence* means something: `null` is the
 * default policy, an empty rule set is an empty selection, and a malformed one is
 * refused rather than repaired.
 *
 * Exported because the panel builds the bodies this reads, and the pair is the only
 * thing standing between a renamed field and a 400 the reader would take for a broken
 * panel: `tools/verify-selection.mjs` feeds the panel's own `panelQueryBody` output
 * through this function rather than through a hand-written copy of the schema.
 */
export function queryFromBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'body must be a JSON object' }
  }
  const at = (name, allowed, fallback) => {
    const value = body[name]
    if (value === undefined || value === null) return { value: fallback }
    if (allowed !== null && !allowed.includes(value)) {
      return { error: `${name} must be one of ${allowed.join(', ')}` }
    }
    return { value }
  }
  const sort = at('sort', PANEL_SORTS, 'steps')
  if (sort.error !== undefined) return sort
  const dir = at('dir', ['asc', 'desc'], null)
  if (dir.error !== undefined) return dir
  const view = at('view', ['model', 'provider'], 'model')
  if (view.error !== undefined) return view
  if (body.archived !== undefined && typeof body.archived !== 'boolean') {
    return { error: 'archived must be a boolean' }
  }
  if (
    body.limit !== undefined &&
    (!Number.isInteger(body.limit) || body.limit < 1 || body.limit > MAX_PANEL_ROWS)
  ) {
    return { error: `limit must be an integer between 1 and ${MAX_PANEL_ROWS}` }
  }
  const selection = normalizeSelectionRules(body.selection)
  if (selection.ok !== true) return { error: selection.error }
  return {
    sort: sort.value,
    dir: dir.value,
    view: view.value,
    limit: body.limit === undefined ? 50 : body.limit,
    includeArchived: body.archived === true,
    selectionRules: selection.rules,
  }
}
