// Render the real report through the same collector the tool and the panel use,
// so the text output and the panel payload are checked against one corpus
// rather than against a fixture.
//
// Usage: node tools/render-report.mjs [corpus-dir]

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { foldSession } from '../lib/fold.js'
import { aggregate } from '../lib/fold.js'
import { renderReportText, toPanelPayload } from '../lib/collect.js'

const CORPUS = process.argv[2] ?? '/tmp/dshcorpus'
const samples = []
const errors = []
const retries = []
let sessions = 0
for (const name of readdirSync(CORPUS).filter((f) => f.endsWith('.jsonl'))) {
  const events = []
  for (const line of readFileSync(join(CORPUS, name), 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      /* torn tail */
    }
  }
  const folded = foldSession(events, { sessionId: name.replace(/\.jsonl$/, '') })
  samples.push(...folded.samples)
  errors.push(...folded.errors)
  retries.push(...folded.retries)
  sessions += 1
}

// Passed through whole: the aggregate reads `code` and `name` off an error to
// classify it, so a record rebuilt here with only the names would come out
// classified as `other`.
const attributed = errors.map((error) => ({
  ...error,
  provider: error.provider ?? 'unknown',
  model: error.model ?? 'unknown',
}))

const result = {
  report: aggregate(samples, { sort: 'ttft', errors: attributed, retries }),
  scanned: sessions,
  skipped: 0,
  pending: 0,
  complete: true,
  provenance: { snapshotAt: null, readNow: sessions, reused: 0, pruned: 0 },
}

console.log(renderReportText(result, { sort: 'ttft', limit: 12 }))
console.log('')
console.log('--- panel payload (first 2 rows) ---')
const payload = toPanelPayload(result, { sort: 'retry', dir: 'desc', limit: 2 })
console.log(JSON.stringify({ totals: payload.totals, shown: payload.shown, sort: payload.sort, rows: payload.rows }, null, 2))
