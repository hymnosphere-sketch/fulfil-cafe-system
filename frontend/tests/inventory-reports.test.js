import assert from 'node:assert/strict'
import test from 'node:test'
import { createDemoInventoryRepository } from '../src/data/demo-inventory-repository.js'
import { readDemoInventory } from '../src/data/demo-data-provider.js'
import { demoInventory } from '../src/data/demo-inventory.js'
import {
  normalizeReportFilters, reportSelectOptions,
  renderReportLoading, renderReportPanel, renderReportReadError, renderReportResults, renderReportsPage, reportDefaults,
} from '../src/pages/report-rendering.js'
import {
  aggregateReportMovements, buildInventoryReports, expirationMonitoring, inventoryOverview, movementReport, restockingItems,
} from '../src/services/inventory-reports.js'
import { buildTransactionHistory, filterTransactionHistory } from '../src/services/transaction-history.js'

const id = (value) => '00000000-0000-4000-8000-' + String(value).padStart(12, '0')
const baseline = { totalActive: 12, lowStock: 3, outOfStock: 2, sufficient: 7, expiringSoon: 3 }
const fixtureReports = () => buildInventoryReports(demoInventory)

test('reports match the fixture summary and leave archived items out of active results', () => {
  const before = structuredClone(demoInventory)
  const data = fixtureReports()
  assert.deepEqual(data.inventory.summary.counts, baseline)
  assert.equal(inventoryOverview(data).length, 12)
  assert.ok(inventoryOverview(data).every(({ isActive }) => isActive))
  assert.equal(inventoryOverview(data, { query: id(113), view: 'all' }).length, 0)
  assert.ok(movementReport(data, { itemId: id(113) }).groups.every(({ isActive }) => !isActive))
  assert.ok(movementReport(data, { itemId: id(113) }).matchingMovements > 0)
  assert.deepEqual(demoInventory, before)
})

test('overview combines text, full-ID, category and status filters', () => {
  const data = fixtureReports()
  const item = data.inventory.itemById.get(id(101))
  const names = inventoryOverview(data, { query: ' sInGlE   OrIgIn ', categoryId: item.categoryId, stockStatus: 'low-stock' })
  assert.deepEqual(names.map(({ itemId }) => itemId), [item.itemId])
  assert.equal(inventoryOverview(data, { query: item.itemId }).length, 1)
  assert.deepEqual(inventoryOverview(data, { query: item.itemId.slice(0, -1) }), [])
  assert.deepEqual(inventoryOverview(data, { query: item.itemId, stockStatus: 'out-of-stock' }), [])
})

test('overview sorts by name and keeps numeric sorting within stable unit groups', () => {
  const data = fixtureReports()
  const alphabetical = inventoryOverview(data, { sort: 'name-asc' })
  const reverse = inventoryOverview(data, { sort: 'name-desc' })
  assert.deepEqual(reverse.map(({ itemId }) => itemId), [...alphabetical].reverse().map(({ itemId }) => itemId))
  const byQuantity = inventoryOverview(data, { sort: 'quantity-asc' })
  const units = byQuantity.map(({ unit }) => unit)
  assert.ok(new Set(units).size > 1)
  assert.deepEqual(units, [...units].sort())
  for (const unit of new Set(units)) {
    const quantities = byQuantity.filter((item) => item.unit === unit).map(({ availableQuantity }) => availableQuantity)
    assert.deepEqual(quantities, [...quantities].sort((a, b) => a - b))
  }
})

test('restocking places out-of-stock before low stock and filters categories and scope', () => {
  const data = fixtureReports()
  const items = restockingItems(data)
  assert.deepEqual(items.map(({ name, stockStatus }) => [name, stockStatus]), [
    ['House decaf', 'out-of-stock'], ['Paper lids', 'out-of-stock'], ['Single origin beans', 'low-stock'],
    ['Vanilla syrup', 'low-stock'], ['Whole milk', 'low-stock'],
  ])
  assert.equal(restockingItems(data, { includeOutOfStock: false }).length, 3)
  const coffee = data.inventory.itemById.get(id(101)).categoryId
  assert.deepEqual(restockingItems(data, { categoryId: coffee }).map(({ name }) => name), ['House decaf', 'Single origin beans'])
  const ties = [
    { ...items[0], itemId: 'B', name: 'Same', normalizedName: 'same' },
    { ...items[0], itemId: 'A', name: 'same', normalizedName: 'same' },
  ]
  assert.deepEqual(restockingItems({ inventory: { items: ties } }).map(({ itemId }) => itemId), ['A', 'B'])
})

