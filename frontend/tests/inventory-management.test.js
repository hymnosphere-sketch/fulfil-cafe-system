import assert from 'node:assert/strict'
import { test } from 'node:test'

import { readDemoInventory } from '../src/data/demo-data-provider.js'
import { createDemoInventoryRepository } from '../src/data/demo-inventory-repository.js'
import { buildDemoCatalogCandidate } from '../src/data/demo-inventory-rules.js'
import { demoBusinessDate, demoInventory } from '../src/data/demo-inventory.js'
import {
  buildInventoryReadModel,
  filterAndSortInventory,
  findPotentialDuplicateItems,
} from '../src/services/inventory-read-model.js'
import { summarizeInventory } from '../src/services/inventory-summary.js'

const coffeeCategory = demoInventory.categories[0].category_id
const cocoaCategory = demoInventory.categories[2].category_id
const demoId = (suffix) => '00000000-0000-4000-8000-' + String(suffix).padStart(12, '0')
const timestamp = '2026-11-19T07:15:00.000Z'

function repositoryForTest(options = {}) {
  let nextId = 10000
  return createDemoInventoryRepository({
    createId: () => demoId(nextId++),
    now: () => timestamp,
    ...options,
  })
}

function itemInput(overrides = {}) {
  return {
    name: 'Fictional reserve beans',
    category_id: coffeeCategory,
    unit_of_measurement: 'bags',
    minimum_stock_level: '2',
    ...overrides,
  }
}

function editableFields(item, overrides = {}) {
  const { name, category_id, unit_of_measurement, minimum_stock_level } = item
  return { name, category_id, unit_of_measurement, minimum_stock_level, ...overrides }
}

async function initialModel() {
  return buildInventoryReadModel(await readDemoInventory())
}

async function duplicateReview(submit) {
  let review
  await assert.rejects(submit, (error) => {
    assert.equal(error.code, 'POTENTIAL_DUPLICATE_ITEM')
    review = error.duplicateReview
    return true
  })
  return review
}

test('the shared session begins with a detached fixture and the approved dashboard totals', async () => {
  const repository = repositoryForTest()
  const snapshot = await repository.read()
  assert.deepEqual(snapshot, demoInventory)
  assert.notEqual(snapshot.inventory_items, demoInventory.inventory_items)
  snapshot.inventory_items[0].name = 'Changed outside the repository'
  snapshot.stock_movements.length = 0
  const freshRead = await repository.read()
  assert.deepEqual(freshRead, demoInventory)
  const model = buildInventoryReadModel(freshRead)
  assert.deepEqual(model.summary.counts, {
    totalActive: 12, sufficient: 7, lowStock: 3, outOfStock: 2, expiringSoon: 3,
  })
  assert.equal(model.summary.attentionItems.length, 7)
  assert.equal(model.summary.recentMovements.length, 5)
  assert.equal(filterAndSortInventory(model.items).length, 12)
  assert.deepEqual(filterAndSortInventory(model.items, { view: 'archived' }).map(({ name }) => name), ['Seasonal drink mix'])
})

test('searches normalized name substrings and exact identifiers', async () => {
  const { items } = await initialModel()
  assert.deepEqual(filterAndSortInventory(items, { query: '  MiLk  ' }).map(({ name }) => name), ['Oat milk', 'Whole milk'])
  assert.deepEqual(filterAndSortInventory(items, { query: demoId(104) }).map(({ itemId }) => itemId), [demoId(104)])
  assert.deepEqual(filterAndSortInventory(items, { query: demoId(104).slice(0, -1) }), [])
})

test('combines view, search, category, and stock status filters without changing their source', async () => {
  const { items } = await initialModel()
  const before = structuredClone(items)
  const filters = { query: 'syrup', categoryId: cocoaCategory, stockStatus: 'low-stock', view: 'active', sort: 'name-desc' }
  assert.deepEqual(filterAndSortInventory(items, filters).map(({ name }) => name), ['Vanilla syrup'])
  assert.deepEqual(filterAndSortInventory(items, { ...filters, view: 'archived' }), [])
  assert.deepEqual(items, before)
})

