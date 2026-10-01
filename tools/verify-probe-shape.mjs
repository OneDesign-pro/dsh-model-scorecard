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

// --- the pairs a caller named outright ----------------------------------------

// The panel's second probe button sends the models the reader ticked, as pairs.
// The contract this guards is that a named list is exactly those models and
// nothing else: a sweep that widened to the catalog would spend a real request on
// every configured route, and the reader would have no way to see that it had —
// the circles of the models they did not pick are the ones that would change.
{
  const asked = []
  const service = {
    async listProviders() {
      return ['stub']
    },
    async listModels() {
      return ['m1', 'm2', 'm3']
    },
    async *stream(request) {
      asked.push(`${request.provider}/${request.model}`)
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const snapshot = await livenessOver(service).check({
    pairs: [
      { provider: 'stub', model: 'm2' },
      // A repeat of the same pair is one probe, not two: the list is a selection,
      // and a selection holds a pair once.
      { provider: 'stub', model: 'm2' },
      // Neither of these is a pair this host can probe, and neither is a reason to
      // refuse the pair that is.
      { provider: 'stub' },
      { model: 'm3' },
      { provider: '', model: 'm3' },
    ],
  })
  check(
    'a named list probes exactly the pairs it names, once each',
    JSON.stringify(asked) === JSON.stringify(['stub/m2']),
    JSON.stringify(asked),
  )
  check(
    'a malformed entry is skipped rather than refusing the list',
    (snapshot.results ?? []).length === 1 && snapshot.results[0].model === 'm2',
    JSON.stringify((snapshot.results ?? []).map((entry) => entry.model)),
  )
}

// The list is not filtered against the catalog, because the catalog is what the
// host serves right now and the reader named what they wanted checked: a pair the
// configuration has since dropped is exactly the one worth asking about, and its
// answer is a code rather than silence.
{
  const asked = []
  const service = {
    async listProviders() {
      return ['stub']
    },
    async listModels() {
      return ['m1']
    },
    async *stream(request) {
      asked.push(request.model)
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const snapshot = await livenessOver(service).check({
    pairs: [{ provider: 'stub', model: 'gone-from-the-catalog' }],
  })
  const goneRow = (snapshot.results ?? [])[0]
  check(
    'a named pair outside the catalog is still probed',
    JSON.stringify(asked) === JSON.stringify(['gone-from-the-catalog']),
    JSON.stringify(asked),
  )
  // The stub serves every model it is asked for, so the verdict here is `ok`; what
  // matters is that the pair came back as a recorded answer at all. A sweep that
  // had dropped the pair would leave the store empty, and the reader would be told
  // "already checked" about a model nothing had asked.
  check(
    'and the pair comes back as a recorded answer rather than silence',
    goneRow?.status === 'ok' && goneRow.model === 'gone-from-the-catalog',
    JSON.stringify(goneRow?.status),
  )
}

// A named list is a question, so it is re-probed even when a fresh answer exists:
// the freshness window belongs to the plain catalog click, and a reader who names
// the models is asking for them now.
{
  let probes = 0
  const service = {
    async listProviders() {
      return ['stub']
    },
    async listModels() {
      return ['m1']
    },
    async *stream() {
      probes += 1
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const liveness = livenessOver(service)
  await liveness.check({ pairs: [{ provider: 'stub', model: 'm1' }] })
  await liveness.check({ pairs: [{ provider: 'stub', model: 'm1' }] })
  check('a named pair is probed again despite a fresh answer', probes === 2, `probes: ${probes}`)
}

// The cap is the one thing a long list is refused for. It is a real bound rather
// than a formality: every pair is a real request, and a sweep of thousands of them
// is a mistake the host answers instead of paying for.
{
  const many = Array.from({ length: 1025 }, (unused, index) => ({ provider: 'stub', model: `m${index}` }))
  const service = {
    async listProviders() {
      return ['stub']
    },
    async listModels() {
      return ['m1']
    },
    async *stream() {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const refusedLong = await livenessOver(service)
    .check({ pairs: many })
    .then(() => null, (error) => error)
  check(
    'an oversized named list is refused, and says why',
    refusedLong instanceof Error && refusedLong.message.includes('at most 1024'),
    String(refusedLong?.message),
  )
}

console.log(`\n${failures === 0 ? 'ALL OK' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
