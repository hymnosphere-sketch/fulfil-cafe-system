import { movementTimestamp } from '../services/inventory-summary.js'
import { createUniqueId, DemoRepositoryError } from './demo-inventory-rules.js'

export function catalogOperation(type, record, snapshot) {
  const category = type.endsWith('_category')
  const entityId = category ? record.category_id : record.item_id
  let payload = {}
  if (!type.startsWith('archive_')) {
    if (category) {
      payload = { name: record.name, description: record.description }
      if (type === 'create_category') payload.category_id = entityId
    } else {
      payload = {
        name: record.name,
        category_id: record.category_id,
        minimum_stock_level: record.minimum_stock_level,
      }
      if (type === 'create_item') {
        payload.item_id = entityId
        payload.unit_of_measurement = record.unit_of_measurement
      } else {
        const previous = snapshot.inventory_items.find(({ item_id }) => item_id === entityId)
        if (previous.unit_of_measurement !== record.unit_of_measurement) {
          payload.unit_of_measurement = record.unit_of_measurement
        }
      }
    }
  }
  return { type, entityId, payload, createdAt: record.updated_at }
}

export function stockOperation({ movement, batch, allocations }) {
  const { movement_id, item_id, movement_type, quantity_change, reason, created_at } = movement
  const payload = {
    movement_id, item_id, movement_type, quantity_change, reason,
    allocations: allocations.map(({ allocation_id, batch_id, quantity_change }) => ({
      allocation_id, batch_id, quantity_change,
    })),
  }
  if (batch) {
    const { batch_id, received_quantity, purchase_date, purchase_cost, expiration_date } = batch
    payload.new_batches = [{ batch_id, received_quantity, purchase_date, purchase_cost, expiration_date }]
  }
  return { type: 'record_stock_movement', entityId: movement_id, payload, createdAt: created_at }
}

export function buildDemoQueueRecord({ type, entityId, payload, createdAt }, localSequence, createId) {
  try {
    movementTimestamp(createdAt)
  } catch {
    throw new DemoRepositoryError('INVALID_TIMESTAMP', 'The device could not provide a valid local operation timestamp.')
  }
  return {
    operation_id: createUniqueId(createId, new Set([entityId])),
    operation_type: type,
    entity_id: entityId,
    payload,
    wire_version: 1,
    local_sequence: localSequence,
    status: 'pending',
    retry_count: 0,
    last_attempt_at: null,
    last_error: null,
    created_at: createdAt,
    synchronized_at: null,
    resolution_status: 'none',
    resolution_audit: null,
    // These demonstration commands have no approved production unit, policy, or generation mapping.
    fictional: true,
    upload_eligible: false,
  }
}
