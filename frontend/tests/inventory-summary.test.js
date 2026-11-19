import assert from 'node:assert/strict'
import { test } from 'node:test'

import { readDemoInventory } from '../src/data/demo-data-provider.js'
import { demoBusinessDate, demoInventory } from '../src/data/demo-inventory.js'
import { summarizeInventory } from '../src/services/inventory-summary.js'

const businessDate = '2026-11-19'
const openingTimestamp = '2026-11-01T01:00:00Z'
const categoryId = '00000000-0000-4000-8000-100000000001'

function fixtureId(group, number) {
  return '00000000-0000-4000-8000-' + group + String(number).padStart(11, '0')
}

function createSnapshot(warningDays = 7) {
  return {
    categories: [{
      category_id: categoryId,
      name: 'Test goods',
      normalized_name: 'test goods',
      is_active: true,
      created_at: openingTimestamp,
      updated_at: openingTimestamp,
    }],
    inventory_items: [],
    stock_batches: [],
    stock_movements: [],
    batch_allocations: [],
    settings: {
      settings_version: 1,
      business_timezone: 'Asia/Manila',
      expiration_warning_days: warningDays,
    },
  }
}

function addItem(snapshot, name, { minimum = 5, active = true } = {}) {
  const item = {
    item_id: fixtureId(2, snapshot.inventory_items.length + 1),
    category_id: categoryId,
    name,
    normalized_name: name.toLowerCase(),
    unit_of_measurement: 'pieces',
    minimum_stock_level: minimum,
    is_active: active,
    created_at: openingTimestamp,
    updated_at: openingTimestamp,
  }
  snapshot.inventory_items.push(item)
  return item
}

function addMovement(snapshot, item, batchAmounts, { type, timestamp = openingTimestamp, number } = {}) {
  const movement = {
    movement_id: fixtureId(4, number ?? snapshot.stock_movements.length + 1),
    item_id: item.item_id,
    movement_type: type,
    quantity_change: batchAmounts.reduce((sum, [, quantity]) => sum + quantity, 0),
    reason: null,
    recorded_by: null,
    created_at: timestamp,
  }
  snapshot.stock_movements.push(movement)
  for (const [batch, quantity] of batchAmounts) {
    snapshot.batch_allocations.push({
      allocation_id: fixtureId(5, snapshot.batch_allocations.length + 1),
      movement_id: movement.movement_id,
      batch_id: batch.batch_id,
      quantity_change: quantity,
    })
  }
  return movement
}

function addBatch(snapshot, item, quantity, { expires = null, type = 'initial_stock', timestamp = openingTimestamp, number } = {}) {
  const batch = {
    batch_id: fixtureId(3, snapshot.stock_batches.length + 1),
    item_id: item.item_id,
    received_quantity: quantity,
    purchase_date: null,
    purchase_cost: null,
    expiration_date: expires,
    created_at: timestamp,
  }
  snapshot.stock_batches.push(batch)
  addMovement(snapshot, item, [[batch, quantity]], { type, timestamp, number })
  return batch
}

test('derives item and batch balances by applying signed records once', () => {
  const snapshot = createSnapshot()
  const item = addItem(snapshot, 'Coffee filters')
  const first = addBatch(snapshot, item, 20)
  const second = addBatch(snapshot, item, 10, { type: 'stock_in', timestamp: '2026-11-02T01:00:00Z' })
  addMovement(snapshot, item, [[first, -5], [second, -2]], { type: 'stock_out', timestamp: '2026-11-03T01:00:00Z' })
  addMovement(snapshot, item, [[second, 2]], { type: 'positive_adjustment', timestamp: '2026-11-04T01:00:00Z' })
  snapshot.stock_movements.reverse()
  const summary = summarizeInventory(snapshot, businessDate)

  assert.equal(summary.itemBalances.get(item.item_id), 25)
  assert.equal(summary.batchBalances.get(first.batch_id), 15)
  assert.equal(summary.batchBalances.get(second.batch_id), 10)
})

