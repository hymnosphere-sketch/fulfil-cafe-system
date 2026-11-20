import { InventoryDatabaseError } from '../db/database.js'
import { stockOperation } from './demo-operation-record.js'

export function invalidLedger(message, cause) {
  return new InventoryDatabaseError('DB_INTEGRITY', message, cause)
}

function indexStockCommands(queue, lastSequence) {
  const sequences = new Set()
  const stock = new Map()
  if (queue.length !== lastSequence) throw invalidLedger('The saved queue and committed sequence disagree.')
  for (const command of queue) {
    const sequence = command.local_sequence
    if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > lastSequence || sequences.has(sequence)) {
      throw invalidLedger('The saved queue has an invalid operation sequence.')
    }
    sequences.add(sequence)
    if (command.operation_type === 'record_stock_movement') {
      if (stock.has(command.entity_id)) throw invalidLedger('A stock movement has more than one queued operation.')
      stock.set(command.entity_id, command)
    }
  }
  return stock
}

function sameFields(actual, expected) {
  return actual != null && Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => Object.hasOwn(actual, key) && actual[key] === value)
}

function sameRecords(actual, expected, idField) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false
  const byId = new Map(actual.map((record) => [record?.[idField], record]))
  return byId.size === actual.length && expected.every((record) => sameFields(byId.get(record[idField]), record))
}

function matchesStockCommand(command, movement, allocations, batches) {
  if (command?.local_sequence !== movement.demo_order || !command.payload) return false
  const batch = movement.movement_type === 'stock_in' ? batches.get(allocations[0]?.batch_id) : null
  if (movement.movement_type === 'stock_in' && (!batch || allocations.length !== 1)) return false

  const { payload, createdAt } = stockOperation({ movement, batch, allocations })
  const { allocations: actualAllocations, new_batches: actualBatches, ...actual } = command.payload
  const { allocations: expectedAllocations, new_batches: expectedBatches, ...expected } = payload
  return command.created_at === createdAt && sameFields(actual, expected) &&
    sameRecords(actualAllocations, expectedAllocations, 'allocation_id') &&
    (expectedBatches ? sameRecords(actualBatches, expectedBatches, 'batch_id') : actualBatches === undefined)
}

// Version 1 gives the fixture a contiguous negative prefix. Only stock
// commands appear in the positive suffix, so catalog sequences can be skipped.
export function reconstructStoredMovements(snapshot, queue, lastSequence) {
  const stock = indexStockCommands(queue, lastSequence)
  const orders = new Set()
  const moves = snapshot.stock_movements
  const seedCount = moves.filter(({ demo_order }) => demo_order < 0).length
  const batches = new Map(snapshot.stock_batches.map((batch) => [batch.batch_id, batch]))
  const allocationsByMovement = new Map()
  for (const allocation of snapshot.batch_allocations) {
    const allocations = allocationsByMovement.get(allocation.movement_id) ?? []
    allocations.push(allocation)
    allocationsByMovement.set(allocation.movement_id, allocations)
  }

  for (const movement of moves) {
    const order = movement.demo_order
    if (!Number.isSafeInteger(order) || order === 0 || order < -seedCount || order > lastSequence || orders.has(order)) {
      throw invalidLedger('A saved stock movement has an invalid recording order.')
    }
    orders.add(order)
    if (order < 0) continue

    const id = movement.movement_id
    if (!matchesStockCommand(stock.get(id), movement, allocationsByMovement.get(id) ?? [], batches)) {
      throw invalidLedger('A saved stock movement disagrees with its queued operation.')
    }
    stock.delete(id)
  }
  if (stock.size) throw invalidLedger('A queued stock operation has no matching saved movement.')

  moves.sort((left, right) => left.demo_order - right.demo_order)
  snapshot.stock_movements = moves.map(({ demo_order, ...movement }) => movement)
  if (seedCount < moves.length) snapshot.demoSessionMovementStart = seedCount
}

export function verifyStockReceipt(snapshot, attemptId, result) {
  const movements = snapshot.stock_movements
  const index = movements.findIndex(({ movement_id }) => movement_id === attemptId)
  if (snapshot.demoSessionMovementStart === undefined || index < snapshot.demoSessionMovementStart ||
    !sameFields(result?.movement, movements[index])) {
    throw invalidLedger('A saved stock confirmation disagrees with its committed movement.')
  }
  const movement = movements[index]
  const allocations = snapshot.batch_allocations.filter(({ movement_id }) => movement_id === attemptId)
  if (!sameRecords(result.allocations, allocations, 'allocation_id')) {
    throw invalidLedger('A saved stock confirmation disagrees with its committed allocations.')
  }
  const received = movement.movement_type === 'stock_in'
  const batch = received ? snapshot.stock_batches.find(({ batch_id }) => batch_id === allocations[0]?.batch_id) : null
  if (received ? !batch || !sameFields(result.batch, batch) : result.batch !== null) {
    throw invalidLedger('A saved stock confirmation disagrees with its committed batch.')
  }

  // Check the balances at this operation in replay order. Later movements
  // may have changed the current balance. The validated changes are exact.
  let before = 0n
  for (let prior = 0; prior < index; prior += 1) {
    if (movements[prior].item_id === movement.item_id) before += BigInt(movements[prior].quantity_change)
  }
  if (result.currentQuantity !== Number(before) || result.resultingQuantity !== Number(before + BigInt(movement.quantity_change))) {
    throw invalidLedger('A saved stock confirmation disagrees with its historical balances.')
  }
}
