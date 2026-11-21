import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ApiProtocolError, validateAcknowledgment, validateHealth, validateSnapshot } from '../src/api/responses.js'
import wireFixtures from './fixtures/api-v1-commands.json' with { type: 'json' }

const id = (suffix) => `a0000000-0000-4000-8000-${suffix.toString(16).padStart(12, '0')}`
const categoryId = id(1)
const itemId = id(2)
const batchId = id(3)
const generation = id(4)
const receiveId = id(5)
const usageId = id(6)
const time = '2026-11-18T02:00:10Z'
const earlierTime = '2026-11-17T01:00:05Z'

function rejectsAt(field, validate) {
  assert.throws(validate, {
    name: 'ApiProtocolError',
    field,
    code: 'INVALID_PROTOCOL_RESPONSE',
    message: `Invalid inventory API response at ${field}.`,
  })
}

function emptySnapshot() {
  return {
    schema_version: 1,
    server_generation_id: generation,
    receipt_checks: [],
    snapshot_at: time,
    categories: [],
    inventory_items: [],
    stock_batches: [],
    stock_movements: [],
    batch_allocations: [],
    settings: { settings_version: 1, business_timezone: 'Asia/Manila', expiration_warning_days: null },
    sync: { last_committed_operation_id: null, last_committed_at: null },
    backup: { last_successful_backup_at: null },
  }
}

function category(overrides = {}) {
  return {
    category_id: categoryId, name: 'Test containers', normalized_name: 'test containers',
    description: null, is_active: true, created_at: time, updated_at: time, ...overrides,
  }
}

function item(overrides = {}) {
  return {
    item_id: itemId, category_id: categoryId, name: 'Test cup', normalized_name: 'test cup',
    unit_of_measurement: 'piece', minimum_stock_level: 15, is_active: true, created_at: time,
    updated_at: time, available_quantity: 15, stock_status: 'low_stock', ...overrides,
  }
}

function allocation(allocationId, quantity, overrides = {}) {
  return { allocation_id: allocationId, batch_id: batchId, quantity_change: quantity, ...overrides }
}

function movement(movementId, type, quantity, overrides = {}) {
  return {
    movement_id: movementId, item_id: itemId, movement_type: type, quantity_change: quantity,
    reason: null, recorded_by: null, created_at: time, ...overrides,
  }
}

function stockedSnapshot() {
  return {
    ...emptySnapshot(),
    categories: [category()],
    inventory_items: [item()],
    stock_batches: [{
      batch_id: batchId, item_id: itemId, received_quantity: 20, remaining_quantity: 15,
      purchase_date: null, expiration_date: null, purchase_cost: null, created_at: time,
    }],
    stock_movements: [movement(usageId, 'stock_out', -5), movement(receiveId, 'stock_in', 20)],
    batch_allocations: [
      allocation(id(7), -5, { movement_id: usageId }),
      allocation(id(8), 20, { movement_id: receiveId }),
    ],
  }
}

function command(type, entityId, payload, createdAt = time) {
  return {
    operation_id: id(9).toUpperCase(), operation_type: type, entity_id: entityId,
    payload, created_at: createdAt, local_sequence: 1,
  }
}

function ack(result, overrides = {}) {
  return { operation_id: id(9), outcome: 'accepted', processed_at: time, result, ...overrides }
}

test('recognizes only the audited health payload and keeps invalid response details private', () => {
  const healthy = { status: 'ok' }
  assert.equal(validateHealth(healthy), healthy)
  rejectsAt('health.status', () => validateHealth({ status: 'private text' }))
  rejectsAt('health', () => validateHealth({ status: 'ok', extra: true }))
})

test('returns a structurally valid empty snapshot for isolated inspection only', () => {
  const data = Object.freeze(emptySnapshot())
  assert.deepEqual(validateSnapshot(data), {
    snapshot: data, installable: false, installationBlocker: 'isolated_inspection_only',
  })
})

test('accepts tied and backward-clock timestamps for inspection and never infers replay order', () => {
  const data = stockedSnapshot()
  const [usage, receipt] = data.stock_movements
  assert.equal(usage.created_at, receipt.created_at)
  assert.deepEqual(validateSnapshot(data), {
    snapshot: data, installable: false, installationBlocker: 'missing_authoritative_replay_order',
  })
  usage.created_at = earlierTime
  assert.equal(validateSnapshot(data).snapshot.stock_movements[0], usage)
  assert.equal(validateSnapshot(data).snapshot.stock_movements[1], receipt)
})

