import {
  buildInventoryReadModel, filterAndSortInventory, filterInventoryByCategory, sortInventoryByName,
} from './inventory-read-model.js'
import { filterTransactionHistory, projectTransactionMovements } from './transaction-history.js'

function compareText(left, right) {
  return left === right ? 0 : left < right ? -1 : 1
}

function compareBatchDates(left, right) {
  if (left.expirationDate === right.expirationDate) return compareText(left.batchId, right.batchId)
  if (left.expirationDate === null) return 1
  if (right.expirationDate === null) return -1
  return compareText(left.expirationDate, right.expirationDate)
}

// Build one projection from the shared snapshot. The read model replays stock
// once and owns all balance and status rules.
export function buildInventoryReports(snapshot, businessDate) {
  const inventory = buildInventoryReadModel(snapshot, businessDate)
  const expirationRecords = []
  for (const { itemId, name, categoryId, categoryName, unit, batches, isActive } of inventory.items) {
    if (!isActive) continue
    for (const { batchId, remainingQuantity, purchaseDate, expirationDate, expirationStatus } of batches) {
      if (remainingQuantity <= 0) continue
      expirationRecords.push({
        itemId, name, categoryId, categoryName, unit, batchId,
        remainingQuantity, purchaseDate, expirationDate, expirationStatus,
      })
    }
  }
  return {
    inventory,
    expirationRecords: expirationRecords.sort(compareBatchDates),
    movements: projectTransactionMovements(inventory),
  }
}

export function inventoryOverview({ inventory }, filters) {
  return filterAndSortInventory(inventory.items, { ...filters, view: 'active' })
}

export function restockingItems({ inventory }, { categoryId = '', includeOutOfStock = true } = {}) {
  const candidates = filterInventoryByCategory(inventory.items, categoryId).filter(({ isActive, stockStatus }) =>
    isActive && (stockStatus === 'low-stock' || (includeOutOfStock && stockStatus === 'out-of-stock')))
  const ordered = sortInventoryByName(candidates)
  return [
    ...ordered.filter(({ stockStatus }) => stockStatus === 'out-of-stock'),
    ...ordered.filter(({ stockStatus }) => stockStatus === 'low-stock'),
  ].map((item) => ({
    ...item,
    shortfallToMinimum: Math.max(0, item.minimumStockLevel - item.availableQuantity),
  }))
}

export function expirationMonitoring({ inventory, expirationRecords }, { categoryId = '', status = '' } = {}) {
  const categoryMatches = filterInventoryByCategory(expirationRecords, categoryId)
  const expiredBatchCount = categoryMatches.filter(({ expirationStatus }) => expirationStatus === 'expired').length
  const hasDatedStock = categoryMatches.some(({ expirationDate }) => expirationDate !== null)
  // A missing period or an absence of dated stock leaves the warning count unavailable.
  const warningPeriodUnavailable = inventory.warningDays === null
  const expiringSoonItemCount = warningPeriodUnavailable || !hasDatedStock ? null : new Set(
    categoryMatches.filter(({ expirationStatus }) => expirationStatus === 'expiring-soon').map(({ itemId }) => itemId),
  ).size
  const rows = categoryMatches.filter(({ expirationStatus }) =>
    !status || (status === 'alerts' ? expirationStatus === 'expired' || expirationStatus === 'expiring-soon' : expirationStatus === status))
  return { rows, expiredBatchCount, expiringSoonItemCount, hasDatedStock, warningPeriodUnavailable }
}

// Key each signed sum by stable item ID, unit, and movement type. An overflowed
// group stays unavailable even if other groups can still be reported.
export function aggregateReportMovements(movements, itemById) {
  const groups = new Map()
  for (const movement of movements) {
    const { itemId, name, categoryName, isActive, unit, type, quantity } = movement
    const key = JSON.stringify([itemId, unit, type])
    if (!groups.has(key)) {
      groups.set(key, {
        itemId, name, categoryName, isActive, unit, type,
        normalizedName: itemById.get(itemId).normalizedName, movementCount: 0, quantityChange: 0,
      })
    }
    const group = groups.get(key)
    group.movementCount += 1
    if (group.quantityChange !== null) {
      const next = group.quantityChange + quantity
      group.quantityChange = Number.isSafeInteger(next) ? next : null
    }
  }
  return [...groups.values()].sort((left, right) =>
    compareText(left.normalizedName, right.normalizedName) ||
    compareText(left.itemId, right.itemId) ||
    compareText(left.unit, right.unit) ||
    compareText(left.type, right.type))
}

export function movementReport({ movements, inventory }, filters) {
  const result = filterTransactionHistory(movements, filters)
  return {
    errors: result.errors,
    matchingMovements: result.movements.length,
    groups: aggregateReportMovements(result.movements, inventory.itemById),
  }
}
