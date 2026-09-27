// Reproduce the dsh-usage-vendor-stats health formula on the same real history:
//   avgTtftMs      = sum(sessionStats.ttftMs) / sum(ttftSteps)
//   genTokensPerSec= sum(decodeTokens) / (sum(decodeMs)/1000)
import { foldSession } from '../lib/fold.js'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

const SESSIONS = join(homedir(), '.dsh', 'sessions')
let ttftMs = 0, ttftSteps = 0, decodeMs = 0, decodeTokens = 0
let myTtft = 0, mySteps = 0, mySpanTokens = 0, mySpanMs = 0
const providers = new Set()

for (const dir of readdirSync(SESSIONS)) {
  let entries = []
  try { entries = readdirSync(join(SESSIONS, dir)) } catch { continue }
  for (const e of entries) {
    if (!e.startsWith('session-')) continue
    const base = join(SESSIONS, dir, e)
    let raw = null
    try { raw = execFileSync('zstd', ['-d','-c',join(base,'session.v4.jsonl.zstd')], {maxBuffer:1<<30, stdio:['ignore','pipe','ignore']}).toString('utf8') } catch { continue }
    const events = []
    for (const line of raw.split('\n')) { const t=line.trim(); if(!t) continue; try { events.push(JSON.parse(t)) } catch {} }
    const folded = foldSession(events, { sessionId: e })
    for (const s of folded.samples) {
      providers.add(s.provider)
      if (s.ttftMs !== null) { ttftMs += s.ttftMs; ttftSteps++; myTtft += s.ttftMs; mySteps++ }
      if (s.ttftMs !== null && s.outputTokens !== null) { decodeMs += s.decodeMs; decodeTokens += s.outputTokens }
      if (s.streamMs && s.streamTokens && s.streamMs >= 100 && s.streamTokens >= 8) { mySpanMs += s.streamMs; mySpanTokens += s.streamTokens }
    }
  }
}
console.log('SUMMARY over the whole history')
console.log('  providers seen            :', providers.size)
console.log('')
console.log('vendor-stats health formula (one global figure, no per-model view):')
console.log('  avgTtftMs                 :', (ttftMs/ttftSteps).toFixed(0), 'ms  (ttftSteps='+ttftSteps+')')
console.log('  genTokensPerSec           :', (decodeTokens/(decodeMs/1000)).toFixed(1), 'tok/s')
console.log('')
console.log('dsh-model-stats equivalent:')
console.log('  avgTtftMs                 :', (myTtft/mySteps).toFixed(0), 'ms  (steps='+mySteps+')')
console.log('  span-based tok/s          :', (mySpanTokens/(mySpanMs/1000)).toFixed(1), 'tok/s')
console.log('  inflation factor          :', ((decodeTokens/(decodeMs/1000)) / (mySpanTokens/(mySpanMs/1000))).toFixed(1)+'x')
