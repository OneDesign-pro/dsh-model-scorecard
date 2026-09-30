import { foldSession, aggregate, SPEED_QUALIFICATION } from '../lib/fold.js'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
const SESSIONS = join(homedir(), '.dsh', 'sessions')
const samples = []
for (const dir of readdirSync(SESSIONS)) {
  let entries=[]; try { entries=readdirSync(join(SESSIONS,dir)) } catch { continue }
  for (const e of entries) {
    if (!e.startsWith('session-')) continue
    let raw=null
    try { raw=execFileSync('zstd',['-d','-c',join(SESSIONS,dir,e,'session.v4.jsonl.zstd')],{maxBuffer:1<<30,stdio:['ignore','pipe','ignore']}).toString('utf8') } catch { continue }
    const events=[]; for (const l of raw.split('\n')){const t=l.trim(); if(!t) continue; try{events.push(JSON.parse(t))}catch{}}
    samples.push(...foldSession(events,{sessionId:e}).samples)
  }
}
const byModel = new Map()
for (const s of samples) {
  const k = `${s.provider}/${s.model}`
  const b = byModel.get(k) ?? { k, decodeMs:0, decodeTok:0, spanMs:0, spanTok:0, n:0 }
  if (s.ttftMs!==null && s.outputTokens!==null) { b.decodeMs += s.decodeMs; b.decodeTok += s.outputTokens }
  if (s.streamMs && s.streamTokens && s.streamFragments
      && s.streamMs >= SPEED_QUALIFICATION.minSpanMs
      && s.streamTokens >= SPEED_QUALIFICATION.minTokens
      && s.streamFragments >= SPEED_QUALIFICATION.minFragments) { b.spanMs += s.streamMs; b.spanTok += s.streamTokens; b.n++ }
  byModel.set(k,b)
}
console.log('model'.padEnd(44), 'decode tok/s', 'span tok/s', 'inflation')
const rows=[...byModel.values()].filter(b=>b.spanMs>0 && b.decodeMs>0).sort((a,b)=>(b.decodeTok/(b.decodeMs/1000))/(b.spanTok/(b.spanMs/1000))-(a.decodeTok/(a.decodeMs/1000))/(a.spanTok/(a.spanMs/1000)))
for (const b of rows) {
  const d=b.decodeTok/(b.decodeMs/1000), s=b.spanTok/(b.spanMs/1000)
  console.log(b.k.padEnd(44), d.toFixed(1).padStart(12), s.toFixed(1).padStart(10), (d/s).toFixed(1).padStart(9)+'x')
}
