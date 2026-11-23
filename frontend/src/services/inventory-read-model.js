import { demoBusinessDate, demoInventory } from '../data/demo-inventory.js'
import { findDemoItemMatches, normalizeDemoName } from '../utils/demo-catalog.js'
import { classifyStock, summarizeInventory } from './inventory-summary.js'

function compareText(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function countActiveItemsByCategory(items) {
  const counts = new Map()
  for (const item of items) {
    if (item.is_active) {
      counts.set(item.category_id, (counts.get(item.category_id) ?? 0) + 1)
    }
  }
  return counts
}

function groupRecordsByItem(records) {
  const groups = new Map()
  for (const record of records) {
    if (!groups.has(record.item_id)) groups.set(record.item_id, [])
    groups.get(record.item_id).push(record)
  }
  return groups
}

// Derive balances once from movements and batch allocations. Maps associate each
// category, batch, and movement with its item without scanning history per row.
export function buildInventoryReadModel(snapshot, businessDate = snapshot.businessDate ?? demoBusinessDate) {
  const summary = summarizeInventory(snapshot, businessDate)
  const activeCounts = countActiveItemsByCategory(snapshot.inventory_items)
  const categories = snapshot.categories.map((category) => ({
    categoryId: category.category_id,
    name: category.name,
    description: category.description ?? null,
    isActive: category.is_active,
    activeItemCount: activeCounts.get(category.category_id) ?? 0,
    createdAt: category.created_at ?? null,
    updatedAt: category.updated_at ?? null,
  })).sort((left, right) => compareText(normalizeDemoName(left.name), normalizeDemoName(right.name)) ||
    compareText(left.categoryId, right.categoryId))
  const categoryById = new Map(categories.map((category) => [category.categoryId, category]))

  const batchesByItem = groupRecordsByItem(snapshot.stock_batches)
  const movementsByItem = groupRecordsByItem(summary.movementsNewestFirst)

  const items = snapshot.inventory_items.map((item) => {
    const itemId = item.item_id
    const unit = item.unit_of_measurement
    const availableQuantity = summary.itemBalances.get(itemId)
    const minimumStockLevel = item.minimum_stock_level
    const batches = (batchesByItem.get(itemId) ?? []).map((batch) => ({
      batchId: batch.batch_id,
      receivedQuantity: batch.received_quantity,
      remainingQuantity: summary.batchBalances.get(batch.batch_id),
      purchaseDate: batch.purchase_date ?? null,
      expirationDate: batch.expiration_date ?? null,
      expirationStatus: summary.batchExpirationStatuses.get(batch.batch_id),
      purchaseCost: batch.purchase_cost ?? null,
    }))
    const movements = (movementsByItem.get(itemId) ?? []).map((movement) => ({
      movementId: movement.movement_id,
      type: movement.movement_type,
      quantity: movement.quantity_change,
      unit,
      timestamp: movement.created_at,
      reason: movement.reason ?? null,
    }))
    const alerts = summary.expirationAlertsByItem.get(itemId)

    return {
      itemId,
      categoryId: item.category_id,
      name: item.name,
      normalizedName: normalizeDemoName(item.name),
      categoryName: categoryById.get(item.category_id).name,
      unit,
      availableQuantity,
      minimumStockLevel,
      stockStatus: classifyStock(availableQuantity, minimumStockLevel),
      expirationAlerts: ['expired', 'expiring-soon'].filter((alert) => alerts?.has(alert)),
      isActive: item.is_active,
      createdAt: item.created_at ?? null,
      updatedAt: item.updated_at ?? null,
      hasHistory: batches.length > 0 || movements.length > 0,
      batches,
      movements,
    }
  })

  return {
    items,
    categories,
    itemById: new Map(items.map((item) => [item.itemId, item])),
    categoryById,
    summary,
    businessDate,
    quantityUnits: snapshot.quantityUnits,
    // Use the fictional fixture's timezone for display when settings are absent.
    businessTimezone: snapshot.settings?.business_timezone ?? demoInventory.settings.business_timezone,
    warningDays: snapshot.settings?.expiration_warning_days ?? null,
  }
}

export function searchInventory(items, query) {
  const normalizedQuery = normalizeDemoName(query)
  if (!normalizedQuery) return items.slice()

  const exactId = query.trim()
  return items.filter((item) => item.itemId === exactId || item.normalizedName.includes(normalizedQuery))
}

export function filterInventoryByCategory(items, categoryId) {
  return items.filter((item) => !categoryId || item.categoryId === categoryId)
}

export function filterInventoryByStockStatus(items, stockStatus) {
  return items.filter((item) => !stockStatus || item.stockStatus === stockStatus)
}

export function filterInventoryByRecordStatus(items, view = 'active') {
  return items.filter((item) => view === 'all' || item.isActive === (view === 'active'))
}

function compareItemNames(left, right, direction = 1) {
  return direction * compareText(left.normalizedName, right.normalizedName) ||
    compareText(left.itemId, right.itemId)
}

export function sortInventoryByName(items, order = 'asc') {
  const direction = order === 'desc' ? -1 : 1
  return items.slice().sort((left, right) => compareItemNames(left, right, direction))
}

export function sortInventoryByQuantity(items, order = 'asc') {
  const direction = order === 'desc' ? -1 : 1
  const itemsByUnit = new Map()
  for (const item of items) {
    // Each fictional unit ID is its own compatible group. No conversions are applied.
    if (!itemsByUnit.has(item.unit)) itemsByUnit.set(item.unit, [])
    itemsByUnit.get(item.unit).push(item)
  }

  return [...itemsByUnit.keys()].sort(compareText).flatMap((unit) =>
    itemsByUnit.get(unit).sort((left, right) =>
      direction * (left.availableQuantity - right.availableQuantity) || compareItemNames(left, right)),
  )
}

export function filterAndSortInventory(items, {
  query = '',
  categoryId = '',
  stockStatus = '',
  view = 'active',
  sort = 'name-asc',
} = {}) {
  const matchingRecords = filterInventoryByRecordStatus(items, view)
  const searchMatches = searchInventory(matchingRecords, query)
  const categoryMatches = filterInventoryByCategory(searchMatches, categoryId)
  const filtered = filterInventoryByStockStatus(categoryMatches, stockStatus)

  if (sort === 'quantity-asc') return sortInventoryByQuantity(filtered)
  if (sort === 'quantity-desc') return sortInventoryByQuantity(filtered, 'desc')
  return sortInventoryByName(filtered, sort === 'name-desc' ? 'desc' : 'asc')
}

export function findPotentialDuplicateItems(items, name, { excludeItemId } = {}) {
  return findDemoItemMatches(items, name, { excludeId: excludeItemId, idField: 'itemId' })
    .map(({ record, reason }) => ({ ...record, reason }))
}