test('uses normalized names and record IDs for repeatable ascending and descending sorts', async () => {
  const snapshot = await readDemoInventory()
  const [first, middle, third] = snapshot.inventory_items
  first.name = 'A TEST'
  middle.name = 'Z test'
  third.name = 'a test'
  const { items } = buildInventoryReadModel(snapshot)
  const records = items.slice(0, 3).reverse()
  assert.deepEqual(filterAndSortInventory(records, { sort: 'name-asc' }).map(({ itemId }) => itemId), [first.item_id, third.item_id, middle.item_id])
  const descending = filterAndSortInventory(records, { sort: 'name-desc' })
  assert.deepEqual(descending.map(({ itemId }) => itemId), [middle.item_id, first.item_id, third.item_id])
  assert.deepEqual(descending, filterAndSortInventory([...records].reverse(), { sort: 'name-desc' }))
})

test('quantity sorts compare balances only within compatible unit groups', async () => {
  const { items } = await initialModel()
  for (const sort of ['quantity-asc', 'quantity-desc']) {
    const sorted = filterAndSortInventory(items, { sort })
    const groups = new Map()
    let lastUnit
    for (const { unit, availableQuantity } of sorted) {
      if (unit !== lastUnit) {
        assert.equal(groups.has(unit), false, 'a unit group must be contiguous')
        groups.set(unit, [])
        lastUnit = unit
      }
      groups.get(unit).push(availableQuantity)
    }
    assert.ok(groups.size > 1)
    for (const quantities of groups.values()) {
      assert.deepEqual(quantities, [...quantities].sort((a, b) => sort === 'quantity-asc' ? a - b : b - a))
    }
  }
})

test('derives item and batch quantities and keeps the full selected history', async () => {
  const { itemById } = await initialModel()
  const beans = itemById.get(demoId(101))
  assert.equal(beans.availableQuantity, 6)
  assert.equal(beans.stockStatus, 'low-stock')
  assert.deepEqual(beans.batches.map(({ remainingQuantity }) => remainingQuantity).sort((a, b) => a - b), [2, 4])
  assert.deepEqual(beans.movements.map(({ quantity }) => quantity), [-6, 7, 5])
  assert.equal(beans.hasHistory, true)
  assert.equal(beans.batches.every(({ purchaseCost }) => purchaseCost == null), true)
  const archived = itemById.get(demoId(113))
  assert.equal(archived.isActive, false)
  assert.equal(archived.batches[0].remainingQuantity, 0)
  assert.deepEqual(archived.movements.map(({ quantity }) => quantity), [-6, 6])
})

test('creates a unique zero-stock item and leaves transaction history untouched', async () => {
  const repository = repositoryForTest()
  const item = await repository.createItem(itemInput())
  assert.match(item.item_id, /^[0-9a-f-]{36}$/)
  assert.equal(item.created_at, timestamp)
  assert.equal(item.minimum_stock_level, 2)
  const snapshot = await repository.read()
  const row = buildInventoryReadModel(snapshot).itemById.get(item.item_id)
  assert.equal(row.availableQuantity, 0)
  assert.equal(row.stockStatus, 'out-of-stock')
  assert.deepEqual(row.batches, [])
  assert.deepEqual(row.movements, [])
  assert.deepEqual(snapshot.stock_movements, demoInventory.stock_movements)
  assert.deepEqual(snapshot.batch_allocations, demoInventory.batch_allocations)
  item.name = 'Changed after save'
  assert.equal((await repository.read()).inventory_items.at(-1).name, 'Fictional reserve beans')
})

test('rejects invalid thresholds, unknown units, blank names, and unavailable categories atomically', async () => {
  const repository = repositoryForTest()
  const before = await repository.read()
  for (const invalid of ['', '-1', '1.0', '1.5', '1e2', '2kg', '0x12', '9007199254740992', NaN, Infinity]) {
    await assert.rejects(repository.createItem(itemInput({ minimum_stock_level: invalid })), { code: 'VALIDATION' })
  }
  for (const overrides of [{ unit_of_measurement: 'furlongs' }, { name: '  ' }, { category_id: 'missing' }]) {
    await assert.rejects(repository.createItem(itemInput(overrides)), { code: 'VALIDATION' })
  }
  assert.deepEqual(await repository.read(), before)
  const item = await repository.createItem(itemInput({ minimum_stock_level: '0' }))
  assert.equal(item.minimum_stock_level, 0)
  const largestSupported = await repository.createItem(itemInput({
    name: 'Demo maximum safe threshold',
    minimum_stock_level: String(Number.MAX_SAFE_INTEGER),
  }))
  assert.equal(largestSupported.minimum_stock_level, Number.MAX_SAFE_INTEGER)
})