test('keeps zero stock separate from low stock and includes the minimum threshold', () => {
  const snapshot = createSnapshot()
  const zero = addItem(snapshot, 'Zero')
  const atMinimum = addItem(snapshot, 'At minimum')
  const below = addItem(snapshot, 'Below minimum')
  const above = addItem(snapshot, 'Above minimum')
  addBatch(snapshot, atMinimum, 5)
  addBatch(snapshot, below, 4)
  addBatch(snapshot, above, 6)

  const { counts, attentionItems } = summarizeInventory(snapshot, businessDate)
  assert.deepEqual(counts, { totalActive: 4, lowStock: 2, outOfStock: 1, sufficient: 1, expiringSoon: null })
  assert.deepEqual(attentionItems.map(({ itemId, alerts }) => [itemId, alerts]), [
    [zero.item_id, ['out-of-stock']],
    [atMinimum.item_id, ['low-stock']],
    [below.item_id, ['low-stock']],
  ])
})

test('excludes archived items from dashboard counts and keeps historical references', () => {
  const snapshot = createSnapshot()
  const archived = addItem(snapshot, 'Archived mixer', { active: false })
  const current = addItem(snapshot, 'Current mixer')
  const batch = addBatch(snapshot, archived, 4, { expires: '2026-11-19' })
  addMovement(snapshot, archived, [[batch, -4]], { type: 'stock_out', timestamp: '2026-11-18T05:00:00Z' })
  addBatch(snapshot, current, 9, { expires: '2026-12-01' })

  const summary = summarizeInventory(snapshot, businessDate)
  assert.equal(summary.counts.totalActive, 1)
  assert.equal(summary.counts.outOfStock, 0)
  assert.equal(summary.counts.expiringSoon, 0)
  assert.deepEqual(summary.attentionItems, [])
  assert.equal(summary.recentMovements[0].itemName, 'Archived mixer')
  assert.equal(summary.recentMovements[0].quantity, -4)
  assert.equal(summary.recentMovements[0].unit, 'pieces')
})

test('an empty inventory has zero stock group counts and no usable expiration data', () => {
  const summary = summarizeInventory(createSnapshot(), businessDate)
  assert.deepEqual(summary.counts, { totalActive: 0, lowStock: 0, outOfStock: 0, sufficient: 0, expiringSoon: null })
  assert.equal(summary.expirationUnavailableReason, 'no-dated-stock')
  assert.deepEqual(summary.attentionItems, [])
  assert.deepEqual(summary.recentMovements, [])
})

test('counts distinct active items with positive batches expiring today through the inclusive final warning day', () => {
  const snapshot = createSnapshot()
  const todayAndSoon = addItem(snapshot, 'Today and soon')
  const finalDay = addItem(snapshot, 'Final day')
  const later = addItem(snapshot, 'After the warning window')
  const expired = addItem(snapshot, 'Expired')
  addBatch(snapshot, todayAndSoon, 6, { expires: '2026-11-19' })
  addBatch(snapshot, todayAndSoon, 6, { expires: '2026-11-21' })
  addBatch(snapshot, finalDay, 6, { expires: '2026-11-26' })
  addBatch(snapshot, later, 6, { expires: '2026-11-27' })
  addBatch(snapshot, expired, 6, { expires: '2026-11-18' })

  const summary = summarizeInventory(snapshot, businessDate)
  assert.equal(summary.counts.expiringSoon, 2)
  assert.equal(summary.expirationUnavailableReason, null)
  assert.equal(summary.itemBalances.get(expired.item_id), 6)
  assert.deepEqual(summary.attentionItems.map(({ itemId, alerts }) => [itemId, alerts]), [
    [expired.item_id, ['expired']],
    [finalDay.item_id, ['expiring-soon']],
    [todayAndSoon.item_id, ['expiring-soon']],
  ])
})

test('handles an inclusive expiration window across the end of a year', () => {
  const snapshot = createSnapshot(2)
  const finalDay = addItem(snapshot, 'Final day')
  const later = addItem(snapshot, 'After the warning window')
  addBatch(snapshot, finalDay, 9, { expires: '2027-01-02' })
  addBatch(snapshot, later, 9, { expires: '2027-01-03' })

  const { counts, attentionItems } = summarizeInventory(snapshot, '2026-12-31')
  assert.equal(counts.expiringSoon, 1)
  assert.deepEqual(attentionItems.map(({ itemId }) => itemId), [finalDay.item_id])
})

