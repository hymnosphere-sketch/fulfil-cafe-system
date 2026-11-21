const WIRE_FIELDS = [
  'operation_id', 'operation_type', 'entity_id', 'payload', 'created_at', 'local_sequence',
]
const ITEM_FIELDS = ['category_id', 'name', 'unit_of_measurement', 'minimum_stock_level']
const CATEGORY_FIELDS = ['name', 'description']
const MOVEMENT_FIELDS = ['movement_id', 'item_id', 'movement_type', 'quantity_change', 'allocations']
const ALLOCATION_FIELDS = ['allocation_id', 'batch_id', 'quantity_change']
const BATCH_FIELDS = ['batch_id', 'received_quantity']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TIMESTAMP = /^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(\.[0-9]{3})?Z$/
const CALENDAR_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/
const BLANK_TEXT = /^[\p{White_Space}\u001c-\u001f]*$/u
const UNPAIRED_SURROGATE = /[\ud800-\udfff]/u

export const WIRE_UNIT_SCALES = Object.freeze({ piece: 0, kg: 3, l: 3 })
export const POSITIVE_MOVEMENT_TYPES = Object.freeze(['initial_stock', 'stock_in', 'positive_adjustment'])
export const MOVEMENT_TYPES = Object.freeze([
  ...POSITIVE_MOVEMENT_TYPES, 'stock_out', 'wastage', 'negative_adjustment',
])
export const REASON_REQUIRED_MOVEMENT_TYPES = Object.freeze([
  'wastage', 'positive_adjustment', 'negative_adjustment',
])

export class CommandValidationError extends Error {
  constructor(code, field) {
    super('The command does not match the supported inventory API profile.')
    this.name = 'CommandValidationError'
    this.code = code
    this.field = field
  }
}

export function isWireUuid(value) {
  return typeof value === 'string' && value.length === 36 && UUID.test(value)
}

export function sameWireUuid(left, right) {
  return isWireUuid(left) && isWireUuid(right) && left.toLowerCase() === right.toLowerCase()
}

export function isWireTimestamp(value) {
  if (typeof value !== 'string' || (value.length !== 20 && value.length !== 24)) return false
  const parts = TIMESTAMP.exec(value)
  if (!parts || value.startsWith('0000')) return false

  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === parts[1] + (parts[2] ?? '.000') + 'Z'
}

export function isWireDate(value) {
  return typeof value === 'string' && value.length === 10 && CALENDAR_DATE.test(value) &&
    isWireTimestamp(value + 'T00:00:00Z')
}

export function normalizeWireDisplayText(value) {
  // Match the audited Python display-name cleanup, including its extra edge separators.
  return value.normalize('NFC').replace(/\p{White_Space}+/gu, ' ').replace(/^[ \u001c-\u001f]+|[ \u001c-\u001f]+$/g, '')
}

function ownData(record, field) {
  const descriptor = Object.getOwnPropertyDescriptor(record, field)
  return descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value')
    ? descriptor.value
    : undefined
}

function requireRecord(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CommandValidationError('INVALID_COMMAND', field)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CommandValidationError('INVALID_COMMAND', field)
  }
}

function copyFields(value, field, allowed, required = allowed) {
  requireRecord(value, field)
  const keys = Reflect.ownKeys(value)
  if (keys.some((key) => !allowed.includes(key) || ownData(value, key) === undefined) ||
      required.some((key) => !Object.hasOwn(value, key))) {
    throw new CommandValidationError('INVALID_COMMAND', field)
  }
  return Object.fromEntries(keys.map((key) => [key, ownData(value, key)]))
}

function copyArray(value, field, copyEntry) {
  if (!Array.isArray(value) || Reflect.ownKeys(value).length !== value.length + 1) {
    throw new CommandValidationError('INVALID_COMMAND', field)
  }
  const result = []
  for (let index = 0; index < value.length; index += 1) {
    result.push(copyEntry(ownData(value, String(index))))
  }
  return result
}

function requireUuid(value, field) {
  if (!isWireUuid(value)) throw new CommandValidationError('INVALID_COMMAND', field)
}

function requireEntity(value, entityId, field) {
  if (!sameWireUuid(value, entityId)) throw new CommandValidationError('INVALID_COMMAND', field)
}

