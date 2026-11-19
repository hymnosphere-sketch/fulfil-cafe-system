import assert from 'node:assert/strict'
import test from 'node:test'
import { demoInventory } from '../src/data/demo-inventory.js'
import { createDemoInventoryRepository } from '../src/data/demo-inventory-repository.js'
import { renderHistoryList, renderHistoryRows, renderTransactionDetail } from '../src/pages/transaction-history.js'
import {
  buildTransactionHistory, filterTransactionHistory,
} from '../src/services/transaction-history.js'

function demoId(number) {
  return '00000000-0000-4000-8000-' + String(number).padStart(12, '0')
}

test('history includes the complete ledger, deterministic ties, and both allocations for a withdrawal', () => {
  const model = buildTransactionHistory(structuredClone(demoInventory))
  assert.equal(model.movements.length, demoInventory.stock_movements.length)
  assert.deepEqual(model.movements.slice(0, 3).map(({ movementId }) => movementId), [358, 356, 357].map(demoId))

  const withdrawal = model.movementById.get(demoId(356))
  assert.equal(withdrawal.quantity, -6)
  assert.equal(withdrawal.unit, 'bags')
  assert.deepEqual(withdrawal.allocations, [201, 202].map((batch) => ({ batchId: demoId(batch), quantity: -3 })))
})

test('history combines item, movement type, and inclusive calendar-date filters', () => {
  const { movements } = buildTransactionHistory(structuredClone(demoInventory))
  const result = filterTransactionHistory(movements, {
    itemId: demoId(101), type: 'stock_out', fromDate: '2026-11-19', toDate: '2026-11-19',
  })
  assert.deepEqual(result.errors, {})
  assert.deepEqual(result.movements.map(({ movementId }) => movementId), [demoId(356)])
})

test('history interprets both inclusive date bounds in the Asia/Manila timezone', () => {
  const snapshot = structuredClone(demoInventory)
  const timestamps = [
    '2026-11-18T15:59:59.999Z',
    '2026-11-18T16:00:00.000Z',
    '2026-11-19T15:59:59.999Z',
    '2026-11-19T16:00:00.000Z',
  ]
  snapshot.stock_movements = snapshot.stock_movements.slice(0, 4).map((movement, index) => ({
    ...movement, created_at: timestamps[index],
  }))
  snapshot.stock_batches = snapshot.stock_batches.slice(0, 4)
  const receiptIds = new Set(snapshot.stock_movements.map((movement) => movement.movement_id))
  snapshot.batch_allocations = snapshot.batch_allocations.filter((allocation) => receiptIds.has(allocation.movement_id))
  const { movements } = buildTransactionHistory(snapshot)

  assert.deepEqual(movements.map(({ businessDay }) => businessDay), [20261120, 20261119, 20261119, 20261118])
  assert.deepEqual(filterTransactionHistory(movements, {
    fromDate: '2026-11-19', toDate: '2026-11-19',
  }).movements.map(({ timestamp }) => timestamp), [timestamps[2], timestamps[1]])
})

test('history rejects impossible dates and reversed ranges with actionable field errors', () => {
  const { movements } = buildTransactionHistory(structuredClone(demoInventory))
  assert.deepEqual(filterTransactionHistory(movements, { fromDate: '2026-02-30', toDate: 'tomorrow' }), {
    errors: { fromDate: 'Enter a valid start date.', toDate: 'Enter a valid end date.' },
    movements: [],
  })
  assert.deepEqual(filterTransactionHistory(movements, { fromDate: '2026-11-20', toDate: '2026-11-19' }), {
    errors: { toDate: 'Enter an end date on or after the start date.' },
    movements: [],
  })
})

test('archived items stay in the item filter and retain category and movement references', () => {
  const model = buildTransactionHistory(structuredClone(demoInventory))
  const archived = model.items.find(({ itemId }) => itemId === demoId(113))
  assert.equal(archived.isActive, false)
  assert.equal(archived.categoryName, 'Beverage ingredients')
  const { movements } = filterTransactionHistory(model.movements, { itemId: archived.itemId })
  assert.deepEqual(movements.map(({ movementId }) => movementId), [355, 314].map(demoId))
  assert.equal(movements[0].reason, 'Damaged packaging')
  assert.equal(movements[0].categoryName, archived.categoryName)
})

