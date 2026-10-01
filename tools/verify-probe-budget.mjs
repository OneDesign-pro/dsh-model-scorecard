// Checks the budget one probe is given.
//
// The bug this exists to catch: every probe was aborted after a flat 15 s — a
// deadline the host itself does not have. A real request to a slow free tier
// (NVIDIA's answers in 20-200 s) was therefore recorded as a timeout while the
// provider was perfectly reachable. The fix has two halves, and both are
// asserted here: a route's own patience, the `timeoutMs` / `streamIdleTimeoutMs`
// its profile declares, is what its probe is given; and a route that declares
// nothing gets the host's own default rather than a number this plugin made up.
//
// The slow case is a local HTTP server that answers just past the old 15 s
// deadline, so the regression is proven without spending provider traffic. The
// temp DSH_HOME borrows the real profile's `js-yaml`, because the config reader
// resolves the parser the same two ways the plugin does.
//
// Usage: node tools/verify-probe-budget.mjs
//
// Env:
//   DSH_HOME   the real home the js-yaml symlink comes from (default ~/.dsh)

import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { createLiveness, PROBE_TIMEOUT_MS } from '../lib/liveness.js'
import { createHttpProbe, DEFAULT_TIMEOUT_MS } from '../lib/liveness-http.js'

let failures = 0
function check(label, condition, detail) {
  const mark = condition ? 'OK  ' : 'FAIL'
  if (!condition) failures += 1
  console.log(`${mark} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** The flat deadline that used to abort every probe. */
const OLD_DEADLINE_MS = 15000
/** One answer slower than that deadline is the whole regression. */
const SLOW_MS = OLD_DEADLINE_MS + 1000
/** An answer slower than the short deadline one route declares for itself. */
const SLOWISH_MS = 2000
const SHORT_DEADLINE_MS = 400

// --- a provider that answers late, on purpose --------------------------------

const asked = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
  })
  req.on('end', () => {
    let model = ''
    try {
      model = JSON.parse(body)?.model ?? ''
    } catch {
      model = ''
    }
    const delay = model === 'slow' ? SLOW_MS : model === 'slowish' ? SLOWISH_MS : 10
    asked.push({ model, delay })
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'pong' } }] }))
    }, delay)
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

// --- a temp home whose profile declares the three routes ---------------------

const realHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const home = await mkdtemp(join(tmpdir(), 'model-scorecard-probe-budget-'))
const profileDir = join(home, 'profiles', 'web')
await mkdir(join(profileDir, 'node_modules'), { recursive: true })
await symlink(
  join(realHome, 'profiles', 'web', 'node_modules', 'js-yaml'),
  join(profileDir, 'node_modules', 'js-yaml'),
  'dir',
)
await writeFile(
  join(profileDir, 'cordis.patch.yml'),
  [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      patient:',
    `        baseURL: http://127.0.0.1:${port}`,
    '        api: openai-completions',
    '      impatient:',
    `        baseURL: http://127.0.0.1:${port}`,
    '        api: openai-completions',
    `        timeoutMs: ${SHORT_DEADLINE_MS}`,
    '      idler:',
    `        baseURL: http://127.0.0.1:${port}`,
    '        api: openai-completions',
    '        streamIdleTimeoutMs: 60000',
    '',
  ].join('\n'),
  'utf8',
)

process.env.DSH_HOME = home
process.env.DSH_MODEL_SCORE_CARD_CACHE_DIR = join(home, 'cache')

const http = createHttpProbe({ profile: 'web' })

// --- what a route says about itself ------------------------------------------

check(
  'a route that declares no deadline declares none',
  http.timeoutFor('patient') === null,
  String(http.timeoutFor('patient')),
)
check(
  'timeoutMs is read as the route\'s own patience',
  http.timeoutFor('impatient') === SHORT_DEADLINE_MS,
  `${http.timeoutFor('impatient')} ms`,
)
check(
  'streamIdleTimeoutMs is the fallback declaration',
  http.timeoutFor('idler') === 60000,
  `${http.timeoutFor('idler')} ms`,
)
check('an unknown route declares nothing', http.timeoutFor('nobody') === null)
check(
  'the plugin default is the host default, not the old flat deadline',
  PROBE_TIMEOUT_MS === DEFAULT_TIMEOUT_MS && PROBE_TIMEOUT_MS > OLD_DEADLINE_MS,
  `${PROBE_TIMEOUT_MS} ms`,
)

// --- what the plugin does with it --------------------------------------------

// No `llm` service: every probe here takes the HTTP transport, which is the
// same budget logic on the second path.
const liveness = createLiveness({ get: () => undefined }, { persist: false })

async function timedProbe(provider, model, timeoutMs) {
  const started = Date.now()
  const result = await liveness.probe(provider, model, timeoutMs)
  const elapsed = Date.now() - started
  console.log(
    `     probe ${provider}/${model}${timeoutMs === undefined ? '' : ` (asked ${timeoutMs} ms)`} in ${elapsed} ms: ${result.status} ${result.code ?? ''}`,
  )
  return { result, elapsed }
}

const slow = await timedProbe('patient', 'slow')
check(
  'an answer slower than the old 15 s deadline is an answer, not a timeout',
  slow.result.status === 'ok',
  `${slow.result.status} ${slow.result.code ?? ''} ${slow.result.error ?? ''}`.trim(),
)
check(
  'that answer really did outlive the old deadline',
  slow.elapsed >= SLOW_MS,
  `${slow.elapsed} ms`,
)
check('the slow answer came from the HTTP transport', slow.result.source === 'http', slow.result.source)

const impatient = await timedProbe('impatient', 'slowish')
check(
  'a route that declares a short deadline is probed with exactly that',
  impatient.result.status === 'fail' &&
    impatient.result.code === 'TIMEOUT' &&
    String(impatient.result.error ?? '').includes(String(SHORT_DEADLINE_MS)),
  `${impatient.result.code} ${impatient.result.error ?? ''}`.trim(),
)
check(
  'and the declared deadline is what ended it, not the plugin default',
  impatient.elapsed < SLOWISH_MS,
  `${impatient.elapsed} ms`,
)

const asked300 = await timedProbe('patient', 'slowish', 300)
check(
  'a caller\'s own timeoutMs still wins',
  asked300.result.code === 'TIMEOUT' && asked300.elapsed < 1000,
  `${asked300.result.code ?? asked300.result.status} in ${asked300.elapsed} ms`,
)

check('the server was asked, so none of the above was a local short-circuit', asked.length > 0, `${asked.length} request(s)`)

server.close()
await rm(home, { recursive: true, force: true })

console.log(`\n${failures === 0 ? 'ALL OK' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