test('ignores depleted batches and distinguishes undated stock from zero upcoming expirations', () => {
  const snapshot = createSnapshot()
  const item = addItem(snapshot, 'Two lots')
  const depleted = addBatch(snapshot, item, 4, { expires: '2026-11-19' })
  addBatch(snapshot, item, 8)
  addMovement(snapshot, item, [[depleted, -4]], { type: 'stock_out', timestamp: '2026-11-15T02:00:00Z' })

  const unavailable = summarizeInventory(snapshot, businessDate)
  assert.equal(unavailable.batchBalances.get(depleted.batch_id), 0)
  assert.equal(unavailable.counts.expiringSoon, null)
  assert.equal(unavailable.expirationUnavailableReason, 'no-dated-stock')
  assert.deepEqual(unavailable.attentionItems, [])

  addBatch(snapshot, item, 8, { expires: '2026-12-01' })
  const known = summarizeInventory(snapshot, businessDate)
  assert.equal(known.counts.expiringSoon, 0)
  assert.equal(known.expirationUnavailableReason, null)
  assert.deepEqual(known.attentionItems, [])
})

test('an unset warning period leaves upcoming counts unavailable while retaining expired-stock alerts', () => {
  const snapshot = createSnapshot(null)
  const alreadyExpired = addItem(snapshot, 'Expired')
  const today = addItem(snapshot, 'Dated today')
  addBatch(snapshot, alreadyExpired, 6, { expires: '2026-11-18' })
  addBatch(snapshot, today, 6, { expires: '2026-11-19' })

  const summary = summarizeInventory(snapshot, businessDate)
  assert.equal(summary.counts.expiringSoon, null)
  assert.equal(summary.expirationUnavailableReason, 'warning-period-unset')
  assert.deepEqual(summary.attentionItems.map(({ itemId, alerts }) => [itemId, alerts]), [
    [alreadyExpired.item_id, ['expired']],
  ])
})

test('collects all applicable conditions in one deterministic attention row per item', () => {
  const snapshot = createSnapshot()
  const lowSoonAndExpired = addItem(snapshot, 'Several alerts')
  const noStock = addItem(snapshot, 'No stock')
  const onlyLow = addItem(snapshot, 'Low alone')
  addBatch(snapshot, lowSoonAndExpired, 3, { expires: '2026-11-18' })
  addBatch(snapshot, lowSoonAndExpired, 2, { expires: '2026-11-20' })
  addBatch(snapshot, onlyLow, 4)

  const summary = summarizeInventory(snapshot, businessDate)
  assert.deepEqual(summary.attentionItems.map(({ itemId }) => itemId), [
    noStock.item_id, lowSoonAndExpired.item_id, onlyLow.item_id,
  ])
  const [, combined] = summary.attentionItems
  assert.deepEqual(new Set(combined.alerts), new Set(['expired', 'low-stock', 'expiring-soon']))
  assert.equal(combined.alerts.length, 3)
  assert.equal(combined.quantity, 5)
  assert.equal(combined.unit, 'pieces')
})

test('orders five recent movements by UTC instant, breaks ties by ID, and preserves the snapshot', () => {
  const snapshot = createSnapshot()
  const item = addItem(snapshot, 'Reusable cup')
  const timestamps = [
    '2026-11-14T01:00:00Z',
    '2026-11-18T06:00:00.000Z',
    '2026-11-10T01:00:00Z',
    '2026-11-18T06:00:00Z',
    '2026-11-12T01:00:00Z',
    '2026-11-11T01:00:00Z',
  ]
  timestamps.forEach((timestamp) => addBatch(snapshot, item, 4, { timestamp }))
  const original = structuredClone(snapshot)

  const summary = summarizeInventory(snapshot, businessDate)
  assert.deepEqual(summary.recentMovements.map(({ movementId }) => movementId), [
    fixtureId(4, 2), fixtureId(4, 4), fixtureId(4, 1), fixtureId(4, 5), fixtureId(4, 6),
  ])
  assert.deepEqual(snapshot, original)
})

test('rejects negative item stock instead of showing it as zero', () => {
  const snapshot = createSnapshot()
  const item = addItem(snapshot, 'Missing item balance')
  const batch = addBatch(snapshot, item, 4)
  addMovement(snapshot, item, [[batch, -5]], { type: 'stock_out', timestamp: '2026-11-02T01:00:00Z' })
  assert.throws(() => summarizeInventory(snapshot, businessDate))
})