test('history list and detail escape recorded text, identifiers, and navigation parameters', () => {
  const itemId = 'item&<tag>"'
  const movement = {
    movementId: 'movement&<id>"',
    itemId,
    name: '<img src=x onerror="alert(1)">',
    categoryName: '<script>bad()</script>',
    isActive: false,
    type: 'wastage',
    quantity: -3,
    unit: 'bags<script>',
    timestamp: '2026-11-18T09:00:00Z',
    reason: 'Discarded <b>spoiled</b> stock',
    allocations: [{ batchId: 'batch&<id>"', quantity: -3 }],
  }
  const filters = { itemId }
  const rows = renderHistoryRows([movement], 'Asia/Manila', filters)
  const details = renderTransactionDetail(movement, 'Asia/Manila', filters)
  for (const markup of [rows, details]) {
    assert.doesNotMatch(markup, /<img|<script|<b>/)
    assert.match(markup, /&lt;img /)
    assert.match(markup, /Discarded &lt;b&gt;spoiled&lt;\/b&gt; stock/)
    assert.ok(markup.includes(encodeURIComponent(itemId)))
    assert.match(markup, /\(archived\)/)
  }
  assert.match(details, /movement&amp;&lt;id&gt;&quot;/)
  assert.match(details, /batch&amp;&lt;id&gt;&quot;/)
})

test('identical History item choices show distinct labels and filter by their full stable IDs', () => {
  const snapshot = structuredClone(demoInventory)
  const firstId = demoId(101)
  const secondId = demoId(102)
  const first = snapshot.inventory_items.find(({ item_id }) => item_id === firstId)
  const second = snapshot.inventory_items.find(({ item_id }) => item_id === secondId)
  second.name = first.name
  assert.equal(second.category_id, first.category_id)
  assert.equal(second.unit_of_measurement, first.unit_of_measurement)
  const model = buildTransactionHistory(snapshot)
  const filters = { itemId: firstId, type: '', fromDate: '', toDate: '' }
  const markup = renderHistoryList(model, filters)
  const options = new Map([...markup.matchAll(/<option value="([^"]*)"([^>]*)>([^<]*)<\/option>/g)]
    .map(([, value, attributes, label]) => [value, { attributes, label }]))
  const firstChoice = options.get(firstId)
  const secondChoice = options.get(secondId)
  assert.match(firstChoice.label, /^Item \S+ · Single origin beans · Coffee · bags$/)
  assert.match(secondChoice.label, /^Item \S+ · Single origin beans · Coffee · bags$/)
  assert.notEqual(firstChoice.label, secondChoice.label)
  assert.match(firstChoice.attributes, /selected/)
  assert.doesNotMatch(secondChoice.attributes, /selected/)
  assert.match(options.get(demoId(113)).label, /Seasonal drink mix · Beverage ingredients · .+ \(archived\)/)
  for (const itemId of [firstId, secondId]) {
    const selected = filterTransactionHistory(model.movements, { itemId }).movements
    assert.deepEqual(selected.map(({ movementId }) => movementId),
      model.movements.filter((movement) => movement.itemId === itemId).map(({ movementId }) => movementId))
    assert.ok(selected.length > 0)
  }
})

test('catalog renames update History labels without altering original movements and allocations', async () => {
  const repository = createDemoInventoryRepository()
  const original = await repository.read()
  const itemId = demoId(101)
  const item = original.inventory_items.find(({ item_id }) => item_id === itemId)
  const before = buildTransactionHistory(original).movementById.get(demoId(356))
  await repository.updateItem(itemId, {
    name: 'Fictional house selection',
    category_id: item.category_id,
    unit_of_measurement: item.unit_of_measurement,
    minimum_stock_level: item.minimum_stock_level,
  })
  await repository.updateCategory(item.category_id, { name: 'Fictional coffee selection', description: '' })
  const changed = await repository.read()
  const after = buildTransactionHistory(changed).movementById.get(demoId(356))
  assert.deepEqual(after, { ...before, name: 'Fictional house selection', categoryName: 'Fictional coffee selection' })
  assert.deepEqual(changed.stock_movements, original.stock_movements)
  assert.deepEqual(changed.batch_allocations, original.batch_allocations)
  assert.deepEqual(changed.stock_batches, original.stock_batches)
})
