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
      { key: 'steps', labelKey: 'sort.steps' },
      { key: 'ttft', labelKey: 'sort.ttft' },
      { key: 'speed', labelKey: 'sort.speed' },
      { key: 'errors', labelKey: 'sort.errors' },
      { key: 'lastSeen', labelKey: 'sort.lastSeen' },
    ]

    const DEFAULT_QUERY = { sort: 'ttft', view: 'model' }

    // --- localized copy ----------------------------------------------------------
    // The panel follows the host's locale service: its dictionaries are registered
    // under this package's namespace and read back through a bound translate
    // function, so the panel switches language together with the rest of the GUI,
    // and a language pack can override any key. Without that service — an older
    // host — the built-in Russian copy below keeps the panel complete.
    const I18N_NS = 'dsh-model-stats'
    const FALLBACK_LOCALE = 'ru'

    const MESSAGES = {
      ru: {
        'section.label': 'Скорость моделей',
        'panel.title': 'Скорость и стабильность моделей',
        'panel.subtitle':
          'Считается по истории сессий. Отклик — время до первого токена, tok/s — по спану стриминга провайдера.',
        'sort.caption': 'Сортировка:',
        'sort.group': 'Сортировка',
        'sort.steps': 'по числу шагов',
        'sort.ttft': 'быстрый отклик',
        'sort.speed': 'скорость',
        'sort.errors': 'нестабильные',
        'sort.lastSeen': 'недавние',
        'view.models': 'по моделям',
        'view.providers': 'по провайдерам',
        'columns.all': 'все метрики',
        'column.model': 'Модель',
        'column.provider': 'Провайдер',
        'column.steps': 'шагов',
        'column.ttft': 'отклик med',
        'column.tps': 'tok/s med',
        'column.errors': 'ош.',
        'column.ttftP90': 'отклик p90',
        'column.tpsMax': 'tok/s max',
        'column.confidence': 'замер',
        'column.llm': 'llm / шаг',
        'column.cache': 'кэш',
        'column.lastSeen': 'виден',
        'action.refresh': 'Обновить',
        'action.refreshing': 'обновляю…',
        'loading.body':
          'Считаю статистику по истории сессий… Первый в этой установке проход читает все логи сессий и может занять до минуты. Дальше ответ берётся из кэша сразу, а свежие данные догружаются в фоне.',
        'empty.pending':
          'Прочитано {scanned} сессий, ещё {pending} в очереди — данные появятся по мере обработки.',
        'empty.nodata':
          'В истории пока нет замеров. Поработайте в сессии — метрики считаются по уже записанным логам.',
        'error.body':
          'Не удалось получить статистику: {error}. Нажмите «Обновить», чтобы повторить.',
        'warn.body':
          'Не удалось обновить данные: {warning}. Показаны последние полученные значения — нажмите «Обновить», чтобы повторить.',
        'warn.stale':
          'Не удалось получить порядок «{sort}»: {warning}. Показаны строки прежнего запроса — нажмите «Обновить», чтобы повторить.',
        'status.updating':
          'Показан прежний ответ — обновляю сортировку «{sort}». Обычно это доли секунды.',
        'timeout.reason': 'превышено время ожидания ответа ({seconds} с)',
        'announce.refreshing': 'Обновляю статистику…',
        'announce.updated': 'Статистика обновлена',
        'footer.scanned': 'сессий в отчёте: {count}',
        'footer.skipped': 'пропущено: {count}',
        'footer.steps': 'шагов: {count}',
        'footer.models': 'моделей: {count}',
        'footer.readNow': 'прочитано сейчас: {count}',
        'footer.reused': 'из кэша: {count}',
        'footer.pending': 'обновляю ещё {count}',
        'footer.snapshot': 'снимок {ago}',
        'note.core':
          'Зелёным отмечены лучшая медиана отклика и лучшая медиана скорости среди показанных строк. Значение «-» означает, что провайдер не записал тайминги потока для этой модели, а не что она медленная. ',
        'note.extra':
          '«замер» — доля шагов, где спана хватило для достоверной скорости: низкое значение значит, что модель в основном отдавала очень короткие порции, и tok/s по ней менее надёжен. «кэш» — доля чтения из кэша промпта во входных токенах. «виден» — когда модель последний раз отвечала.',
        'note.collapsed':
          'Отклик p90, tok/s max, «замер», llm / шаг, «кэш» и «виден» — за кнопкой «все метрики».',
      },
      en: {
        'section.label': 'Model Speed',
        'panel.title': 'Model speed and stability',
        'panel.subtitle':
          'Folded from session history. Response is the time to first token; tok/s is measured over the provider’s streaming span.',
        'sort.caption': 'Sort:',
        'sort.group': 'Sort',
        'sort.steps': 'most steps',
        'sort.ttft': 'fastest response',
        'sort.speed': 'fastest decode',
        'sort.errors': 'least stable',
        'sort.lastSeen': 'most recent',
        'view.models': 'by model',
        'view.providers': 'by provider',
        'columns.all': 'all metrics',
        'column.model': 'Model',
        'column.provider': 'Provider',
        'column.steps': 'steps',
        'column.ttft': 'response med',
        'column.tps': 'tok/s med',
        'column.errors': 'errors',
        'column.ttftP90': 'response p90',
        'column.tpsMax': 'tok/s max',
        'column.confidence': 'meas.',
        'column.llm': 'llm / step',
        'column.cache': 'cache',
        'column.lastSeen': 'seen',
        'action.refresh': 'Refresh',
        'action.refreshing': 'refreshing…',
        'loading.body':
          'Counting over session history… The first pass in this install reads every session log and can take up to a minute. After that the answer comes from the cache immediately and fresh data is loaded in the background.',
        'empty.pending':
          'Read {scanned} sessions, {pending} still queued — rows appear as they are processed.',
        'empty.nodata':
          'No measurements in the history yet. Work in a session — metrics are folded from logs that are already written.',
        'error.body': 'Could not get the statistics: {error}. Press “Refresh” to retry.',
        'warn.body':
          'Could not refresh: {warning}. Showing the last values received — press “Refresh” to retry.',
        'warn.stale':
          'Could not load the “{sort}” order: {warning}. Showing the previous query’s rows — press “Refresh” to retry.',
        'status.updating':
          'Showing the previous answer — updating the “{sort}” order. This usually takes a moment.',
        'timeout.reason': 'the request timed out ({seconds} s)',
        'announce.refreshing': 'Refreshing statistics…',
        'announce.updated': 'Statistics updated',
        'footer.scanned': 'sessions in report: {count}',
        'footer.skipped': 'skipped: {count}',
        'footer.steps': 'steps: {count}',
        'footer.models': 'models: {count}',
        'footer.readNow': 'read now: {count}',
        'footer.reused': 'from cache: {count}',
        'footer.pending': 'refreshing {count} more',
        'footer.snapshot': 'snapshot {ago}',
        'note.core':
          'Green marks the best median response and the best median decode among the rows shown. A “-” means the provider recorded no stream timing for that model, not that the model is slow. ',
        'note.extra':
          '“meas.” is the share of steps whose span was long enough to be a reliable rate: a low value means the model mostly emitted very short bursts, so its tok/s is the least trustworthy number in the row. “cache” is the prompt-cache read share of input tokens. “seen” is when the model last answered.',
        'note.collapsed':
          'Response p90, tok/s max, “meas.”, llm / step, “cache” and “seen” — behind the “all metrics” button.',
      },
    }

    /** `{name}` interpolation, the same dictionary format the host service uses. */
    function interpolate(template, params) {
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        name in params ? String(params[name]) : match,
      )
    }

    /** Translator used when the host has no locale service. */
    function fallbackTranslate(key, params) {
      return interpolate(MESSAGES[FALLBACK_LOCALE][key] ?? key, params)
    }

    /**
     * Bind this package's copy to the host's locale service.
     *
     * Resolved lazily — on the first label or render, not at plugin apply — so
     * the panel still finds the service when it is provided later in the boot
     * sequence. Any failure keeps the built-in copy rather than keying the panel
     * to raw dictionary ids.
     */
    function bindPanelLocale(ctx) {
      const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
      const usable =
        locale !== undefined &&
        typeof locale.register === 'function' &&
        typeof locale.bind === 'function'
      if (!usable) return { t: fallbackTranslate, locale: undefined }
      const register = (tag, dict) => {
        const call = () => locale.register(I18N_NS, tag, dict)
        if (typeof ctx.effect === 'function') ctx.effect(call, `${I18N_NS}: ${tag}`)
        else call()
      }
      try {
        register('ru', MESSAGES.ru)
        register('en', MESSAGES.en)
        return { t: locale.bind(I18N_NS), locale }
      } catch (error) {
        return { t: fallbackTranslate, locale: undefined }
      }
    }

    // --- formatting helpers ------------------------------------------------------
    // Numbers and times follow the active language too, so a Russian sentence in
    // the Russian UI says "45,2", not "45.2".
    const dash = '-'
    /** Between a number and its unit: "820 ms" must not wrap into two lines. */
    const NBSP = '\u00A0'

    function finite(value) {
      return value !== null && value !== undefined && Number.isFinite(value)
    }

    /** Intl formatters are expensive to build, so they are cached per language. */
    const formatterBundles = new Map()

    function formattersFor(locale) {
      const cached = formatterBundles.get(locale)
      if (cached !== undefined) return cached

      // An unknown or malformed tag must not take the panel down with it.
      let resolved = locale
      try {
        new Intl.NumberFormat(resolved)
      } catch (error) {
        resolved = FALLBACK_LOCALE
      }

      const decimals = new Map()
      const decimalFormat = (digits) => {
        let format = decimals.get(digits)
        if (format === undefined) {
          format = new Intl.NumberFormat(resolved, {
            minimumFractionDigits: digits,
            maximumFractionDigits: digits,
          })
          decimals.set(digits, format)
        }
        return format
      }

      const relative = new Intl.RelativeTimeFormat(resolved, { numeric: 'auto' })

      const bundle = {
        num(value, digits) {
          if (!finite(value)) return dash
          return decimalFormat(digits).format(value)
        },
        /** Counts are grouped, never fractional: 12 345 steps, not 12345. */
        count(value) {
          if (!finite(value)) return dash
          return decimalFormat(0).format(value)
        },
        ms(value) {
          if (!finite(value)) return dash
          if (value < 1000) return `${decimalFormat(0).format(Math.round(value))}${NBSP}ms`
          return `${decimalFormat(1).format(value / 1000)}${NBSP}s`
        },
        pct(value) {
          if (!finite(value)) return dash
          return `${decimalFormat(1).format(value * 100)}%`
        },
        // numeric:'auto' yields "сейчас" for a snapshot taken moments ago and the
        // correct plural everywhere else, in every language Intl knows.
        ago(ts) {
          if (!Number.isFinite(ts)) return dash
          const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000))
          if (seconds < 60) return relative.format(-seconds, 'second')
          if (seconds < 3600) return relative.format(-Math.round(seconds / 60), 'minute')
          if (seconds < 86400) return relative.format(-Math.round(seconds / 3600), 'hour')
          return relative.format(-Math.round(seconds / 86400), 'day')
        },
      }
      formatterBundles.set(locale, bundle)
      return bundle
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

    /**
     * The identity of one query: `sort|view`.
     *
     * It names a cache entry and it labels the rows a payload answers. The panel
     * needs the second job because a switch to another sort has no answer yet,
     * and what is on screen in the meantime belongs to a query the user is no
     * longer asking for.
     */
    function queryKey(sort, view) {
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
      const entry = readCache()[queryKey(sort, view)]
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
        entries[queryKey(sort, view)] = { at: Date.now(), data }
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

    // --- panel state -------------------------------------------------------------
    // The state machine is four pure functions, written out rather than inlined
    // into the component so that `tools/verify-panel-state.mjs` can drive the
    // real panel through them. They exist because of one rule:
    //
    //   rows already on screen are never replaced by a message.
    //
    // Switching the sort asks a question the host has not answered yet, so the
    // panel has a choice: blank itself, or keep what it has. It keeps it. Losing
    // the table is the one outcome the user cannot act on — and if that request
    // is slow, fails, or is aborted by a following click, the table did not come
    // back on its own. `dataQuery` records which query the visible rows answer,
    // so the panel can name the wait instead of passing off a stale order as the
    // requested one.
    const EMPTY_STATE = { phase: 'loading', data: null, dataQuery: null, warning: null, error: null }

    /** The state a switch to `key` starts from: cached answer, kept rows, or nothing. */
    function querySwitched(prev, cached, key) {
      const fresh = cached ?? null
      if (fresh !== null) return { phase: 'ready', data: fresh, dataQuery: key, warning: null, error: null }
      if (prev.data === null || prev.data === undefined) return EMPTY_STATE
      return { ...prev, phase: 'loading', warning: null, error: null }
    }

    /** The state an answer for `key` puts the panel in. */
    function queryAnswered(data, key) {
      return { phase: 'ready', data, dataQuery: key, warning: null, error: null }
    }

    /** The state a failed request puts the panel in. Rows survive a failure. */
    function queryFailed(prev, message) {
      if (prev.data === null || prev.data === undefined) {
        return { phase: 'error', data: null, dataQuery: null, warning: null, error: message }
      }
      return { ...prev, phase: 'ready', warning: message, error: null }
    }

    /** Which block the panel renders. Rows win over every message. */
    function contentKind(rows, state) {
      if (rows.length > 0) return 'table'
      if (state.phase === 'error') return 'error'
      if (state.phase === 'loading' || state.phase === 'refreshing') return 'loading'
      return 'empty'
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
        labelKey: (view) => (view === 'model' ? 'column.model' : 'column.provider'),
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
      {
        key: 'steps',
        tier: 'core',
        base: 'num',
        labelKey: 'column.steps',
        cell: (row, ctx) => ctx.fmt.count(row.steps),
      },
      {
        key: 'ttft',
        tier: 'core',
        base: 'num',
        labelKey: 'column.ttft',
        cell: (row, ctx) => ctx.fmt.ms(row.ttftMedian),
        tone: (row, ctx) => (ctx.best.ttft === row ? 'dsh-ms-good' : null),
      },
      {
        key: 'tps',
        tier: 'core',
        base: 'num',
        labelKey: 'column.tps',
        cell: (row, ctx) => ctx.fmt.num(row.tpsMedian, 1),
        tone: (row, ctx) => (ctx.best.tps === row ? 'dsh-ms-good' : null),
      },
      {
        key: 'errors',
        tier: 'core',
        labelKey: 'column.errors',
        cell: (row, ctx) => ctx.fmt.count(row.errors ?? 0),
        tone: (row) => (row.errors > 0 ? 'dsh-ms-bad' : null),
      },
      {
        key: 'ttftP90',
        tier: 'extra',
        labelKey: 'column.ttftP90',
        cell: (row, ctx) => ctx.fmt.ms(row.ttftP90),
      },
      {
        key: 'tpsMax',
        tier: 'extra',
        labelKey: 'column.tpsMax',
        cell: (row, ctx) => ctx.fmt.num(row.tpsMax, 1),
      },
      {
        key: 'confidence',
        tier: 'extra',
        labelKey: 'column.confidence',
        cell: (row, ctx) =>
          row.speedConfidence === null
            ? dash
            : `${ctx.fmt.count(Math.round(row.speedConfidence * 100))}%`,
        tone: (row) => (row.speedConfidence !== null && row.speedConfidence < 0.5 ? 'dsh-ms-warn' : null),
      },
      {
        key: 'llm',
        tier: 'extra',
        labelKey: 'column.llm',
        cell: (row, ctx) => ctx.fmt.ms(row.llmMeanMs),
      },
      {
        key: 'cache',
        tier: 'extra',
        labelKey: 'column.cache',
        cell: (row, ctx) => ctx.fmt.pct(row.cacheHitRate),
      },
      // The panel can sort by recency, so the timestamp it sorts by is a column
      // of its own instead of an invisible key.
      {
        key: 'lastSeen',
        tier: 'extra',
        labelKey: 'column.lastSeen',
        cell: (row, ctx) => ctx.fmt.ago(row.lastSeen),
      },
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
    function footerSummary(data, totals, pending, t, fmt) {
      const parts = [t('footer.scanned', { count: fmt.count(data.scanned) })]
      if (data.skipped) parts.push(t('footer.skipped', { count: fmt.count(data.skipped) }))
      if (totals) {
        parts.push(
          t('footer.steps', { count: fmt.count(totals.steps) }),
          t('footer.models', { count: fmt.count(totals.models) }),
        )
      }
      if (data.readNow > 0) parts.push(t('footer.readNow', { count: fmt.count(data.readNow) }))
      if (data.reused > 0) parts.push(t('footer.reused', { count: fmt.count(data.reused) }))
      if (pending > 0) parts.push(t('footer.pending', { count: fmt.count(pending) }))
      if (Number.isFinite(data.snapshotAt)) {
        parts.push(t('footer.snapshot', { ago: fmt.ago(data.snapshotAt) }))
      }
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
.dsh-ms-btn { display:inline-flex; align-items:center; justify-content:center; gap:6px;
  min-width:118px; font:inherit; font-size:12px; padding:4px 11px; border-radius:6px; cursor:pointer;
  touch-action:manipulation;
  border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-primary); }
.dsh-ms-btn:hover { border-color:var(--dsw-alias-border-l2); }
/* Not the disabled attribute: the button keeps focus and its tab stop. */
.dsh-ms-btn[aria-disabled="true"] { opacity:.6; cursor:default; }
/* Feedback for a request in flight. Under reduced motion it keeps turning, just
   slowly: a frozen ring reads as a stuck panel, and this is the only signal
   that the panel is doing something. */
.dsh-ms-spin { width:10px; height:10px; border-radius:50%; border:2px solid var(--dsw-alias-border-l2);
  border-top-color:var(--dsw-alias-brand-primary); animation:dsh-ms-turn .7s linear infinite; }
@keyframes dsh-ms-turn { to { transform:rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .dsh-ms-spin { animation-duration:2.5s; } }
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
/* The same line, without the alarm: a request still in flight is not a failure,
   and colouring it like one would teach the user to ignore the warn border. */
.dsh-ms-alert.dsh-ms-quiet { border-left-color:var(--dsw-alias-border-l2);
  color:var(--dsw-alias-label-secondary); }
.dsh-ms-foot { display:flex; flex-wrap:wrap; align-items:center; gap:10px; }
`

    // --- component ---------------------------------------------------------------
    /**
     * The active locale id, kept live so formatters follow it. Falls back to the
     * panel's own language when the host exposes no locale service.
     */
    function useActiveLocale(locale) {
      const read = React.useCallback(
        () =>
          locale !== undefined && typeof locale.getSnapshot === 'function'
            ? (locale.getSnapshot().active ?? FALLBACK_LOCALE)
            : FALLBACK_LOCALE,
        [locale],
      )
      const [active, setActive] = React.useState(read)
      React.useEffect(() => {
        setActive(read())
        if (locale === undefined || typeof locale.subscribe !== 'function') return undefined
        return locale.subscribe(() => setActive(read()))
      }, [locale, read])
      return active
    }

    function Panel({ i18n }) {
      const t = i18n?.t ?? fallbackTranslate
      const locale = useActiveLocale(i18n?.locale)
      const fmt = React.useMemo(() => formattersFor(locale), [locale])
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
      // The last answer, whatever query it answered. It is shown immediately
      // when the browser still has it and replaced the moment the host answers;
      // when it is older than the current query it stays on screen and says so.
      const [state, setState] = React.useState(() => {
        const cached = readCachedPayload(initialQuery.sort, initialQuery.view)
        return querySwitched(
          EMPTY_STATE,
          cached,
          queryKey(initialQuery.sort, initialQuery.view),
        )
      })
      const timedOutRef = React.useRef(false)
      const retriesRef = React.useRef(0)
      const lastPendingRef = React.useRef(0)
      // A background refresh is the panel talking to itself; only a refresh the
      // user asked for is worth announcing.
      const manualRef = React.useRef(false)
      const [announce, setAnnounce] = React.useState('')

      // A failed request must not wipe the table — not for a refresh of the same
      // query, and not for the switch that produced it. The host folds in the
      // background and answers early, so a single hiccup used to replace a
      // perfectly good table with an error line; the switch case was worse,
      // because the rows had already been dropped before the request went out.
      // Keep the last answer and attach a warning; only a failure with nothing
      // to show becomes a full error.
      const fail = React.useCallback((message) => {
        setState((prev) => queryFailed(prev, message))
      }, [])

      const load = React.useCallback(
        async (signal) => {
          const manual = manualRef.current
          manualRef.current = false
          if (manual) setAnnounce(t('announce.refreshing'))
          setState((prev) => ({
            ...prev,
            phase: prev.data ? 'refreshing' : 'loading',
            warning: null,
            error: null,
          }))
          try {
            const query = `?sort=${encodeURIComponent(sort)}&view=${encodeURIComponent(view)}`
            const response = await fetch(`/api/model-stats${query}`, { signal })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const data = await response.json()
            if (data.ok === false) throw new Error(data.error ?? 'unknown error')
            writeCachedPayload(sort, view, data)
            setState(queryAnswered(data, queryKey(sort, view)))
            if (manual) setAnnounce(t('announce.updated'))
          } catch (error) {
            if (error && error.name === 'AbortError') {
              // A user-visible deadline, not an unmount: say so instead of
              // leaving the spinner up forever.
              if (timedOutRef.current) {
                fail(
                  t('timeout.reason', { seconds: Math.round(REQUEST_TIMEOUT_MS / 1000) }),
                )
              }
              return
            }
            fail(String(error?.message ?? error))
          }
        },
        [sort, view, fail, t],
      )

      React.useEffect(() => {
        // Switching the sort or view switches the query: show what the browser
        // already has for the new one, and when it has nothing, keep the rows
        // that are already on screen rather than blanking the panel while the
        // host is asked.
        setState((prev) =>
          querySwitched(prev, readCachedPayload(sort, view), queryKey(sort, view)),
        )

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
        // The visible sort caption is a caption, not a control label: the group
        // carries the name so a screen reader hears one labelled group instead of
        // a stray word followed by five buttons.
        h(
          'div',
          { className: 'dsh-ms-group', role: 'group', 'aria-label': t('sort.group') },
          h('span', { className: 'dsh-ms-meta', 'aria-hidden': 'true' }, t('sort.caption')),
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
              t(entry.labelKey),
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
          t(view === 'model' ? 'view.models' : 'view.providers'),
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
          t('columns.all'),
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
              t(
                typeof column.labelKey === 'function' ? column.labelKey(view) : column.labelKey,
              ),
            ),
          ),
        ),
      )

      const body = h(
        'tbody',
        null,
        ...rows.map((row) => {
          const key = `${row.provider}/${row.model}`
          const ctx = { view, best, t, fmt }
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
      // A real `disabled` takes the button out of the tab order and drops the
      // focus of whoever just pressed it. The busy state is expressed with
      // aria-disabled plus a guarded handler instead, so the control stays
      // focusable and the keyboard user keeps their place.
      const refreshing = state.phase === 'loading' || state.phase === 'refreshing'
      const footer = h(
        'div',
        { className: 'dsh-ms-foot' },
        h(
          'span',
          { className: 'dsh-ms-meta' },
          state.data ? footerSummary(state.data, totals, pending, t, fmt) : '',
        ),
        h('span', { style: { flex: '1 0 auto' } }),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-ms-btn',
            'aria-disabled': refreshing,
            onClick: () => {
              if (refreshing) return
              manualRef.current = true
              load()
            },
          },
          refreshing ? h('span', { className: 'dsh-ms-spin', 'aria-hidden': 'true' }) : null,
          t(state.phase === 'refreshing' ? 'action.refreshing' : 'action.refresh'),
        ),
      )

      // What is on screen may answer an older query than the one selected: the
      // panel says which wait it is in instead of passing the old order off as
      // the new one.
      const currentKey = queryKey(sort, view)
      const behind = state.data !== null && state.data !== undefined && state.dataQuery !== currentKey
      const sortLabel = t((SORTS.find((entry) => entry.key === sort) ?? SORTS[0]).labelKey)

      const kind = contentKind(rows, state)
      let content
      if (kind === 'table') {
        content = h('div', { className: 'dsh-ms-wrap' }, h('table', { className: 'dsh-ms-table' }, header, body))
      } else if (kind === 'error') {
        content = h(
          'div',
          { className: 'dsh-ms-empty', role: 'status' },
          t('error.body', { error: state.error }),
        )
      } else if (kind === 'loading') {
        content = h('div', { className: 'dsh-ms-empty' }, t('loading.body'))
      } else {
        content = h(
          'div',
          { className: 'dsh-ms-empty' },
          pending > 0
            ? t('empty.pending', {
                scanned: fmt.count(state.data.scanned),
                pending: fmt.count(pending),
              })
            : t('empty.nodata'),
        )
      }

      // A failure keeps the table and explains itself; a request still in flight
      // for another query only needs to say that the order on screen is the one
      // it already had. Both are announcements, neither replaces the rows.
      const alert =
        kind !== 'table'
          ? null
          : state.warning
            ? h(
                'div',
                { className: 'dsh-ms-alert', role: 'status' },
                behind
                  ? t('warn.stale', { sort: sortLabel, warning: state.warning })
                  : t('warn.body', { warning: state.warning }),
              )
            : behind
              ? h(
                  'div',
                  { className: 'dsh-ms-alert dsh-ms-quiet', role: 'status' },
                  t('status.updating', { sort: sortLabel }),
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
          h('h2', { className: 'dsh-ms-title' }, t('panel.title')),
          h('span', { className: 'dsh-ms-meta' }, t('panel.subtitle')),
        ),
        toolbar,
        alert,
        content,
        footer,
        h(
          'div',
          { className: 'dsh-ms-note' },
          t('note.core') + (showAllColumns ? t('note.extra') : t('note.collapsed')),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.get('slots')
        if (slots === undefined) return

        // The host locale service is resolved on first use rather than here: the
        // panel is only rendered once the settings dialog opens, by which point a
        // service provided later in the boot sequence is guaranteed to exist.
        // Without one, the panel keeps its own copy (see bindPanelLocale).
        let bound = null
        const i18n = () => {
          if (bound === null) bound = bindPanelLocale(ctx)
          return bound
        }

        slots.inject('settings.section', () =>
          slots.register(
            {
              name: 'settings.section',
              id: 'model-stats',
              order: 32,
              // The section list is re-derived on every locale revision, so the
              // navigation label follows a language switch too.
              label: () => i18n().t('section.label'),
            },
            (props) => h(Panel, { ...props, i18n: i18n() }),
          ),
        )
      },
      // The state machine and the dictionaries, reachable from a repository
      // test. This half is browser-only — no build step, so nothing imports it —
      // and `tools/verify-panel-state.mjs` drives the registered section instead
      // of describing it. The module loader reads `inject` and `apply` and
      // ignores everything else.
      __test__: { MESSAGES, contentKind, querySwitched, queryAnswered, queryFailed },
    }
  },
})
