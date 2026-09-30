// Regression guard for the throughput unit bug.
//
// A delta fragment is a transport chunk, not a token. This folds the real logs
// and prints, per model, both rates over the same steps:
//
//   frag/s - what the collector used to report (chunks per second)
//   tok/s  - what it reports now (provider outputTokens over the streaming span)
//
// A model whose two figures differ is a provider that batches its deltas; the
// gap is exactly that provider's understatement factor. `tok/frag` is the
// batching factor itself, and it is the number to watch: above ~50 a provider
// is likely reporting tokens it never streamed, which would overstate the rate
// in the other direction.
//
//   node tools/verify-tokens-per-fragment.mjs [min-samples]
import { aggregate, foldSession, SPEED_QUALIFICATION } from '../lib/fold.js'
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const SESSIONS = join(homedir(), '.dsh', 'sessions')
const MIN_SAMPLES = Number.parseInt(process.argv[2] ?? '', 10) || 10

const samples = []
for (const dir of readdirSync(SESSIONS)) {
  let entries = []
  try {
    entries = readdirSync(join(SESSIONS, dir))
  } catch {
    continue
  }
  for (const entry of entries) {
    if (!entry.startsWith('session-')) continue
    const file = join(SESSIONS, dir, entry, 'session.v4.jsonl.zstd')
    try {
      statSync(file)
    } catch {
      continue
    }
    let raw = ''
    try {
      raw = execFileSync('zstd', ['-d', '-c', file], { maxBuffer: 1 << 30 }).toString('utf8')
    } catch {
      continue
    }
    const events = []
    for (const line of raw.split('\n')) {
      const text = line.trim()
      if (text === '') continue
      try {
        events.push(JSON.parse(text))
      } catch {
        /* torn line */
      }
    }
    samples.push(...foldSession(events, { sessionId: entry }).samples)
  }
}

const stats = (values) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return {
    median: sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    p90: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))],
    max: sorted[sorted.length - 1],
  }
}

const byModel = new Map()
for (const sample of samples) {
  const key = `${sample.provider}/${sample.model}`
  const bucket = byModel.get(key) ?? { key, frag: [], tok: [], ratio: [] }
  // The same qualification the aggregate applies, so this recomputation is a
  // check on the aggregate rather than a second, laxer measurement.
  if (
    sample.streamMs !== null &&
    sample.streamTokens !== null &&
    sample.streamFragments !== null &&
    sample.streamMs >= SPEED_QUALIFICATION.minSpanMs &&
    sample.streamTokens >= SPEED_QUALIFICATION.minTokens &&
    sample.streamFragments >= SPEED_QUALIFICATION.minFragments
  ) {
    bucket.tok.push((sample.streamTokens * 1000) / sample.streamMs)
    if (sample.streamFragments > 0) {
      bucket.frag.push((sample.streamFragments * 1000) / sample.streamMs)
      bucket.ratio.push(sample.streamTokens / sample.streamFragments)
    }
  }
  byModel.set(key, bucket)
}

const report = aggregate(samples, { sort: 'speed' })
const rows = [...byModel.values()].filter((bucket) => bucket.tok.length >= MIN_SAMPLES)
const fragRank = new Map(
  [...rows]
    .sort((a, b) => (stats(b.frag)?.median ?? 0) - (stats(a.frag)?.median ?? 0))
    .map((bucket, index) => [bucket.key, index + 1]),
)
const tokRank = new Map(
  [...rows]
    .sort((a, b) => (stats(b.tok)?.median ?? 0) - (stats(a.tok)?.median ?? 0))
    .map((bucket, index) => [bucket.key, index + 1]),
)

console.log(
  'model'.padEnd(46),
  'n'.padStart(5),
  'frag/s'.padStart(9),
  'tok/s'.padStart(8),
  'p90'.padStart(8),
  'max'.padStart(9),
  'tok/frag'.padStart(9),
  'rank'.padStart(11),
)
for (const bucket of rows.sort((a, b) => (stats(a.tok)?.median ?? 0) - (stats(b.tok)?.median ?? 0))) {
  const tok = stats(bucket.tok)
  const frag = stats(bucket.frag)
  const ratio = stats(bucket.ratio)
  const before = fragRank.get(bucket.key)
  const after = tokRank.get(bucket.key)
  console.log(
    bucket.key.slice(0, 45).padEnd(46),
    String(bucket.tok.length).padStart(5),
    (frag?.median ?? 0).toFixed(1).padStart(9),
    tok.median.toFixed(1).padStart(8),
    tok.p90.toFixed(1).padStart(8),
    tok.max.toFixed(1).padStart(9),
    (ratio?.median ?? 0).toFixed(1).padStart(9),
    `${before} -> ${after}`.padStart(11),
  )
}

const mismatched = report.byModel.filter((row) => {
  const bucket = byModel.get(`${row.provider}/${row.model}`)
  if (bucket === undefined || bucket.tok.length < MIN_SAMPLES) return false
  return Math.abs((stats(bucket.tok).median ?? 0) - (row.speedTps.median ?? 0)) > 0.5
})
const inflated = rows.filter((bucket) => (stats(bucket.ratio)?.median ?? 0) > 50)
console.log(
  `\nfolded ${samples.length} step(s); ${rows.length} model(s) with >= ${MIN_SAMPLES} rate samples.`,
)
console.log(
  mismatched.length === 0
    ? 'aggregate agrees with the recomputed per-step rates for every model.'
    : `aggregate MISMATCH: ${mismatched.map((row) => `${row.provider}/${row.model}`).join(', ')}`,
)
console.log(
  inflated.length === 0
    ? 'no model reports more than 50 tokens per delta fragment.'
    : `CHECK: tokens-per-fragment above 50 (tokens possibly not streamed): ${inflated
        .map((bucket) => `${bucket.key}=${(stats(bucket.ratio)?.median ?? 0).toFixed(1)}`)
        .join(', ')}`,
)