test('accepts archived rows with allocated history and zero remaining quantity', () => {
  const data = stockedSnapshot()
  data.categories[0].is_active = false
  Object.assign(data.inventory_items[0], { is_active: false, available_quantity: 0, stock_status: 'out_of_stock' })
  data.stock_batches[0].remaining_quantity = 0
  data.stock_movements[0].quantity_change = -20
  data.batch_allocations[0].quantity_change = -20
  assert.equal(validateSnapshot(data).installable, false)
})

test('checks version, metadata types, UTC calendar timestamps and supported timezone names', () => {
  rejectsAt('snapshot.schema_version', () => validateSnapshot({ ...emptySnapshot(), schema_version: 2 }))
  rejectsAt('snapshot.server_generation_id', () => validateSnapshot({ ...emptySnapshot(), server_generation_id: null }))
  rejectsAt('snapshot.snapshot_at', () => validateSnapshot({ ...emptySnapshot(), snapshot_at: '2026-02-29T00:00:00Z' }))
  const data = emptySnapshot()
  data.settings.settings_version = Number.MAX_SAFE_INTEGER + 1
  rejectsAt('snapshot.settings.settings_version', () => validateSnapshot(data))
  data.settings.settings_version = 1
  data.settings.business_timezone = 'Mars/Olympus'
  rejectsAt('snapshot.settings.business_timezone', () => validateSnapshot(data))
  data.settings.business_timezone = 'Asia/Manila'
  data.settings.expiration_warning_days = false
  rejectsAt('snapshot.settings.expiration_warning_days', () => validateSnapshot(data))
  data.settings.expiration_warning_days = 0
  data.sync.last_committed_at = time
  rejectsAt('snapshot.sync', () => validateSnapshot(data))
})

test('correlates receipt checks to requested identifiers and validates their state and timestamp', () => {
  const data = stockedSnapshot()
  data.sync = { last_committed_operation_id: id(10), last_committed_at: time }
  data.receipt_checks = [
    { operation_id: id(10), status: 'accepted', processed_at: time },
    { operation_id: id(11), status: 'missing', processed_at: null },
  ]
  const requested = [id(10).toUpperCase(), id(11)]
  assert.equal(validateSnapshot(data, requested).snapshot, data)
  rejectsAt('snapshot.receipt_checks', () => validateSnapshot(data))
  rejectsAt('snapshot.receipt_checks.operation_id', () => validateSnapshot(data, requested.toReversed()))
  data.receipt_checks[1].processed_at = time
  rejectsAt('snapshot.receipt_checks.processed_at', () => validateSnapshot(data, requested))
})

test('requires safe scaled integers and checks derived item and batch totals', () => {
  const data = stockedSnapshot()
  data.inventory_items[0].available_quantity = Number.MAX_SAFE_INTEGER + 1
  rejectsAt('snapshot.inventory_items.available_quantity', () => validateSnapshot(data))
  data.inventory_items[0].available_quantity = 14
  rejectsAt('snapshot.inventory_items.available_quantity', () => validateSnapshot(data))
  data.inventory_items[0].available_quantity = 15
  data.stock_batches[0].remaining_quantity = 14
  rejectsAt('snapshot.stock_batches.remaining_quantity', () => validateSnapshot(data))
  data.stock_batches[0].remaining_quantity = 15
  data.stock_batches[0].purchase_cost = 1.5
  rejectsAt('snapshot.stock_batches.purchase_cost', () => validateSnapshot(data))
  data.stock_batches[0].purchase_cost = 1500
  data.inventory_items[0].stock_status = 'sufficient'
  rejectsAt('snapshot.inventory_items.stock_status', () => validateSnapshot(data))
})

test('compares exact final totals even when response order would round an intermediate sum', () => {
  const data = stockedSnapshot()
  const maximum = Number.MAX_SAFE_INTEGER
  const adjustmentId = id(13)
  data.inventory_items[0].available_quantity = maximum - 1
  data.inventory_items[0].stock_status = 'sufficient'
  data.stock_batches[0].received_quantity = maximum
  data.stock_batches[0].remaining_quantity = maximum - 1
  data.stock_movements = [
    movement(receiveId, 'stock_in', maximum),
    movement(adjustmentId, 'positive_adjustment', 2, { reason: 'Test correction' }),
    movement(usageId, 'stock_out', -3),
  ]
  data.batch_allocations = [
    allocation(id(7), maximum, { movement_id: receiveId }),
    allocation(id(8), 2, { movement_id: adjustmentId }),
    allocation(id(14), -3, { movement_id: usageId }),
  ]
  assert.equal(validateSnapshot(data).installable, false)
  data.inventory_items[0].available_quantity = maximum + 2 - 3
  assert.notEqual(data.inventory_items[0].available_quantity, maximum - 1)
  rejectsAt('snapshot.inventory_items.available_quantity', () => validateSnapshot(data))
})

