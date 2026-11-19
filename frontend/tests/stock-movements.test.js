import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createDemoInventoryRepository } from '../src/data/demo-inventory-repository.js'
import { demoBusinessDate, demoInventory } from '../src/data/demo-inventory.js'
import { buildInventoryReadModel } from '../src/services/inventory-read-model.js'
import { summarizeInventory } from '../src/services/inventory-summary.js'

const id = (suffix) => '00000000-0000-4000-8000-' + String(suffix).padStart(12, '0')
const beans = id(101)
const oatMilk = id(105)
const fixtureDate = '2026-11-19T07:00:00Z'

function repositoryForTest(options = {}) {
  let nextId = 20000
  return createDemoInventoryRepository({ createId: () => id(nextId++), now: () => fixtureDate, ...options })
}

async function createTestItem(repository) {
  return repository.createItem({
    name: 'Fictional stock test cups',
    category_id: id(4),
    unit_of_measurement: 'pieces',
    minimum_stock_level: '5',
  })
}

function command(itemId, type, quantity, unit, allocations = [], details = {}) {
  return { itemId, type, quantity, unit, scale: 0, allocations, ...details }
}

function assignment(batchId, quantity) {
  return { batchId, quantity }
}

async function submit(repository, movement) {
  const preview = await repository.previewStockMovement(movement)
  return repository.recordStockMovement(preview.attemptId)
}

async function rejectAndCompare(repository, movement, code) {
  const before = await repository.read()
  await assert.rejects(() => submit(repository, movement), { code })
  assert.deepEqual(await repository.read(), before)
}

test('a receipt creates one batch and one matching positive allocation while retaining the item ID', async () => {
  const repository = repositoryForTest()
  const before = await repository.read()
  const receipt = await submit(repository, command(beans, 'stock_in', '20', 'bags', [], {
    purchaseDate: '2026-11-18', expirationDate: '2026-11-22', reason: 'Fictional delivery',
  }))
  const after = await repository.read()
  assert.equal(receipt.movement.item_id, beans)
  assert.equal(receipt.movement.movement_type, 'stock_in')
  assert.equal(receipt.movement.quantity_change, 20)
  assert.equal(receipt.movement.reason, 'Fictional delivery')
  assert.equal(receipt.movement.recorded_by, null)
  assert.equal(receipt.batch.item_id, beans)
  assert.equal(receipt.batch.received_quantity, 20)
  assert.equal(receipt.batch.purchase_date, '2026-11-18')
  assert.equal(receipt.batch.expiration_date, '2026-11-22')
  assert.equal(receipt.batch.purchase_cost, null)
  assert.equal(receipt.allocations.length, 1)
  const [allocation] = receipt.allocations
  assert.equal(allocation.movement_id, receipt.movement.movement_id)
  assert.equal(allocation.batch_id, receipt.batch.batch_id)
  assert.equal(allocation.quantity_change, 20)
  assert.equal(after.stock_batches.length, before.stock_batches.length + 1)
  assert.equal(after.stock_movements.length, before.stock_movements.length + 1)
  assert.equal(after.batch_allocations.length, before.batch_allocations.length + 1)
  assert.deepEqual(after.inventory_items, before.inventory_items)
  const summary = summarizeInventory(after, demoBusinessDate)
  assert.equal(summary.itemBalances.get(beans), 26)
  assert.equal(summary.batchBalances.get(receipt.batch.batch_id), 20)
})

test('one usage movement can consume two explicitly assigned batches', async () => {
  const repository = repositoryForTest()
  const before = await repository.read()
  const usage = await submit(repository, command(beans, 'stock_out', '5', 'bags', [
    assignment(id(201), '2'), assignment(id(202), '3'),
  ]))
  assert.equal(usage.batch, null)
  assert.equal(usage.movement.quantity_change, -5)
  assert.deepEqual(usage.allocations.map(({ quantity_change }) => quantity_change), [-2, -3])
  assert.equal(new Set(usage.allocations.map(({ allocation_id }) => allocation_id)).size, 2)
  const after = await repository.read()
  assert.deepEqual(after.stock_batches, before.stock_batches)
  assert.deepEqual(after.stock_movements.slice(0, before.stock_movements.length), before.stock_movements)
  const summary = summarizeInventory(after, demoBusinessDate)
  assert.equal(summary.itemBalances.get(beans), 1)
  assert.equal(summary.batchBalances.get(id(201)), 0)
  assert.equal(summary.batchBalances.get(id(202)), 1)
})

