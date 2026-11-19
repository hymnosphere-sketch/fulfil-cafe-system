import assert from 'node:assert/strict'
import test from 'node:test'
import { readDemoInventory } from '../src/data/demo-data-provider.js'
import { buildInventoryReadModel } from '../src/services/inventory-read-model.js'
import { calculateStockPreview } from '../src/services/stock-preview.js'
import {
  renderStockConfirmation, renderStockForm, renderStockSuccess, renderStockTotals,
  stockItemOptions,
} from '../src/pages/stock-rendering.js'
import { shortRecordReferences as shortStockReferences } from '../src/utils/catalog-display.js'

function createDraft(workflow, itemId, overrides = {}) {
  return {
    workflow, itemId, query: '', quantity: '', purchaseDate: '', expirationDate: '', reason: '', direction: '',
    allocations: new Map(), busy: false, error: null, ...overrides,
  }
}

test('stock forms escape record names, values, and validation errors', async () => {
  const snapshot = await readDemoInventory()
  const payload = '<img src=x onerror="alert(1)">'
  const item = snapshot.inventory_items[0]
  item.name = payload
  const model = buildInventoryReadModel(snapshot)
  const draft = createDraft('receive', item.item_id, {
    reason: payload,
    error: { field: 'quantity', message: payload },
  })

  const html = renderStockForm(draft, model)
  assert.doesNotMatch(html, /<img/)
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/)
  assert.match(html, /aria-invalid="true" aria-describedby="stock-quantity-help stock-quantity-error"/)
})

test('ordinary usage shows expired stock and its restriction while wastage enables the same batch', async () => {
  const model = buildInventoryReadModel(await readDemoInventory())
  const item = model.items.find((record) => record.name === 'Oat milk')
  const [batch] = item.batches
  const batchInput = new RegExp(`data-stock-batch-id="${batch.batchId}" disabled`)

  const usage = renderStockForm(createDraft('usage', item.itemId), model)
  assert.match(usage, /Ordinary usage excludes expired batches/)
  assert.match(usage, batchInput)
  assert.match(usage, /Expiration/)
  assert.match(usage, /Expired/)

  const wastage = renderStockForm(createDraft('wastage', item.itemId), model)
  assert.doesNotMatch(wastage, batchInput)
  assert.match(wastage, /id="stock-reason" name="reason" required/)
})

test('assignment totals show quantity assigned and remaining across selected batches', async () => {
  const model = buildInventoryReadModel(await readDemoInventory())
  const item = model.items.find((record) => record.name === 'Single origin beans')
  const [first, second] = item.batches
  const html = renderStockTotals(createDraft('usage', item.itemId, {
    quantity: '5',
    allocations: new Map([[first.batchId, '2'], [second.batchId, '1']]),
  }), item)

  assert.match(html, /Requested change<\/dt><dd>−5 bags/)
  assert.match(html, /Expected balance<\/dt><dd><span data-stock-resulting-quantity>1 bag/)
  assert.match(html, /Total allocated<\/dt><dd>3 bags/)
  assert.match(html, /Remaining to allocate<\/dt><dd>2 bags/)
})