test('accepts scale-3 profile integers and rejects draft demo labels and fractional wire values', () => {
  const data = stockedSnapshot()
  for (const unit of ['kg', 'l']) {
    data.inventory_items[0].unit_of_measurement = unit
    data.inventory_items[0].minimum_stock_level = 1500
    assert.equal(validateSnapshot(data).snapshot.inventory_items[0].minimum_stock_level, 1500)
  }
  data.inventory_items[0].minimum_stock_level = 1.5
  rejectsAt('snapshot.inventory_items.minimum_stock_level', () => validateSnapshot(data))
  data.inventory_items[0].minimum_stock_level = 15
  data.inventory_items[0].unit_of_measurement = 'pieces'
  rejectsAt('snapshot.inventory_items.unit_of_measurement', () => validateSnapshot(data))
})

test('requires unique resource IDs and verifies item, batch and movement relationships', () => {
  const data = stockedSnapshot()
  data.categories.push(category({ category_id: categoryId.toUpperCase() }))
  rejectsAt('snapshot.categories.category_id', () => validateSnapshot(data))
  data.categories.pop()
  data.inventory_items[0].category_id = id(12)
  rejectsAt('snapshot.inventory_items.category_id', () => validateSnapshot(data))
  data.inventory_items[0].category_id = categoryId
  data.stock_movements[0].item_id = id(12)
  rejectsAt('snapshot.stock_movements.item_id', () => validateSnapshot(data))
  data.stock_movements[0].item_id = itemId
  data.stock_batches[0].item_id = id(12)
  rejectsAt('snapshot.batch_allocations', () => validateSnapshot(data))
  data.stock_batches[0].item_id = itemId
  data.batch_allocations[1].batch_id = id(12)
  rejectsAt('snapshot.batch_allocations', () => validateSnapshot(data))
})

test('rejects repeated movement/batch pairs, mismatched signs and unallocated movements', () => {
  const data = stockedSnapshot()
  data.batch_allocations[0].quantity_change = 5
  rejectsAt('snapshot.batch_allocations.quantity_change', () => validateSnapshot(data))
  data.batch_allocations[0].quantity_change = -5
  data.batch_allocations.push(allocation(id(12), -1, { movement_id: usageId }))
  rejectsAt('snapshot.batch_allocations', () => validateSnapshot(data))
  data.batch_allocations.pop()
  data.batch_allocations.shift()
  rejectsAt('snapshot.stock_movements.quantity_change', () => validateSnapshot(data))
})

test('handles audited category and item acknowledgments including archival and timestamp equivalence', () => {
  const categoryCreated = ack(category())
  assert.equal(validateAcknowledgment(categoryCreated,
    command('create_category', categoryId.toUpperCase(), { name: 'Test containers' }, time.replace('Z', '.000Z'))),
  categoryCreated)
  const itemCreated = ack(item({ available_quantity: 0, stock_status: 'out_of_stock' }))
  const create = command('create_item', itemId, {
    category_id: categoryId, name: 'Test cup', unit_of_measurement: 'piece', minimum_stock_level: 15,
  })
  assert.equal(validateAcknowledgment(itemCreated, create), itemCreated)
  const archived = ack(item({ is_active: false, available_quantity: 0, stock_status: 'out_of_stock' }))
  assert.equal(validateAcknowledgment(archived, command('archive_item', itemId, {}, earlierTime)), archived)
  const updated = ack(category(), { outcome: 'already_processed' })
  assert.equal(validateAcknowledgment(updated, command('update_category', categoryId, { description: null })), updated)
})

test('rejects wrong acknowledgments even when the outer status looks successful', () => {
  const request = command('update_item', itemId, { minimum_stock_level: 15 })
  rejectsAt('acknowledgment.operation_id', () => validateAcknowledgment(ack(item(), { operation_id: id(12) }), request))
  rejectsAt('acknowledgment.outcome', () => validateAcknowledgment(ack(item(), { outcome: 'rejected' }), request))
  rejectsAt('acknowledgment.processed_at', () => validateAcknowledgment(ack(item(), { processed_at: null }), request))
  rejectsAt('acknowledgment.result.item_id', () => validateAcknowledgment(ack(item({ item_id: id(12) })), request))
  rejectsAt('acknowledgment.result.minimum_stock_level', () => validateAcknowledgment(
    ack(item({ available_quantity: 20, minimum_stock_level: 16, stock_status: 'sufficient' })), request))
  rejectsAt('acknowledgment.result.available_quantity', () => validateAcknowledgment(
    ack(item({ available_quantity: Number.MAX_SAFE_INTEGER + 1 })), request))
})