test('the required stock scenario produces 0, 20, 15, 13, 14 and 10 with five movements', async () => {
  const repository = repositoryForTest()
  const item = await createTestItem(repository)
  const snapshot = await repository.read()
  const itemId = item.item_id
  const readItem = async () => buildInventoryReadModel(await repository.read()).itemById.get(itemId)
  assert.equal((await readItem()).availableQuantity, 0)
  const receipt = await submit(repository, command(itemId, 'stock_in', '20', 'pieces'))
  const batchId = receipt.batch.batch_id
  assert.equal((await readItem()).availableQuantity, 20)
  for (const [type, magnitude, difference, expected] of [
    ['stock_out', '5', -5, 15],
    ['wastage', '2', -2, 13],
    ['positive_adjustment', '1', 1, 14],
    ['negative_adjustment', '4', -4, 10],
  ]) {
    const result = await submit(repository, command(itemId, type, magnitude, 'pieces', [
      assignment(batchId, magnitude),
    ], { reason: 'Fictional stock count or disposal' }))
    assert.equal(result.movement.quantity_change, difference)
    const row = await readItem()
    assert.equal(row.availableQuantity, expected)
    assert.equal(row.batches[0].remainingQuantity, expected)
    assert.equal(row.batches[0].receivedQuantity, 20)
  }
  const beforeRejection = await repository.read()
  await rejectAndCompare(repository, command(itemId, 'stock_out', '11', 'pieces', [
    assignment(batchId, '11'),
  ]), 'INSUFFICIENT_STOCK')
  assert.equal(beforeRejection.stock_movements.length - snapshot.stock_movements.length, 5)
  assert.equal(beforeRejection.batch_allocations.length - snapshot.batch_allocations.length, 5)
  const final = await readItem()
  assert.equal(final.availableQuantity, 10)
  assert.equal(final.availableQuantity, final.batches.reduce((total, batch) => total + batch.remainingQuantity, 0))
  assert.equal(final.movements.length, 5)
})

test('rejects mismatched allocation sums, duplicate assignments and batches owned by other items', async () => {
  const repository = repositoryForTest()
  for (const allocations of [
    [],
    [assignment(id(201), '1')],
    [assignment(id(201), '1'), assignment(id(201), '1')],
    [assignment(id(203), '2')],
    [assignment(id(999), '2')],
  ]) {
    await rejectAndCompare(repository, command(beans, 'stock_out', '2', 'bags', allocations), 'INVALID_BATCH_ALLOCATION')
  }
})

test('blocks a deduction that overdraws an individual batch even when the item has enough stock', async () => {
  const repository = repositoryForTest()
  await rejectAndCompare(repository, command(beans, 'stock_out', '3', 'bags', [
    assignment(id(201), '3'),
  ]), 'INSUFFICIENT_STOCK')
})

test('validates positive whole quantities for both requested stock and assignments', async () => {
  const repository = repositoryForTest()
  for (const value of ['', '0', '0.1', '1.0', '1e2', '-1', '+1', '2 bags', '9007199254740992', Infinity, NaN]) {
    await rejectAndCompare(repository, command(beans, 'stock_in', value, 'bags'), 'INVALID_QUANTITY')
  }
  for (const value of ['0', '-1', '1.2', '1e0', '9007199254740992']) {
    const before = await repository.read()
    await assert.rejects(() => submit(repository, command(beans, 'stock_out', '1', 'bags', [assignment(id(201), value)])))
    assert.deepEqual(await repository.read(), before)
  }
})

test('allows the largest exact balance and rejects aggregate overflow', async () => {
  const repository = repositoryForTest()
  const { item_id: itemId } = await createTestItem(repository)
  const receipt = await submit(repository, command(itemId, 'stock_in', String(Number.MAX_SAFE_INTEGER), 'pieces'))
  assert.equal(receipt.resultingQuantity, Number.MAX_SAFE_INTEGER)
  await rejectAndCompare(repository, command(itemId, 'stock_in', '1', 'pieces'), 'INVALID_QUANTITY')
})

test('a usage movement may consume undated stock and leaves it unclassified', async () => {
  const repository = repositoryForTest()
  const usage = await submit(repository, command(id(102), 'stock_out', '3', 'bags', [assignment(id(203), '3')]))
  assert.equal(usage.resultingQuantity, 12)
  const model = buildInventoryReadModel(await repository.read())
  assert.equal(model.itemById.get(id(102)).batches[0].expirationStatus, 'undated')
})

