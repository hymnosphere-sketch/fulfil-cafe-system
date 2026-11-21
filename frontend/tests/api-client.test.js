import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ApiClientError, createInventoryApiClient } from '../src/api/client.js'
import { buildDemoQueueRecord, catalogOperation } from '../src/data/demo-operation-record.js'
import { demoInventory } from '../src/data/demo-inventory.js'
import { createLoopbackTestApiClient } from './api-v1-test-client.mjs'

const G = 'aaaaaaaa-1000-4000-8000-000000000001'
const OTHER = 'aaaaaaaa-1000-4000-8000-000000000002'
const OP = 'bbbbbbbb-1000-4000-8000-000000000001'
const CAT = 'cccccccc-1000-4000-8000-000000000001'
const ITEM = 'dddddddd-1000-4000-8000-000000000001'
const WHEN = '2026-11-19T02:00:00Z'
const NOW = Date.parse(WHEN)
const backendResponses = JSON.parse(readFileSync(new URL('./fixtures/api-v1-backend-responses.json', import.meta.url), 'utf8'))

const category = {
  category_id: CAT, name: 'Fictional categories', normalized_name: 'fictional categories',
  description: null, is_active: true, created_at: WHEN, updated_at: WHEN,
}
const item = {
  item_id: ITEM, category_id: CAT, name: 'Fictional cups', normalized_name: 'fictional cups',
  unit_of_measurement: 'piece', minimum_stock_level: 15, available_quantity: 0,
  stock_status: 'out_of_stock', is_active: true, created_at: WHEN, updated_at: WHEN,
}
const wire = {
  operation_id: OP,
  operation_type: 'create_item',
  entity_id: ITEM,
  payload: {
    item_id: ITEM, category_id: CAT, name: item.name,
    unit_of_measurement: 'piece', minimum_stock_level: 15,
  },
  created_at: WHEN,
  local_sequence: 2,
}
const record = {
  ...wire,
  wire_version: 1,
  fictional: false,
  upload_eligible: true,
  status: 'pending',
  retry_count: 0,
  resolution_status: 'none',
  local_stock_confirmation: { internal: true },
}
const syncOptions = { generation: G }
const empty = {
  schema_version: 1, server_generation_id: G, snapshot_at: WHEN,
  categories: [], inventory_items: [], stock_batches: [], stock_movements: [], batch_allocations: [],
  settings: { settings_version: 1, business_timezone: 'Asia/Manila', expiration_warning_days: null },
  sync: { last_committed_operation_id: null, last_committed_at: null },
  backup: { last_successful_backup_at: null }, receipt_checks: [],
}

function json(body, { status = 200, generation = G, version = '1', headers: moreHeaders } = {}) {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', ...moreHeaders })
  if (generation !== null) headers.set('X-Inventory-Generation', generation)
  if (version !== null) headers.set('X-Inventory-Settings-Version', version)
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })
}

function success(data, options) {
  return json({ success: true, data }, options)
}

function ack(outcome = 'accepted', changes = {}, options) {
  return success({ operation_id: OP, outcome, processed_at: WHEN, result: item, ...changes }, options)
}

function rejectResponse(status, code, details = {}, headers) {
  return json({
    success: false,
    error: { code, message: 'Sensitive server message and raw details', details },
  }, { status, headers })
}

const rejectedDetails = { operation_id: OP, outcome: 'rejected', untrusted: 'Sensitive server details' }

function mock(handler, options = {}) {
  const calls = []
  const api = createInventoryApiClient({
    baseUrl: 'http://127.0.0.1:5000/api/v1/',
    now: () => NOW,
    ...options,
    fetch(url, request) {
      calls.push({ url, request })
      return handler(url, request)
    },
  })
  return { api, calls }
}

function expectError(kind, extras = {}) {
  return (error) => {
    assert.ok(error instanceof ApiClientError)
    assert.equal(error.kind, kind)
    for (const [key, expected] of Object.entries(extras)) assert.equal(error[key], expected, key)
    assert.doesNotMatch(JSON.stringify(error) + error.message, /Sensitive|password|Fictional cups/)
    assert.equal(error.cause, undefined)
    return true
  }
}