test('correlates submitted display text using audited cleanup without changing the request', () => {
  const name = '\u001c  Cafe\u0301\u0085containers  \u001f'
  const description = '  Food\u00a0 storage  '
  const request = command('update_category', categoryId, { name, description })
  const result = category({ name: 'Café containers', normalized_name: 'café containers', description: 'Food storage' })
  const response = ack(result)
  assert.equal(validateAcknowledgment(response, request), response)
  assert.deepEqual(request.payload, { name, description })
  rejectsAt('acknowledgment.result.name', () => validateAcknowledgment(
    ack({ ...result, name: 'Other containers' }), request))
  rejectsAt('acknowledgment.result.description', () => validateAcknowledgment(
    ack({ ...result, description: null }), request))

  const blankDescription = command('update_category', categoryId, { description: '\u001c \u0085' })
  assert.equal(validateAcknowledgment(ack(category()), blankDescription).result.description, null)
  const omittedDescription = command('update_category', categoryId, { name: result.name })
  assert.equal(validateAcknowledgment(response, omittedDescription), response)
})

test('reconciles only the movement receipt and compares allocation identity independently of order', () => {
  const allocations = [allocation(id(20), -2), allocation(id(21), -3, { batch_id: id(22) })]
  const payload = {
    movement_id: usageId, item_id: itemId, movement_type: 'stock_out', quantity_change: -5, allocations,
  }
  const request = command('record_stock_movement', usageId, payload)
  const result = movement(usageId, 'stock_out', -5, { allocations: allocations.toReversed() })
  const response = ack(result)
  assert.equal(validateAcknowledgment(response, request), response)
  assert.throws(() => validateAcknowledgment(ack({ ...result, allocations: [
    { ...allocations[0], batch_id: id(12) }, allocations[1],
  ] }), request), (error) => error instanceof ApiProtocolError && error.field === 'acknowledgment.result.allocations')

  const withReason = command('record_stock_movement', usageId, { ...payload, reason: '  Service\u00a0use ' })
  assert.equal(validateAcknowledgment(ack({ ...result, reason: 'Service use' }), withReason).result.reason, 'Service use')
  rejectsAt('acknowledgment.result.reason', () => validateAcknowledgment(ack({ ...result, reason: 'Other' }), withReason))
  const blankReason = command('record_stock_movement', usageId, { ...payload, reason: ' \u0085 ' })
  assert.equal(validateAcknowledgment(response, blankReason), response)
})

test('rejects unrelated normalized names in category, item, and archived category acknowledgments', () => {
  const cases = [
    [command('create_category', categoryId, { name: 'Test containers' }), category()],
    [command('update_item', itemId, { minimum_stock_level: 15 }), item()],
    [command('archive_category', categoryId, {}, earlierTime), category({ is_active: false })],
  ]
  for (const [request, validResult] of cases) {
    const response = ack(validResult)
    assert.equal(validateAcknowledgment(response, request), response)
    rejectsAt('acknowledgment.result.normalized_name', () => validateAcknowledgment(
      ack({ ...validResult, normalized_name: 'unrelated' }), request))
  }
})

test('checks the audited Python full-fold examples on wire responses', () => {
  for (const { input, pythonDisplay, pythonNormalized, javascriptLowercase } of wireFixtures.normalization) {
    const request = command('create_category', categoryId, { name: input })
    const result = category({ name: pythonDisplay, normalized_name: pythonNormalized })
    const response = ack(result)
    assert.equal(validateAcknowledgment(response, request), response)
    if (pythonNormalized !== javascriptLowercase) {
      rejectsAt('acknowledgment.result.normalized_name', () => validateAcknowledgment(
        ack({ ...result, normalized_name: javascriptLowercase }), request))
    }
  }
  const name = 'Étagère, µ, μ, ẞ, ΟΣος \ufffd'
  const result = category({ name, normalized_name: 'étagère, μ, μ, ss, οσοσ \ufffd' })
  const response = ack(result)
  assert.equal(validateAcknowledgment(response, command('create_category', categoryId, { name })), response)
})

test('does not accept an unverifiable fold outside the response normalization profile', () => {
  const name = '商品'
  const request = command('create_category', categoryId, { name })
  rejectsAt('acknowledgment.result.normalized_name', () => validateAcknowledgment(
    ack(category({ name, normalized_name: name })), request))
})

