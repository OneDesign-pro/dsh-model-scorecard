/**
 * liveness-http.js — HTTP-транспорт для проверки живости моделей.
 *
 * Основной путь проверки в плагине dsh-model-stats — ctx.llm. Этот модуль нужен
 * как фолбэк: для провайдеров/моделей, у которых нет живого адаптера в ctx.llm
 * (dormant routes) либо когда адаптер не умеет отдать результат.
 *
 * Модуль только читает конфиг и делает один короткий chat/completions-запрос.
 * Ничего не пишет на диск, ключи не логирует и не возвращает наружу.
 * Ни один публичный метод не бросает исключение: сбой конфига/парсера/сети
 * всегда превращается в пустой каталог, false или {ok:false}.
 */
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Бюджет пробы, когда сама маршрутка не объявила своего.
 *
 * Маршрутка — это не абстракция: у неё есть собственное терпение, и харнесс
 * им и ограничивается. Профиль может задать `timeoutMs` (весь запрос) или
 * `streamIdleTimeoutMs` (пауза между чанками), а по умолчанию харнесс ждёт
 * пять минут тишины, прежде чем считать поток потерянным. Проба — настоящий
 * запрос, поэтому выдуманный плагином дедлайн короче этого объявляет живую,
 * но медленную маршрутку мёртвой: свободный тариф NVIDIA отвечает за 20-200 с.
 */
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const BODY_LIMIT = 300
/** Наибольшая задержка, которую Node ставит, не зажимая её до миллисекунды. */
const MAX_TIMER_DELAY_MS = 2147483647

// Провайдеры, которым baseURL не пишут в конфиге, но он общеизвестен.
const DEFAULT_BASE_URLS = {
  'deepseek-official': 'https://api.deepseek.com',
  openrouter: 'https://openrouter.ai/api/v1',
}

// API-формы, у которых тело запроса совпадает с OpenAI chat/completions.
const OPENAI_LIKE_APIS = new Set([
  '',
  'openai',
  'openai-completions',
  'openai-chat',
  'openai-chat-completions',
  'deepseek',
  'deepseek-chat',
])

/**
 * Терпение, которое профиль объявил для этой маршрутки, в его собственном
 * словаре: `timeoutMs` — весь запрос, `streamIdleTimeoutMs` — пауза между
 * чанками. Первое определённое значение побеждает, как и у харнесса.
 * null — маршрутка не объявила ничего, и решает вызывающий.
 *
 * Значение зажимается сверху: и `setTimeout`, и `AbortSignal.timeout` за
 * пределом 2^31-1 мс перестают означать то, что написано (первый срабатывает
 * сразу, второй бросает RangeError), а это уже не терпение, а его отсутствие.
 */
function declaredTimeoutMs(cfg) {
  if (!cfg || typeof cfg !== 'object') return null
  for (const field of ['timeoutMs', 'streamIdleTimeoutMs']) {
    const value = cfg[field]
    if (Number.isFinite(value) && value > 0) return Math.min(value, MAX_TIMER_DELAY_MS)
  }
  return null
}

/**
 * Фабрика HTTP-пробника живости.
 *
 * @param {object} [options]
 * @param {string} [options.dshHome] каталог DSH_HOME (по умолчанию env DSH_HOME или ~/.dsh)
 * @param {string} [options.profile] имя профиля (по умолчанию 'web')
 * @returns {{
 *   catalog: () => Promise<Array<{provider: string, model: string, baseURL: string|undefined, api: string}>>,
 *   has: (provider: string) => boolean,
 *   timeoutFor: (provider: string) => number|null,
 *   probe: (input: {provider: string, model?: string, timeoutMs?: number}) => Promise<{ok: boolean, status?: number, error?: string, code?: string, latencyMs: number}>
 * }}
 */