test('demo eligibility blocks expired usage and positive adjustments but permits traced disposal and downward corrections', async () => {
  const repository = repositoryForTest()
  const allocations = [assignment(id(206), '1')]
  const reason = { reason: 'Expired fictional stock' }
  await rejectAndCompare(repository, command(oatMilk, 'stock_out', '1', 'cartons', allocations), 'INVALID_BATCH_ALLOCATION')
  await rejectAndCompare(repository, command(oatMilk, 'positive_adjustment', '1', 'cartons', allocations, reason), 'INVALID_BATCH_ALLOCATION')
  const waste = await submit(repository, command(oatMilk, 'wastage', '1', 'cartons', allocations, reason))
  assert.equal(waste.movement.reason, reason.reason)
  assert.equal(waste.resultingQuantity, 11)
  const correction = await submit(repository, command(oatMilk, 'negative_adjustment', '1', 'cartons', allocations, reason))
  assert.equal(correction.resultingQuantity, 10)
})

test('requires a reason for wastage and both kinds of adjustment', async () => {
  const repository = repositoryForTest()
  for (const type of ['wastage', 'positive_adjustment', 'negative_adjustment']) {
    await rejectAndCompare(repository, command(beans, type, '1', 'bags', [
      assignment(id(201), '1'),
    ], { reason: '  ' }), 'REASON_REQUIRED')
  }
})

test('rejects archived items, unknown items, unsupported movement types, and incompatible unit profiles', async () => {
  const repository = repositoryForTest()
  await rejectAndCompare(repository, command(id(113), 'stock_in', '1', 'packs'), 'ITEM_ARCHIVED')
  await rejectAndCompare(repository, command(id(999), 'stock_in', '1', 'packs'), 'ITEM_NOT_FOUND')
  await rejectAndCompare(repository, command(beans, 'initial_stock', '1', 'bags'), 'INVALID_MOVEMENT_TYPE')
  await rejectAndCompare(repository, command(beans, 'stock_in', '1', 'pieces'), 'INVALID_UNIT')
  await rejectAndCompare(repository, command(beans, 'stock_in', '1', 'bags', [], { scale: 1 }), 'INVALID_UNIT')
})

test('optional delivery dates remain null and calendar validation rejects impossible or reversed dates', async () => {
  const repository = repositoryForTest()
  for (const dates of [
    { purchaseDate: '2026-02-29' },
    { expirationDate: '2026-11-31' },
    { purchaseDate: '2026-11-19', expirationDate: '2026-11-18' },
  ]) {
    await rejectAndCompare(repository, command(beans, 'stock_in', '1', 'bags', [], dates), 'INVALID_DATE')
  }
  const { batch } = await submit(repository, command(beans, 'stock_in', '1', 'bags'))
  assert.equal(batch.purchase_date, null)
  assert.equal(batch.expiration_date, null)
})

test('a bad recording timestamp or conflicting identifier leaves all shared records intact', async () => {
  const badClock = repositoryForTest({ now: () => '2026-02-30T07:00:00Z' })
  await rejectAndCompare(badClock, command(beans, 'stock_in', '1', 'bags'), 'INVALID_TIMESTAMP')
  const duplicateId = repositoryForTest({ createId: () => demoInventory.stock_movements[0].movement_id })
  await rejectAndCompare(duplicateId, command(beans, 'stock_in', '1', 'bags'), 'ID_UNAVAILABLE')
})

test('equal timestamps preserve the receipt prerequisite and a backward clock cannot reorder a subsequent deduction', async () => {
  let now = '2026-11-18T09:00:00Z'
  const repository = repositoryForTest({ now: () => now })
  const receipt = await submit(repository, command(beans, 'stock_in', '3', 'bags'))
  const allocations = [assignment(receipt.batch.batch_id, '1')]
  const sameTime = await submit(repository, command(beans, 'stock_out', '1', 'bags', allocations))
  assert.equal(sameTime.movement.created_at, receipt.movement.created_at)
  now = '2026-11-16T09:00:00Z'
  const earlierTime = await submit(repository, command(beans, 'stock_out', '1', 'bags', allocations))
  const snapshot = await repository.read()
  assert.equal(earlierTime.movement.created_at, now)
  assert.equal(summarizeInventory(snapshot, demoBusinessDate).batchBalances.get(receipt.batch.batch_id), 1)
  assert.equal(summarizeInventory(snapshot, demoBusinessDate).itemBalances.get(beans), 7)
  assert.equal(summarizeInventory(snapshot, demoBusinessDate).recentMovements[0].movementId, earlierTime.movement.movement_id)
  assert.deepEqual(snapshot.stock_movements.slice(0, demoInventory.stock_movements.length), demoInventory.stock_movements)
})