test('requires explicit trusted URL configuration and a bounded timeout', () => {
  for (const baseUrl of [
    undefined, '/api/v1', 'http://128.0.0.1:5000', 'file:///api/v1',
    'https://user:password@example.test', 'https://example.test/api/v1?token=hidden',
    'https://example.test/api/v1#fragment', 'https://example.test/other-api',
  ]) {
    assert.throws(() => createInventoryApiClient({ baseUrl }), { name: 'TypeError' })
  }
  for (const timeoutMs of [0, 120_001, 1.5, NaN, '20']) {
    assert.throws(() => createInventoryApiClient({ baseUrl: 'https://example.test', timeoutMs }), { name: 'RangeError' })
  }
  assert.doesNotThrow(() => createInventoryApiClient({ baseUrl: 'https://example.test' }))
})

test('health sends one credential-free GET and requires a valid service response', async () => {
  const { api, calls } = mock(() => success({ status: 'ok' }))
  assert.deepEqual(await api.health(), { data: { status: 'ok' }, generation: G, settingsVersion: 1 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url.href, 'http://127.0.0.1:5000/api/v1/health')
  assert.equal(calls[0].request.method, 'GET')
  assert.equal(calls[0].request.headers.get('Accept'), 'application/json')
  assert.equal(calls[0].request.headers.has('Content-Type'), false)
  assert.equal(calls[0].request.credentials, 'omit')
  assert.equal(calls[0].request.body, undefined)

  const bad = mock(() => success({ status: 'unavailable' }))
  await assert.rejects(bad.api.health(), expectError('invalid_protocol', { status: 200, outcome: 'not_applicable' }))
  const unavailable = mock(() => json({ success: false, error: { code: 'SYNC_FAILED', message: 'Unavailable', details: {} } }, {
    status: 503, generation: null, version: null,
  }))
  await assert.rejects(unavailable.api.health(), expectError('temporary_failure', { status: 503, code: 'SYNC_FAILED', generation: null }))
})

test('validates an empty snapshot in isolation and verifies receipt query correlation', async () => {
  const { api, calls } = mock(() => success({
    ...empty, receipt_checks: [{ operation_id: OP, status: 'missing', processed_at: null }],
  }))
  const result = await api.snapshot({ receiptIds: [OP.toUpperCase()] })
  assert.equal(result.installable, false)
  assert.equal(result.installationBlocker, 'isolated_inspection_only')
  assert.equal(result.generation, G)
  assert.deepEqual(result.data.inventory_items, [])
  assert.deepEqual(calls[0].url.searchParams.getAll('receipt_id'), [OP.toUpperCase()])
  assert.equal(calls[0].request.method, 'GET')
  await assert.rejects(api.snapshot({ receiptIds: ['bad'] }), expectError('invalid_command', { outcome: 'not_sent' }))
  assert.equal(calls.length, 1)
  const mismatch = mock(() => success({
    ...empty, receipt_checks: [{ operation_id: OTHER, status: 'missing', processed_at: null }],
  }))
  await assert.rejects(mismatch.api.snapshot({ receiptIds: [OP] }), expectError('invalid_protocol'))
})

test('structurally checks a nonempty snapshot and refuses installation', async () => {
  const { api } = mock(() => success({ ...empty, categories: [category], inventory_items: [item] }))
  const result = await api.snapshot()
  assert.equal(result.installable, false)
  assert.equal(result.installationBlocker, 'missing_authoritative_replay_order')
  assert.deepEqual(result.data.inventory_items, [item])
})

test('rejects raw unsafe, fractional and exponent numeric tokens even when JSON.parse rounds them', async () => {
  const base = JSON.stringify({ success: true, data: { ...empty, categories: [category], inventory_items: [item] } })
  for (const token of ['9007199254740993', '-9007199254740993', '0.00000000000000000000001',
    '1e-400', '0e0', '0.0', '1.00000000000000001']) {
    const source = base.replace('"available_quantity":0', '"available_quantity":' + token)
    const { api } = mock(() => json(source))
    await assert.rejects(api.snapshot(), expectError('invalid_protocol', { status: 200 }))
  }
  const stringName = 'label \" with numbers 1e-400, 9007199254740993 and slash \\'
  const { api } = mock(() => success({
    ...empty, categories: [{ ...category, name: stringName, normalized_name: stringName }],
  }))
  assert.equal((await api.snapshot()).data.categories[0].name, stringName)
})

for (const outcome of ['accepted', 'already_processed']) {
  test('validates a matching ' + outcome + ' acknowledgment and sends the exact six fields once', async () => {
    const source = structuredClone(record)
    const { api, calls } = mock(() => ack(outcome))
    const result = await api.sync(record, { generation: G.toUpperCase() })
    assert.equal(result.data.outcome, outcome)
    assert.equal(result.data.operation_id, OP)
    assert.deepEqual(result.data.result, item)
    assert.equal(result.generation, G)
    assert.deepEqual(record, source)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url.pathname, '/api/v1/sync')
    const { request } = calls[0]
    assert.equal(request.method, 'POST')
    assert.equal(request.credentials, 'omit')
    assert.equal(request.redirect, 'manual')
    assert.equal(request.headers.get('Content-Type'), 'application/json')
    assert.equal(request.headers.get('X-Inventory-Generation'), G.toUpperCase())
    assert.deepEqual(JSON.parse(request.body), wire)
  })
}

