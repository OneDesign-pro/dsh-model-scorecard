// Drives the liveness layer against the real LLM stack.
//
// The bug this exists to catch is the one that shipped: the liveness code read
// `ctx.llm` while the plugin never declared `llm` among the services it injects,
// so every probe failed in zero milliseconds with
// `cannot get property "llm" without inject`. A test that stubs `ctx.get` cannot
// see that class of failure at all — it hands the plugin the service the real
// host refuses. So this harness mounts the actual `LlmRuntime`, the actual
// credential store and the actual provider adapter, and lets the plugin reach
// them exactly the way the host wires them.
//
// It is a live test: it spends one short probe request per probed model. It probes
// until one model answers, then stops, so the cost is one request in the normal
// case and a handful when a provider is down.
//
// Usage: node tools/verify-liveness.mjs [--probe <provider>/<model>]
//
// Env:
//   DSH_HOME              default ~/.dsh
//   LIVENESS_PROFILE      profile whose patch declares the providers (default web)

import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { mkdtemp, readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createLiveness } from '../lib/liveness.js'

const DSH = '/Users/jeka/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const PROFILE = process.env.LIVENESS_PROFILE || 'web'

let failures = 0
function check(label, condition, detail) {
  const mark = condition ? 'OK  ' : 'FAIL'
  if (!condition) failures += 1
  console.log(`${mark} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

// --- the real host stack -----------------------------------------------------

const { Context } = await import(`${DSH}/cordis/lib/index.js`)
const { default: LlmRuntime } = await import(`${DSH}/dsh-llm/lib/index.js`)
const { default: LocalCredentialProvider } = await import(`${DSH}/dsh-credentials-local/lib/index.js`)
// The provider adapter is a plugin object (`{ name, inject, apply, Config }`)
// rather than a class, so the namespace is what gets mounted.
const piAiModule = await import(`${DSH}/dsh-llm-pi-ai/lib/index.js`)

// The provider configuration is the profile's own, read from the same patch the
// host composes. A hand-written provider list here would test a different
// install than the one the user runs.
const yamlModule = await import(
  `${DSH_HOME}/profiles/${PROFILE}/node_modules/js-yaml/index.js`
).catch(() => null)
const yaml = yamlModule?.default ?? yamlModule
if (yaml === null || typeof yaml?.load !== 'function') {
  console.log('SKIP: js-yaml is unavailable, cannot read the profile patch')
  process.exit(0)
}
const patch = yaml.load(await readFile(join(DSH_HOME, 'profiles', PROFILE, 'cordis.patch.yml'), 'utf8'))
const llmEntry = (Array.isArray(patch) ? patch : []).find((entry) => entry?.id === 'llm-pi-ai')
const providers = llmEntry?.config?.providers ?? {}
check('profile patch declares providers', Object.keys(providers).length > 0, Object.keys(providers).join(', '))

const ctx = new Context()
ctx.plugin(LlmRuntime)
ctx.plugin(LocalCredentialProvider, {
  path: join(DSH_HOME, '.credentials.yaml'),
  dshHome: DSH_HOME,
  watch: false,
})
// A namespace object is frozen and carries a module tag, so the plugin is
// rebuilt as a plain object Cordis can own.
const piAi = {
  name: piAiModule.name,
  inject: piAiModule.inject,
  Config: piAiModule.Config,
  apply: piAiModule.apply,
}

ctx.plugin(piAi, { providers })
await new Promise((resolve) => setTimeout(resolve, 400))

const llm = ctx.get('llm')
check('LlmRuntime mounted', llm !== undefined)
const live = llm.listProviders()
console.log(`     live routes: ${live.map((entry) => entry.id ?? entry).join(', ')}`)

// --- the plugin, wired the way the host wires it ------------------------------

// The plugin reads the cache directory from the environment, so the real store
// is untouched by a test run.
const cacheDir = await mkdtemp(join(tmpdir(), 'model-stats-liveness-'))
process.env.DSH_MODEL_STATS_CACHE_DIR = cacheDir

const registered = []
const routes = new Map()
const pluginCtx = {
  get(name) {
    if (name === 'tools') return { register: (def) => { registered.push(def); return () => {} } }
    if (name === 'webServer') return { register: (route) => { routes.set(route.path, route); return () => {} } }
    if (name === 'sessionQuery') return { async listSessions() { return [] }, async readSession() { return { session: { id: 'x' }, events: [] } } }
    // Everything else is the real service, reached the way the host exposes it.
    return ctx.get(name)
  },
  effect(fn) { return fn() },
  logger: { info: () => {}, warn: (...args) => console.log('     warn:', ...args) },
}

const plugin = await import('../lib/index.js')

// The regression, stated as a contract: a service the code reads must be a
// service the plugin declares. This one line is what the whole file is for.
check('plugin declares the llm service', plugin.inject.includes('llm'), plugin.inject.join(', '))
check('plugin declares its other services', ['tools', 'webServer', 'sessionQuery'].every((s) => plugin.inject.includes(s)))

plugin.apply(pluginCtx)
await new Promise((resolve) => setTimeout(resolve, 150))

check('model_liveness tool registered', registered.some((def) => def.name === 'model_liveness'))
check('liveness routes registered', routes.has('/api/model-stats/liveness') && routes.has('/api/model-stats/liveness/check'))

// --- a real probe ------------------------------------------------------------

const tool = registered.find((def) => def.name === 'model_liveness')
const explicit = (() => {
  const index = process.argv.indexOf('--probe')
  return index === -1 ? null : process.argv[index + 1]
})()

/**
 * A probe is given the patience its own route declares — minutes, for a slow
 * free tier — while the tool answers as soon as it can rather than holding one
 * call open that long. The tool's call starts the probe; the sweep is then
 * followed over the panel's own GET route, because asking the tool again would
 * ask for another probe rather than for the progress of this one. The leash
 * outlives the plugin's own default budget (five minutes), so a route that is
 * genuinely silent is reported as a timeout rather than as an unfinished run.
 */
const PROBE_LEASH_MS = 360000
const POLL_MS = 2000
/** How long the default walk of a few candidates may take in total. */
const WALK_DEADLINE_MS = 600000

/** The panel's GET route, called the way the panel calls it. */
function readLiveness() {
  const route = routes.get('/api/model-stats/liveness')
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      setHeader() {},
      end(body) {
        try {
          resolve(JSON.parse(body))
        } catch (error) {
          reject(error)
        }
      },
    }
    Promise.resolve(route.handler({ method: 'GET' }, res)).catch(reject)
  })
}

function resultOf(snapshot, provider, model) {
  return (snapshot?.results ?? []).find((row) => row.provider === provider && row.model === model) ?? null
}

async function probeOne(provider, model) {
  const started = Date.now()
  // The agent's own path, taken once: it starts the probe and answers with
  // whatever the store holds at that moment.
  const text = await tool.execute({ provider, model })
  let snapshot = await readLiveness()
  let result = resultOf(snapshot, provider, model)
  while (result === null && Date.now() - started < PROBE_LEASH_MS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    snapshot = await readLiveness()
    result = resultOf(snapshot, provider, model)
  }
  const elapsed = Date.now() - started
  if (result !== null) {
    console.log(
      `     [${new Date().toISOString().slice(11, 19)}] ${result.status} ${provider}/${model} in ${result.latencyMs} ms (${result.code ?? ''} ${result.error ?? ''})`.trimEnd(),
    )
  } else {
    console.log(`     [${new Date().toISOString().slice(11, 19)}] ${provider}/${model}: still checking after ${elapsed} ms`)
  }
  return { text, result, elapsed }
}

// A real probe costs one short request, so the harness walks a short candidate
// list and stops at the first model that answers. The list is drawn from the
// profile's own configuration rather than hard-coded: whichever providers this
// install declares are the ones worth asking, and a hard-coded list would test a
// different install than the user runs.
const liveIds = new Set(live.map((entry) => entry.id ?? entry))
const configured = []
for (const [provider, profile] of Object.entries(providers)) {
  if (!liveIds.has(provider)) continue
  for (const model of profile?.models ?? []) {
    if (typeof model?.id === 'string') configured.push(`${provider}/${model.id}`)
  }
}

const candidates = explicit !== null
  ? [explicit]
  : configured.slice(0, 8)

/**
 * Whether the probe answered.
 *
 * Read from the stored result rather than by looking for "OK" anywhere in the
 * report: the summary reads `OK 0/1` when nothing answered, so a substring test
 * reports success for a total failure. That is not a hypothetical — this
 * harness shipped that bug for one run, and it only surfaced because the free
 * model it probed hit a daily rate limit.
 */
function answered(result) {
  return result !== null && result.status === 'ok'
}

let answer = null
if (candidates.length === 0) {
  console.log('SKIP: no live route declares a model, pass --probe <provider>/<model>')
} else {
  // The walk is bounded as a whole: each candidate may now legitimately take
  // minutes, and a harness that can run for half an hour is a harness nobody
  // runs. The explicit `--probe` path is not bounded, because it asks for one
  // named answer rather than a sample.
  const walkStarted = Date.now()
  let walked = 0
  for (const pair of candidates) {
    if (explicit === null && Date.now() - walkStarted > WALK_DEADLINE_MS) {
      console.log(`NOTE: stopping the walk after ${walked} model(s) — the ${WALK_DEADLINE_MS / 60000} min budget for a sample ran out`)
      break
    }
    walked += 1
    const cut = pair.indexOf('/')
    const provider = pair.slice(0, cut)
    const model = pair.slice(cut + 1)
    const { text, result, elapsed } = await probeOne(provider, model)
    console.log(`     probe ${pair} in ${elapsed} ms: ${result === null ? 'unfinished' : `${result.status} ${result.code ?? ''}`}`.trimEnd())
    check(
      `probe of ${pair} does not fail on the service declaration`,
      !/without inject/i.test(text) && !/model_liveness error/i.test(text),
      /model_liveness error/i.test(text) ? text.slice(0, 120) : undefined,
    )
    if (answered(result)) {
      answer = pair
      break
    }
  }
  // A provider being rate-limited or down is a legitimate state of the world, so
  // this is reported rather than asserted: what the harness must prove is that a
  // probe reaches the provider and reports what it found, which every run above
  // already did.
  if (answer === null) {
    console.log(`NOTE: none of the ${walked} probed model(s) answered — each failure came from the provider, not from the wiring`)
  } else {
    check('at least one real model answered', true, answer)
  }
}

// --- a failure that is about the model, not about the wiring -----------------

if (answer !== null) {
  const cut = answer.indexOf('/')
  const provider = answer.slice(0, cut)
  const bogus = `definitely-not-a-model-${Date.now()}`
  const { text, result } = await probeOne(provider, bogus)
  console.log(`     probe ${provider}/${bogus}: ${result === null ? 'unfinished' : `${result.status} ${result.code ?? ''} ${result.error ?? ''}`}`.trimEnd())
  check(
    'a bogus model fails with a provider reason, not a wiring reason',
    result !== null && result.status !== 'ok' && !/without inject/i.test(String(result.error ?? '')),
  )
  check('a bogus model is not reported as answering', result === null || result.status !== 'ok')
}

// --- the stored shape --------------------------------------------------------

// A probe is only written once it finishes, and a route that is given its own
// patience may outlive the leash above; an absent store is that state, not a
// corrupt one, so it is reported rather than thrown.
let stored = null
try {
  stored = JSON.parse(await readFile(join(cacheDir, 'liveness.json'), 'utf8'))
} catch {
  stored = null
}
if (stored === null) {
  console.log('NOTE: no probe finished inside this run, so there is no store to check')
} else {
  check('store is written with the current format', stored.version === 2, `version=${stored.version}`)
  check('store keeps one entry per probed model', Array.isArray(stored.results) && stored.results.length > 0, `${stored.results?.length} entries`)
  check(
    'no stored entry blames the service declaration',
    (stored.results ?? []).every((entry) => !/without inject/i.test(String(entry.error ?? ''))),
  )
}

// --- the catalog a row is graded against -------------------------------------
//
// The archive's trust rule, asserted against the real service rather than a stub:
// `configured()` has to answer with the pairs the harness serves *and* with
// whether the live half answered at all. Grading rows on the configuration files
// alone is the mistake the flag exists to catch — measured on this machine it
// would archive 15932 of 26600 steps, `deepseek-official/deepseek-flash` among
// them, because `dsh-llm-deepseek` serves that model without any provider block
// listing it.
{
  const grader = createLiveness(pluginCtx, { persist: false })
  const catalog = await grader.configured()
  check('каталог прочитан у живого ctx.llm', catalog.live === true, `live=${catalog.live}, пар ${catalog.pairs?.length ?? 0}`)
  const present = new Set((catalog.pairs ?? []).map((pair) => `${pair.provider}\u0000${pair.model}`))
  const missing = []
  for (const entry of live) {
    const provider = entry.id ?? entry
    for (const model of await llm.listModels(provider).catch(() => [])) {
      const id = typeof model === 'string' ? model : (model?.id ?? model?.name)
      if (!present.has(`${provider}\u0000${id}`)) missing.push(`${provider}/${id}`)
    }
  }
  check(
    'каждая живая пара попадает в каталог, а не теряется за конфигом',
    missing.length === 0,
    missing.slice(0, 3).join(', ') || `${present.size} пар`,
  )

  // The union itself, on a service whose list is deliberately not the config's:
  // the profile's own install is the one composition where the two agree, so a
  // check that only read it could pass while the live half was being dropped.
  const union = await createLiveness(
    {
      get: () => ({
        async listProviders() {
          return ['a-provider-only-live']
        },
        async listModels() {
          return ['only-live-model']
        },
      }),
    },
    { persist: false },
  ).configured()
  check(
    'пара, которую знает только живой ctx.llm, тоже в каталоге',
    union.pairs.some((pair) => pair.provider === 'a-provider-only-live' && pair.model === 'only-live-model'),
    JSON.stringify(union.pairs.slice(0, 3)),
  )

  // The two states that must not be read as "the configuration serves nothing":
  // no service at all, and a service that throws on the way to its own list.
  const absent = await createLiveness({ get: () => undefined }, { persist: false }).configured()
  check('без ctx.llm каталог помечен непрочитанным', absent.live === false, JSON.stringify(absent))
  const broken = await createLiveness(
    {
      get: () => ({
        listProviders() {
          throw new Error('adapter is down')
        },
      }),
    },
    { persist: false },
  ).configured()
  check('упавший listProviders — тоже непрочитанный', broken.live === false && broken.pairs.length === 0, JSON.stringify(broken))
}

console.log(`\n${failures === 0 ? 'ALL OK' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