test('warns about active and archived item matches and requires explicit permission to proceed', async () => {
  const repository = repositoryForTest()
  const { items } = await initialModel()
  assert.equal(findPotentialDuplicateItems(items, '  SEASONAL drink MIX ')[0].isActive, false)
  assert.deepEqual(findPotentialDuplicateItems(items, 'OAT MILK', { excludeItemId: demoId(105) }), [])
  const before = await repository.read()
  for (const name of ['  Single ORIGIN beans ', ' SEASONAL DRINK MIX ']) {
    await assert.rejects(repository.createItem(itemInput({ name })), (error) => {
      assert.equal(error.code, 'POTENTIAL_DUPLICATE_ITEM')
      assert.ok(error.duplicateReview.matches.length > 0)
      assert.ok(error.duplicateReview.matches.every(({ itemId }) => itemId))
      return true
    })
  }
  assert.deepEqual(await repository.read(), before)
  const draft = itemInput({ name: 'Single origin beans' })
  const review = await duplicateReview(() => repository.createItem(draft))
  const item = await repository.createItem(draft, { duplicateApproval: review.approval })
  assert.notEqual(item.item_id, demoId(101))
  assert.equal((await repository.read()).inventory_items.length, before.inventory_items.length + 1)
})

test('duplicate approval is independent of match ordering and is tied to the submitted draft', async () => {
  const repository = repositoryForTest()
  const draft = itemInput({ name: 'Single origin beans' })
  const first = await duplicateReview(() => repository.createItem(draft))
  await repository.createItem(draft, { duplicateApproval: first.approval })
  const review = await duplicateReview(() => repository.createItem(draft))
  assert.equal(review.matches.length, 2)
  const before = await repository.read()
  const reordered = { ...before, inventory_items: before.inventory_items.toReversed() }
  assert.doesNotThrow(() => buildDemoCatalogCandidate(reordered, 'create_item', {
    input: draft, duplicateApproval: review.approval, createId: () => demoId(20000), now: () => timestamp,
  }))
  const changed = itemInput({ ...draft, minimum_stock_level: '3' })
  const updated = await duplicateReview(() => repository.createItem(changed, { duplicateApproval: review.approval }))
  assert.equal(updated.updated, true)
  assert.deepEqual(updated.matches, review.matches)
  assert.deepEqual(await repository.read(), before)
})

test('duplicate approval expires when the displayed category, quantity or archived status changes', async () => {
  const cases = [
    ['Single origin beans', 'categoryName', 'Coffee reserve', (repo) =>
      repo.updateCategory(coffeeCategory, { name: 'Coffee reserve' })],
    ['Single origin beans', 'availableQuantity', 7, async (repo) => {
      const preview = await repo.previewStockMovement({ itemId: demoId(101), type: 'stock_in', unit: 'bags', scale: 0, quantity: 1 })
      await repo.recordStockMovement(preview.attemptId)
    }],
    ['Paper lids', 'isActive', false, (repo) => repo.archiveItem(demoId(110))],
  ]
  for (const [name, field, value, change] of cases) {
    const repository = repositoryForTest()
    const draft = itemInput({ name })
    const first = await duplicateReview(() => repository.createItem(draft))
    await change(repository)
    const before = await repository.read()
    const renewed = await duplicateReview(() => repository.createItem(draft, { duplicateApproval: first.approval }))
    assert.equal(renewed.updated, true)
    assert.equal(renewed.matches[0][field], value)
    assert.notEqual(renewed.approval, first.approval)
    assert.deepEqual(await repository.read(), before)
    await repository.createItem(draft, { duplicateApproval: renewed.approval })
  }
})