for (const [label, changes] of [
  ['wrong operation ID', { operation_id: OTHER }],
  ['wrong result ID', { result: { ...item, item_id: OTHER } }],
  ['unknown acknowledgment outcome', { outcome: 'rejected' }],
  ['invalid processed time', { processed_at: '2026-02-30T00:00:00Z' }],
  ['incomplete resource', { result: { item_id: ITEM } }],
  ['unsupported unit', { result: { ...item, unit_of_measurement: 'pieces' } }],
]) {
  test(label + ' leaves the command outcome uncertain', async () => {
    const { api, calls } = mock(() => ack('accepted', changes))
    await assert.rejects(api.sync(record, syncOptions), expectError('invalid_protocol', {
      status: 200, outcome: 'unknown', retry: 'same_command',
    }))
    assert.equal(calls.length, 1)
    assert.equal(JSON.parse(calls[0].request.body).operation_id, OP)
  })
}

test('rejects missing or malformed success headers and snapshot metadata mismatches', async () => {
  for (const options of [{ generation: null }, { generation: 'bad' }, { version: null }, { version: '1.0' },
    { version: '0' }, { version: '9007199254740993' }]) {
    const { api } = mock(() => ack('accepted', {}, options))
    await assert.rejects(api.sync(record, syncOptions), expectError('invalid_protocol', { outcome: 'unknown' }))
  }
  for (const options of [{ generation: OTHER }, { version: '2' }]) {
    const { api } = mock(() => success(empty, options))
    await assert.rejects(api.snapshot(), expectError('invalid_protocol', { status: 200 }))
  }
})

test('a duplicate JSON key cannot conceal a mismatched acknowledgment', async () => {
  const data = { operation_id: OP, outcome: 'accepted', processed_at: WHEN, result: item }
  const raw = JSON.stringify({ success: true, data })
    .replace('"operation_id":', '"operation_id":"' + OTHER + '","operation_\\u0069d":')
  assert.equal(JSON.parse(raw).data.operation_id, OP)
  const { api, calls } = mock(() => json(raw))
  await assert.rejects(api.sync(record, syncOptions), expectError('invalid_protocol', {
    outcome: 'unknown', retry: 'same_command',
  }))
  assert.equal(calls.length, 1)
})

test('pauses when a 200 acknowledgment is for a different server generation', async () => {
  const { api } = mock(() => ack('accepted', {}, { generation: OTHER }))
  await assert.rejects(api.sync(record, syncOptions), expectError('recovery_required', {
    status: 200, outcome: 'unknown', retry: 'pause', generation: OTHER,
  }))
})

