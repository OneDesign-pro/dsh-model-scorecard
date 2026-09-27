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

    // --- formatting helpers ------------------------------------------------------
    const dash = '-'

    function num(value, digits) {
      if (value === null || value === undefined || !Number.isFinite(value)) return dash
      return value.toFixed(digits)
    }

    function ms(value) {
      if (value === null || value === undefined || !Number.isFinite(value)) return dash
      if (value < 1000) return `${Math.round(value)} ms`
      return `${(value / 1000).toFixed(1)} s`
    }

    function pct(value) {
      if (value === null || value === undefined || !Number.isFinite(value)) return dash
      return `${(value * 100).toFixed(1)}%`
    }

    function ago(ts) {
      if (!Number.isFinite(ts)) return dash
      const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000))
      if (seconds < 60) return `${seconds} с назад`
      if (seconds < 3600) return `${Math.round(seconds / 60)} мин назад`
      if (seconds < 86400) return `${Math.round(seconds / 3600)} ч назад`
      return `${Math.round(seconds / 86400)} дн назад`
    }

    // Local model ids are filesystem paths, e.g.
    // /Users/jeka/.lmstudio/models/ornith-ai/Ornith-1.5-9B-GGUF/Ornith-1.5-9B-Q4_K_M.gguf
    // A path that long cannot be shown whole in a table column, so the last
    // segment is displayed and the full id stays in the tooltip (and in the
    // agent's text report, which is unchanged).
    const MAX_LABEL = 44

    // A cold panel request is capped on the host and then reports what is still
    // pending instead of blocking, so this timeout only fires when the host is
    // genuinely unresponsive.
    const REQUEST_TIMEOUT_MS = 25000

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

    /**
     * One line naming where the numbers came from and how fresh they are.
     *
     * The panel answers from a cached fold first, so it must also say when that
     * fold is stale and how much of it is still being refreshed.
     */
    function footerSummary(data, totals, pending) {
      const parts = [`сессий в отчёте: ${data.scanned}`]
      if (data.skipped) parts.push(`пропущено: ${data.skipped}`)
      if (totals) parts.push(`шагов: ${totals.steps}`, `моделей: ${totals.models}`)
      if (data.readNow > 0) parts.push(`прочитано сейчас: ${data.readNow}`)
      if (data.reused > 0) parts.push(`из кэша: ${data.reused}`)
      if (pending > 0) parts.push(`обновляю ещё ${pending}`)
      if (Number.isFinite(data.snapshotAt)) parts.push(`снимок ${ago(data.snapshotAt)}`)
      return parts.join(' · ')
    }

    // --- styles ------------------------------------------------------------------
    // Containers and controls inherit host theme tokens; nothing hard-codes a color.
    const css = `
.dsh-ms-root { display:flex; flex-direction:column; gap:12px; padding:4px 0 16px; }
.dsh-ms-head { display:flex; flex-wrap:wrap; align-items:baseline; gap:8px 16px; }
.dsh-ms-title { font-size:15px; font-weight:600; color:var(--dsw-alias-label-primary); }
.dsh-ms-meta { font-size:12px; color:var(--dsw-alias-label-secondary); }
.dsh-ms-bar { display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
.dsh-ms-chip { font:inherit; font-size:12px; padding:3px 9px; border-radius:999px; cursor:pointer;
  border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-secondary); }
.dsh-ms-chip:hover { border-color:var(--dsw-alias-border-l2); color:var(--dsw-alias-label-primary); }
.dsh-ms-chip[aria-pressed="true"] { border-color:var(--dsw-alias-brand-primary);
  color:var(--dsw-alias-brand-primary); }
.dsh-ms-btn { font:inherit; font-size:12px; padding:4px 11px; border-radius:6px; cursor:pointer;
  border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-primary); }
.dsh-ms-btn:hover { border-color:var(--dsw-alias-border-l2); }
.dsh-ms-btn[disabled] { opacity:.55; cursor:default; }
.dsh-ms-wrap { overflow-x:auto; border:1px solid var(--dsw-alias-border-l1); border-radius:8px;
  background:var(--dsw-alias-bg-layer-1); }
.dsh-ms-table { border-collapse:collapse; width:100%; font-size:12px; }
.dsh-ms-table th, .dsh-ms-table td { padding:6px 10px; text-align:right; white-space:nowrap;
  border-bottom:1px solid var(--dsw-alias-border-l1); }
.dsh-ms-table thead th { position:sticky; top:0; background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-secondary); font-weight:600; }
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
      const [sort, setSort] = React.useState('ttft')
      const [view, setView] = React.useState('model')
      // The last answer for this exact query, if the browser still has it. It is
      // shown immediately and replaced the moment the host answers.
      const [state, setState] = React.useState(() => {
        const cached = readCachedPayload('ttft', 'model')
        return cached === null ? { phase: 'loading' } : { phase: 'ready', data: cached }
      })
      const timedOutRef = React.useRef(false)
      const retriesRef = React.useRef(0)
      const lastPendingRef = React.useRef(0)

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
          setState((prev) => ({ ...prev, phase: prev.data ? 'refreshing' : 'loading', error: null }))
          try {
            const query = `?sort=${encodeURIComponent(sort)}&view=${encodeURIComponent(view)}`
            const response = await fetch(`/api/model-stats${query}`, { signal })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const data = await response.json()
            if (data.ok === false) throw new Error(data.error ?? 'unknown error')
            writeCachedPayload(sort, view, data)
            setState({ phase: 'ready', data })
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

      const toolbar = h(
        'div',
        { className: 'dsh-ms-bar' },
        h('span', { className: 'dsh-ms-meta' }, 'Сортировка:'),
        ...SORTS.map((entry) =>
          h(
            'button',
            {
              key: entry.key,
              type: 'button',
              className: 'dsh-ms-chip',
              'aria-pressed': sort === entry.key,
              onClick: () => setSort(entry.key),
            },
            entry.label,
          ),
        ),
        h('span', { style: { flex: '1 0 auto' } }),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-ms-chip',
            'aria-pressed': view === 'provider',
            onClick: () => setView(view === 'model' ? 'provider' : 'model'),
          },
          view === 'model' ? 'по моделям' : 'по провайдерам',
        ),
      )

      const header = h(
        'thead',
        null,
        h(
          'tr',
          null,
          h('th', { style: { textAlign: 'left' } }, view === 'model' ? 'Модель' : 'Провайдер'),
          h('th', null, 'шагов'),
          h('th', null, 'отклик med'),
          h('th', null, 'отклик p90'),
          h('th', null, 'tok/s med'),
          h('th', null, 'tok/s max'),
          h('th', null, 'замер'),
          h('th', null, 'llm / шаг'),
          h('th', null, 'кэш'),
          h('th', null, 'ош.'),
        ),
      )

      const body = h(
        'tbody',
        null,
        ...rows.map((row) => {
          const key = `${row.provider}/${row.model}`
          const isBestTtft = best.ttft === row
          const isBestTps = best.tps === row
          return h(
            'tr',
            { key },
            h(
              'td',
              { className: 'dsh-ms-model' },
              h(
                'div',
                { className: 'dsh-ms-model-inner' },
                h(
                  'span',
                  { className: 'dsh-ms-model-name', title: view === 'model' ? row.model : row.provider },
                  view === 'model' ? shortLabel(row.model) : row.provider,
                ),
                view === 'model'
                  ? h('span', { className: 'dsh-ms-provider', title: row.provider }, row.provider)
                  : null,
              ),
            ),
            h('td', { className: 'dsh-ms-num' }, String(row.steps ?? dash)),
            h(
              'td',
              { className: isBestTtft ? 'dsh-ms-good' : 'dsh-ms-num' },
              ms(row.ttftMedian),
            ),
            h('td', { className: 'dsh-ms-dim' }, ms(row.ttftP90)),
            h(
              'td',
              { className: isBestTps ? 'dsh-ms-good' : 'dsh-ms-num' },
              num(row.tpsMedian, 1),
            ),
            h('td', { className: 'dsh-ms-dim' }, num(row.tpsMax, 1)),
            h(
              'td',
              { className: row.speedConfidence !== null && row.speedConfidence < 0.5 ? 'dsh-ms-warn' : 'dsh-ms-dim' },
              row.speedConfidence === null ? dash : `${Math.round(row.speedConfidence * 100)}%`,
            ),
            h('td', { className: 'dsh-ms-dim' }, ms(row.llmMeanMs)),
            h('td', { className: 'dsh-ms-dim' }, pct(row.cacheHitRate)),
            h(
              'td',
              { className: row.errors > 0 ? 'dsh-ms-bad' : 'dsh-ms-dim' },
              String(row.errors ?? 0),
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
            onClick: () => load(),
          },
          state.phase === 'refreshing' ? 'обновляю…' : 'Обновить',
        ),
      )

      let content
      if (state.phase === 'error') {
        content = h(
          'div',
          { className: 'dsh-ms-empty' },
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
            ? `Прочитано ${state.data.scanned} сессий, ещё ${pending} в очереди — данные появятся по мере обработки.`
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
        h(
          'div',
          { className: 'dsh-ms-head' },
          h('span', { className: 'dsh-ms-title' }, 'Скорость и стабильность моделей'),
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
            '«замер» — доля шагов, где спана хватило для достоверной скорости: низкое значение значит, что модель в основном отдавала очень короткие порции, и tok/s по ней менее надёжен. ' +
            '«кэш» — доля чтения из кэша промпта во входных токенах. Значение «-» означает, что провайдер не записал тайминги потока для этой модели, а не что она медленная.',
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
