import assert from 'node:assert/strict'
import test from 'node:test'

import { createIsolatedV2Client } from '../src/api/v2-client.js'
import { validateV2Snapshot } from '../src/api/v2-snapshot.js'
import {
  FE09C_TEST_CONSENT, initializeIsolatedV2,
} from '../src/db/v2-isolated-initialization.js'
import {
  checkedReceipt, fixtureId, lastOperationId,
  makeEmptyVerifiedV2Snapshot, makeProvisionalV2Snapshot,
  makeVerifiedV2Snapshot,
} from './fixtures/api-v2-initialization.mjs'

const clone = (value) => structuredClone(value)
const rejectProtocol = (value, ids = []) => assert.throws(
  () => validateV2Snapshot(value, ids),
  (error) => error.name === 'ApiProtocolError',
)
const metadata = (data) => ({
  generation: data.server_generation_id,
  settingsVersion: data.settings.settings_version,
})
function response(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', ...headers },
  })
}

test('authoritative v2 snapshot verifies +20, -5 and backward event timestamps', () => {
  const value = makeVerifiedV2Snapshot()
  const result = validateV2Snapshot(value)
  assert.equal(result.installable, true)
  assert.equal(result.installationBlocker, null)
  assert.equal(value.inventory_items[0].available_quantity, 15)
  assert.deepEqual(value.stock_movements.map((row) => row.commit_seq), [3, 4])
  assert.ok(value.stock_movements[1].created_at < value.stock_movements[0].created_at)
})

test('an empty but authoritative ledger is installable for isolated test initialization', () => {
  assert.equal(validateV2Snapshot(makeEmptyVerifiedV2Snapshot()).installable, true)
})

test('coherent provisional history is readable but cannot be installed', () => {
  const result = validateV2Snapshot(makeProvisionalV2Snapshot())
  assert.equal(result.installable, false)
  assert.equal(result.installationBlocker, 'provisional_history')
})

test('provisional accepted receipt checks remain noninstallable without last-commit markers', () => {
  const value = checkedReceipt(makeProvisionalV2Snapshot())
  assert.equal(validateV2Snapshot(value, [lastOperationId]).installable, false)
})

test('authoritative receipt checks bind the last commit and original timestamp', () => {
  const value = checkedReceipt(makeVerifiedV2Snapshot())
  assert.equal(validateV2Snapshot(value, [lastOperationId]).installable, true)
  value.receipt_checks[0].commit_seq = 3
  rejectProtocol(value, [lastOperationId])
})

test('missing receipt checks have null metadata', () => {
  const value = makeVerifiedV2Snapshot()
  const missing = fixtureId(444)
  value.receipt_checks = [{
    operation_id: missing, status: 'missing', processed_at: null,
    commit_seq: null, replay_status: null,
  }]
  assert.equal(validateV2Snapshot(value, [missing]).installable, true)
  value.receipt_checks[0].commit_seq = 1
  rejectProtocol(value, [missing])
})

test('duplicated receipt checks must agree including sequence', () => {
  const value = checkedReceipt(makeVerifiedV2Snapshot())
  value.receipt_checks.push(clone(value.receipt_checks[0]))
  assert.equal(validateV2Snapshot(value, [lastOperationId, lastOperationId]).installable, true)
  value.receipt_checks[1].commit_seq = 3
  rejectProtocol(value, [lastOperationId, lastOperationId])
})

test('swapped commit sequences fail closed even if timestamps appear chronological', () => {
  const value = makeVerifiedV2Snapshot()
  value.stock_movements[0].commit_seq = 4
  value.stock_movements[1].commit_seq = 3
  rejectProtocol(value)
})

test('a resealed withdrawal before its supplying batch fails chronological replay', () => {
  const value = makeVerifiedV2Snapshot()
  const [incoming, outgoing] = value.stock_movements
  value.stock_movements = [
    { ...outgoing, commit_seq: 3 },
    { ...incoming, commit_seq: 4 },
  ]
  rejectProtocol(value)
})

test('a missing withdrawal allocation cannot inflate stock', () => {
  const value = makeVerifiedV2Snapshot()
  value.batch_allocations.pop()
  rejectProtocol(value)
})

test('incorrect historical/final derived balance is rejected', () => {
  const value = makeVerifiedV2Snapshot()
  value.inventory_items[0].available_quantity = 16
  rejectProtocol(value)
})

test('invalid migration counts or last sequence cannot authorize installation', () => {
  const value = makeVerifiedV2Snapshot()
  value.migration.verified_receipt_count = 3
  rejectProtocol(value)
  value.migration.verified_receipt_count = 4
  value.sync.last_commit_seq = Number.MAX_SAFE_INTEGER + 1
  rejectProtocol(value)
})