test('restocking shortfalls retain their units and a positive balance at the minimum stays low stock', () => {
  const data = fixtureReports()
  const items = restockingItems(data)
  assert.deepEqual(items.map(({ name, shortfallToMinimum, unit }) => [name, shortfallToMinimum, unit]), [
    ['House decaf', 4, 'bags'],
    ['Paper lids', 10, 'pieces'],
    ['Single origin beans', 2, 'bags'],
    ['Vanilla syrup', 1, 'bottles'],
    ['Whole milk', 0, 'cartons'],
  ])
  const atMinimum = items.find(({ name }) => name === 'Whole milk')
  assert.equal(atMinimum.availableQuantity, atMinimum.minimumStockLevel)
  assert.equal(atMinimum.stockStatus, 'low-stock')
  const rendered = renderReportResults('restocking', data, reportDefaults.restocking)
  assert.match(rendered.html, /<th scope="col">Shortfall to minimum/)
  assert.match(rendered.html, /<dt>Shortfall to minimum<\/dt><dd>1 bottle/)
  assert.match(rendered.html, /Recorded balances can include expired stock/)
  assert.match(rendered.html, /A positive balance at the minimum is still classified as low stock/)
  assert.equal(rendered.count, 'Showing 5 of 5 restocking items')
  assert.equal(renderReportResults('restocking', data, { ...reportDefaults.restocking, stockScope: 'low-only' }).count,
    'Showing 3 of 5 restocking items')
})

test('overview and expiration summaries show their scope independently of filtered rows', async () => {
  const data = fixtureReports()
  const overview = renderReportResults('inventory', data, reportDefaults.inventory)
  const noMatches = renderReportResults('inventory', data, { ...reportDefaults.inventory, query: 'unknown item' })
  assert.equal(overview.count, 'Showing 12 of 12 active items')
  assert.equal(noMatches.count, 'Showing 0 of 12 active items')
  assert.equal(noMatches.summary, overview.summary)
  assert.match(overview.summary, /Overall inventory summary/)
  assert.match(overview.summary, /all active items/)
  assert.match(noMatches.html, /No matching items/)
  const empty = buildInventoryReports(await readDemoInventory({ scenario: 'empty' }))
  const emptyOverview = renderReportResults('inventory', empty, reportDefaults.inventory)
  assert.equal(emptyOverview.count, 'Showing 0 of 0 active items')
  assert.match(emptyOverview.html, /No active inventory/)

  const expiry = renderReportResults('expiration', data, { categoryId: id(1), status: 'expired' })
  const allStatuses = renderReportResults('expiration', data, { categoryId: id(1), status: '' })
  assert.equal(expiry.summary, allStatuses.summary)
  assert.match(expiry.summary, /remaining batches in Coffee/)
  assert.match(expiry.summary, /An item can have more than one batch/)
  assert.equal(expiry.count, 'Showing 0 of 11 remaining batches')
  assert.equal(renderReportResults('expiration', data, reportDefaults.expiration).count, 'Showing 11 of 11 remaining batches')
  assert.equal(renderReportResults('movements', data, reportDefaults.movements).count, 'Showing 22 of 22 movement records in 22 groups')
})