function requireInteger(value, field, minimum = Number.MIN_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new CommandValidationError('INVALID_QUANTITY', field)
  }
}

function requireText(value, field, required = false) {
  if (!required && value === null) return
  if (typeof value !== 'string' || UNPAIRED_SURROGATE.test(value) ||
      (required && BLANK_TEXT.test(value))) {
    throw new CommandValidationError('INVALID_COMMAND', field)
  }
}

function validateCategory(operation, value, entityId) {
  const creates = operation === 'create_category'
  const allowed = creates ? ['category_id', ...CATEGORY_FIELDS] : CATEGORY_FIELDS
  const required = creates ? ['category_id', 'name'] : []
  const payload = copyFields(value, 'payload', allowed, required)
  if (!Object.keys(payload).length) throw new CommandValidationError('INVALID_COMMAND', 'payload')
  if (creates) requireEntity(payload.category_id, entityId, 'category_id')
  if (Object.hasOwn(payload, 'name')) requireText(payload.name, 'name', true)
  if (Object.hasOwn(payload, 'description')) requireText(payload.description, 'description')
  return payload
}

function validateItem(operation, value, entityId) {
  const creates = operation === 'create_item'
  const allowed = creates ? ['item_id', ...ITEM_FIELDS] : ITEM_FIELDS
  const payload = copyFields(value, 'payload', allowed, creates ? allowed : [])
  if (!Object.keys(payload).length) throw new CommandValidationError('INVALID_COMMAND', 'payload')
  if (creates) requireEntity(payload.item_id, entityId, 'item_id')
  if (Object.hasOwn(payload, 'category_id')) requireUuid(payload.category_id, 'category_id')
  if (Object.hasOwn(payload, 'name')) requireText(payload.name, 'name', true)
  if (Object.hasOwn(payload, 'minimum_stock_level')) {
    requireInteger(payload.minimum_stock_level, 'minimum_stock_level', 0)
  }
  if (Object.hasOwn(payload, 'unit_of_measurement') &&
      (typeof payload.unit_of_measurement !== 'string' ||
       !Object.hasOwn(WIRE_UNIT_SCALES, payload.unit_of_measurement))) {
    throw new CommandValidationError('UNSUPPORTED_UNIT', 'unit_of_measurement')
  }
  return payload
}

function copyAllocation(value) {
  const allocation = copyFields(value, 'allocations', ALLOCATION_FIELDS)
  requireUuid(allocation.allocation_id, 'allocation_id')
  requireUuid(allocation.batch_id, 'batch_id')
  requireInteger(allocation.quantity_change, 'allocation quantity_change')
  return allocation
}

function copyNewBatch(value) {
  const payload = copyFields(value, 'new_batches',
    [...BATCH_FIELDS, 'purchase_date', 'purchase_cost', 'expiration_date'], BATCH_FIELDS)
  requireUuid(payload.batch_id, 'batch_id')
  requireInteger(payload.received_quantity, 'received_quantity', 1)
  for (const field of ['purchase_date', 'expiration_date']) {
    if (Object.hasOwn(payload, field) && payload[field] !== null && !isWireDate(payload[field])) {
      throw new CommandValidationError('INVALID_COMMAND', field)
    }
  }
  if (Object.hasOwn(payload, 'purchase_cost') && payload.purchase_cost !== null) {
    requireInteger(payload.purchase_cost, 'purchase_cost', 0)
  }
  return payload
}

function validateAllocations(allocations, total, positive) {
  if (!allocations.length) throw new CommandValidationError('INVALID_COMMAND', 'allocations')
  const batchQuantities = new Map()
  const allocationIds = new Set()
  let allocated = 0
  for (const allocation of allocations) {
    const id = allocation.allocation_id.toLowerCase()
    const batchId = allocation.batch_id.toLowerCase()
    const quantity = allocation.quantity_change
    if (allocationIds.has(id) || batchQuantities.has(batchId) ||
        (positive ? quantity <= 0 : quantity >= 0)) {
      throw new CommandValidationError('INVALID_BATCH_ALLOCATION', 'allocations')
    }
    allocationIds.add(id)
    batchQuantities.set(batchId, quantity)
    allocated += quantity
    requireInteger(allocated, 'allocation total')
  }
  if (allocated !== total) throw new CommandValidationError('INVALID_BATCH_ALLOCATION', 'allocations')
  return batchQuantities
}

