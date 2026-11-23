import assert from 'node:assert/strict'
import test from 'node:test'
import { createIsolatedV2SyncClient } from '../src/api/client.js'
import { createIsolatedV2Client } from '../src/api/v2-client.js'
import { drainOrderedV2Queue } from '../src/services/v2-ordered-sync.js'
import { makeVerifiedV2Snapshot } from './fixtures/api-v2-initialization.mjs'
import { at, id, queueCommands } from './fixtures/api-v2-queue.mjs'

const baseUrl = 'http://127.0.0.1:5099'
const generation = id(99)
const options = { generation, settingsVersion: 1 }
const { category, item } = queueCommands()
const accepted = {
  operation_id: category.operation_id, outcome: 'accepted', processed_at: at, commit_seq: 1, replay_status: 'verified',
  result: { ...category.payload, normalized_name: 'fictional supplies', description: null,
    is_active: true, created_at: at, updated_at: at },
}

function reply(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'X-Inventory-Generation': generation,
      'X-Inventory-Settings-Version': '1', ...headers },
  })
}

function success(data = accepted, settings) { return reply({ success: true, data }, settings) }

function error(kind, extra = {}) {
  return (value) => {
    assert.equal(value.kind, kind)
    for (const [key, expected] of Object.entries(extra)) assert.equal(value[key], expected, key)
    return true
  }
}

test('the isolated v2 adapter posts the original six fields and validates acceptance and replay', async () => {
  const calls = []
  const client = createIsolatedV2SyncClient({ baseUrl, fetch: async (url, request) => {
    calls.push(request.body)
    assert.equal(url.pathname, '/api/v2/sync')
    assert.equal(request.method, 'POST')
    assert.equal(request.credentials, 'omit')
    assert.equal(request.headers.get('X-Inventory-Generation'), generation)
    return success({ ...accepted, outcome: calls.length === 1 ? 'accepted' : 'already_processed' })
  } })
  const first = await client.sync(category, options)
  const second = await client.sync(category, options)
  assert.deepEqual(first, { data: accepted, ...options })
  assert.equal(second.data.outcome, 'already_processed')
  assert.equal(second.data.processed_at, first.data.processed_at)
  assert.equal(second.data.commit_seq, first.data.commit_seq)
  assert.deepEqual(calls.map((body) => JSON.parse(body)), [category, category])
  assert.equal(calls[0], calls[1])
  assert.deepEqual(Object.keys(client), ['sync'])
  assert.deepEqual(Object.keys(createIsolatedV2Client({ baseUrl })), ['health', 'snapshot'])
})

test('the v2 adapter refuses remote endpoints and demo queue rows before sending', async () => {
  assert.throws(() => createIsolatedV2SyncClient({ baseUrl: 'https://example.test' }), TypeError)
  let sent = 0
  const client = createIsolatedV2SyncClient({ baseUrl, fetch: () => { sent++ } })
  await assert.rejects(client.sync({ ...category, wire_version: 1, upload_eligible: false, fictional: true }, options),
    error('invalid_command', { outcome: 'not_sent' }))
  await assert.rejects(client.sync(category, { generation }), error('invalid_command', { outcome: 'not_sent' }))
  assert.equal(sent, 0)
})

test('malformed and contradictory v2 acknowledgments remain uncertain', async () => {
  for (const change of [
    { operation_id: id(999) }, { processed_at: 'invalid' }, { outcome: 'rejected' },
    { commit_seq: 0 }, { commit_seq: Number.MAX_SAFE_INTEGER + 1 }, { commit_seq: null },
    { replay_status: 'unverified' }, { extra: true }, { result: { ...accepted.result, category_id: id(999) } },
  ]) {
    const client = createIsolatedV2SyncClient({ baseUrl, fetch: () => success({ ...accepted, ...change }) })
    await assert.rejects(client.sync(category, options), error('invalid_protocol', { outcome: 'unknown' }))
  }
})

test('wrong generation, changed settings, provisional receipts and recovery responses pause v2 delivery', async () => {
  const cases = [
    [success(accepted, { headers: { 'X-Inventory-Generation': id(998) } }), 'RECOVERY_REQUIRED'],
    [success(accepted, { headers: { 'X-Inventory-Settings-Version': '2' } }), 'SETTINGS_VERSION_MISMATCH'],
    [success({ ...accepted, commit_seq: null, replay_status: 'provisional' }), 'PROVISIONAL_HISTORY'],
    [reply({ success: false, error: { code: 'RECOVERY_REQUIRED', message: 'Recovery', details: {} } },
      { status: 409 }), 'RECOVERY_REQUIRED'],
  ]
  for (const [response, code] of cases) {
    const client = createIsolatedV2SyncClient({ baseUrl, fetch: () => response })
    await assert.rejects(client.sync(category, options), error('recovery_required', { code, retry: 'pause' }))
  }
})