test('stock confirmation displays signed changes and escapes user text and identifiers', () => {
  const preview = {
    type: 'stock_in',
    item: { itemId: 'item"id', name: '<Coffee>', categoryName: 'Coffee', unit: 'bags' },
    currentQuantity: 0,
    quantityChange: 20,
    resultingQuantity: 20,
    purchaseDate: '2026-11-19',
    expirationDate: null,
    reason: '<img src=x onerror=alert(1)>',
    assignments: [{ isNew: true, batchId: 'new"id', quantityChange: 20, remainingQuantity: 0, resultingQuantity: 20 }],
  }
  const html = renderStockConfirmation(preview)
  assert.doesNotMatch(html, /<Coffee>|<img/)
  assert.match(html, /&lt;Coffee&gt;/)
  assert.match(html, /new&quot;id/)
  assert.match(html, /Quantity change<\/dt><dd>\+20 bags/)
  assert.match(html, /datetime="2026-11-19"/)
  assert.match(html, /Expiration date<\/dt><dd>Not recorded/)
  assert.match(renderStockSuccess({ movement: { item_id: 'one&two', movement_id: 'movement' } }),
    /#\/history\?item=one%26two&amp;movement=movement/)
})

test('preview distinguishes an empty draft, invalid magnitudes and unavailable exact balances', async () => {
  const model = buildInventoryReadModel(await readDemoInventory())
  const item = model.items[0]
  const preview = (quantity, record = item) =>
    calculateStockPreview(createDraft('receive', item.itemId, { quantity }), record, 'stock_in', model.businessDate)
  assert.equal(preview('').state, 'incomplete')
  for (const quantity of ['0', '1e2', '1.5', '-1']) assert.equal(preview(quantity).state, 'invalid-input')
  const unknown = preview('1', { ...item, availableQuantity: undefined })
  assert.equal(unknown.state, 'unavailable')
  assert.equal(unknown.expected, null)
  assert.equal(preview(String(Number.MAX_SAFE_INTEGER), { ...item, availableQuantity: 1 }).state, 'unavailable')
  const receipt = renderStockTotals(createDraft('receive', item.itemId, { quantity: '3' }), item, model.businessDate)
  assert.match(receipt, /data-stock-tone="success"/)
  assert.doesNotMatch(receipt, /<progress/)
})

test('allocation progress covers zero, partial, complete, excessive, and malformed assignments', async () => {
  const model = buildInventoryReadModel(await readDemoInventory())
  const item = model.items.find(({ name }) => name === 'Single origin beans')
  const [first, second] = item.batches
  const preview = (firstAmount, secondAmount, quantity = '5') => {
    const allocations = new Map([[first.batchId, firstAmount], [second.batchId, secondAmount]].filter(([, value]) => value !== ''))
    return calculateStockPreview(createDraft('usage', item.itemId, { quantity, allocations }), item, 'stock_out', model.businessDate)
  }
  assert.deepEqual(preview('', '').progress, { assigned: 0, requested: 5 })
  assert.equal(preview('2', '1').state, 'incomplete-allocation')
  assert.deepEqual(preview('2', '1').progress, { assigned: 3, requested: 5 })
  assert.equal(preview('2', '3').state, 'valid')
  assert.deepEqual(preview('2', '3').progress, { assigned: 5, requested: 5 })
  assert.equal(preview('2', '4').state, 'excessive-allocation')
  assert.equal(preview('2', '4').progress, null)
  assert.equal(preview('abc', '4').state, 'invalid-input')
  assert.equal(preview('abc', '4').assigned, null)
  assert.equal(preview('', '', '0').progress, null)
})

test('a complete allocation can still overdraw one batch and item shortages have no negative expected balance', async () => {
  const model = buildInventoryReadModel(await readDemoInventory())
  const item = model.items.find(({ name }) => name === 'Single origin beans')
  const [batch] = item.batches
  const draft = createDraft('usage', item.itemId, { quantity: '3', allocations: new Map([[batch.batchId, '3']]) })
  const html = renderStockTotals(draft, item, model.businessDate)
  assert.match(html, /data-stock-preview-state="insufficient-batch" data-stock-tone="error"/)
  assert.match(html, /value="3" max="3"/)
  assert.match(html, /Shortage<\/dt><dd>1 bag/)
  assert.match(html, /No movement recorded/)
  const itemShortage = renderStockTotals({ ...draft, quantity: '7' }, item, model.businessDate)
  assert.match(itemShortage, /data-stock-preview-state="insufficient-item"/)
  assert.match(itemShortage, /<span data-stock-resulting-quantity>Unavailable/)
  assert.match(itemShortage, /Shortage<\/dt><dd>1 bag/)
})

test('recorded and eligible quantities distinguish expired, undated and uncertain batches', async () => {
  const model = buildInventoryReadModel(await readDemoInventory())
  const item = model.items.find(({ name }) => name === 'Oat milk')
  const expired = item.batches[0]
  const undated = { ...expired, batchId: 'undated', remainingQuantity: 3, expirationDate: null }
  const record = { ...item, availableQuantity: item.availableQuantity + 3, batches: [expired, undated] }
  const draft = createDraft('usage', item.itemId, { quantity: '4' })
  const html = renderStockTotals(draft, record, model.businessDate)
  assert.match(html, /Current recorded balance<\/dt><dd>15 cartons/)
  assert.match(html, /Eligible for usage<\/dt><dd>3 cartons/)
  assert.match(html, /Excluded due to expiration<\/dt><dd>12 cartons/)
  assert.match(html, /data-stock-preview-state="insufficient-eligible"/)
  assert.match(html, /Shortage<\/dt><dd>1 carton/)
  const unknown = renderStockTotals(draft, { ...record, batches: [{ ...expired, expirationDate: undefined }, undated] }, model.businessDate)
  assert.match(unknown, /data-stock-preview-state="unavailable"/)
  assert.match(unknown, /Eligible for usage<\/dt><dd>Unavailable/)
})

test('batch display references expand deterministically when suffixes collide and disclose escaped full IDs', async () => {
  const ids = ['batch-aa-123456', 'batch-bb-123456', '<batch&"other>']
  const references = shortStockReferences(ids)
  assert.equal(new Set(references.values()).size, ids.length)
  assert.ok(references.get(ids[0]).length > 6)
  assert.deepEqual(shortStockReferences([...ids].reverse()), references)
  const model = buildInventoryReadModel(await readDemoInventory())
  const item = model.items.find(({ name }) => name === 'Single origin beans')
  item.batches[0].batchId = '<batch&"other>'
  const page = renderStockForm(createDraft('usage', item.itemId), model)
  assert.match(page, /Full batch ID/)
  assert.match(page, /data-stock-batch-id="&lt;batch&amp;&quot;other&gt;"/)
  assert.doesNotMatch(page, /<batch/)
  assert.match(page, /Purchased/)
})

test('duplicate item choices retain stable values and show distinct references and units', async () => {
  const model = buildInventoryReadModel(await readDemoInventory())
  const original = model.items.find(({ name }) => name === 'Single origin beans')
  const duplicate = { ...original, itemId: 'another-' + original.itemId }
  model.items.push(duplicate)
  model.itemById.set(duplicate.itemId, duplicate)
  const options = stockItemOptions(model, 'single origin', original.itemId).markup
  const optionRefs = [...options.matchAll(/Coffee · bags · Item ([^<]+)/g)].map((match) => match[1])
  assert.equal(new Set(optionRefs).size, 2)
  assert.ok(options.includes(`value="${original.itemId}" selected`))
  assert.ok(options.includes(`value="${duplicate.itemId}"`))
})

test('receipt dates use optional native date inputs and keep canonical date strings', async () => {
  const model = buildInventoryReadModel(await readDemoInventory())
  const item = model.items[0]
  const draft = createDraft('receive', item.itemId, { purchaseDate: '2026-11-19', quantity: '1' })
  const html = renderStockForm(draft, model)
  assert.match(html, /type="date" value="2026-11-19" id="stock-purchase-date" name="purchaseDate"/)
  assert.match(html, /type="date" value="" id="stock-expiration-date" name="expirationDate"/)
  assert.doesNotMatch(html, /name="(?:purchaseDate|expirationDate)" required/)
  const partial = renderStockTotals(draft, item, model.businessDate, { hasInvalidDateInput: true })
  assert.match(partial, /data-stock-preview-state="invalid-input"/)
  const reversed = renderStockTotals({ ...draft, expirationDate: '2026-11-18' }, item, model.businessDate)
  assert.match(reversed, /cannot precede the purchase date/)
})