test('extra or missing v2 schema keys are incompatible', () => {
  const value = makeVerifiedV2Snapshot()
  value.extra = 1
  rejectProtocol(value)
  delete value.extra
  delete value.migration
  rejectProtocol(value)
})

test('mislabeled provisional state is not accepted as authoritative', () => {
  const value = makeVerifiedV2Snapshot()
  value.replay = { status: 'provisional', order: null, installation_blocked: true }
  rejectProtocol(value)
})

test('v2 snapshot transport uses explicit /api/v2 and has no sync method', async () => {
  const value = makeVerifiedV2Snapshot()
  let calls = 0
  const client = createIsolatedV2Client({
    baseUrl: 'http://127.0.0.1:5000',
    fetch: async (url, options) => {
      calls += 1
      assert.equal(url.pathname, '/api/v2/snapshot')
      assert.equal(options.method, 'GET')
      assert.equal(options.credentials, 'omit')
      return response({ success: true, data: value }, 200, {
        'X-Inventory-Generation': value.server_generation_id,
        'X-Inventory-Settings-Version': '1',
      })
    },
  })
  assert.equal(client.sync, undefined)
  const data = await client.snapshot()
  assert.equal(data.installable, true)
  assert.equal(data.generation, value.server_generation_id)
  assert.equal(calls, 1)
})

test('FE-09C v2 client rejects remote HTTPS endpoints', () => {
  assert.throws(
    () => createIsolatedV2Client({ baseUrl: 'https://inventory.example.com' }),
    /loopback/,
  )
})

test('successful HTTP 200 with mismatched generation never becomes installable', async () => {
  const value = makeVerifiedV2Snapshot()
  const client = createIsolatedV2Client({
    baseUrl: 'http://127.0.0.1:5000',
    fetch: async () => response({ success: true, data: value }, 200, {
      'X-Inventory-Generation': fixtureId(888),
      'X-Inventory-Settings-Version': '1',
    }),
  })
  await assert.rejects(client.snapshot(),
    (error) => error.kind === 'invalid_protocol')
})

test('corruption 409 is classified as recovery_required without installation', async () => {
  const value = makeVerifiedV2Snapshot()
  const client = createIsolatedV2Client({
    baseUrl: 'http://127.0.0.1:5000',
    fetch: async () => response({ success: false, error: {
      code: 'RECOVERY_REQUIRED', message: 'Inventory history requires reconciliation.', details: {},
    } }, 409, {
      'X-Inventory-Generation': value.server_generation_id,
      'X-Inventory-Settings-Version': '1',
    }),
  })
  await assert.rejects(client.snapshot(),
    (error) => error.kind === 'recovery_required' && error.status === 409)
})

test('temporary SQLite unavailability retains retry guidance', async () => {
  const client = createIsolatedV2Client({
    baseUrl: 'http://127.0.0.1:5000',
    fetch: async () => response({ success: false, error: {
      code: 'SYNC_FAILED', message: 'Service unavailable.', details: {},
    } }, 503, { 'Retry-After': '3' }),
  })
  await assert.rejects(client.snapshot(),
    (error) => error.kind === 'temporary_failure' && error.retryAfterMs === 3000)
})

test('FE-09C cannot run without exact test consent or on demo storage', async () => {
  const value = makeVerifiedV2Snapshot()
  let called = false
  const client = { snapshot: async () => {
    called = true
    return { data: value, installable: true, ...metadata(value) }
  } }
  await assert.rejects(initializeIsolatedV2({ client }),
    (error) => error.code === 'EXPLICIT_TEST_CONSENT_REQUIRED')
  assert.equal(called, false)
  await assert.rejects(initializeIsolatedV2({
    client, consent: FE09C_TEST_CONSENT, databaseName: 'fulfil-cafe-demo-inventory',
  }), (error) => error.code === 'EXPLICIT_TEST_CONSENT_REQUIRED')
  assert.equal(called, false)
})

test('provisional snapshot is rejected before opening IndexedDB', async () => {
  const value = makeProvisionalV2Snapshot()
  let opened = false
  await assert.rejects(initializeIsolatedV2({
    consent: FE09C_TEST_CONSENT,
    indexedDB: { open: () => { opened = true } },
    client: { snapshot: async () => ({ data: value, installable: false, ...metadata(value) }) },
  }), (error) => error.code === 'SNAPSHOT_NOT_AUTHORITATIVE')
  assert.equal(opened, false)
})

test('incompatible response headers are refused before any persistent write', async () => {
  const value = makeVerifiedV2Snapshot()
  let opened = false
  await assert.rejects(initializeIsolatedV2({
    consent: FE09C_TEST_CONSENT,
    indexedDB: { open: () => { opened = true } },
    client: { snapshot: async () => ({
      data: value, installable: true, ...metadata(value), generation: fixtureId(777),
    }) },
  }), (error) => error.code === 'SNAPSHOT_HEADER_MISMATCH')
  assert.equal(opened, false)
})
