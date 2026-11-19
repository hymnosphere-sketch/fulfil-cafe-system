const MOVEMENT_SIGNS = new Map([
  ['initial_stock', 1],
  ['stock_in', 1],
  ['stock_out', -1],
  ['wastage', -1],
  ['positive_adjustment', 1],
  ['negative_adjustment', -1],
])

// Display order for the fictional dashboard. Production prioritization is still open.
const ALERT_PRIORITY = ['out-of-stock', 'expired', 'low-stock', 'expiring-soon']
const MILLISECONDS_PER_DAY = 86_400_000

function hasText(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function indexRecords(records, idField) {
  if (!Array.isArray(records)) {
    throw new Error('The inventory snapshot is missing records for ' + idField)
  }

  const index = new Map()
  for (const record of records) {
    const id = record?.[idField]
    if (!hasText(id) || index.has(id)) {
      throw new Error('Missing or duplicate ' + idField)
    }
    index.set(id, record)
  }

  return index
}

function civilDay(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('Invalid ' + label)
  }

  // Treat a civil date as a day number. No local timezone or daylight-saving conversion is needed.
  const timestamp = Date.parse(value + 'T00:00:00Z')
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new Error('Invalid ' + label)
  }

  return timestamp / MILLISECONDS_PER_DAY
}

function movementTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value)) {
    throw new Error('Invalid movement timestamp')
  }

  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 19) !== value.slice(0, 19)) {
    throw new Error('Invalid movement timestamp')
  }
  return timestamp
}

function safeSum(left, right, label) {
  const total = left + right
  if (!Number.isSafeInteger(total)) {
    throw new Error(label + ' exceeds the safe integer range')
  }
  return total
}

function updateBalance(balances, id, change, label) {
  const balance = safeSum(balances.get(id) ?? 0, change, label)
  if (balance < 0) {
    throw new Error(label + ' has a negative balance')
  }
  balances.set(id, balance)
}

function indexHistory(movements, allocations, items, batches) {
  const history = new Map()
  for (const movement of movements.values()) {
    const sign = MOVEMENT_SIGNS.get(movement.movement_type)
    if (!items.has(movement.item_id) || !Number.isSafeInteger(movement.quantity_change) ||
      !sign || Math.sign(movement.quantity_change) !== sign) {
      throw new Error('Invalid movement: ' + movement.movement_id)
    }

    history.set(movement.movement_id, {
      movement,
      timestamp: movementTimestamp(movement.created_at),
      allocations: new Map(),
    })
  }

  for (const allocation of allocations.values()) {
    const entry = history.get(allocation.movement_id)
    const batch = batches.get(allocation.batch_id)
    if (!entry || !batch || batch.item_id !== entry.movement.item_id ||
      entry.allocations.has(allocation.batch_id) || !Number.isSafeInteger(allocation.quantity_change) ||
      Math.sign(allocation.quantity_change) !== Math.sign(entry.movement.quantity_change)) {
      throw new Error('Invalid batch allocation: ' + allocation.allocation_id)
    }

    entry.allocations.set(allocation.batch_id, allocation.quantity_change)
  }

  return [...history.values()]
}

function calculateBalances(items, batches, history) {
  const itemBalances = new Map([...items.keys()].map((id) => [id, 0]))
  const batchBalances = new Map()

  // Stable sorting preserves the snapshot's recorded order when timestamps are equal.
  const chronological = [...history].sort((left, right) => left.timestamp - right.timestamp)
  for (const { movement, allocations } of chronological) {
    let allocated = 0
    for (const [batchId, quantity] of allocations) {
      if (!batchBalances.has(batchId) && quantity !== batches.get(batchId).received_quantity) {
        throw new Error('Batch ' + batchId + ' must start with a matching receipt allocation')
      }

      allocated = safeSum(allocated, quantity, 'Allocation total')
      updateBalance(batchBalances, batchId, quantity, 'Batch ' + batchId)
    }

    if (allocated !== movement.quantity_change) {
      throw new Error('Allocation total does not match movement ' + movement.movement_id)
    }
    updateBalance(itemBalances, movement.item_id, movement.quantity_change, 'Item ' + movement.item_id)
  }

  if (batchBalances.size !== batches.size) {
    throw new Error('Every batch must have a recorded receipt allocation')
  }

  return { itemBalances, batchBalances }
}