export function createHttpProbe(options = {}) {
  const dshHome = String(options.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
  const profile = String(options.profile ?? 'web')

  // Конфиг читается один раз на фабрику и живёт в памяти (не перечитываем файлы
  // на каждый probe). Ошибки кэшируются как пустой конфиг.
  let configPromise
  let resolvedConfig = null
  let yamlAsyncPromise
  let yamlSyncReady = false
  let yamlSyncLoader = null

  // --- YAML -----------------------------------------------------------------

  /** Приводим любой вариант namespace (ESM/CJS/двойной default) к {load}. */
  function pickLoader(mod) {
    const load = mod?.load ?? mod?.default?.load ?? mod?.default?.default?.load
    return typeof load === 'function' ? { load } : null
  }

  /**
   * js-yaml подключается ДИНАМИЧЕСКИ: сначала обычный import('js-yaml')
   * (сработает, если зависимость резолвится от плагина), затем абсолютный путь
   * в node_modules профиля через pathToFileURL. Оба варианта в try/catch:
   * если парсер недоступен, возвращаем null и работаем в режиме «пусто/false».
   */
  function loadYamlAsync() {
    if (!yamlAsyncPromise) {
      yamlAsyncPromise = (async () => {
        try {
          const loader = pickLoader(await import('js-yaml'))
          if (loader) return loader
        } catch {}
        try {
          const fallback = join(dshHome, 'profiles', profile, 'node_modules', 'js-yaml', 'index.js')
          const loader = pickLoader(await import(pathToFileURL(fallback).href))
          if (loader) return loader
        } catch {}
        return null
      })()
    }
    return yamlAsyncPromise
  }

  /**
   * Синхронный доступ к тому же js-yaml (для has(), который обязан ответить
   * boolean немедленно, без await). Пакет — CJS, поэтому createRequire надёжен;
   * если и он недоступен — честно возвращаем null.
   */
  function loadYamlSync() {
    if (!yamlSyncReady) {
      yamlSyncReady = true
      try {
        const require = createRequire(import.meta.url)
        let mod
        try {
          mod = require('js-yaml')
        } catch {
          mod = require(join(dshHome, 'profiles', profile, 'node_modules', 'js-yaml', 'index.js'))
        }
        yamlSyncLoader = pickLoader(mod)
      } catch {
        yamlSyncLoader = null
      }
    }
    return yamlSyncLoader
  }

  /** Разбор текста; undefined вместо исключения на любой сбой. */
  function parseYaml(loader, text) {
    try {
      if (typeof text !== 'string' || !text.trim()) return undefined
      const doc = loader.load(text)
      return doc === null ? undefined : doc
    } catch {
      return undefined
    }
  }

  async function readYaml(loader, file) {
    try {
      return parseYaml(loader, await readFile(file, 'utf8'))
    } catch {
      return undefined
    }
  }

  function readYamlSync(loader, file) {
    try {
      return parseYaml(loader, readFileSync(file, 'utf8'))
    } catch {
      return undefined
    }
  }

  // --- источники конфига (порядок = приоритет) -------------------------------

  const SOURCES = [
    { kind: 'settings', file: join(dshHome, 'settings.yaml') },
    { kind: 'settings', file: join(dshHome, 'settings.yaml.imported') },
    { kind: 'patch', file: join(dshHome, 'profiles', profile, 'cordis.patch.yml') },
  ]
  const CREDENTIALS_FILE = join(dshHome, '.credentials.yaml')

  function newConfig(yamlAvailable) {
    return { providers: new Map(), refs: Object.create(null), yamlAvailable }
  }

  function emptyConfig() {
    return newConfig(false)
  }

  /** Один документ -> провайдеры в общий конфиг. */
  function applyDocument(config, kind, doc) {
    if (doc === undefined) return
    const found = kind === 'patch' ? providersFromPatch(doc) : providersFromSettings(doc)
    mergeProviders(config.providers, found)
  }

  /** refs из .credentials.yaml — вторая половина пары «process.env + refs». */
  function applyCredentials(config, doc) {
    if (!doc || typeof doc !== 'object' || typeof doc.refs !== 'object' || !doc.refs) return
    for (const [name, value] of Object.entries(doc.refs)) {
      if (typeof value === 'string' && value.trim()) config.refs[name] = value.trim()
    }
  }

  function getConfig() {
    if (configPromise) return configPromise
    const sync = loadConfigSync()
    if (sync) {
      resolvedConfig = sync
      configPromise = Promise.resolve(sync)
      return configPromise
    }
    // Синхронный путь недоступен (js-yaml нет в CJS-виде) — читаем асинхронно.
    configPromise = loadConfigAsync()
      .then((config) => {
        resolvedConfig = config
        return config
      })
      .catch(() => {
        resolvedConfig = emptyConfig()
        return resolvedConfig
      })
    return configPromise
  }

  async function loadConfigAsync() {
    const loader = await loadYamlAsync()
    if (!loader) return emptyConfig()
    const config = newConfig(true)
    for (const source of SOURCES) applyDocument(config, source.kind, await readYaml(loader, source.file))
    applyCredentials(config, await readYaml(loader, CREDENTIALS_FILE))
    return config
  }

  /** null, если синхронный YAML-парсер недоступен. */
  function loadConfigSync() {
    const loader = loadYamlSync()
    if (!loader) return null
    const config = newConfig(true)
    for (const source of SOURCES) applyDocument(config, source.kind, readYamlSync(loader, source.file))
    applyCredentials(config, readYamlSync(loader, CREDENTIALS_FILE))
    return config
  }

  // --- разбор структур -------------------------------------------------------

  /**
   * Модели бывают списком строк, списком объектов {id} или словарём id -> описание.
   * Возвращаем только идентификаторы, всё остальное игнорируем.
   */
  function extractModelIds(models) {
    const ids = []
    const push = (value) => {
      if (typeof value === 'string' && value.trim()) ids.push(value.trim())
    }
    if (Array.isArray(models)) {
      for (const item of models) {
        if (typeof item === 'string') push(item)
        else if (item && typeof item === 'object') push(item.id ?? item.model ?? item.name)
      }
    } else if (models && typeof models === 'object') {
      for (const [key, value] of Object.entries(models)) {
        if (value && typeof value === 'object') push(value.id ?? key)
        else push(key)
      }
    }
    return [...new Set(ids)]
  }

  /** Нормализация записи провайдера; null — запись непригодна. */
  function normalizeProvider(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    if (raw.enabled === false || raw.disabled === true) return null
    const out = { models: extractModelIds(raw.models) }
    const baseURL = typeof raw.baseURL === 'string' ? raw.baseURL : raw.baseUrl
    if (typeof baseURL === 'string' && baseURL.trim()) out.baseURL = baseURL.trim().replace(/\/+$/, '')
    if (typeof raw.api === 'string' && raw.api.trim()) out.api = raw.api.trim()
    if (typeof raw.apiKeyEnv === 'string' && raw.apiKeyEnv.trim()) out.apiKeyEnv = raw.apiKeyEnv.trim()
    // Инлайновый ключ допускаем к использованию, но наружу он не отдаётся никогда.
    if (typeof raw.apiKey === 'string' && raw.apiKey.trim()) out.apiKey = raw.apiKey.trim()
    // Терпение маршрутки читаем здесь же: оно нужно и HTTP-пробнику, и слою
    // живости, чтобы проба не оказалась строже настоящего запроса.
    for (const field of ['timeoutMs', 'streamIdleTimeoutMs']) {
      const value = Number(raw[field])
      if (Number.isFinite(value) && value > 0) out[field] = value
    }
    return out
  }

  function addProvider(map, name, raw) {
    if (typeof name !== 'string' || !name.trim()) return
    const cfg = normalizeProvider(raw)
    if (!cfg) return
    const key = name.trim()
    const existing = map.get(key)
    if (!existing) {
      map.set(key, cfg)
      return
    }
    // Приоритет: первое *определённое* значение поля. Модели объединяем.
    for (const field of ['baseURL', 'api', 'apiKeyEnv', 'apiKey', 'timeoutMs', 'streamIdleTimeoutMs']) {
      if (existing[field] === undefined && cfg[field] !== undefined) existing[field] = cfg[field]
    }
    existing.models = [...new Set([...existing.models, ...cfg.models])]
  }

  function mergeProviders(target, source) {
    for (const [name, cfg] of source) addProvider(target, name, cfg)
  }

  /** Одиночный LLM-модуль вида llm-deepseek: {apiKeyEnv, baseURL, models}. */
  function addSingleLlmModule(map, moduleId, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    if (value.providers && typeof value.providers === 'object') return
    const cfg = value.config && typeof value.config === 'object' ? value.config : value
    if (!cfg || typeof cfg !== 'object') return
    const provider =
      (typeof value.provider === 'string' && value.provider) ||
      (typeof cfg.provider === 'string' && cfg.provider) ||
      (moduleId === 'llm-deepseek' ? 'deepseek-official' : moduleId.replace(/^llm-/, ''))
    addProvider(map, provider, cfg)
  }

  /** settings.yaml / settings.yaml.imported: провайдеры в <llm-module>.providers. */
  function providersFromSettings(doc) {
    const out = new Map()
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return out
    for (const [moduleId, value] of Object.entries(doc)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const providers = value.providers ?? value.config?.providers
      if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
        for (const [name, cfg] of Object.entries(providers)) addProvider(out, name, cfg)
        continue
      }
      if (moduleId.startsWith('llm-')) addSingleLlmModule(out, moduleId, value)
    }
    return out
  }

  /** cordis.patch.yml: массив записей {id, name, config: {providers: {...}}}. */
  function providersFromPatch(doc) {
    const out = new Map()
    const visitRecord = (record) => {
      if (!record || typeof record !== 'object' || Array.isArray(record)) return
      const id = typeof record.id === 'string' ? record.id : undefined
      const providers = record.config?.providers ?? record.providers
      if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
        for (const [name, cfg] of Object.entries(providers)) addProvider(out, name, cfg)
        return
      }
      if (id && id.startsWith('llm-')) addSingleLlmModule(out, id, record)
    }
    if (Array.isArray(doc)) {
      for (const record of doc) visitRecord(record)
    } else if (doc && typeof doc === 'object') {
      // Нестандартный patch-слой: пробуем обе известные формы, не падая.
      mergeProviders(out, providersFromSettings(doc))
      for (const value of Object.values(doc)) {
        if (Array.isArray(value)) for (const record of value) visitRecord(record)
      }
    }
    return out
  }

  // --- ключи и адреса --------------------------------------------------------

  function isLocalBaseURL(baseURL) {
    try {
      const host = new URL(baseURL).hostname.toLowerCase()
      return (
        host === 'localhost' ||
        host === '::1' ||
        host === '0.0.0.0' ||
        host.endsWith('.localhost') ||
        host.startsWith('127.') ||
        host.startsWith('192.168.') ||
        host.startsWith('10.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host)
      )
    } catch {
      return false
    }
  }

  function resolveBaseURL(provider, cfg) {
    return cfg.baseURL || DEFAULT_BASE_URLS[provider]
  }

  /**
   * Ключ ищем в process.env, затем в refs из .credentials.yaml.
   * Значение ключа не попадает ни в один возвращаемый объект и ни в один лог.
   */
  function resolveKey(provider, cfg, refs) {
    if (cfg.apiKey) return cfg.apiKey
    const candidates = []
    if (cfg.apiKeyEnv) candidates.push(cfg.apiKeyEnv)
    candidates.push(`${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`)
    for (const name of candidates) {
      const fromEnv = process.env[name]
      if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim()
      const fromRefs = refs[name]
      if (typeof fromRefs === 'string' && fromRefs.trim()) return fromRefs.trim()
    }
    return null
  }

  // --- публичный API ---------------------------------------------------------

  /**
   * Все пары provider/model из конфига. baseURL — итоговый (с учётом дефолтов).
   * Провайдер без объявленных моделей пар не даёт: он остаётся виден через has().
   */
  async function catalog() {
    try {
      const config = await getConfig()
      const out = []
      for (const [provider, cfg] of config.providers) {
        const baseURL = resolveBaseURL(provider, cfg)
        const api = cfg.api ?? 'openai-completions'
        for (const model of cfg.models) out.push({ provider, model, baseURL, api })
      }
      return out
    } catch {
      return []
    }
  }

  /** Знает ли пробник провайдера и есть ли у него адрес. Никогда не бросает. */
  function has(provider) {
    try {
      if (typeof provider !== 'string' || !provider.trim()) return false
      if (!resolvedConfig) {
        const sync = loadConfigSync()
        if (sync) {
          resolvedConfig = sync
          if (!configPromise) configPromise = Promise.resolve(sync)
        }
      }
      if (!resolvedConfig) {
        // Остался только асинхронный путь: отвечаем false сейчас,
        // но гарантируем, что дальнейшие вызовы увидят каталог.
        void getConfig()
        return false
      }
      const name = provider.trim()
      const cfg = resolvedConfig.providers.get(name)
      return Boolean(cfg && resolveBaseURL(name, cfg))
    } catch {
      return false
    }
  }

  function shortText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, BODY_LIMIT)
  }

  /**
   * Сколько эта маршрутка сама себе разрешает, из той же конфигурации, которую
   * читает харнесс. null — не объявила ничего (тогда решает вызывающий).
   *
   * Синхронно и молча: решение о бюджете не должно стоить пробы и не имеет
   * права бросать — недоступный YAML означает «ничего не объявлено», а не
   * сорванную проверку.
   */
  function timeoutFor(provider) {
    try {
      if (typeof provider !== 'string' || !provider.trim()) return null
      if (!resolvedConfig) {
        const sync = loadConfigSync()
        if (sync) {
          resolvedConfig = sync
          if (!configPromise) configPromise = Promise.resolve(sync)
        }
      }
      if (!resolvedConfig) {
        // Остался только асинхронный путь: отвечаем null сейчас, но
        // гарантируем, что дальнейшие вызовы увидят каталог.
        void getConfig()
        return null
      }
      return declaredTimeoutMs(resolvedConfig.providers.get(provider.trim()))
    } catch {
      return null
    }
  }

  /** Короткое человекочитаемое сообщение об ошибке из тела ответа. */
  function errorMessageFrom(parsed, rawText) {
    const candidate = parsed?.error?.message ?? parsed?.error ?? parsed?.message
    if (typeof candidate === 'string' && candidate.trim()) return shortText(candidate)
    if (candidate && typeof candidate === 'object') return shortText(JSON.stringify(candidate))
    return shortText(rawText) || 'пустое тело ответа'
  }

  /**
   * Одна проверка: POST <baseURL>/chat/completions.
   * Возвращает {ok, status?, error?, code?, latencyMs} и никогда не бросает.
   */
  async function probe(input, maybeModel) {
    const started = Date.now()
    const fail = (code, error, status) => {
      const result = { ok: false, code, error, latencyMs: Date.now() - started }
      if (typeof status === 'number') result.status = status
      return result
    }
    try {
      // Терпим и объектную форму (основную), и probe('provider', 'model').
      const params = typeof input === 'string' ? { provider: input, model: maybeModel } : (input ?? {})
      const provider = typeof params.provider === 'string' ? params.provider.trim() : ''
      const model = typeof params.model === 'string' ? params.model.trim() : ''
      const requested =
        Number.isFinite(params.timeoutMs) && params.timeoutMs > 0 ? params.timeoutMs : null
      if (!provider) return fail('BAD_REQUEST', 'provider обязателен')
      if (!model) return fail('BAD_REQUEST', 'model обязателен')

      const config = await getConfig()
      resolvedConfig = config
      const cfg = config.providers.get(provider)
      if (!cfg) {
        return fail(
          config.yamlAvailable ? 'UNKNOWN_PROVIDER' : 'NO_YAML',
          config.yamlAvailable ? `провайдер ${provider} не найден в конфиге` : 'YAML-парсер недоступен',
        )
      }
      // Явный бюджет вызывающего побеждает; иначе маршрутка говорит за себя
      // своим `timeoutMs`/`streamIdleTimeoutMs`, и только молчащая получает
      // терпение харнесса по умолчанию.
      const timeoutMs = requested ?? declaredTimeoutMs(cfg) ?? DEFAULT_TIMEOUT_MS
      const baseURL = resolveBaseURL(provider, cfg)
      if (!baseURL) return fail('NO_BASE_URL', `у провайдера ${provider} нет baseURL`)

      const api = (cfg.api ?? 'openai-completions').toLowerCase()
      if (!OPENAI_LIKE_APIS.has(api)) {
        // anthropic/gemini и подобные требуют другого транспорта — не врём успехом.
        return fail('UNSUPPORTED_API', `api ${cfg.api} не поддерживается HTTP-пробником`)
      }

      const key = resolveKey(provider, cfg, config.refs)
      const local = isLocalBaseURL(baseURL)
      if (!key && !local) return fail('NO_KEY', `нет ключа для провайдера ${provider}`)

      const headers = {
        'content-type': 'application/json',
        // Локальным серверам (lmstudio, llama.cpp и пр.) обычно нужен любой заголовок.
        authorization: `Bearer ${key ?? 'none'}`,
      }

      const url = `${baseURL.replace(/\/+$/, '')}/chat/completions`
      let response
      try {
        response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 16,
            stream: false,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
          return fail('TIMEOUT', `таймаут ${timeoutMs} мс`)
        }
        return fail('NETWORK', shortText(error?.message ?? error) || 'сетевая ошибка')
      }

      const status = response.status
      let rawText = ''
      try {
        rawText = await response.text()
      } catch {
        rawText = ''
      }

      let parsed = null
      let parseFailed = false
      try {
        parsed = rawText.trim() ? JSON.parse(rawText) : null
        if (parsed === null) parseFailed = true
      } catch {
        parseFailed = true
      }

      // Не-2xx: код HTTP наружу + короткая причина из тела.
      if (!response.ok) {
        return fail(`HTTP_${status}`, errorMessageFrom(parsed, rawText), status)
      }
      // 2xx: тело обязано быть валидным JSON без error и с массивом choices.
      if (parseFailed) {
        return fail('BAD_BODY', `ответ не JSON: ${shortText(rawText) || 'пусто'}`, status)
      }
      if (typeof parsed === 'object' && parsed && parsed.error) {
        return fail('API_ERROR', errorMessageFrom(parsed, rawText), status)
      }
      if (!Array.isArray(parsed?.choices)) {
        return fail('NO_CHOICES', `в ответе нет choices: ${shortText(rawText)}`, status)
      }
      return { ok: true, status, latencyMs: Date.now() - started }
    } catch (error) {
      return fail('INTERNAL', shortText(error?.message ?? error) || 'внутренняя ошибка')
    }
  }

  return { catalog, has, probe, timeoutFor }
}

/*
 * Пример вызова:
 *
 *   import { createHttpProbe } from './liveness-http.js'
 *
 *   const http = createHttpProbe({ profile: 'web' })   // dshHome: env DSH_HOME || ~/.dsh
 *   http.has('openrouter')                             // true|false — синхронно, без await
 *   http.timeoutFor('openrouter')                      // объявленное терпение маршрутки или null
 *   const rows = await http.catalog()                  // [{provider, model, baseURL, api}, ...]
 *   const r = await http.probe({ provider: 'openrouter', model: 'z-ai/glm-5.3-flash' })
 *   // r -> { ok: true,  status: 200, latencyMs: 812 }
 *   // r -> { ok: false, status: 401, code: 'HTTP_401', error: 'Invalid API key', latencyMs: 233 }
 *   // Бюджет: timeoutMs вызывающего > объявленный маршруткой > DEFAULT_TIMEOUT_MS.
 *   // Переопределяется: probe({ provider, model, timeoutMs: 3000 })
 */