test('repeat and concurrent confirmations of one attempt return the same movement', async () => {
  const repository = repositoryForTest()
  const before = await repository.read()
  const preview = await repository.previewStockMovement(command(beans, 'stock_in', '2', 'bags'))
  assert.deepEqual(await repository.read(), before)
  const [first, repeat] = await Promise.all([
    repository.recordStockMovement(preview.attemptId),
    repository.recordStockMovement(preview.attemptId),
  ])
  assert.equal(first.movement.movement_id, repeat.movement.movement_id)
  assert.deepEqual([first.alreadyRecorded, repeat.alreadyRecorded].sort(), [false, true])
  assert.equal((await repository.read()).stock_movements.length, before.stock_movements.length + 1)
  first.movement.reason = 'Changed by a caller'
  const later = await repository.recordStockMovement(preview.attemptId)
  assert.notEqual(later.movement.reason, first.movement.reason)
})

test('a stock change invalidates an older preview and requiring a new review preserves the latest balances', async () => {
  const repository = repositoryForTest()
  const pending = await repository.previewStockMovement(command(beans, 'stock_in', '2', 'bags'))
  await submit(repository, command(beans, 'stock_in', '1', 'bags'))
  const before = await repository.read()
  await assert.rejects(() => repository.recordStockMovement(pending.attemptId), { code: 'STALE_PREVIEW' })
  assert.deepEqual(await repository.read(), before)
})

test('an accepted submission identifier cannot be reused to record different stock contents', async () => {
  const attemptId = id(21001)
  const generatedIds = [attemptId, id(21002), id(21003), attemptId]
  const repository = repositoryForTest({ createId: () => generatedIds.shift() })
  const input = command(beans, 'stock_in', '2', 'bags', [], { reason: 'Original delivery' })
  const preview = await repository.previewStockMovement(input)
  input.quantity = '9'
  input.reason = 'Edited after preview'
  const original = await repository.recordStockMovement(preview.attemptId)
  assert.equal(original.movement.quantity_change, 2)
  assert.equal(original.movement.reason, 'Original delivery')
  const saved = await repository.read()
  await assert.rejects(() => repository.previewStockMovement(input), { code: 'ID_UNAVAILABLE' })
  const replay = await repository.recordStockMovement(attemptId)
  assert.equal(replay.alreadyRecorded, true)
  assert.deepEqual(replay.movement, original.movement)
  assert.deepEqual(await repository.read(), saved)
})

test('canceling a review invalidates its attempt and leaves the complete ledger unchanged', async () => {
  const repository = repositoryForTest()
  const before = await repository.read()
  const preview = await repository.previewStockMovement(command(beans, 'stock_in', '2', 'bags'))
  repository.discardStockPreview(preview.attemptId)
  await assert.rejects(() => repository.recordStockMovement(preview.attemptId), { code: 'STALE_PREVIEW' })
  assert.deepEqual(await repository.read(), before)
})

test('recorded stock updates the shared inventory, expiration summary and dashboard, and a fresh session resets them', async () => {
  const repository = repositoryForTest()
  const { item_id: itemId } = await createTestItem(repository)
  const created = buildInventoryReadModel(await repository.read())
  assert.equal(created.summary.counts.totalActive, 13)
  assert.equal(created.summary.counts.outOfStock, 3)
  const receipt = await submit(repository, command(itemId, 'stock_in', '4', 'pieces', [], { expirationDate: demoBusinessDate }))
  const changed = buildInventoryReadModel(await repository.read())
  assert.equal(changed.itemById.get(itemId).stockStatus, 'low-stock')
  assert.equal(changed.itemById.get(itemId).availableQuantity, 4)
  assert.equal(changed.summary.counts.expiringSoon, 4)
  assert.equal(changed.summary.counts.outOfStock, 2)
  assert.equal(changed.summary.recentMovements[0].movementId, receipt.movement.movement_id)
  assert.equal(changed.categoryById.get(id(4)).activeItemCount, created.categoryById.get(id(4)).activeItemCount)
  const reset = await repositoryForTest().read()
  assert.deepEqual(reset, demoInventory)
  const summary = summarizeInventory(reset, demoBusinessDate)
  assert.deepEqual(summary.counts, { totalActive: 12, sufficient: 7, lowStock: 3, outOfStock: 2, expiringSoon: 3 })
  assert.equal(summary.attentionItems.length, 7)
  assert.equal(summary.recentMovements.length, 5)
})
