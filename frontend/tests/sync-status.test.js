import assert from 'node:assert/strict'
import test from 'node:test'
import { renderSyncBadge, renderSyncPanel, renderSyncSummary } from '../src/components/sync-status.js'
import { createSyncStatusRefresh, deriveSyncStatus } from '../src/services/sync-status.js'
import { id, queueCommands } from './fixtures/api-v2-queue.mjs'

const { ordered } = queueCommands()
const generation = id(99)
const settingsVersion = 1
const earlier = '2026-11-19T03:00:00Z'
const later = '2026-11-19T04:00:00Z'
const now = Date.parse(later)
const queue = (...operations) => ({ generation, settingsVersion, operations })
const pending = (index = 0, fields = {}) => ({ command: ordered[index], status: 'pending',
  resolution_status: 'none', retry_at: null, last_error: null, ...fields })
const confirmed = (index, processed_at, fields = {}) => ({
  ...pending(index), status: 'synchronized', last_attempt_at: '2026-11-20T00:00:00Z',
  acknowledgment: { operation_id: ordered[index].operation_id, processed_at, outcome: 'accepted',
    replay_status: 'verified', commit_seq: index + 1, server_generation_id: generation,
    settings_version: settingsVersion, ...fields },
})
const view = (records, options) => deriveSyncStatus({ configured: true, queue: records, now, ...options })

test('unconfigured, configured empty, loading and unavailable are distinct states', () => {
  assert.equal(deriveSyncStatus().state, 'not_configured')
  assert.deepEqual(view(queue()).counts, { pending: 0, synchronized: 0, review: 0 })
  assert.equal(view(queue()).state, 'ready')
  assert.equal(view(null, { loading: true }).state, 'loading')
  assert.equal(view(null, { unavailable: true }).state, 'unavailable')
  assert.match(renderSyncPanel(), /Not yet synchronized/)
  assert.doesNotMatch(renderSyncPanel(view(null)), /Not yet synchronized/)
})

test('pending and mixed counts come from persisted operations without implying activity', () => {
  const allPending = view(queue(pending(0), pending(1)))
  assert.equal(allPending.label, '2 changes pending')
  assert.equal(allPending.lastConfirmed, null)
  const model = view(queue(confirmed(0, earlier), pending(1)))
  assert.deepEqual(model.counts, { pending: 1, synchronized: 1, review: 0 })
  assert.equal(model.label, '1 change pending')
  assert.equal(model.lastConfirmed, earlier)
  assert.equal(view(queue(pending()), { active: true }).state, 'synchronizing')
  assert.equal(view(queue(pending()), { result: { status: 'busy' } }).state, 'unavailable')
})

test('fully synchronized requires verified receipts and displays the newest confirmed processing time', () => {
  const model = view(queue(confirmed(0, later), confirmed(1, earlier, { outcome: 'already_processed' })))
  assert.equal(model.state, 'synchronized')
  assert.equal(model.lastConfirmed, later)
  assert.equal(model.counts.synchronized, 2)
  assert.match(renderSyncPanel(model), /datetime="2026-11-19T04:00:00.000Z"/)
  assert.doesNotMatch(renderSyncPanel(model), /2026-11-20/)
  for (const fields of [
    { operation_id: id(1000) }, { replay_status: 'provisional' }, { commit_seq: null },
    { server_generation_id: id(1000) }, { settings_version: 2 }, { outcome: 'rejected' },
    { processed_at: 'invalid' },
  ]) {
    const invalid = view(queue(confirmed(0, earlier, fields)))
    assert.equal(invalid.state, 'unavailable')
    assert.equal(invalid.lastConfirmed, null)
    assert.notEqual(invalid.counts?.synchronized, 1)
  }
})

test('retry eligibility changes with time and promises only a manual retry', () => {
  const retryAt = now + 1000
  const records = queue(confirmed(0, earlier),
    pending(1, { retry_at: retryAt, last_error: { kind: 'temporary_failure' } }))
  const waiting = view(records)
  assert.equal(waiting.state, 'retry_delayed')
  assert.equal(waiting.retryAt, retryAt)
  assert.match(renderSyncPanel(waiting), /you can retry when the delay ends/i)
  const eligible = view(records, { now: retryAt })
  assert.equal(eligible.state, 'temporary_failure')
  assert.equal(eligible.canRetry, true)
  assert.match(renderSyncPanel(eligible), /Can retry now/)
})

test('rejection and recovery take precedence over later pending commands', () => {
  const failed = { ...pending(), status: 'failed', resolution_status: 'needs_review',
    last_error: { kind: 'server_rejection' } }
  const rejected = view(queue(failed, pending(1)))
  assert.equal(rejected.state, 'needs_review')
  assert.deepEqual(rejected.counts, { pending: 1, synchronized: 0, review: 1 })
  const recovery = view(queue(pending(0, { last_error: { kind: 'recovery_required' } }), pending(1)))
  assert.equal(recovery.state, 'recovery_required')
  assert.deepEqual(recovery.counts, { pending: 2, synchronized: 0, review: 0 })
})

test('components present safe messages and never render command payloads or raw error text', () => {
  const entry = pending(0, { last_error: { kind: 'access_denied', details: '<secret>' } })
  const model = view(queue(entry))
  const markup = renderSyncBadge(model) + renderSyncPanel(model) + renderSyncSummary(model)
  assert.match(markup, /Server access is unavailable/)
  assert.doesNotMatch(markup, /<secret>|Fictional supplies|access_denied/)
})

test('the latest explicit read wins when an older success or failure settles late', async () => {
  const reads = [Promise.withResolvers(), Promise.withResolvers(), Promise.withResolvers()]
  let index = 0
  const states = []
  const refresh = createSyncStatusRefresh(() => reads[index++].promise, (state) => states.push(state))
  const first = refresh('first')
  const second = refresh('second')
  const third = refresh('third')
  const latest = queue(pending())
  reads[2].resolve(latest)
  await third
  reads[1].reject(new Error('old storage failure'))
  reads[0].resolve(queue())
  await Promise.all([first, second])
  assert.deepEqual(states, [{ loading: true }, { loading: true }, { loading: true }, { queue: latest }])
})

test('a current read failure publishes unavailable without echoing the error', async () => {
  const states = []
  const refresh = createSyncStatusRefresh(async () => { throw new Error('private storage details') },
    (state) => states.push(state))
  await refresh('current')
  assert.deepEqual(states, [{ loading: true }, { unavailable: true }])
})