test('expiration keeps positive active batches and uses inclusive boundaries and stable date ordering', () => {
  const data = fixtureReports()
  const all = expirationMonitoring(data)
  assert.equal(all.expiredBatchCount, 1)
  assert.equal(all.expiringSoonItemCount, 3)
  const expired = expirationMonitoring(data, { status: 'expired' }).rows
  assert.deepEqual(expired.map(({ name, remainingQuantity }) => [name, remainingQuantity]), [['Oat milk', 12]])
  const soon = expirationMonitoring(data, { status: 'expiring-soon' }).rows
  assert.equal(soon.length, 4)
  assert.ok(soon.some(({ expirationDate }) => expirationDate === '2026-11-19'))
  assert.ok(soon.some(({ expirationDate }) => expirationDate === '2026-11-26'))
  assert.deepEqual(expirationMonitoring(data, { status: 'alerts' }).rows, [...expired, ...soon])
  const sameDay = all.rows.filter(({ expirationDate }) => expirationDate === '2026-11-26').map(({ batchId }) => batchId)
  assert.deepEqual(sameDay, [...sameDay].sort())
  assert.ok(all.rows.every(({ remainingQuantity, itemId }) => remainingQuantity > 0 && data.inventory.itemById.get(itemId).isActive))
  assert.ok(!all.rows.some(({ batchId }) => batchId === id(204)))
  const undated = expirationMonitoring(data, { status: 'undated' }).rows
  assert.ok(undated.length > 0 && undated.every(({ expirationDate }) => expirationDate === null))
  assert.deepEqual(all.rows.slice(-undated.length), undated)
})

