import { buildInventoryReadModel, sortInventoryByName } from './inventory-read-model.js'
import { civilDay } from './inventory-summary.js'

function businessDayAt(timestamp, formatter) {
  const fields = Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map(({ type, value }) => [type, value]))
  const year = fields.era === 'BC' ? 1 - Number(fields.year) : Number(fields.year)
  return year * 10_000 + Number(fields.month) * 100 + Number(fields.day)
}

// Use the same movement order as the dashboard and item details. Grouping the
// allocations takes O(a), and joining the m movements to their items takes O(m).
export function buildTransactionHistory(snapshot) {
  const { items, itemById, summary, businessTimezone } = buildInventoryReadModel(snapshot)
  const formatter = new Intl.DateTimeFormat('en-GB-u-ca-gregory-nu-latn', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    era: 'short',
    timeZone: businessTimezone,
  })
  const allocationsByMovement = new Map()
  for (const allocation of snapshot.batch_allocations) {
    if (!allocationsByMovement.has(allocation.movement_id)) {
      allocationsByMovement.set(allocation.movement_id, [])
    }
    allocationsByMovement.get(allocation.movement_id).push({
      batchId: allocation.batch_id,
      quantity: allocation.quantity_change,
    })
  }

  const movements = summary.movementsNewestFirst.map((movement) => {
    const item = itemById.get(movement.item_id)
    return {
      movementId: movement.movement_id,
      itemId: item.itemId,
      name: item.name,
      categoryName: item.categoryName,
      isActive: item.isActive,
      type: movement.movement_type,
      quantity: movement.quantity_change,
      unit: item.unit,
      timestamp: movement.created_at,
      businessDay: businessDayAt(movement.created_at, formatter),
      reason: movement.reason,
      allocations: allocationsByMovement.get(movement.movement_id),
    }
  })

  return {
    items: sortInventoryByName(items),
    businessTimezone,
    movements,
    movementById: new Map(movements.map((movement) => [movement.movementId, movement])),
  }
}

export function validateTransactionDateRange({ fromDate = '', toDate = '' } = {}) {
  const errors = {}
  for (const [field, date, label] of [
    ['fromDate', fromDate, 'start'],
    ['toDate', toDate, 'end'],
  ]) {
    if (date === '') continue
    try {
      civilDay(date)
    } catch {
      errors[field] = `Enter a valid ${label} date.`
    }
  }
  if (!errors.fromDate && !errors.toDate && fromDate && toDate && fromDate > toDate) {
    errors.toDate = 'Enter an end date on or after the start date.'
  }
  return errors
}

// A single pass keeps display order. Numeric calendar dates include the full
// selected start and end days regardless of the time of each movement.
export function filterTransactionHistory(movements, {
  itemId = '', type = '', fromDate = '', toDate = '',
} = {}) {
  const errors = validateTransactionDateRange({ fromDate, toDate })
  if (Object.keys(errors).length) return { errors, movements: [] }

  const start = fromDate ? Number(fromDate.replaceAll('-', '')) : -Infinity
  const end = toDate ? Number(toDate.replaceAll('-', '')) : Infinity
  return {
    errors,
    movements: movements.filter((movement) =>
      (!itemId || movement.itemId === itemId) &&
      (!type || movement.type === type) &&
      movement.businessDay >= start &&
      movement.businessDay <= end),
  }
}