test('duplicate edits require a fresh review when a rename adds or removes matches', async () => {
  const repository = repositoryForTest()
  const item = await repository.createItem(itemInput())
  const another = await repository.createItem(itemInput({ name: 'Another fictional item' }))
  const draft = itemInput({ name: 'Single origin beans' })
  const review = await duplicateReview(() => repository.updateItem(item.item_id, draft))
  const renameReview = await duplicateReview(() => repository.updateItem(another.item_id, draft))
  await repository.updateItem(another.item_id, draft, { duplicateApproval: renameReview.approval })
  const renewed = await duplicateReview(() => repository.updateItem(item.item_id, draft, { duplicateApproval: review.approval }))
  assert.equal(renewed.matches.length, 2)
  const snapshot = await repository.read()
  const original = snapshot.inventory_items.find(({ item_id }) => item_id === demoId(101))
  await repository.updateItem(original.item_id, editableFields(original, { name: 'Original renamed' }))
  await repository.updateItem(another.item_id, itemInput({ name: 'Other renamed' }))
  const before = await repository.read()
  await assert.rejects(repository.updateItem(item.item_id, draft, { duplicateApproval: renewed.approval }),
    { code: 'DUPLICATE_REVIEW_EXPIRED' })
  assert.deepEqual(await repository.read(), before)
  assert.equal((await repository.updateItem(item.item_id, draft)).name, draft.name)
})

test('edits metadata without replacing identity, creation time, or historical stock records', async () => {
  const repository = repositoryForTest()
  const before = await repository.read()
  const original = before.inventory_items.find(({ item_id }) => item_id === demoId(101))
  const saved = await repository.updateItem(original.item_id, editableFields(original, {
    name: 'Single origin reserve',
    category_id: cocoaCategory,
    minimum_stock_level: '3',
  }))
  assert.equal(saved.item_id, original.item_id)
  assert.equal(saved.created_at, original.created_at)
  assert.equal(saved.updated_at, timestamp)
  const after = await repository.read()
  for (const field of ['stock_batches', 'stock_movements', 'batch_allocations']) {
    assert.deepEqual(after[field], before[field])
  }
  const renamed = buildInventoryReadModel(after).itemById.get(original.item_id)
  assert.equal(renamed.availableQuantity, 6)
  assert.equal(renamed.categoryId, cocoaCategory)
  assert.equal(renamed.movements.length, 3)
})

test('locks the unit even when all historic stock is depleted and allows it on a new item', async () => {
  const repository = repositoryForTest()
  const original = demoInventory.inventory_items.find(({ item_id }) => item_id === demoId(103))
  const before = await repository.read()
  await assert.rejects(repository.updateItem(original.item_id, editableFields(original, { unit_of_measurement: 'pieces' })), { code: 'ITEM_UNIT_LOCKED' })
  assert.deepEqual(await repository.read(), before)
  const newItem = await repository.createItem(itemInput())
  const edited = await repository.updateItem(newItem.item_id, editableFields(newItem, { unit_of_measurement: 'pieces' }))
  assert.equal(edited.unit_of_measurement, 'pieces')
})

test('archives eligible items without changing their related history and rejects items with stock', async () => {
  const repository = repositoryForTest()
  const before = await repository.read()
  await assert.rejects(repository.archiveItem(demoId(101)), { code: 'ITEM_HAS_STOCK' })
  assert.deepEqual(await repository.read(), before)
  await repository.archiveItem(demoId(103))
  const after = await repository.read()
  const readModel = buildInventoryReadModel(after)
  const archived = filterAndSortInventory(readModel.items, { view: 'archived' })
  const decaf = archived.find(({ itemId }) => itemId === demoId(103))
  assert.equal(decaf.availableQuantity, 0)
  assert.equal(decaf.batches.length, 1)
  assert.equal(decaf.movements.length, 2)
  assert.deepEqual(after.stock_movements, before.stock_movements)
  assert.deepEqual(after.batch_allocations, before.batch_allocations)
})