for (const [status, code, details, kind, outcome, retry] of [
  [400, 'INVALID_REQUEST', {}, 'server_rejection', 'rejected', 'none'],
  [401, 'UNAUTHORIZED', {}, 'access_denied', 'paused', 'pause'],
  [403, 'FORBIDDEN', {}, 'access_denied', 'paused', 'pause'],
  [404, 'CATEGORY_NOT_FOUND', rejectedDetails, 'server_rejection', 'rejected', 'none'],
  [409, 'DUPLICATE_ITEM', rejectedDetails, 'server_rejection', 'rejected', 'none'],
  [409, 'OPERATION_ID_CONFLICT', rejectedDetails, 'operation_id_conflict', 'rejected', 'pause'],
  [409, 'RECOVERY_REQUIRED', {}, 'recovery_required', 'paused', 'pause'],
  [422, 'INSUFFICIENT_STOCK', rejectedDetails, 'server_rejection', 'rejected', 'none'],
  [500, 'SERVER_ERROR', {}, 'http_failure', 'unknown', 'same_command'],
  [503, 'SYNC_FAILED', {}, 'temporary_failure', 'unknown', 'same_command'],
]) {
  test('classifies HTTP ' + status + ' ' + code + ' without leaking server text', async () => {
    const { api, calls } = mock(() => rejectResponse(status, code, details))
    await assert.rejects(api.sync(record, syncOptions), expectError(kind, { status, code, outcome, retry }))
    assert.equal(calls.length, 1)
  })
}

test('unrecognized or uncorrelated 4xx responses do not prove rejection', async () => {
  for (const [status, code, details, kind] of [
    [404, 'INVALID_REQUEST', {}, 'http_failure'],
    [422, 'INSUFFICIENT_STOCK', {}, 'invalid_protocol'],
    [422, 'VALIDATION_ERROR', { ...rejectedDetails, operation_id: OTHER }, 'invalid_protocol'],
    [409, 'SENSITIVE_PRIVATE_CODE', rejectedDetails, 'http_failure'],
    [400, 'INVALID_REQUEST', { operation_id: OTHER }, 'invalid_protocol'],
  ]) {
    const { api } = mock(() => rejectResponse(status, code, details))
    await assert.rejects(api.sync(record, syncOptions), expectError(kind, { outcome: 'unknown', retry: 'same_command' }))
  }
})

test('a contradictory 400 response preserves the same operation ID and command for an explicit retry', async () => {
  const source = structuredClone(record)
  let attempts = 0
  const { api, calls } = mock(() => ++attempts === 1
    ? rejectResponse(400, 'INVALID_REQUEST', { outcome: 'accepted' })
    : ack('already_processed'))

  await assert.rejects(api.sync(record, syncOptions), expectError('invalid_protocol', {
    status: 400, outcome: 'unknown', retry: 'same_command',
  }))
  assert.equal(calls.length, 1)
  assert.deepEqual(record, source)
  assert.equal((await api.sync(record, syncOptions)).data.outcome, 'already_processed')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].request.body, calls[1].request.body)
  assert.equal(JSON.parse(calls[1].request.body).operation_id, OP)
})

test('recognizes the pinned pre-processing detail shapes', async () => {
  for (const details of [{}, { key: 'payload' }, { fields: Object.keys(wire) }]) {
    const { api } = mock(() => rejectResponse(400, 'INVALID_REQUEST', details))
    await assert.rejects(api.sync(record, syncOptions), expectError('server_rejection', {
      code: 'INVALID_REQUEST', outcome: 'rejected', retry: 'none',
    }))
  }
})

test('contradictory and malformed error metadata leave the mutation outcome unknown', async () => {
  for (const [status, code, details] of [
    [400, 'INVALID_REQUEST', { operation_id: OP, outcome: 'rejected' }],
    [400, 'INVALID_REQUEST', { outcome: null }],
    [400, 'INVALID_REQUEST', { fields: ['operation_id'] }],
    [400, 'INVALID_REQUEST', { key: 5 }],
    [409, 'DUPLICATE_ITEM', { operation_id: OP, outcome: 'accepted' }],
    [409, 'OPERATION_ID_CONFLICT', { operation_id: OP }],
    [409, 'RECOVERY_REQUIRED', { operation_id: OP, outcome: 'rejected' }],
    [422, 'VALIDATION_ERROR', { operation_id: 'malformed', outcome: 'rejected' }],
    [403, 'FORBIDDEN', { outcome: 'accepted' }],
    [503, 'SYNC_FAILED', { operation_id: OP, outcome: 'rejected' }],
  ]) {
    const { api, calls } = mock(() => rejectResponse(status, code, details))
    await assert.rejects(api.sync(record, syncOptions), expectError('invalid_protocol', {
      status, outcome: 'unknown', retry: 'same_command',
    }))
    assert.equal(calls.length, 1)
  }
})