function validateNewBatches(batches, batchQuantities, movementType, positive) {
  if ((!positive && batches.length) ||
      ((movementType === 'stock_in' || movementType === 'initial_stock') &&
       batches.length !== batchQuantities.size)) {
    throw new CommandValidationError('INVALID_BATCH_ALLOCATION', 'new_batches')
  }
  const seen = new Set()
  for (const batch of batches) {
    const id = batch.batch_id.toLowerCase()
    if (seen.has(id) || batchQuantities.get(id) !== batch.received_quantity) {
      throw new CommandValidationError('INVALID_BATCH_ALLOCATION', 'new_batches')
    }
    seen.add(id)
  }
}

function validateStock(value, entityId) {
  const payload = copyFields(value, 'payload',
    [...MOVEMENT_FIELDS, 'reason', 'recorded_by', 'new_batches'], MOVEMENT_FIELDS)
  requireEntity(payload.movement_id, entityId, 'movement_id')
  requireUuid(payload.item_id, 'item_id')
  const { movement_type: type, quantity_change: quantity } = payload
  if (!MOVEMENT_TYPES.includes(type)) throw new CommandValidationError('INVALID_COMMAND', 'movement_type')
  const positive = POSITIVE_MOVEMENT_TYPES.includes(type)
  requireInteger(quantity, 'quantity_change')
  if (positive ? quantity <= 0 : quantity >= 0) {
    throw new CommandValidationError('INVALID_QUANTITY', 'quantity_change')
  }
  const reasonRequired = REASON_REQUIRED_MOVEMENT_TYPES.includes(type)
  if (reasonRequired || Object.hasOwn(payload, 'reason')) {
    requireText(payload.reason, 'reason', reasonRequired)
  }
  if (Object.hasOwn(payload, 'recorded_by') && payload.recorded_by !== null) {
    throw new CommandValidationError('INVALID_COMMAND', 'recorded_by')
  }

  payload.allocations = copyArray(payload.allocations, 'allocations', copyAllocation)
  const batchQuantities = validateAllocations(payload.allocations, quantity, positive)
  if (Object.hasOwn(payload, 'new_batches')) {
    payload.new_batches = copyArray(payload.new_batches, 'new_batches', copyNewBatch)
  }
  validateNewBatches(payload.new_batches ?? [], batchQuantities, type, positive)
  return payload
}

function validatePayload(type, payload, entityId) {
  switch (type) {
    case 'create_category':
    case 'update_category':
      return validateCategory(type, payload, entityId)
    case 'archive_category':
    case 'archive_item':
      return copyFields(payload, 'payload', [])
    case 'create_item':
    case 'update_item':
      return validateItem(type, payload, entityId)
    case 'record_stock_movement':
      return validateStock(payload, entityId)
    default:
      throw new CommandValidationError('UNSUPPORTED_OPERATION', 'operation_type')
  }
}

export function validateWireCommand(value) {
  const command = copyFields(value, 'command', WIRE_FIELDS)
  requireUuid(command.operation_id, 'operation_id')
  requireUuid(command.entity_id, 'entity_id')
  if (!isWireTimestamp(command.created_at)) throw new CommandValidationError('INVALID_COMMAND', 'created_at')
  requireInteger(command.local_sequence, 'local_sequence', 1)
  command.payload = validatePayload(command.operation_type, command.payload, command.entity_id)
  return command
}

export function adaptQueueCommand(record) {
  requireRecord(record, 'queue record')
  if (ownData(record, 'fictional') !== false || ownData(record, 'upload_eligible') !== true) {
    throw new CommandValidationError('INELIGIBLE_QUEUE_RECORD', 'queue record')
  }
  if (ownData(record, 'wire_version') !== 1) {
    throw new CommandValidationError('UNSUPPORTED_WIRE_VERSION', 'wire_version')
  }
  // Project only the approved wire fields; never serialize the whole queue row.
  return validateWireCommand(Object.fromEntries(WIRE_FIELDS.map((field) => [field, ownData(record, field)])))
}