test('adds and edits categories with stable identifiers and applies the demo name rule', async () => {
  const repository = repositoryForTest()
  const created = await repository.createCategory({ name: 'Fictional supplies', description: 'Demo only' })
  const edited = await repository.updateCategory(created.category_id, { name: 'Reserve supplies', description: '' })
  assert.equal(edited.category_id, created.category_id)
  assert.equal(edited.name, 'Reserve supplies')
  assert.equal(buildInventoryReadModel(await repository.read()).categoryById.get(edited.category_id).activeItemCount, 0)
  await repository.archiveCategory(edited.category_id)
  const before = await repository.read()
  await assert.rejects(repository.createCategory({ name: ' RESERVE supplies ' }), { code: 'DUPLICATE_CATEGORY' })
  await assert.rejects(repository.createItem(itemInput({ category_id: edited.category_id })), { code: 'VALIDATION' })
  assert.deepEqual(await repository.read(), before)
})

test('blocks category archival while active items remain and retains references after eligible archival', async () => {
  const repository = repositoryForTest()
  const category = await repository.createCategory({ name: 'Temporary category' })
  const item = await repository.createItem(itemInput({ category_id: category.category_id }))
  const before = await repository.read()
  await assert.rejects(repository.archiveCategory(category.category_id), { code: 'CATEGORY_IN_USE' })
  assert.deepEqual(await repository.read(), before)
  await repository.archiveItem(item.item_id)
  await repository.archiveCategory(category.category_id)
  const after = buildInventoryReadModel(await repository.read())
  assert.equal(after.itemById.get(item.item_id).categoryId, category.category_id)
  assert.equal(after.itemById.get(item.item_id).categoryName, category.name)
  assert.equal(after.categoryById.get(category.category_id).isActive, false)
})

test('dashboard counts follow session creates, threshold edits, and archives, with a fresh session resetting', async () => {
  const repository = repositoryForTest()
  const summarize = async () => summarizeInventory(await repository.read(), demoBusinessDate)
  const initial = await summarize()
  const item = await repository.createItem(itemInput())
  assert.equal((await summarize()).counts.totalActive, 13)
  assert.equal((await summarize()).counts.outOfStock, 3)
  const beans = demoInventory.inventory_items.find(({ item_id }) => item_id === demoId(101))
  await repository.updateItem(beans.item_id, editableFields(beans, { minimum_stock_level: 2 }))
  assert.equal((await summarize()).counts.lowStock, 2)
  await repository.archiveItem(item.item_id)
  assert.equal((await summarize()).counts.totalActive, 12)
  assert.equal((await summarize()).counts.outOfStock, 2)
  const refresh = await repositoryForTest().read()
  assert.deepEqual(summarizeInventory(refresh, demoBusinessDate).counts, initial.counts)
  assert.deepEqual(refresh, demoInventory)
  assert.deepEqual(await readDemoInventory(), refresh)
  assert.equal((await readDemoInventory({ scenario: 'empty' })).inventory_items.length, 0)
  assert.equal((await repository.read()).inventory_items.length, 14)
})

test('missing expiration settings leave catalog data and stock calculations available', async () => {
  const snapshot = await readDemoInventory()
  delete snapshot.settings
  const model = buildInventoryReadModel(snapshot)
  assert.equal(model.summary.counts.totalActive, 12)
  assert.equal(model.summary.counts.expiringSoon, null)
  assert.equal(model.itemById.get(demoId(101)).availableQuantity, 6)
  assert.equal(model.itemById.get(demoId(105)).expirationAlerts.includes('expired'), true)
})

test('a failed initial read can be retried and concurrent demo saves keep both records', async () => {
  let reads = 0
  const repository = repositoryForTest({
    async readInitialSnapshot() {
      reads++
      if (reads === 1) throw new Error('Demo read failed')
      return readDemoInventory()
    },
  })
  await assert.rejects(repository.read(), /Demo read failed/)
  const [first, second] = await Promise.all([
    repository.createItem(itemInput({ name: 'Concurrent demo item A' })),
    repository.createItem(itemInput({ name: 'Concurrent demo item B' })),
  ])
  assert.equal(reads, 2)
  assert.notEqual(first.item_id, second.item_id)
  const { itemById } = buildInventoryReadModel(await repository.read())
  assert.equal(itemById.get(first.item_id).name, first.name)
  assert.equal(itemById.get(second.item_id).name, second.name)
})
