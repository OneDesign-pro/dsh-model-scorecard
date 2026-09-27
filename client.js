// dsh-model-stats - Client half.
//
// A settings panel over the host's `GET /api/model-stats`. It renders the same
// aggregation the `model_stats` tool returns, so what the agent reads and what
// the human sees cannot drift apart.
//
// The factory is lazy and side-effect free: all fetching happens in effects on
// the mounted component, and styles are registered as resources.

window.__ModuleLoader__.load({
  id: 'dsh-model-stats',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const SORTS = [
      { key: 'steps', label: 'по числу шагов' },
      { key: 'ttft', label: 'быстрый отклик' },
      { key: 'speed', label: 'скорость' },
      { key: 'errors', label: 'нестабильные' },
      { key: 'lastSeen', label: 'недавние' },
    ]

    const DEFAULT_QUERY = { sort: 'ttft', view: 'model' }

    // --- formatting helpers ------------------------------------------------------
    // The panel's copy is Russian, so its numbers and its times follow the same
    // language rather than the browser's: a Russian sentence quoting "45.2"
    // reads worse than a consistent one. A full translation pass would move
    // LOCALE — and this comment — along with the strings.
    const LOCALE = 'ru'

    const dash = '-'
    /** Between a number and its unit: "820 ms" must not wrap into two lines. */
    const NBSP = '\u00A0'

    // Intl formatters are expensive to build, so one instance per precision.
    const numberFormats = new Map()

    function decimalFormat(digits) {
      let format = numberFormats.get(digits)
      if (format === undefined) {
        format = new Intl.NumberFormat(LOCALE, {
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        })
        numberFormats.set(digits, format)
      }
      return format
    }

    function finite(value) {
      return value !== null && value !== undefined && Number.isFinite(value)
    }

    function num(value, digits) {
      if (!finite(value)) return dash
      return decimalFormat(digits).format(value)
    }

    /** Counts are grouped, never fractional: 12 345 steps, not 12345 or 12.3 k. */
    function count(value) {
      if (!finite(value)) return dash
      return decimalFormat(0).format(value)
    }

    function ms(value) {
      if (!finite(value)) return dash
      if (value < 1000) return `${decimalFormat(0).format(Math.round(value))}${NBSP}ms`
      return `${decimalFormat(1).format(value / 1000)}${NBSP}s`
    }

    function pct(value) {
      if (!finite(value)) return dash
      return `${decimalFormat(1).format(value * 100)}%`
    }

    // Relative time through Intl: numeric:'auto' yields "сейчас" for a snapshot
    // taken moments ago and the correct Russian plural everywhere else.
    const relativeFormat = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' })

    function ago(ts) {
      if (!Number.isFinite(ts)) return dash
      const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000))
      if (seconds < 60) return relativeFormat.format(-seconds, 'second')
      if (seconds < 3600) return relativeFormat.format(-Math.round(seconds / 60), 'minute')
      if (seconds < 86400) return relativeFormat.format(-Math.round(seconds / 3600), 'hour')
      return relativeFormat.format(-Math.round(seconds / 86400), 'day')
    }

    // Local model ids are filesystem paths, e.g.
    // /Users/jeka/.lmstudio/models/ornith-ai/Ornith-1.5-9B-GGUF/Ornith-1.5-9B-Q4_K_M.gguf
    // A path that long cannot be shown whole in a table column, so the last
    // segment is displayed and the full id stays in the tooltip (and in the
    // agent's text report, which is unchanged).
    const MAX_LABEL = 44

    // The host bounds its own panel answer (PANEL_BUDGET_MS, 2.5 s in this tree)
    // and returns partial work, which the refresh loop then polls for. This
    // deadline is only the point where a host that is not answering at all
    // becomes something the user can act on: well above that budget plus the
    // corpus listing, and still bounded. It was 25 s, which was below the 47-56 s
    // answer time measured on a host running an older build of the plugin — and
    // a panel that aborts a request the host is still working on reports an
    // error where it would otherwise have had data.
    const REQUEST_TIMEOUT_MS = 60000

    // The last successful answer is kept in the browser so opening the panel
    // shows the table at once instead of a spinner, then refreshes behind it.
    // The host folds in the background either way; this only removes the wait
    // from the first paint.
    const STORE_KEY = 'dsh-model-stats:v1'
    const STORE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
    const REFRESH_INTERVAL_MS = 1500
    const MAX_REFRESHES = 20

    function cacheKey(sort, view) {
      return `${sort}|${view}`
    }

    /** Best-effort read: a broken or unavailable store must never break the panel. */
    function readCache() {
      try {
        const raw = window.localStorage.getItem(STORE_KEY)
        if (raw === null) return {}
        const parsed = JSON.parse(raw)
        const entries = parsed?.entries
        return entries !== null && typeof entries === 'object' ? entries : {}
      } catch {
        return {}
      }
    }

    function readCachedPayload(sort, view) {
      const entry = readCache()[cacheKey(sort, view)]
      if (entry === null || typeof entry !== 'object') return null
      if (typeof entry.at !== 'number' || Date.now() - entry.at > STORE_MAX_AGE_MS) return null
      const data = entry.data
      if (data === null || typeof data !== 'object' || data.ok !== true) return null
      if (!Array.isArray(data.rows)) return null
      return data
    }

    function writeCachedPayload(sort, view, data) {
      try {
        const entries = readCache()
        entries[cacheKey(sort, view)] = { at: Date.now(), data }
        // Two keys per view are enough for a session; old ones would only grow.
        const keys = Object.keys(entries)
        for (const key of keys.slice(0, Math.max(0, keys.length - 4))) delete entries[key]
        window.localStorage.setItem(STORE_KEY, JSON.stringify({ entries }))
      } catch {
        // A full or disabled store is not the panel's problem.
      }
    }

    // How the panel is set up is the user's choice, not a cache: it lives in its
    // own key so that dropping the payload cache can never drop the preferences.
    const PREFS_KEY = 'dsh-model-stats:prefs:v1'

    /** Best-effort read, same contract as the payload cache. */
    function readPrefs() {
      try {
        const raw = window.localStorage.getItem(PREFS_KEY)
        if (raw === null) return {}
        const parsed = JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' ? parsed : {}
      } catch {
        return {}
      }
    }

    function writePrefs(patch) {
      try {
        window.localStorage.setItem(PREFS_KEY, JSON.stringify({ ...readPrefs(), ...patch }))
      } catch {
        // A full or disabled store is not the panel's problem.
      }
    }

    /**
     * The query the panel opens with: the user's last choice, validated against
     * the current option list, falling back to the defaults. A stale or corrupt
     * value must never reach the host as a query.
     */
    function readStoredQuery() {
      const prefs = readPrefs()
      const sort = SORTS.some((entry) => entry.key === prefs.sort) ? prefs.sort : DEFAULT_QUERY.sort
      return { sort, view: prefs.view === 'provider' ? 'provider' : DEFAULT_QUERY.view }
    }

    function shortLabel(id) {
      if (typeof id !== 'string' || id.length <= MAX_LABEL) return id
      const segments = id.split('/').filter((part) => part !== '')
      const tail = segments.length > 0 ? segments[segments.length - 1] : id
      if (segments.length > 1 && tail.length >= 8 && tail.length <= MAX_LABEL) {
        return `…/${tail}`
      }
      // A long single token has no informative segment: keep both ends.
      return `${id.slice(0, 20)}…${id.slice(-20)}`
    }

    // --- columns -----------------------------------------------------------------
    // Declared once and consumed by both the header and the body, so a metric's
    // label, its cell and its position cannot drift apart between the two.
    //
    // `core` columns are what the panel shows by default. This table lives in a
    // settings section, and ten columns of `white-space: nowrap` numbers do not
    // fit there without a horizontal scrollbar. The `extra` columns hold the
    // deeper numbers and stay one click away — nothing is dropped, only deferred.
    //
    // `base` is the class of an ordinary cell ('num' = primary, otherwise dim),
    // `tone` may override it per row (best median, error, low confidence).
    const COLUMNS = [
      {
        key: 'name',
        align: 'left',
        label: (view) => (view === 'model' ? 'Модель' : 'Провайдер'),
        cell: (row, ctx) => {
          const full = ctx.view === 'model' ? row.model : row.provider
          const short = ctx.view === 'model' ? shortLabel(row.model) : row.provider
          return h(
            'div',
            { className: 'dsh-ms-model-inner' },
            h(
              'span',
              { className: 'dsh-ms-model-name', title: full },
              short,
              // The tooltip carries the full id for the mouse. A shortened label
              // must not be the only thing everyone else can reach.
              short === full ? null : h('span', { className: 'dsh-ms-sr-only' }, ` — ${full}`),
            ),
            ctx.view === 'model'
              ? h('span', { className: 'dsh-ms-provider', title: row.provider }, row.provider)
              : null,
          )
        },
      },
      { key: 'steps', tier: 'core', base: 'num', label: 'шагов', cell: (row) => count(row.steps) },
      {
        key: 'ttft',
        tier: 'core',
        base: 'num',
        label: 'отклик med',
        cell: (row) => ms(row.ttftMedian),
        tone: (row, ctx) => (ctx.best.ttft === row ? 'dsh-ms-good' : null),
      },
      {
        key: 'tps',
        tier: 'core',
        base: 'num',
        label: 'tok/s med',
        cell: (row) => num(row.tpsMedian, 1),
        tone: (row, ctx) => (ctx.best.tps === row ? 'dsh-ms-good' : null),
      },
      {
        key: 'errors',
        tier: 'core',
        label: 'ош.',
        cell: (row) => count(row.errors ?? 0),
        tone: (row) => (row.errors > 0 ? 'dsh-ms-bad' : null),
      },
      { key: 'ttftP90', tier: 'extra', label: 'отклик p90', cell: (row) => ms(row.ttftP90) },
      { key: 'tpsMax', tier: 'extra', label: 'tok/s max', cell: (row) => num(row.tpsMax, 1) },
      {
        key: 'confidence',
        tier: 'extra',
        label: 'замер',
        cell: (row) => (row.speedConfidence === null ? dash : `${count(Math.round(row.speedConfidence * 100))}%`),
        tone: (row) => (row.speedConfidence !== null && row.speedConfidence < 0.5 ? 'dsh-ms-warn' : null),
      },
      { key: 'llm', tier: 'extra', label: 'llm / шаг', cell: (row) => ms(row.llmMeanMs) },
      { key: 'cache', tier: 'extra', label: 'кэш', cell: (row) => pct(row.cacheHitRate) },
      // The panel can sort by recency, so the timestamp it sorts by is a column
      // of its own instead of an invisible key.
      { key: 'lastSeen', tier: 'extra', label: 'виден', cell: (row) => ago(row.lastSeen) },
    ]

    /** An ordinary cell is dimmed unless its column's tone claims it. */
    function cellClass(column, row, ctx) {
      const tone = typeof column.tone === 'function' ? column.tone(row, ctx) : null
      return tone ?? (column.base === 'num' ? 'dsh-ms-num' : 'dsh-ms-dim')
    }

    /**
     * One line naming where the numbers came from and how fresh they are.
     *
     * The panel answers from a cached fold first, so it must also say when that
     * fold is stale and how much of it is still being refreshed.
     */
    function footerSummary(data, totals, pending) {
      const parts = [`сессий в отчёте: ${count(data.scanned)}`]
      if (data.skipped) parts.push(`пропущено: ${count(data.skipped)}`)
      if (totals) parts.push(`шагов: ${count(totals.steps)}`, `моделей: ${count(totals.models)}`)
      if (data.readNow > 0) parts.push(`прочитано сейчас: ${count(data.readNow)}`)
      if (data.reused > 0) parts.push(`из кэша: ${count(data.reused)}`)
      if (pending > 0) parts.push(`обновляю ещё ${count(pending)}`)
      if (Number.isFinite(data.snapshotAt)) parts.push(`снимок ${ago(data.snapshotAt)}`)
      return parts.join(' · ')
    }

    // --- styles ------------------------------------------------------------------
    // Containers and controls inherit host theme tokens; nothing hard-codes a color.
    const css = `
.dsh-ms-root { display:flex; flex-direction:column; gap:12px; padding:4px 0 16px; }
.dsh-ms-head { display:flex; flex-wrap:wrap; align-items:baseline; gap:8px 16px; }
.dsh-ms-title { margin:0; font-size:15px; font-weight:600; color:var(--dsw-alias-label-primary); }
.dsh-ms-meta { font-size:12px; color:var(--dsw-alias-label-secondary); }
.dsh-ms-bar { display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
.dsh-ms-group { display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
.dsh-ms-chip { font:inherit; font-size:12px; padding:3px 9px; border-radius:999px; cursor:pointer;
  touch-action:manipulation;
  border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-secondary); }
.dsh-ms-chip:hover { border-color:var(--dsw-alias-border-l2); color:var(--dsw-alias-label-primary); }
.dsh-ms-chip[aria-pressed="true"] { border-color:var(--dsw-alias-brand-primary);
  color:var(--dsw-alias-brand-primary); }
.dsh-ms-btn { font:inherit; font-size:12px; padding:4px 11px; border-radius:6px; cursor:pointer;
  touch-action:manipulation;
  border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-primary); }
.dsh-ms-btn:hover { border-color:var(--dsw-alias-border-l2); }
.dsh-ms-btn[disabled] { opacity:.55; cursor:default; }
/* The host theme has no focus token for these controls, so draw the ring
   explicitly. An outline rather than a shadow: the table wrapper clips. */
.dsh-ms-chip:focus-visible, .dsh-ms-btn:focus-visible { outline:2px solid var(--dsw-alias-brand-primary);
  outline-offset:2px; }
/* Visually hidden, still read: a shortened model id must not lose the full one. */
.dsh-ms-sr-only { position:absolute; width:1px; height:1px; margin:-1px; padding:0; border:0;
  overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
/* A bounded scroller, not a growing table: with ~50 rows the panel used to push
   the footer and the legend far below the fold, and the sticky header below had
   no scroller to stick to (overflow-x alone never scrolls vertically). The cap
   is in viewport units so a short window still gets a usable table. */
.dsh-ms-wrap { overflow:auto; max-height:min(56vh, 520px); overscroll-behavior:contain;
  border:1px solid var(--dsw-alias-border-l1); border-radius:8px;
  background:var(--dsw-alias-bg-layer-1); }
.dsh-ms-table { border-collapse:collapse; width:100%; font-size:12px; font-variant-numeric:tabular-nums; }
.dsh-ms-table th, .dsh-ms-table td { padding:6px 10px; text-align:right; white-space:nowrap;
  border-bottom:1px solid var(--dsw-alias-border-l1); }
.dsh-ms-table .dsh-ms-left { text-align:left; }
/* In an auto-layout table the browser may shrink the name column to its
   min-content — a single breakable character — once the expanded column set
   competes for width, which turns a model path into a vertical ribbon. Give
   the column a readable floor and let the wrapper scroll instead. */
.dsh-ms-table th.dsh-ms-left, .dsh-ms-table td.dsh-ms-model { min-width:200px; }
/* The rule under the pinned header has to travel with it: the cells' own
   border-bottom scrolls away with the rows, leaving text to slide under a
   header with no edge of its own. */
.dsh-ms-table thead th { position:sticky; top:0; z-index:1; background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-secondary); font-weight:600;
  box-shadow:inset 0 -1px 0 var(--dsw-alias-border-l1); }
.dsh-ms-table tbody tr:last-child td { border-bottom:none; }
.dsh-ms-table tbody tr:hover td { background:var(--dsw-alias-bg-layer-2); }
/* The width cap lives on an inner block, not on the td: in an auto-layout table
   browsers ignore max-width on table cells, so a long unbreakable model path
   used to widen the column and spill past the cell border.
   The model cell is addressed as td.dsh-ms-model because the generic
   .dsh-ms-table td rule (specificity 0,1,1) otherwise beats a bare
   .dsh-ms-model (0,1,0) and keeps white-space:nowrap — which is what stopped
   the path from wrapping in the first place. */
.dsh-ms-table td.dsh-ms-model { text-align:left; white-space:normal; }
.dsh-ms-model-inner { max-width:340px; white-space:normal; overflow-wrap:anywhere;
  word-break:break-word; }
.dsh-ms-model-name { display:block; font-weight:500; color:var(--dsw-alias-label-primary); }
.dsh-ms-provider { display:block; font-size:11px; font-weight:400;
  color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; }
.dsh-ms-num { color:var(--dsw-alias-label-primary); }
.dsh-ms-dim { color:var(--dsw-alias-label-secondary); }
.dsh-ms-warn { color:var(--dsw-alias-state-warn-primary); }
.dsh-ms-bad { color:var(--dsw-alias-state-error-primary); }
.dsh-ms-good { color:var(--dsw-alias-state-success-primary); }
.dsh-ms-note { font-size:11.5px; line-height:1.5; color:var(--dsw-alias-label-secondary);
  max-width:78ch; }
.dsh-ms-empty { padding:16px; font-size:13px; color:var(--dsw-alias-label-secondary); }
.dsh-ms-alert { padding:8px 10px; border-radius:8px; border:1px solid var(--dsw-alias-border-l1);
  border-left:3px solid var(--dsw-alias-state-warn-primary); background:var(--dsw-alias-bg-layer-2);
  font-size:12px; line-height:1.5; color:var(--dsw-alias-label-primary); overflow-wrap:anywhere; }
.dsh-ms-foot { display:flex; flex-wrap:wrap; align-items:center; gap:10px; }
`

    // --- component ---------------------------------------------------------------
    function Panel() {
      // Sort and view are the user's settings, not view state: reopening the
      // panel reopens the same question. The payload cache is keyed by the exact
      // query (sort|view), so restoring the query also restores an instant
      // first paint instead of a spinner.
      const [initialQuery] = React.useState(readStoredQuery)
      const [sort, setSort] = React.useState(initialQuery.sort)
      const [view, setView] = React.useState(initialQuery.view)
      // Ten columns do not fit a settings section, so the deep metrics start
      // collapsed; the choice sticks to the browser across reopenings.
      const [showAllColumns, setShowAllColumns] = React.useState(() => readPrefs().columnsAll === true)
      // The last answer for this exact query, if the browser still has it. It is
      // shown immediately and replaced the moment the host answers.
      const [state, setState] = React.useState(() => {
        const cached = readCachedPayload(initialQuery.sort, initialQuery.view)
        return cached === null ? { phase: 'loading' } : { phase: 'ready', data: cached }
      })
      const timedOutRef = React.useRef(false)
      const retriesRef = React.useRef(0)
      const lastPendingRef = React.useRef(0)
      // A background refresh is the panel talking to itself; only a refresh the
      // user asked for is worth announcing.
      const manualRef = React.useRef(false)
      const [announce, setAnnounce] = React.useState('')

      // A failed request must not wipe the table. The host folds in the
      // background and answers early, so a single hiccup — or one dropped reply
      // out of the refresh loop — used to replace a perfectly good table with an
      // error line. Keep the last answer for this exact query and attach a
      // warning; only a failure with nothing to show becomes a full error.
      const fail = React.useCallback((message) => {
        setState((prev) =>
          prev.data
            ? { phase: 'ready', data: prev.data, warning: message }
            : { phase: 'error', error: message },
        )
      }, [])

      const load = React.useCallback(
        async (signal) => {
          const manual = manualRef.current
          manualRef.current = false
          if (manual) setAnnounce('Обновляю статистику…')
          setState((prev) => ({ ...prev, phase: prev.data ? 'refreshing' : 'loading', error: null }))
          try {
            const query = `?sort=${encodeURIComponent(sort)}&view=${encodeURIComponent(view)}`
            const response = await fetch(`/api/model-stats${query}`, { signal })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const data = await response.json()
            if (data.ok === false) throw new Error(data.error ?? 'unknown error')
            writeCachedPayload(sort, view, data)
            setState({ phase: 'ready', data })
            if (manual) setAnnounce('Статистика обновлена')
          } catch (error) {
            if (error && error.name === 'AbortError') {
              // A user-visible deadline, not an unmount: say so instead of
              // leaving the spinner up forever.
              if (timedOutRef.current) {
                fail(
                  `превышено время ожидания ответа (${Math.round(REQUEST_TIMEOUT_MS / 1000)} с)`,
                )
              }
              return
            }
            fail(String(error?.message ?? error))
          }
        },
        [sort, view, fail],
      )

      React.useEffect(() => {
        // Switching the sort or view switches the query, so show whatever the
        // browser already has for the new one rather than the previous table.
        const cached = readCachedPayload(sort, view)
        setState(cached === null ? { phase: 'loading' } : { phase: 'ready', data: cached })

        const controller = new AbortController()
        timedOutRef.current = false
        retriesRef.current = 0
        lastPendingRef.current = 0
        const timer = setTimeout(() => {
          timedOutRef.current = true
          controller.abort()
        }, REQUEST_TIMEOUT_MS)
        load(controller.signal)
        return () => {
          clearTimeout(timer)
          controller.abort()
        }
      }, [load, sort, view])

      // The host answers from its cache first and refreshes behind it, so an
      // early answer can still be catching up. Keep asking — quietly, and only
      // while the work is actually moving — until it stops changing.
      React.useEffect(() => {
        if (state.phase !== 'ready') return undefined
        const data = state.data
        const busy = (data?.pending ?? 0) > 0 || (data?.readNow ?? 0) > 0
        if (!busy) return undefined
        // A refresh is worth one round when the host just folded something the
        // answer cannot yet contain; after that, only real progress counts.
        const stamp = `${data?.pending ?? 0}:${data?.readNow ?? 0}:${data?.snapshotAt ?? 0}`
        if (retriesRef.current > 0 && stamp === lastPendingRef.current) return undefined
        if (retriesRef.current >= MAX_REFRESHES) return undefined
        lastPendingRef.current = stamp
        const timer = setTimeout(() => {
          retriesRef.current += 1
          load()
        }, REFRESH_INTERVAL_MS)
        return () => clearTimeout(timer)
      }, [state, load])

      const rows = Array.isArray(state.data?.rows) ? state.data.rows : []
      const best = React.useMemo(() => {
        if (rows.length < 2) return {}
        const pick = (selector, better) => {
          let winner = null
          for (const row of rows) {
            const value = selector(row)
            if (value === null || value === undefined || !Number.isFinite(value)) continue
            if (winner === null || better(value, selector(winner))) winner = row
          }
          return winner
        }
        return {
          ttft: pick((r) => r.ttftMedian, (a, b) => a < b),
          tps: pick((r) => r.tpsMedian, (a, b) => a > b),
        }
      }, [rows])

      // Choosing a sort or a view is a lasting decision, so it is written down
      // as it is made — never in an effect keyed on the value, which would also
      // rewrite the default on a panel the user only glanced at.
      const chooseSort = (key) => {
        setSort(key)
        writePrefs({ sort: key })
      }
      const chooseView = (next) => {
        setView(next)
        writePrefs({ view: next })
      }

      const toolbar = h(
        'div',
        { className: 'dsh-ms-bar' },
        // The visible "Сортировка:" is a caption, not a control label: the group
        // carries the name so a screen reader hears one labelled group instead of
        // a stray word followed by five buttons.
        h(
          'div',
          { className: 'dsh-ms-group', role: 'group', 'aria-label': 'Сортировка' },
          h('span', { className: 'dsh-ms-meta', 'aria-hidden': 'true' }, 'Сортировка:'),
          ...SORTS.map((entry) =>
            h(
              'button',
              {
                key: entry.key,
                type: 'button',
                className: 'dsh-ms-chip',
                'aria-pressed': sort === entry.key,
                onClick: () => chooseSort(entry.key),
              },
              entry.label,
            ),
          ),
        ),
        h('span', { style: { flex: '1 0 auto' } }),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-ms-chip',
            'aria-pressed': view === 'provider',
            onClick: () => chooseView(view === 'model' ? 'provider' : 'model'),
          },
          view === 'model' ? 'по моделям' : 'по провайдерам',
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-ms-chip',
            'aria-pressed': showAllColumns,
            onClick: () => {
              const next = !showAllColumns
              setShowAllColumns(next)
              writePrefs({ columnsAll: next })
            },
          },
          'все метрики',
        ),
      )

      const visible = COLUMNS.filter((column) => column.tier !== 'extra' || showAllColumns)

      const header = h(
        'thead',
        null,
        h(
          'tr',
          null,
          ...visible.map((column) =>
            h(
              'th',
              {
                key: column.key,
                scope: 'col',
                className: column.align === 'left' ? 'dsh-ms-left' : null,
              },
              typeof column.label === 'function' ? column.label(view) : column.label,
            ),
          ),
        ),
      )

      const body = h(
        'tbody',
        null,
        ...rows.map((row) => {
          const key = `${row.provider}/${row.model}`
          const ctx = { view, best }
          return h(
            'tr',
            { key },
            ...visible.map((column) =>
              h(
                'td',
                {
                  key: column.key,
                  className: column.key === 'name' ? 'dsh-ms-model' : cellClass(column, row, ctx),
                },
                column.cell(row, ctx),
              ),
            ),
          )
        }),
      )

      const totals = state.data?.totals
      const pending = state.data?.pending ?? 0
      const footer = h(
        'div',
        { className: 'dsh-ms-foot' },
        h(
          'span',
          { className: 'dsh-ms-meta' },
          state.data ? footerSummary(state.data, totals, pending) : '',
        ),
        h('span', { style: { flex: '1 0 auto' } }),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-ms-btn',
            disabled: state.phase === 'loading' || state.phase === 'refreshing',
            onClick: () => {
              manualRef.current = true
              load()
            },
          },
          state.phase === 'refreshing' ? 'обновляю…' : 'Обновить',
        ),
      )

      let content
      if (state.phase === 'error') {
        content = h(
          'div',
          { className: 'dsh-ms-empty', role: 'status' },
          `Не удалось получить статистику: ${state.error}. Нажмите «Обновить», чтобы повторить.`,
        )
      } else if (state.phase === 'loading') {
        content = h(
          'div',
          { className: 'dsh-ms-empty' },
          'Считаю статистику по истории сессий… Первый в этой установке проход читает все логи сессий и может занять до минуты. Дальше ответ берётся из кэша сразу, а свежие данные догружаются в фоне.',
        )
      } else if (rows.length === 0) {
        content = h(
          'div',
          { className: 'dsh-ms-empty' },
          pending > 0
            ? `Прочитано ${count(state.data.scanned)} сессий, ещё ${count(pending)} в очереди — данные появятся по мере обработки.`
            : 'В истории пока нет замеров. Поработайте в сессии — метрики считаются по уже записанным логам.',
        )
      } else {
        content = h('div', { className: 'dsh-ms-wrap' }, h('table', { className: 'dsh-ms-table' }, header, body))
      }

      const alert =
        state.phase === 'ready' && state.warning
          ? h(
              'div',
              { className: 'dsh-ms-alert', role: 'status' },
              `Не удалось обновить данные: ${state.warning}. Показаны последние полученные значения — нажмите «Обновить», чтобы повторить.`,
            )
          : null

      return h(
        'div',
        { className: 'dsh-ms-root' },
        h('style', null, css),
        // One channel for the async work the user started, so a background poll
        // stays silent while a requested refresh is announced politely.
        h('span', { className: 'dsh-ms-sr-only', role: 'status' }, announce),
        h(
          'div',
          { className: 'dsh-ms-head' },
          // The section label already names this panel in the host's navigation;
          // inside the panel it is a heading, not decorative text.
          h('h2', { className: 'dsh-ms-title' }, 'Скорость и стабильность моделей'),
          h(
            'span',
            { className: 'dsh-ms-meta' },
            'Считается по истории сессий. Отклик — время до первого токена, tok/s — по спану стриминга провайдера.',
          ),
        ),
        toolbar,
        alert,
        content,
        footer,
        h(
          'div',
          { className: 'dsh-ms-note' },
          'Зелёным отмечены лучшая медиана отклика и лучшая медиана скорости среди показанных строк. ' +
            'Значение «-» означает, что провайдер не записал тайминги потока для этой модели, а не что она медленная. ' +
            (showAllColumns
              ? '«замер» — доля шагов, где спана хватило для достоверной скорости: низкое значение значит, что модель в основном отдавала очень короткие порции, и tok/s по ней менее надёжен. ' +
                '«кэш» — доля чтения из кэша промпта во входных токенах. «виден» — когда модель последний раз отвечала.'
              : 'Отклик p90, tok/s max, «замер», llm / шаг, «кэш» и «виден» — за кнопкой «все метрики».'),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.get('slots')
        if (slots === undefined) return
        slots.inject('settings.section', () =>
          slots.register(
            { name: 'settings.section', id: 'model-stats', order: 32, label: () => 'Скорость моделей' },
            Panel,
          ),
        )
      },
    }
  },
})