test('a rejection needs valid response metadata from the expected generation', async () => {
  for (const [status, code, details] of [
    [400, 'INVALID_REQUEST', {}],
    [400, 'INVALID_REQUEST', { outcome: 'accepted' }],
    [409, 'DUPLICATE_ITEM', rejectedDetails],
    [409, 'DUPLICATE_ITEM', { ...rejectedDetails, outcome: 'accepted' }],
  ]) {
    const body = { success: false, error: { code, message: 'Sensitive server message', details } }
    for (const options of [{ generation: null }, { version: 'invalid' }]) {
      const { api } = mock(() => json(body, { status, ...options }))
      await assert.rejects(api.sync(record, syncOptions), expectError('invalid_protocol', {
        status, outcome: 'unknown', retry: 'same_command',
      }))
    }
    const { api } = mock(() => json(body, { status, generation: OTHER }))
    await assert.rejects(api.sync(record, syncOptions), expectError('recovery_required', {
      status, outcome: 'unknown', retry: 'pause', generation: OTHER,
    }))
  }
})

test('the original response fixtures can acknowledge both deliveries and inspect the snapshot', async () => {
  const { command, original } = backendResponses
  const options = { generation: original.generation }
  const queued = { ...command, wire_version: 1, fictional: false, upload_eligible: true }
  const responses = [original.accepted, original.replay, original.snapshot]
  const { api, calls } = mock(() => json(responses.shift(), options))

  assert.equal((await api.sync(queued, options)).data.outcome, 'accepted')
  assert.deepEqual((await api.sync(queued, options)).data, { ...original.accepted.data, outcome: 'already_processed' })
  assert.equal((await api.snapshot()).installationBlocker, 'missing_authoritative_replay_order')
  assert.equal(calls.length, 3)
})

test('PR #18 metadata cannot acknowledge the first delivery or validate its schema-1 snapshot', async () => {
  const { command, original, latest } = backendResponses
  const options = { generation: latest.generation }
  const queued = { ...command, wire_version: 1, fictional: false, upload_eligible: true }
  const source = structuredClone(queued)
  const responses = [latest.accepted, latest.snapshot, latest.replay]
  const { api, calls } = mock(() => json(responses.shift(), options))

  await assert.rejects(api.sync(queued, options), expectError('invalid_protocol', {
    status: 200, outcome: 'unknown', retry: 'same_command',
  }))
  assert.equal(calls.length, 1)
  assert.deepEqual(queued, source)
  await assert.rejects(api.snapshot(), expectError('invalid_protocol', {
    status: 200, outcome: 'not_applicable',
  }))

  // The unversioned replay uses the same fields as the original profile.
  // It cannot establish support for PR #18's first-delivery or snapshot metadata.
  assert.deepEqual(latest.replay, original.replay)
  assert.deepEqual((await api.sync(queued, options)).data, original.replay.data)
  assert.equal(calls.length, 3)
  assert.equal(calls[0].request.body, calls[2].request.body)
})

test('provides bounded Retry-After guidance without scheduling requests', async () => {
  for (const [header, ms] of [
    [undefined, 2_000],
    ['3', 3_000],
    ['0', 0],
    ['9007199254740991000000000000000000000000', 60_000],
    ['4.5', 2_000],
    ['-10', 2_000],
    ['2026-11-19', 2_000],
    [new Date(NOW + 4_000).toUTCString(), 4_000],
    [new Date(NOW - 4_000).toUTCString(), 0],
    [new Date(NOW + 600_000).toUTCString(), 60_000],
    ['Thu, 31 Feb 2026 02:00:00 GMT', 2_000],
  ]) {
    // Fetch returns null for both absent headers and headers hidden by CORS.
    const { api, calls } = mock(() => rejectResponse(503, 'SYNC_FAILED', {}, header ? { 'Retry-After': header } : {}))
    await assert.rejects(api.sync(record, syncOptions), expectError('temporary_failure', { retryAfterMs: ms }))
    assert.equal(calls.length, 1)
  }
})

test('distinguishes malformed JSON, HTML error pages and unexpected redirects', async () => {
  for (const [response, kind, status] of [
    [() => json('{"secret":"password"', {}), 'invalid_json', 200],
    [() => new Response('<html>password</html>', { status: 404, headers: { 'Content-Type': 'text/html' } }), 'http_failure', 404],
    [() => new Response(null, { status: 307, headers: { Location: 'https://example.test/password' } }), 'redirect', 307],
    [() => ({ status: 0, type: 'opaqueredirect' }), 'redirect', 0],
  ]) {
    const { api, calls } = mock(response)
    await assert.rejects(api.sync(record, syncOptions), expectError(kind, { status, outcome: 'unknown' }))
    assert.equal(calls[0].request.redirect, 'manual')
    assert.equal(calls.length, 1)
  }
})

