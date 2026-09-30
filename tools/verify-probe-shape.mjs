// Checks the shape of the request one probe sends.
//
// The bug this exists to catch is the one that shipped: the probe capped its
// answer with parameters of its own — `maxTokens: 16` and `temperature: 0` —
// and the harness sends neither (not one DSH bundle mentions either name). The
// dsh-subscriptions codex adapter maps a present `maxTokens` onto
// `max_output_tokens`, which the Codex backend refuses with
// `400 {"detail":"Unsupported parameter: max_output_tokens"}`; every codex model
// was therefore recorded `VENDOR`, a red circle for a provider the fold shows
// answering 335 real steps, none interrupted or retried. The probe was
// measuring its own request instead of the route.
//
// The assertion lives here rather than in `verify-liveness.mjs` because that one
// is live: it proves the shape only for whatever route it happened to probe
// first, and the codex route is the one that a pi-ai-only harness cannot mount
// at all. This one is a stub, so the contract is checked for every probe on
// every run, without spending provider traffic.
//
// Usage: node tools/verify-probe-shape.mjs

import { createLiveness } from '../lib/liveness.js'

let failures = 0
function check(label, condition, detail) {
  const mark = condition ? 'OK  ' : 'FAIL'
  if (!condition) failures += 1
  console.log(`${mark} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/**
 * A stub route that records every request it is asked to answer and finishes
 * the way the host does: a stream ending in a terminal `finish` chunk.
 */
function stubRoute(reason) {
  const requests = []
  return {
    requests,
    service: {
      async listProviders() {
        return ['stub']
      },
      async listModels() {
        return ['m1']
      },
      async *stream(request) {
        requests.push(request)
        yield { type: 'text', text: 'pong' }
        yield { type: 'finish', reason }
      },
    },
  }
}

function livenessOver(service) {
  return createLiveness({ get: (name) => (name === 'llm' ? service : undefined) }, { persist: false })
}

// --- the request the probe sends ----------------------------------------------

const stop = stubRoute({ kind: 'stop' })
const snapshot = await livenessOver(stop.service).check({ provider: 'stub', model: 'm1' })
const row = (snapshot.results ?? []).find((entry) => entry.provider === 'stub' && entry.model === 'm1')
check('the probe reached the route and read its finish', row?.status === 'ok', `${row?.status} ${row?.code ?? ''}`.trim())

const request = stop.requests[0] ?? {}
const keys = JSON.stringify(Object.keys(request).sort())

// The two parameters that broke codex, asserted by name: a probe must send what
// a real request sends, and a real request sends neither of these.
check('the probe sends no maxTokens', !('maxTokens' in request), keys)
check('the probe sends no temperature', !('temperature' in request), keys)

// What it *does* send: the route, the model, one short user message, and the
// signal the budget's abort timer needs. A probe that dropped one of these
// would be a probe of something other than the route.
check('the probe names its provider and model', request.provider === 'stub' && request.model === 'm1', keys)
check(
  'the probe asks one short user message',
  Array.isArray(request.messages) &&
    request.messages.length === 1 &&
    request.messages[0]?.role === 'user' &&
    JSON.stringify(request.messages[0]?.content).includes('ping'),
  JSON.stringify(request.messages),
)
check('the probe passes the signal its own budget aborts on', request.signal !== undefined, keys)

// --- a route that caps the output on its own ----------------------------------

// With no `maxTokens` of its own, a probe can still be answered with
// `max-tokens` by a route that caps output itself. That is an answer, not a
// failure: the circle must be green, or a working route reads as broken for the
// second time — the first for asking too much, now for asking within bounds.
const capped = stubRoute({ kind: 'max-tokens' })
const cappedSnapshot = await livenessOver(capped.service).check({ provider: 'stub', model: 'm1' })
const cappedRow = (cappedSnapshot.results ?? []).find((entry) => entry.provider === 'stub' && entry.model === 'm1')
check(
  'a max-tokens finish is a healthy answer',
  cappedRow?.status === 'ok',
  `${cappedRow?.status} ${cappedRow?.code ?? ''}`.trim(),
)

// --- a route that refuses in its own words ------------------------------------

// Unchanged behaviour, asserted so the fix above cannot have bought a green
// circle by classifying refusals away: an error finish is still a red one.
const refused = stubRoute({ kind: 'error', failure: { code: 'AUTH', message: '401 unauthorized' } })
const refusedSnapshot = await livenessOver(refused.service).check({ provider: 'stub', model: 'm1' })
const refusedRow = (refusedSnapshot.results ?? []).find((entry) => entry.provider === 'stub' && entry.model === 'm1')
check(
  'an error finish is still a failure, with the route\'s own reason',
  refusedRow?.status === 'fail' && refusedRow?.code === 'AUTH',
  `${refusedRow?.status} ${refusedRow?.code ?? ''} ${refusedRow?.error ?? ''}`.trim(),
)

console.log(`\n${failures === 0 ? 'ALL OK' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