test('rejects negative batch stock even if the combined item balance is nonnegative', () => {
  const snapshot = createSnapshot()
  const item = addItem(snapshot, 'Two deliveries')
  const first = addBatch(snapshot, item, 4)
  addBatch(snapshot, item, 5)
  addMovement(snapshot, item, [[first, -5]], { type: 'stock_out', timestamp: '2026-11-02T01:00:00Z' })
  assert.throws(() => summarizeInventory(snapshot, businessDate))
})

test('rejects invalid thresholds, unsafe movements and unsafe intermediate totals', () => {
  for (const minimum of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const snapshot = createSnapshot()
    addItem(snapshot, 'Invalid minimum', { minimum })
    assert.throws(() => summarizeInventory(snapshot, businessDate))
  }

  const invalidMovement = createSnapshot()
  addBatch(invalidMovement, addItem(invalidMovement, 'Unsafe movement'), Number.MAX_SAFE_INTEGER + 1)
  assert.throws(() => summarizeInventory(invalidMovement, businessDate))

  const overflow = createSnapshot()
  const item = addItem(overflow, 'Unsafe total')
  addBatch(overflow, item, Number.MAX_SAFE_INTEGER)
  addBatch(overflow, item, 1, { type: 'stock_in', timestamp: '2026-11-02T01:00:00Z' })
  assert.throws(() => summarizeInventory(overflow, businessDate))
})

test('rejects mismatched allocations and contradictory item relationships', () => {
  const snapshot = createSnapshot()
  const first = addItem(snapshot, 'First item')
  const second = addItem(snapshot, 'Second item')
  addBatch(snapshot, first, 9)
  const otherBatch = addBatch(snapshot, second, 9)

  const wrongTotal = structuredClone(snapshot)
  wrongTotal.batch_allocations[0].quantity_change = 8
  assert.throws(() => summarizeInventory(wrongTotal, businessDate))

  const wrongItem = structuredClone(snapshot)
  wrongItem.batch_allocations[0].batch_id = otherBatch.batch_id
  assert.throws(() => summarizeInventory(wrongItem, businessDate))
})

test('rejects a non-calendar expiration date', () => {
  const snapshot = createSnapshot()
  addBatch(snapshot, addItem(snapshot, 'Invalid date'), 6, { expires: '2026-11-31' })
  assert.throws(() => summarizeInventory(snapshot, businessDate))
})

test('the demo snapshot produces its specified summary and still includes archived movement history', () => {
  const original = structuredClone(demoInventory)
  const summary = summarizeInventory(demoInventory, demoBusinessDate)
  const archivedNames = new Set(demoInventory.inventory_items.filter(({ is_active }) => !is_active).map(({ name }) => name))

  assert.deepEqual(summary.counts, { totalActive: 12, lowStock: 3, outOfStock: 2, sufficient: 7, expiringSoon: 3 })
  assert.equal(summary.expirationUnavailableReason, null)
  assert.equal(summary.attentionItems.length, 7)
  assert.equal(summary.recentMovements.length, 5)
  assert.ok(summary.recentMovements.some(({ itemName }) => archivedNames.has(itemName)))
  assert.deepEqual(demoInventory, original)
})

test('the demo provider supplies isolated snapshots, valid empty and unavailable data, and a distinct read failure', async () => {
  const firstRead = await readDemoInventory()
  const secondRead = await readDemoInventory()
  assert.deepEqual(firstRead, secondRead)
  assert.notEqual(firstRead, secondRead)
  assert.notEqual(firstRead.inventory_items[0], secondRead.inventory_items[0])
  firstRead.inventory_items[0].name = 'Local edit'
  assert.notEqual(firstRead.inventory_items[0].name, secondRead.inventory_items[0].name)

  const empty = summarizeInventory(await readDemoInventory({ scenario: 'empty' }), demoBusinessDate)
  const unavailable = summarizeInventory(await readDemoInventory({ scenario: 'unavailable' }), demoBusinessDate)
  assert.equal(empty.counts.totalActive, 0)
  assert.equal(unavailable.counts.totalActive, 12)
  assert.equal(unavailable.counts.expiringSoon, null)
  assert.equal(unavailable.expirationUnavailableReason, 'warning-period-unset')
  await assert.rejects(readDemoInventory({ scenario: 'error' }))
})