function collectExpirationAlerts(batches, items, batchBalances, today, warningDays) {
  let hasDatedStock = false
  const alertsByItem = new Map()
  for (const batch of batches.values()) {
    if (batch.expiration_date == null) continue

    const expirationDay = civilDay(batch.expiration_date, 'batch expiration date')
    if (!items.get(batch.item_id).is_active || batchBalances.get(batch.batch_id) === 0) continue

    hasDatedStock = true
    const daysUntilExpiry = expirationDay - today
    let alert
    if (daysUntilExpiry < 0) {
      alert = 'expired'
    } else if (warningDays !== null && daysUntilExpiry <= warningDays) {
      alert = 'expiring-soon'
    }

    if (alert) {
      if (!alertsByItem.has(batch.item_id)) alertsByItem.set(batch.item_id, new Set())
      alertsByItem.get(batch.item_id).add(alert)
    }
  }

  return { alertsByItem, hasDatedStock }
}

function compareText(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function compareAttention(left, right) {
  return ALERT_PRIORITY.indexOf(left.alerts[0]) - ALERT_PRIORITY.indexOf(right.alerts[0]) ||
    compareText(left.name.normalize('NFC').toLowerCase(), right.name.normalize('NFC').toLowerCase()) ||
    compareText(left.itemId, right.itemId)
}

function recentMovementsFor(history, items) {
  return [...history]
    .sort((left, right) => right.timestamp - left.timestamp ||
      compareText(left.movement.movement_id, right.movement.movement_id))
    .slice(0, 5)
    .map(({ movement }) => {
      const item = items.get(movement.item_id)
      return {
        movementId: movement.movement_id,
        itemName: item.name,
        type: movement.movement_type,
        quantity: movement.quantity_change,
        unit: item.unit_of_measurement,
        timestamp: movement.created_at,
      }
    })
}

// The caller chooses the business date as YYYY-MM-DD and the snapshot is never mutated.
export function summarizeInventory(snapshot, businessDate) {
  const today = civilDay(businessDate, 'business date')
  const warningDays = snapshot.settings?.expiration_warning_days ?? null
  if (warningDays !== null && (!Number.isSafeInteger(warningDays) || warningDays < 0)) {
    throw new Error('Invalid expiration warning period')
  }

  const categories = indexRecords(snapshot.categories, 'category_id')
  const items = indexRecords(snapshot.inventory_items, 'item_id')
  const batches = indexRecords(snapshot.stock_batches, 'batch_id')
  const movements = indexRecords(snapshot.stock_movements, 'movement_id')
  const allocations = indexRecords(snapshot.batch_allocations, 'allocation_id')

  for (const [id, item] of items) {
    if (!categories.has(item.category_id) || !hasText(item.name) || !hasText(item.unit_of_measurement) ||
      typeof item.is_active !== 'boolean') {
      throw new Error('Invalid inventory item: ' + id)
    }
    if (!Number.isSafeInteger(item.minimum_stock_level) || item.minimum_stock_level < 0) {
      throw new Error('Invalid minimum stock level for item ' + id)
    }
  }

  for (const [id, batch] of batches) {
    if (!items.has(batch.item_id) || !Number.isSafeInteger(batch.received_quantity) || batch.received_quantity <= 0) {
      throw new Error('Invalid stock batch: ' + id)
    }
  }

  const history = indexHistory(movements, allocations, items, batches)
  const { itemBalances, batchBalances } = calculateBalances(items, batches, history)
  const { alertsByItem, hasDatedStock } = collectExpirationAlerts(batches, items, batchBalances, today, warningDays)
  let expirationUnavailableReason = null
  if (warningDays === null) {
    expirationUnavailableReason = 'warning-period-unset'
  } else if (!hasDatedStock) {
    expirationUnavailableReason = 'no-dated-stock'
  }

  const counts = {
    totalActive: 0,
    lowStock: 0,
    outOfStock: 0,
    sufficient: 0,
    expiringSoon: expirationUnavailableReason ? null : 0,
  }
  const attentionItems = []

  for (const [id, item] of items) {
    if (!item.is_active) continue

    counts.totalActive += 1
    const quantity = itemBalances.get(id)
    const alerts = alertsByItem.get(id) ?? new Set()
    if (quantity === 0) {
      counts.outOfStock += 1
      alerts.add('out-of-stock')
    } else if (quantity <= item.minimum_stock_level) {
      counts.lowStock += 1
      alerts.add('low-stock')
    } else {
      counts.sufficient += 1
    }

    if (alerts.has('expiring-soon')) counts.expiringSoon += 1
    if (alerts.size > 0) {
      attentionItems.push({
        itemId: id,
        name: item.name,
        unit: item.unit_of_measurement,
        quantity,
        alerts: ALERT_PRIORITY.filter((alert) => alerts.has(alert)),
      })
    }
  }

  return {
    counts,
    expirationUnavailableReason,
    attentionItems: attentionItems.sort(compareAttention),
    recentMovements: recentMovementsFor(history, items),
    itemBalances,
    batchBalances,
  }
}
