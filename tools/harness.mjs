// End-to-end harness: drive the plugin's real apply()/execute() with a mock ctx
// backed by the actual on-disk session logs.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

const SESSIONS = join(homedir(), '.dsh', 'sessions')

function findLogs() {
  const out = []
  for (const dir of readdirSync(SESSIONS)) {
    const wsDir = join(SESSIONS, dir)
    let entries = []
    try { entries = readdirSync(wsDir) } catch { continue }
    for (const entry of entries) {
      if (!entry.startsWith('session-')) continue
      const file = join(wsDir, entry, 'session.v4.jsonl.zstd')
      try {
        const s = statSync(file)
        out.push({ id: entry, file, size: s.size, mtimeMs: s.mtimeMs })
      } catch { /* skip */ }
    }
  }
  return out
}

const logs = findLogs()
let totalEvents = 0
const eventsByFile = new Map()
for (const log of logs) {
  const raw = execFileSync('zstd', ['-d', '-c', log.file], { maxBuffer: 1 << 30 }).toString('utf8')
  const events = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (t === '') continue
    try { events.push(JSON.parse(t)) } catch { /* skip torn line */ }
  }
  eventsByFile.set(log.id, events)
  totalEvents += events.length
}
console.log(`loaded ${logs.length} session logs, ${totalEvents} events`)

let tQuery = 0, tStat = 0
const mockQuery = {
  async listSessions() {
    return logs.map((log) => ({ header: { id: log.id }, live: false, persisted: true }))
  },
  async readSession(id) {
    const t0 = performance.now()
    const events = eventsByFile.get(id) ?? []
    tQuery += performance.now() - t0
    return { session: { id }, inheritedEventCount: 0, events }
  },
}
const mockPersistence = {
  async stat(id) {
    tStat += 1
    const log = logs.find((l) => l.id === id)
    return log ? { header: { id }, revision: `${log.size}:${log.mtimeMs}` } : undefined
  },
}
const registered = []
const routes = new Map()
const mockCtx = {
  get(name) {
    if (name === 'tools') return { register: (def) => { registered.push(def); return () => {} } }
    if (name === 'sessionQuery') return mockQuery
    if (name === 'sessionPersistence') return mockPersistence
    if (name === 'webServer') {
      return { register: (route) => { routes.set(route.path, route); return () => {} } }
    }
    return undefined
  },
  effect(fn) { return fn() },
  logger: { info: () => {}, warn: (...a) => console.log('WARN', ...a) },
}

const plugin = await import('../lib/index.js')
plugin.apply(mockCtx)
console.log('registered tools :', registered.map((d) => d.name))
console.log('registered routes:', [...routes.keys()])

// --- exercise the panel route through a fake req/res -----------------------------
async function callRoute(path) {
  const route = routes.get('/api/model-scorecard')
  if (route === undefined) throw new Error('route not registered')
  let body = ''
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(k, v) { this.headers[k] = v },
    end(chunk) { body = chunk },
  }
  await route.handler({ url: path, method: 'GET' }, res)
  return { status: res.statusCode, json: JSON.parse(body) }
}

const tool = registered.find((d) => d.name === 'model_stats')
const t0 = performance.now()
const text = await tool.execute({})
const coldMs = performance.now() - t0
console.log(`\n--- execute() cold: ${coldMs.toFixed(0)} ms ---`)
console.log(text)

const t1 = performance.now()
await tool.execute({})
const warmMs = performance.now() - t1
console.log(`\n--- execute() warm (cache hit): ${warmMs.toFixed(0)} ms ---`)

console.log('\n=== edge cases ===')
console.log('[limit clamp]', (await tool.execute({ limit: 999, sort: 'ttft' })).split('\n')[2])
console.log('[bad sort]', (await tool.execute({ sort: 'nonsense' })).split('\n')[1])
console.log('[sinceMs future]', (await tool.execute({ sinceMs: Date.now() + 1e12 })).slice(0, 90))
console.log('[provider filter miss]', (await tool.execute({ provider: 'nope' })).split('\n').slice(0, 3).join('\n').slice(0, 200))
console.log('[view=provider]')
console.log((await tool.execute({ view: 'provider', limit: 5 })).split('\n').slice(0, 8).join('\n'))