test('expiration distinguishes an unavailable warning period from undated stock and preserves known expired batches', async () => {
  const unavailable = buildInventoryReports(await readDemoInventory({ scenario: 'unavailable' }))
  const a = expirationMonitoring(unavailable)
  assert.equal(a.expiringSoonItemCount, null)
  assert.equal(a.expiredBatchCount, 1)
  assert.equal(a.hasDatedStock, true)
  assert.equal(a.warningPeriodUnavailable, true)
  const rendered = renderReportResults('expiration', unavailable, reportDefaults.expiration)
  assert.match(rendered.html, /Warning period unavailable/)
  assert.doesNotMatch(rendered.html, /No expiration alerts/)
  assert.match(rendered.summary, /dashboard-tone--error" aria-labelledby="report-expired"/)
  assert.match(rendered.summary, /dashboard-tone--info" aria-labelledby="report-expiring".*data-lucide="info"/s)
  assert.equal(renderReportResults('expiration', unavailable, { ...reportDefaults.expiration, status: 'expiring-soon' }).count, '')

  const noDates = structuredClone(demoInventory)
  for (const batch of noDates.stock_batches) batch.expiration_date = null
  const undated = buildInventoryReports(noDates)
  const b = expirationMonitoring(undated)
  assert.equal(b.expiringSoonItemCount, null)
  assert.equal(b.hasDatedStock, false)
  assert.equal(b.warningPeriodUnavailable, false)
  assert.match(renderReportResults('expiration', undated, reportDefaults.expiration).html, /No dated batches with remaining stock/)
})

test('repeated receipts aggregate once per item, unit, and type and reconcile across Manila day boundaries', async () => {
  let timestamp
  const repository = createDemoInventoryRepository({ now: () => timestamp })
  const itemId = id(101)
  for (const [time, quantity] of [
    ['2026-11-18T15:59:59.999Z', 1], ['2026-11-18T16:00:00.000Z', 2],
    ['2026-11-19T15:59:59.999Z', 3], ['2026-11-19T16:00:00.000Z', 4],
  ]) {
    timestamp = time
    const preview = await repository.previewStockMovement({
      itemId, type: 'stock_in', quantity, unit: 'bags', scale: 0, allocations: [],
    })
    await repository.recordStockMovement(preview.attemptId)
  }
  const snapshot = await repository.read()
  const filters = { itemId, type: 'stock_in', fromDate: '2026-11-19', toDate: '2026-11-19' }
  const report = movementReport(buildInventoryReports(snapshot), filters)
  const history = filterTransactionHistory(buildTransactionHistory(snapshot).movements, filters)
  assert.equal(report.groups.length, 1)
  assert.equal(report.matchingMovements, 2)
  assert.equal(report.groups[0].movementCount, history.movements.length)
  assert.equal(report.groups[0].quantityChange, 5)
  assert.equal(report.groups[0].quantityChange, history.movements.reduce((total, { quantity }) => total + quantity, 0))
})

test('movement counts and signed groups reconcile to the original ledger by ID, unit and type', () => {
  const data = fixtureReports()
  const report = movementReport(data)
  assert.equal(report.matchingMovements, demoInventory.stock_movements.length)
  const original = new Map(demoInventory.inventory_items.map((item) => [item.item_id, item.unit_of_measurement]))
  const expected = new Map()
  for (const { item_id, movement_type, quantity_change } of demoInventory.stock_movements) {
    const key = JSON.stringify([item_id, original.get(item_id), movement_type])
    const previous = expected.get(key) ?? { count: 0, total: 0 }
    expected.set(key, { count: previous.count + 1, total: previous.total + quantity_change })
  }
  assert.equal(report.groups.length, expected.size)
  for (const group of report.groups) {
    assert.deepEqual({ count: group.movementCount, total: group.quantityChange },
      expected.get(JSON.stringify([group.itemId, group.unit, group.type])))
  }
  assert.ok(new Set(report.groups.map(({ unit }) => unit)).size > 1)
  assert.ok(new Set(report.groups.map(({ type }) => type)).has('wastage'))
  assert.ok(report.groups.some(({ type, quantityChange }) => type === 'positive_adjustment' && quantityChange > 0))
  assert.ok(report.groups.some(({ type, quantityChange }) => type === 'negative_adjustment' && quantityChange < 0))
})

test('movement filters combine item, category, type and inclusive Manila dates and reject invalid ranges', () => {
  const data = fixtureReports()
  const item = data.inventory.itemById.get(id(101))
  const filters = { itemId: item.itemId, categoryId: item.categoryId, type: 'stock_out', fromDate: '2026-11-19', toDate: '2026-11-19' }
  const result = movementReport(data, filters)
  assert.equal(result.groups.length, 1)
  const expected = demoInventory.stock_movements.find(({ movement_id }) => movement_id === id(356))
  assert.equal(result.groups[0].quantityChange, expected.quantity_change)
  assert.equal(movementReport(data, { ...filters, toDate: '2026-11-18' }).errors.toDate, 'Enter an end date on or after the start date.')
  assert.equal(movementReport(data, { ...filters, fromDate: '2026-02-30' }).errors.fromDate, 'Enter a valid start date.')
  assert.equal(movementReport(data, { ...filters, categoryId: 'unmatched' }).matchingMovements, 0)
})

test('movement grouping separates duplicate names, units, types, and unavailable overflowed totals', () => {
  const first = { itemId: '1', name: 'Same', categoryName: 'Coffee', isActive: true, unit: 'bags', type: 'stock_in' }
  const items = new Map([['1', { normalizedName: 'same' }], ['2', { normalizedName: 'same' }]])
  const groups = aggregateReportMovements([
    { ...first, quantity: Number.MAX_SAFE_INTEGER }, { ...first, quantity: 1 },
    { ...first, type: 'positive_adjustment', quantity: 3 }, { ...first, type: 'wastage', quantity: -4 },
    { ...first, type: 'stock_out', quantity: -5 }, { ...first, unit: 'pieces', quantity: 2 },
    { ...first, itemId: '2', quantity: 6 },
  ], items)
  assert.deepEqual(groups.map(({ itemId, unit, type, movementCount, quantityChange }) => [itemId, unit, type, movementCount, quantityChange]), [
    ['1', 'bags', 'positive_adjustment', 1, 3], ['1', 'bags', 'stock_in', 2, null],
    ['1', 'bags', 'stock_out', 1, -5], ['1', 'bags', 'wastage', 1, -4],
    ['1', 'pieces', 'stock_in', 1, 2], ['2', 'bags', 'stock_in', 1, 6],
  ])
})

test('the shared stock scenario updates all report projections and rejects an excessive deduction without changing them', async () => {
  const repository = createDemoInventoryRepository()
  const item = await repository.createItem({ name: 'Report scenario cups', category_id: id(4), unit_of_measurement: 'pieces', minimum_stock_level: '5' })
  const itemId = item.item_id
  const report = async () => buildInventoryReports(await repository.read())
  const stock = (data) => inventoryOverview(data, { query: itemId })[0]
  assert.equal(stock(await report()).availableQuantity, 0)
  assert.equal(stock(await report()).stockStatus, 'out-of-stock')
  let batchId
  for (const [type, quantity, balance] of [
    ['stock_in', 20, 20], ['stock_out', 5, 15], ['wastage', 2, 13], ['positive_adjustment', 1, 14], ['negative_adjustment', 4, 10],
  ]) {
    const preview = await repository.previewStockMovement({
      itemId, type, quantity, unit: 'pieces', scale: 0, reason: 'Fictional report verification',
      allocations: batchId ? [{ batchId, quantity }] : [],
    })
    const result = await repository.recordStockMovement(preview.attemptId)
    if (type === 'stock_in') batchId = result.batch.batch_id
    const data = await report()
    assert.equal(stock(data).availableQuantity, balance)
    assert.equal(data.inventory.summary.batchBalances.get(batchId), balance)
  }
  const before = await report()
  await assert.rejects(() => repository.previewStockMovement({
    itemId, type: 'stock_out', quantity: 11, unit: 'pieces', scale: 0, allocations: [{ batchId, quantity: 11 }],
  }), { code: 'INSUFFICIENT_STOCK' })
  const after = await report()
  assert.deepEqual(after, before)
  assert.equal(stock(after).stockStatus, 'sufficient')
  const movements = movementReport(after, { itemId })
  assert.equal(movements.matchingMovements, 5)
  assert.equal(movements.groups.length, 5)
  assert.deepEqual(Object.fromEntries(movements.groups.map(({ type, quantityChange }) => [type, quantityChange])), {
    stock_in: 20, stock_out: -5, wastage: -2, positive_adjustment: 1, negative_adjustment: -4,
  })
  assert.equal((await repository.read()).batch_allocations.length, demoInventory.batch_allocations.length + 5)
  await repository.updateItem(itemId, {
    name: item.name, category_id: item.category_id, unit_of_measurement: 'pieces', minimum_stock_level: '10',
  })
  assert.equal(stock(await report()).stockStatus, 'low-stock')
  await repository.archiveItem(id(103))
  const archived = await report()
  assert.equal(inventoryOverview(archived, { query: id(103) }).length, 0)
  assert.ok(movementReport(archived, { itemId: id(103) }).matchingMovements > 0)
  assert.deepEqual(buildInventoryReports(await createDemoInventoryRepository().read()).inventory.summary.counts, baseline)
})

test('reports render accessible selection, distinct states, safe text and filter-preserving History links', async () => {
  const snapshot = structuredClone(demoInventory)
  const name = '<img src=x onerror="alert(1)">'
  snapshot.inventory_items.find(({ item_id }) => item_id === id(101)).name = name
  snapshot.categories[0].name = '<b>Coffee</b>'
  const data = buildInventoryReports(snapshot)
  const shell = renderReportsPage('inventory')
  assert.match(shell, /data-report-view="inventory" aria-current="page"/)
  assert.match(renderReportLoading(), /role="status"/)
  assert.match(renderReportReadError(), /role="alert".*Reports could not be loaded/s)
  assert.match(renderReportReadError(), /data-report-retry/)
  const inventory = renderReportResults('inventory', data, reportDefaults.inventory)
  assert.match(inventory.html, /&lt;img/)
  assert.doesNotMatch(inventory.html, /<img|<b>Coffee/)
  assert.match(inventory.html, /&lt;b&gt;Coffee/)
  const filtered = { ...reportDefaults.movements, itemId: id(101), type: 'stock_out', fromDate: '2026-11-19', toDate: '2026-11-19' }
  const movements = renderReportResults('movements', data, filtered)
  assert.match(movements.html, /#!?\/history\?item=.+&amp;type=stock_out&amp;from=2026-11-19&amp;to=2026-11-19/)
  assert.doesNotMatch(movements.html, /<img|<b>Coffee/)
  assert.doesNotMatch(renderReportPanel('movements', data, filtered), /<img|<b>Coffee/)
  assert.match(renderReportResults('inventory', data, { ...reportDefaults.inventory, query: 'no-such-item' }).html, /No matching items/)
  const empty = buildInventoryReports(await readDemoInventory({ scenario: 'empty' }))
  assert.match(renderReportResults('inventory', empty, reportDefaults.inventory).html, /No active inventory/)
  assert.match(renderReportResults('movements', empty, reportDefaults.movements).html, /No stock movements match/)
  const noAlerts = { ...data, expirationRecords: data.expirationRecords.filter(({ expirationStatus }) => expirationStatus === 'current') }
  assert.match(renderReportResults('expiration', noAlerts, reportDefaults.expiration).html, /No expiration alerts/)
})

const normalize = (view, data, values) => normalizeReportFilters(view, values, reportSelectOptions(view, data.inventory))

test('a session-created item filter survives while present and falls back to all 22 fixture movements after refresh', async () => {
  const session = createDemoInventoryRepository()
  const { item_id: itemId } = await session.createItem({
    name: 'Session-only cups', category_id: id(4), unit_of_measurement: 'pieces', minimum_stock_level: '5',
  })
  const current = buildInventoryReports(await session.read())
  assert.deepEqual(normalize('movements', current, { itemId }), {
    filters: { ...reportDefaults.movements, itemId }, cleared: false,
  })
  const refreshed = buildInventoryReports(await createDemoInventoryRepository().read())
  const { filters, cleared } = normalize('movements', refreshed, { itemId })
  assert.equal(cleared, true)
  assert.equal(filters.itemId, '')
  assert.match(renderReportPanel('movements', refreshed, filters), /<option value="" selected>All items<\/option>/)
  assert.equal(renderReportResults('movements', refreshed, filters).count, 'Showing 22 of 22 movement records in 22 groups')
})

test('all four reports keep valid categories and clear a session-created category after refresh', async () => {
  const session = createDemoInventoryRepository()
  const { category_id: categoryId } = await session.createCategory({ name: 'Session-only category' })
  const current = buildInventoryReports(await session.read())
  const refreshed = fixtureReports()
  for (const view of Object.keys(reportDefaults)) {
    assert.deepEqual(normalize(view, current, { categoryId }), {
      filters: { ...reportDefaults[view], categoryId }, cleared: false,
    })
    assert.deepEqual(normalize(view, refreshed, { categoryId: id(1) }), {
      filters: { ...reportDefaults[view], categoryId: id(1) }, cleared: false,
    })
    const { filters, cleared } = normalize(view, refreshed, { categoryId })
    assert.equal(cleared, true)
    assert.equal(filters.categoryId, '')
    assert.match(renderReportPanel(view, refreshed, filters), /<option value="" selected>All categories<\/option>/)
    assert.equal(renderReportResults(view, refreshed, filters).count, renderReportResults(view, refreshed, reportDefaults[view]).count)
  }
})

test('archived items and categories stay selectable for historical movements only', async () => {
  const session = createDemoInventoryRepository()
  const { category_id: categoryId } = await session.createCategory({ name: 'Archived report fixture' })
  await session.archiveCategory(categoryId)
  const data = buildInventoryReports(await session.read())
  const itemId = id(113)
  assert.equal(data.inventory.itemById.get(itemId).isActive, false)
  const { filters, cleared } = normalize('movements', data, { itemId, categoryId })
  assert.equal(cleared, false)
  const html = renderReportPanel('movements', data, filters)
  assert.match(html, new RegExp(`value="${itemId}" selected>[^<]+\\(archived\\)`))
  assert.ok(html.includes(`value="${categoryId}" selected>Archived report fixture (archived)`))
  for (const view of ['inventory', 'restocking', 'expiration']) {
    assert.equal(normalize(view, data, { categoryId }).cleared, true)
    assert.ok(!reportSelectOptions(view, data.inventory).categoryId.some(([key]) => key === categoryId))
  }
})

test('unknown options fall back to defaults while valid zero-result filters are retained', () => {
  const data = fixtureReports()
  const unknown = {
    inventory: { stockStatus: 'bad-status', sort: 'quantity-invalid' },
    restocking: { stockScope: 'bad-scope' },
    expiration: { status: 'bad-classification' },
    movements: { type: 'bad-movement' },
  }
  for (const [view, values] of Object.entries(unknown)) {
    assert.deepEqual(normalize(view, data, values), { filters: reportDefaults[view], cleared: true })
  }
  const query = '<no such item & no movement>'
  const overview = normalize('inventory', data, { query, sort: 'quantity-desc', stockStatus: 'low-stock' })
  assert.equal(overview.cleared, false)
  assert.equal(overview.filters.query, query)
  assert.equal(overview.filters.sort, 'quantity-desc')
  assert.equal(renderReportResults('inventory', data, overview.filters).count, 'Showing 0 of 12 active items')
  const values = { itemId: id(101), categoryId: id(4), type: 'stock_in', fromDate: '2026-11-19', toDate: '2026-11-19' }
  const result = normalize('movements', data, values)
  assert.deepEqual(result, { filters: values, cleared: false })
  assert.equal(renderReportResults('movements', data, result.filters).count, 'Showing 0 of 22 movement records')
})

test('clearing an unavailable option preserves malformed dates and reversed ranges for validation', () => {
  const data = fixtureReports()
  for (const [fromDate, toDate, field, error] of [
    ['2026-02-30', '2026-11-19', 'fromDate', 'Enter a valid start date.'],
    ['2026-11-20', '2026-11-19', 'toDate', 'Enter an end date on or after the start date.'],
  ]) {
    const result = normalize('movements', data, { itemId: 'unavailable', fromDate, toDate })
    assert.equal(result.cleared, true)
    assert.equal(result.filters.fromDate, fromDate)
    assert.equal(result.filters.toDate, toDate)
    assert.equal(renderReportResults('movements', data, result.filters).errors[field], error)
  }
})

test('History link names distinguish movement types and duplicate names with colliding ID suffixes', () => {
  const snapshot = structuredClone(demoInventory)
  const otherId = '10000000-0000-4000-8000-000000000101'
  const name = 'Cups <& "lids">'
  snapshot.inventory_items.find(({ item_id }) => item_id === id(101)).name = name
  const other = snapshot.inventory_items.find(({ item_id }) => item_id === id(102))
  Object.assign(other, { name, item_id: otherId })
  for (const record of [...snapshot.stock_movements, ...snapshot.stock_batches]) {
    if (record.item_id === id(102)) record.item_id = otherId
  }
  const data = buildInventoryReports(snapshot)
  const history = buildTransactionHistory(snapshot)
  const fromDate = '2026-11-01'
  const toDate = '2026-11-30'
  const filters = normalize('movements', data, { fromDate, toDate }).filters
  const html = renderReportResults('movements', data, filters).html.split('</table>')[0]
  const links = [...html.matchAll(/href="([^"]+)" aria-label="([^"]+)">View history<\/a>/g)]
  const groupByKey = new Map(movementReport(data, filters).groups.map((group) => [group.itemId + ':' + group.type, group]))
  const duplicateLabels = []
  for (const [, href, label] of links) {
    const params = new URLSearchParams(href.split('?')[1].replaceAll('&amp;', '&'))
    const itemId = params.get('item')
    if (![id(101), otherId].includes(itemId)) continue
    const type = params.get('type')
    const group = groupByKey.get(itemId + ':' + type)
    assert.equal(params.get('from'), fromDate)
    assert.equal(params.get('to'), toDate)
    const records = filterTransactionHistory(history.movements, { itemId, type, fromDate, toDate }).movements
    assert.equal(records.length, group.movementCount)
    assert.equal(records.reduce((sum, { quantity }) => sum + quantity, 0), group.quantityChange)
    assert.match(label, /View history for Cups &lt;&amp; &quot;lids&quot;&gt; · Item .* · Transaction History$/)
    duplicateLabels.push({ itemId, type, label })
  }
  assert.ok(duplicateLabels.some(({ itemId }) => itemId === otherId))
  const receipts = duplicateLabels.find(({ itemId, type }) => itemId === id(101) && type === 'stock_in')
  const usage = duplicateLabels.find(({ itemId, type }) => itemId === id(101) && type === 'stock_out')
  assert.match(receipts.label, /Stock received/)
  assert.match(usage.label, /Usage recorded/)
  assert.equal(new Set(duplicateLabels.map(({ label }) => label)).size, duplicateLabels.length)
  assert.equal(new Set(duplicateLabels.map(({ label }) => label.split(' · ')[1])).size, 2)
})