test('a lost response allows only an explicit retry of the same command', async () => {
  let attempt = 0
  const { api, calls } = mock(() => {
    attempt += 1
    if (attempt === 1) throw new Error('password in low-level network error')
    return ack('already_processed')
  })
  await assert.rejects(api.sync(record, syncOptions), expectError('network_failure', {
    outcome: 'unknown', status: null, retry: 'same_command',
  }))
  assert.equal(calls.length, 1)
  assert.equal((await api.sync(record, syncOptions)).data.outcome, 'already_processed')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].request.body, calls[1].request.body)
})

test('the injected deadline cancels a hung response body without another request', async () => {
  let fireTimeout
  let readingBody
  let clearCount = 0
  const bodyRead = new Promise((resolve) => { readingBody = resolve })
  const { api, calls } = mock(() => ({
    status: 200, headers: new Headers({ 'Content-Type': 'application/json' }),
    async arrayBuffer() {
      readingBody()
      return new Promise(() => {})
    },
  }), {
    timeoutMs: 123,
    setTimer(callback, duration) {
      assert.equal(duration, 123)
      fireTimeout = callback
      return 'timer'
    },
    clearTimer(timer) {
      assert.equal(timer, 'timer')
      clearCount += 1
    },
  })
  const result = api.sync(record, syncOptions)
  await bodyRead
  fireTimeout()
  await assert.rejects(result, expectError('timeout', { outcome: 'unknown', retry: 'same_command' }))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].request.signal.aborted, true)
  assert.equal(clearCount, 1)
})

test('distinguishes cancellation before and after transport invocation', async () => {
  const { api, calls } = mock(() => new Promise(() => {}))
  const before = new AbortController()
  before.abort('password')
  await assert.rejects(api.sync(record, { generation: G, signal: before.signal }), expectError('cancelled', { outcome: 'not_sent' }))
  assert.equal(calls.length, 0)
  const after = new AbortController()
  const pending = api.sync(record, { generation: G, signal: after.signal })
  after.abort('password')
  await assert.rejects(pending, expectError('cancelled', { outcome: 'unknown', retry: 'same_command' }))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].request.signal.aborted, true)
})

test('unsupported versions, missing generation and existing demo records never reach Fetch', async () => {
  const demo = buildDemoQueueRecord(catalogOperation('create_category', demoInventory.categories[0], demoInventory), 1, () => OP)
  const { api, calls } = mock(() => assert.fail('The command must remain local'))
  const source = structuredClone(demo)
  await assert.rejects(api.sync(demo, syncOptions), expectError('invalid_command', { outcome: 'not_sent' }))
  await assert.rejects(api.sync({ ...record, wire_version: 2 }, syncOptions), expectError('invalid_command', { outcome: 'not_sent' }))
  await assert.rejects(api.sync(record, {}), expectError('invalid_command', { outcome: 'not_sent', code: 'INVALID_GENERATION' }))
  assert.equal(calls.length, 0)
  assert.deepEqual(demo, source)
})

test('the test-only facade rejects queue objects and only sends newly minted loopback commands', async () => {
  assert.throws(() => createLoopbackTestApiClient({ baseUrl: 'https://example.test' }), TypeError)
  let invoked = 0
  const api = createLoopbackTestApiClient({
    baseUrl: 'http://127.0.0.1:5000',
    fetch(url, options) {
      invoked += 1
      assert.equal(url.hostname, '127.0.0.1')
      return ack('accepted', { operation_id: JSON.parse(options.body).operation_id })
    },
  })
  await assert.rejects(api.syncFixture(record, syncOptions))
  await assert.rejects(api.syncFixture(wire, syncOptions), /newly generated/)
  assert.equal(invoked, 0)
  const minted = { ...wire, operation_id: api.fixtureOperationId() }
  assert.equal((await api.syncFixture(minted, syncOptions)).data.operation_id, minted.operation_id)
  assert.equal(invoked, 1)
})