// The filter is the same question through two doors, so it is checked through
// both: a comma-separated string, a JSON array, a repeated query parameter, and
// the two spellings side by side. A route that filtered where the tool does not
// is exactly the drift this panel was built to avoid.
console.log('\n=== фильтр по провайдеру ===')
const all = await tool.execute({ view: 'provider', limit: 50 })
// A row starts with the provider and is followed by its numbers; the note lines
// below the table start with a word and a number too, so a second column is what
// tells a row from a sentence.
const busiest = [...all.matchAll(/^(\S+)\s+(\d+)\s+\d+/gm)].map(([, provider, steps]) => [provider, Number(steps)])
busiest.sort((a, b) => b[1] - a[1])
const [first, second] = busiest.slice(0, 2).map(([provider]) => provider)
console.log(`два самых занятых провайдера: ${first}, ${second}`)

const byList = await tool.execute({ provider: `${first},${second}`, view: 'provider', sort: 'steps' })
const byArray = await tool.execute({ provider: [first, second], view: 'provider', sort: 'steps' })
const byRepeated = await callRoute(
  `/api/model-scorecard?sort=steps&view=provider&provider=${first}&provider=${second}&limit=50`,
)
const byJoined = await callRoute(
  `/api/model-scorecard?sort=steps&view=provider&provider=${encodeURIComponent(`${first},${second}`)}&limit=50`,
)
const listed = [...byList.matchAll(/^(\S+)\s+\d+\s+\d+/gm)].map(([match]) => match)
console.log('[tool, строка] ', listed.join(' | '))
console.log('[tool, массив]', byList === byArray ? 'тот же ответ' : 'ОТЛИЧАЕТСЯ')
console.log('[route, двумя параметрами]', byRepeated.json.rows.map((row) => row.provider).join(' | '))
console.log(
  '[route, одним параметром]',
  byJoined.json.rows.map((row) => row.provider).join(' | ') === byRepeated.json.rows.map((row) => row.provider).join(' | ')
    ? 'тот же ответ'
    : 'ОТЛИЧАЕТСЯ',
)
console.log('[панель предлагает провайдеров]', byRepeated.json.catalog.length, 'из', byRepeated.json.totals.providers)
console.log('[после фильтра]', JSON.stringify(byRepeated.json.shown), '| применён:', byRepeated.json.providers.join('+'))

console.log('\n=== panel route GET /api/model-scorecard ===')
const panel = await callRoute('/api/model-scorecard?sort=ttft&view=model&limit=3')
console.log('status', panel.status, '| ok', panel.json.ok, '| rows', panel.json.rows.length)
console.log('totals', JSON.stringify(panel.json.totals))
for (const row of panel.json.rows) {
  console.log(
    `  ${row.model.padEnd(34)} steps=${String(row.steps).padStart(5)}` +
      ` ttft_med=${row.ttftMedian?.toFixed(0).padStart(5)}` +
      ` tps_med=${row.tpsMedian?.toFixed(1) ?? '-'}` +
      ` conf=${row.speedConfidence === null ? '-' : Math.round(row.speedConfidence * 100) + '%'}`,
  )
}
const bad = await callRoute('/api/model-scorecard?sort=bogus&limit=9999')
console.log('fuzz (bad sort, huge limit):', 'status', bad.status, '| sort ->', bad.json.sort, '| rows', bad.json.rows.length)

// The one order the fold cannot read off the session log: the status column's
// verdict is a probe's, so the route reads the probe store and hands the rank in.
console.log('\n=== порядок по статусу ===')
const byStatus = await callRoute('/api/model-scorecard?sort=liveness&dir=desc&view=model&limit=20')
const byStatusAsc = await callRoute('/api/model-scorecard?sort=liveness&dir=asc&view=model&limit=20')
const show = (answer) =>
  answer.json.rows
    .map((row) => `${row.model ?? '(provider)'} ${row.liveness?.state ?? 'unknown'}`)
    .join(' | ')
console.log('status echoed:', byStatus.json.sort, byStatus.json.dir ?? '(null)')
console.log('broken first  :', show(byStatus))
console.log('available first:', show(byStatusAsc))
console.log('tool rows unchanged by the panel-only order:', (await tool.execute({ sort: 'ttft', limit: 3 })).split('\n')[2])