test('v2 distinguishes access denial, correlated conflicts, business rejection and retry guidance', async () => {
  const context = { operation_id: category.operation_id, outcome: 'rejected' }
  const cases = [
    [401, 'UNAUTHORIZED', {}, 'access_denied', 'paused'],
    [403, 'FORBIDDEN', {}, 'access_denied', 'paused'],
    [409, 'OPERATION_ID_CONFLICT', context, 'operation_id_conflict', 'rejected'],
    [409, 'DUPLICATE_CATEGORY', context, 'server_rejection', 'rejected'],
    [503, 'SYNC_FAILED', {}, 'temporary_failure', 'unknown'],
  ]
  for (const [status, code, details, kind, outcome] of cases) {
    const client = createIsolatedV2SyncClient({ baseUrl, fetch: () => reply({
      success: false, error: { code, message: 'Fictional failure', details },
    }, { status, headers: { 'Retry-After': '3' } }) })
    await assert.rejects(client.sync(category, options),
      error(kind, { code, outcome, retryAfterMs: status === 503 ? 3000 : null }))
  }
})

test('a timeout or interruption after send keeps the v2 outcome unknown', async () => {
  const hold = () => new Promise(() => {})
  const timeoutClient = createIsolatedV2SyncClient({ baseUrl, timeoutMs: 5, fetch: hold })
  await assert.rejects(timeoutClient.sync(category, options), error('timeout', { outcome: 'unknown' }))
  const controller = new AbortController()
  const interruptedClient = createIsolatedV2SyncClient({ baseUrl, fetch: hold })
  const pending = interruptedClient.sync(category, { ...options, signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, error('cancelled', { outcome: 'unknown' }))
})

test('a saved acknowledgment must match its original command and queue before delivery can continue', async (t) => {
  const previousLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (_name, _options, run) => run({}) } })
  t.after(() => {
    if (previousLocks) Object.defineProperty(navigator, 'locks', previousLocks)
    else delete navigator.locks
  })

  const snapshot = makeVerifiedV2Snapshot()
  snapshot.server_generation_id = generation
  const itemReceipt = { ...accepted, operation_id: item.operation_id, commit_seq: 5, result: {
    ...item.payload, normalized_name: 'fictional cups', is_active: true, available_quantity: 0,
    stock_status: 'out_of_stock', created_at: at, updated_at: at,
  } }
  const receipt = { ...accepted, server_generation_id: generation, settings_version: options.settingsVersion }

  async function drain(acknowledgment, pendingAcknowledgment = null) {
    const operations = [
      { command: category, status: 'synchronized', resolution_status: 'none', acknowledgment },
      { command: item, status: 'pending', resolution_status: 'none', retry_count: 0, acknowledgment: pendingAcknowledgment },
    ]
    const requests = []
    const writes = []
    const result = await drainOrderedV2Queue({
      baseUrl,
      withQueue: (work) => work({
        read: async () => ({ ...options, operations, initialCommit: 0 }),
        recordDelivery: async (entry, delivery) => { writes.push({ entry, delivery }) },
      }),
      fetch: (url, request) => {
        requests.push(request.method)
        return url.pathname === '/api/v2/snapshot' ? success(snapshot) : success(itemReceipt)
      },
    })
    return { result, requests, writes }
  }

  const valid = await drain(receipt)
  assert.deepEqual(valid.result, { status: 'complete', synchronized: 1 })
  assert.deepEqual(valid.requests, ['GET', 'POST'])
  assert.equal(valid.writes[0].delivery.acknowledgment.operation_id, item.operation_id)

  for (const change of [
    { result: { ...accepted.result, category_id: id(1000) } },
    { server_generation_id: id(1000) },
    { settings_version: options.settingsVersion + 1 },
    { replay_status: 'provisional', commit_seq: null },
  ]) {
    assert.deepEqual(await drain({ ...receipt, ...change }), {
      result: { status: 'storage_failure', synchronized: 0, code: null }, requests: [], writes: [],
    })
  }
  assert.deepEqual(await drain(receipt, itemReceipt), {
    result: { status: 'storage_failure', synchronized: 0, code: null }, requests: [], writes: [],
  })
})
