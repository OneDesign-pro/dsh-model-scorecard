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
  const route = routes.get('/api/model-stats')
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
console.log('[provider filter miss]', (await tool.execute({ provider: 'nope' })).slice(0, 90))
console.log('[view=provider]')
console.log((await tool.execute({ view: 'provider', limit: 5 })).split('\n').slice(0, 8).join('\n'))

console.log('\n=== panel route GET /api/model-stats ===')
const panel = await callRoute('/api/model-stats?sort=ttft&view=model&limit=3')
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
const bad = await callRoute('/api/model-stats?sort=bogus&limit=9999')
console.log('fuzz (bad sort, huge limit):', 'status', bad.status, '| sort ->', bad.json.sort, '| rows', bad.json.rows.length)