test('checks canonical catalog displays and related normalized names in snapshots', () => {
  const data = stockedSnapshot()
  data.categories[0].name = 'Test   containers'
  rejectsAt('snapshot.categories.name', () => validateSnapshot(data))
  data.categories[0].name = 'Test containers'
  data.inventory_items[0].normalized_name = 'another stock item'
  rejectsAt('snapshot.inventory_items.normalized_name', () => validateSnapshot(data))
})

test('ties a stock-in batch quantity and event timestamp to its originating allocation', () => {
  const data = stockedSnapshot()
  assert.equal(validateSnapshot(data).snapshot, data)
  data.stock_batches[0].received_quantity = 99
  rejectsAt('snapshot.stock_batches.received_quantity', () => validateSnapshot(data))
  data.stock_batches[0].received_quantity = 20
  data.stock_batches[0].created_at = earlierTime
  rejectsAt('snapshot.stock_batches.created_at', () => validateSnapshot(data))
})

test('rejects two movements of batch-creating types claiming to introduce the same batch', () => {
  const data = stockedSnapshot()
  const otherReceiveId = id(22)
  data.stock_movements.splice(1, 0, movement(otherReceiveId, 'initial_stock', 20))
  data.batch_allocations.unshift(allocation(id(23), 20, { movement_id: otherReceiveId }))
  data.stock_batches[0].remaining_quantity = 35
  Object.assign(data.inventory_items[0], { available_quantity: 35, stock_status: 'sufficient' })
  rejectsAt('snapshot.stock_batches.received_quantity', () => validateSnapshot(data))
})

test('inspects legitimate positive adjustments with or without a known batch introduction', () => {
  const data = stockedSnapshot()
  const adjustment = movement(id(22), 'positive_adjustment', 2, { reason: 'Recount', created_at: earlierTime })
  const receipt = data.stock_movements[1]
  data.stock_movements.unshift(adjustment)
  data.batch_allocations.unshift(allocation(id(23), 2, { movement_id: adjustment.movement_id }))
  data.stock_batches[0].remaining_quantity = 17
  Object.assign(data.inventory_items[0], { available_quantity: 17, stock_status: 'sufficient' })
  assert.equal(validateSnapshot(data).snapshot, data)

  Object.assign(receipt, { movement_type: 'positive_adjustment', reason: 'Opening recount' })
  assert.equal(validateSnapshot(data).snapshot, data)
  data.stock_batches[0].received_quantity = 99
  rejectsAt('snapshot.stock_batches.received_quantity', () => validateSnapshot(data))
})

test('requires the last committed operation to have an accepted matching requested receipt', () => {
  const data = stockedSnapshot()
  const operationId = id(32)
  data.sync = { last_committed_operation_id: operationId, last_committed_at: time }
  data.receipt_checks = [{ operation_id: operationId.toUpperCase(), status: 'missing', processed_at: null }]
  rejectsAt('snapshot.receipt_checks.status', () => validateSnapshot(data, [operationId]))
  data.receipt_checks[0].status = 'accepted'
  data.receipt_checks[0].processed_at = earlierTime
  rejectsAt('snapshot.receipt_checks.processed_at', () => validateSnapshot(data, [operationId]))
  data.receipt_checks[0].processed_at = time.replace('Z', '.000Z')
  assert.equal(validateSnapshot(data, [operationId]).snapshot, data)
})

test('rejects accepted receipts without a commit marker and inconsistent repeated receipt checks', () => {
  const data = stockedSnapshot()
  const operationId = id(33)
  const receipt = { operation_id: operationId, status: 'accepted', processed_at: time }
  data.receipt_checks = [receipt]
  rejectsAt('snapshot.receipt_checks.status', () => validateSnapshot(data, [operationId]))

  data.sync = { last_committed_operation_id: id(34), last_committed_at: earlierTime }
  const requested = [operationId, operationId.toUpperCase()]
  data.receipt_checks.push({ ...receipt, operation_id: requested[1], processed_at: time.replace('Z', '.000Z') })
  assert.equal(validateSnapshot(data, requested).snapshot, data)
  data.receipt_checks[1] = { ...receipt, status: 'missing', processed_at: null }
  rejectsAt('snapshot.receipt_checks.status', () => validateSnapshot(data, requested))
  data.receipt_checks[1] = { ...receipt, processed_at: earlierTime }
  rejectsAt('snapshot.receipt_checks.processed_at', () => validateSnapshot(data, requested))
})
