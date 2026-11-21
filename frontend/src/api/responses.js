import {
  isWireDate,
  isWireTimestamp,
  isWireUuid,
  MOVEMENT_TYPES,
  normalizeWireDisplayText,
  POSITIVE_MOVEMENT_TYPES,
  REASON_REQUIRED_MOVEMENT_TYPES,
  sameWireUuid,
  WIRE_UNIT_SCALES,
} from './commands.js'

const SNAPSHOT_FIELDS = [
  'schema_version', 'server_generation_id', 'receipt_checks', 'snapshot_at',
  'categories', 'inventory_items', 'stock_batches', 'stock_movements',
  'batch_allocations', 'settings', 'sync', 'backup',
]
const CATEGORY_FIELDS = [
  'category_id', 'name', 'normalized_name', 'description', 'is_active', 'created_at', 'updated_at',
]
const ITEM_FIELDS = [
  'item_id', 'category_id', 'name', 'normalized_name', 'unit_of_measurement', 'minimum_stock_level',
  'is_active', 'created_at', 'updated_at', 'available_quantity', 'stock_status',
]
const BATCH_FIELDS = [
  'batch_id', 'item_id', 'received_quantity', 'purchase_date', 'purchase_cost',
  'expiration_date', 'created_at', 'remaining_quantity',
]
const MOVEMENT_FIELDS = [
  'movement_id', 'item_id', 'movement_type', 'quantity_change', 'reason', 'recorded_by', 'created_at',
]
const MOVEMENT_RESULT_FIELDS = [...MOVEMENT_FIELDS, 'allocations']
const ALLOCATION_FIELDS = ['allocation_id', 'batch_id', 'quantity_change']
const SNAPSHOT_ALLOCATION_FIELDS = [...ALLOCATION_FIELDS, 'movement_id']
const ACKNOWLEDGMENT_FIELDS = ['operation_id', 'outcome', 'processed_at', 'result']
// The audited response subset covers Latin-1 plus these verified folds and unchanged characters.
const VERIFIED_NAME_FOLDS = new Map([
  ['µ', 'μ'], ['μ', 'μ'], ['ß', 'ss'], ['ẞ', 'ss'], ['ﬃ', 'ffi'],
  ['Ο', 'ο'], ['Σ', 'σ'], ['ς', 'σ'], ['ο', 'ο'], ['σ', 'σ'],
  ['\ufeff', '\ufeff'], ['\ufffd', '\ufffd'],
])

export class ApiProtocolError extends Error {
  constructor(field) {
    super(`Invalid inventory API response at ${field}.`)
    this.name = 'ApiProtocolError'
    this.code = 'INVALID_PROTOCOL_RESPONSE'
    this.field = field
  }
}

function check(valid, field) {
  if (!valid) throw new ApiProtocolError(field)
}

function fields(value, keys, field) {
  check(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)), field)
}

function nonblank(value) {
  // Python's audited text validator also treats the four ASCII separators as whitespace.
  return typeof value === 'string' && !/[\ud800-\udfff]/u.test(value) &&
    /[^\p{White_Space}\u001c-\u001f]/u.test(value)
}

function nonnegative(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function positive(value) {
  return Number.isSafeInteger(value) && value > 0
}

function timezone(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_+/-]*$/i.test(value)) return false
  try {
    new Intl.DateTimeFormat('en', { timeZone: value })
    return true
  } catch {
    return false
  }
}

function sameTimestamp(left, right) {
  return isWireTimestamp(left) && isWireTimestamp(right) &&
    left.replace('.000Z', 'Z') === right.replace('.000Z', 'Z')
}

function nullableDisplayText(value) {
  return value == null ? null : normalizeWireDisplayText(value) || null
}

function foldVerifiedName(name) {
  let folded = ''
  for (const character of name) {
    const fullFold = VERIFIED_NAME_FOLDS.get(character)
    if (fullFold !== undefined) folded += fullFold
    else if (character.codePointAt(0) <= 0xff) folded += character.toLowerCase()
    else return null
  }
  return folded.normalize('NFC')
}

function validateCatalogCommon(record, field, submittedName) {
  check(nonblank(record.name) && record.name === normalizeWireDisplayText(record.name), `${field}.name`)
  if (submittedName !== undefined) {
    check(record.name === normalizeWireDisplayText(submittedName), `${field}.name`)
  }
  const folded = foldVerifiedName(record.name)
  check(folded !== null && record.normalized_name === folded, `${field}.normalized_name`)
  check(typeof record.is_active === 'boolean', `${field}.is_active`)
  check(isWireTimestamp(record.created_at), `${field}.created_at`)
  check(isWireTimestamp(record.updated_at), `${field}.updated_at`)
}

function validateCategory(record, field, submittedName) {
  fields(record, CATEGORY_FIELDS, field)
  validateCatalogCommon(record, field, submittedName)
  check(isWireUuid(record.category_id), `${field}.category_id`)
  check(record.description === null || nonblank(record.description), `${field}.description`)
}

function stockStatus(quantity, minimum) {
  if (quantity === 0) return 'out_of_stock'
  return quantity <= minimum ? 'low_stock' : 'sufficient'
}

function validateItem(record, field, submittedName) {
  fields(record, ITEM_FIELDS, field)
  validateCatalogCommon(record, field, submittedName)
  check(isWireUuid(record.item_id), `${field}.item_id`)
  check(isWireUuid(record.category_id), `${field}.category_id`)
  check(typeof record.unit_of_measurement === 'string' &&
    Object.hasOwn(WIRE_UNIT_SCALES, record.unit_of_measurement), `${field}.unit_of_measurement`)
  check(nonnegative(record.minimum_stock_level), `${field}.minimum_stock_level`)
  check(nonnegative(record.available_quantity), `${field}.available_quantity`)
  check(record.is_active || record.available_quantity === 0, `${field}.available_quantity`)
  check(record.stock_status === stockStatus(record.available_quantity, record.minimum_stock_level),
    `${field}.stock_status`)
}

function validateBatch(record, field) {
  fields(record, BATCH_FIELDS, field)
  check(isWireUuid(record.batch_id), `${field}.batch_id`)
  check(isWireUuid(record.item_id), `${field}.item_id`)
  check(positive(record.received_quantity), `${field}.received_quantity`)
  check(record.purchase_date === null || isWireDate(record.purchase_date), `${field}.purchase_date`)
  check(record.purchase_cost === null || nonnegative(record.purchase_cost), `${field}.purchase_cost`)
  check(record.expiration_date === null || isWireDate(record.expiration_date), `${field}.expiration_date`)
  check(isWireTimestamp(record.created_at), `${field}.created_at`)
  check(nonnegative(record.remaining_quantity), `${field}.remaining_quantity`)
}

function validateMovement(record, field, withAllocations) {
  fields(record, withAllocations ? MOVEMENT_RESULT_FIELDS : MOVEMENT_FIELDS, field)
  check(isWireUuid(record.movement_id), `${field}.movement_id`)
  check(isWireUuid(record.item_id), `${field}.item_id`)
  check(MOVEMENT_TYPES.includes(record.movement_type), `${field}.movement_type`)
  const incoming = POSITIVE_MOVEMENT_TYPES.includes(record.movement_type)
  check(Number.isSafeInteger(record.quantity_change) &&
    (incoming ? record.quantity_change > 0 : record.quantity_change < 0), `${field}.quantity_change`)
  const reasonRequired = REASON_REQUIRED_MOVEMENT_TYPES.includes(record.movement_type)
  check(nonblank(record.reason) || (record.reason === null && !reasonRequired), `${field}.reason`)
  check(record.recorded_by === null, `${field}.recorded_by`)
  check(isWireTimestamp(record.created_at), `${field}.created_at`)
}

function validateAllocation(record, field, withMovementId) {
  fields(record, withMovementId ? SNAPSHOT_ALLOCATION_FIELDS : ALLOCATION_FIELDS, field)
  check(isWireUuid(record.allocation_id), `${field}.allocation_id`)
  check(isWireUuid(record.batch_id), `${field}.batch_id`)
  if (withMovementId) check(isWireUuid(record.movement_id), `${field}.movement_id`)
  check(Number.isSafeInteger(record.quantity_change) && record.quantity_change !== 0, `${field}.quantity_change`)
}

function indexRecords(records, idField, validate, field) {
  check(Array.isArray(records), field)
  const byId = new Map()
  for (const record of records) {
    validate(record, field)
    const id = record[idField].toLowerCase()
    check(!byId.has(id), `${field}.${idField}`)
    byId.set(id, record)
  }
  return byId
}

function matchMovementResult(result, command) {
  const field = 'acknowledgment.result'
  validateMovement(result, field, true)
  const payload = command.payload
  check(sameWireUuid(result.movement_id, command.entity_id), `${field}.movement_id`)
  check(sameWireUuid(result.item_id, payload.item_id), `${field}.item_id`)
  check(result.movement_type === payload.movement_type, `${field}.movement_type`)
  check(result.quantity_change === payload.quantity_change, `${field}.quantity_change`)
  check(sameTimestamp(result.created_at, command.created_at), `${field}.created_at`)
  check(result.reason === nullableDisplayText(payload.reason), `${field}.reason`)
  const allocations = indexRecords(result.allocations, 'allocation_id', validateAllocation, `${field}.allocations`)
  check(allocations.size === payload.allocations.length, `${field}.allocations`)
  for (const expected of payload.allocations) {
    const actual = allocations.get(expected.allocation_id.toLowerCase())
    check(actual && sameWireUuid(actual.batch_id, expected.batch_id) &&
      actual.quantity_change === expected.quantity_change, `${field}.allocations`)
  }
}

function matchCatalogResult(result, command, category) {
  const field = 'acknowledgment.result'
  const { operation_type: type, payload } = command
  const idKey = category ? 'category_id' : 'item_id'
  const submittedName = Object.hasOwn(payload, 'name') ? payload.name : undefined
  if (category) validateCategory(result, field, submittedName)
  else validateItem(result, field, submittedName)
  check(sameWireUuid(result[idKey], command.entity_id), `${field}.${idKey}`)
  check(result.is_active === !type.startsWith('archive_'), `${field}.is_active`)
  if (type.startsWith('create_')) {
    check(sameTimestamp(result.created_at, command.created_at), `${field}.created_at`)
    if (!category) check(result.available_quantity === 0, `${field}.available_quantity`)
  }
  // A second archive command can retain the earlier archive timestamp.
  if (!type.startsWith('archive_')) {
    check(sameTimestamp(result.updated_at, command.created_at), `${field}.updated_at`)
  }
  if (category && (type === 'create_category' || Object.hasOwn(payload, 'description'))) {
    check(result.description === nullableDisplayText(payload.description), `${field}.description`)
  }
  if (!category) {
    if (Object.hasOwn(payload, 'category_id')) {
      check(sameWireUuid(result.category_id, payload.category_id), `${field}.category_id`)
    }
    for (const key of ['unit_of_measurement', 'minimum_stock_level']) {
      if (Object.hasOwn(payload, key)) check(result[key] === payload[key], `${field}.${key}`)
    }
  }
}

export function validateHealth(data) {
  fields(data, ['status'], 'health')
  check(data.status === 'ok', 'health.status')
  return data
}

// The client supplies the already validated, detached command it actually sent.
export function validateAcknowledgment(data, command) {
  fields(data, ACKNOWLEDGMENT_FIELDS, 'acknowledgment')
  check(sameWireUuid(data.operation_id, command.operation_id), 'acknowledgment.operation_id')
  check(data.outcome === 'accepted' || data.outcome === 'already_processed', 'acknowledgment.outcome')
  check(isWireTimestamp(data.processed_at), 'acknowledgment.processed_at')
  switch (command.operation_type) {
    case 'record_stock_movement':
      matchMovementResult(data.result, command)
      break
    case 'create_category':
    case 'update_category':
    case 'archive_category':
      matchCatalogResult(data.result, command, true)
      break
    case 'create_item':
    case 'update_item':
    case 'archive_item':
      matchCatalogResult(data.result, command, false)
      break
    default:
      throw new ApiProtocolError('acknowledgment.result')
  }
  return data
}

function validateReceiptChecks(receipts, requested, sync) {
  const field = 'snapshot.receipt_checks'
  check(Array.isArray(receipts) && receipts.length === requested.length, field)
  const checkedOperations = new Map()
  for (let index = 0; index < receipts.length; index++) {
    const receipt = receipts[index]
    fields(receipt, ['operation_id', 'status', 'processed_at'], field)
    check(sameWireUuid(receipt.operation_id, requested[index]), `${field}.operation_id`)
    check(receipt.status === 'accepted' || receipt.status === 'missing', `${field}.status`)
    const accepted = receipt.status === 'accepted'
    check(accepted ? isWireTimestamp(receipt.processed_at) : receipt.processed_at === null,
      `${field}.processed_at`)
    if (accepted) check(sync.last_committed_operation_id !== null, `${field}.status`)
    if (sameWireUuid(receipt.operation_id, sync.last_committed_operation_id)) {
      check(accepted, `${field}.status`)
      check(sameTimestamp(receipt.processed_at, sync.last_committed_at), `${field}.processed_at`)
    }
    const operationId = receipt.operation_id.toLowerCase()
    const previous = checkedOperations.get(operationId)
    if (previous) {
      check(previous.status === receipt.status, `${field}.status`)
      if (accepted) {
        check(sameTimestamp(previous.processed_at, receipt.processed_at), `${field}.processed_at`)
      }
    }
    checkedOperations.set(operationId, receipt)
  }
}

function validateSnapshotMetadata(data, requestedReceiptIds) {
  check(data.schema_version === 1, 'snapshot.schema_version')
  check(isWireUuid(data.server_generation_id), 'snapshot.server_generation_id')
  check(isWireTimestamp(data.snapshot_at), 'snapshot.snapshot_at')

  const { settings, sync, backup } = data
  fields(settings, ['settings_version', 'business_timezone', 'expiration_warning_days'], 'snapshot.settings')
  check(positive(settings.settings_version), 'snapshot.settings.settings_version')
  check(timezone(settings.business_timezone), 'snapshot.settings.business_timezone')
  check(settings.expiration_warning_days === null || nonnegative(settings.expiration_warning_days),
    'snapshot.settings.expiration_warning_days')
  fields(sync, ['last_committed_operation_id', 'last_committed_at'], 'snapshot.sync')
  check(sync.last_committed_operation_id === null
    ? sync.last_committed_at === null
    : isWireUuid(sync.last_committed_operation_id) && isWireTimestamp(sync.last_committed_at), 'snapshot.sync')
  fields(backup, ['last_successful_backup_at'], 'snapshot.backup')
  check(backup.last_successful_backup_at === null || isWireTimestamp(backup.last_successful_backup_at),
    'snapshot.backup.last_successful_backup_at')
  validateReceiptChecks(data.receipt_checks, requestedReceiptIds, sync)
}

function addQuantity(totals, id, value) {
  // Compare final totals without using the response array order as a replay order.
  totals.set(id, (totals.get(id) ?? 0n) + BigInt(value))
}

function validateSnapshotInventory(data) {
  const categories = indexRecords(data.categories, 'category_id', validateCategory, 'snapshot.categories')
  const items = indexRecords(data.inventory_items, 'item_id', validateItem, 'snapshot.inventory_items')
  const batches = indexRecords(data.stock_batches, 'batch_id', validateBatch, 'snapshot.stock_batches')
  const movements = indexRecords(data.stock_movements, 'movement_id', validateMovement, 'snapshot.stock_movements')
  const allocations = indexRecords(data.batch_allocations, 'allocation_id',
    (record, field) => validateAllocation(record, field, true), 'snapshot.batch_allocations')

  for (const item of items.values()) {
    const category = categories.get(item.category_id.toLowerCase())
    check(category && (!item.is_active || category.is_active), 'snapshot.inventory_items.category_id')
  }
  const itemTotals = new Map()
  for (const movement of movements.values()) {
    const itemId = movement.item_id.toLowerCase()
    check(items.has(itemId), 'snapshot.stock_movements.item_id')
    addQuantity(itemTotals, itemId, movement.quantity_change)
  }
  const movementTotals = new Map()
  const batchTotals = new Map()
  const introducedBatches = new Set()
  const adjustmentCandidates = new Set()
  const seenPairs = new Set()
  for (const allocation of allocations.values()) {
    const movementId = allocation.movement_id.toLowerCase()
    const batchId = allocation.batch_id.toLowerCase()
    const movement = movements.get(movementId)
    const batch = batches.get(batchId)
    check(movement && batch && sameWireUuid(movement.item_id, batch.item_id), 'snapshot.batch_allocations')
    const pair = `${movementId}/${batchId}`
    check(!seenPairs.has(pair), 'snapshot.batch_allocations')
    seenPairs.add(pair)
    check(Math.sign(allocation.quantity_change) === Math.sign(movement.quantity_change),
      'snapshot.batch_allocations.quantity_change')
    // Opening and receipt movements create every batch they allocate to under the audited contract.
    if (movement.movement_type === 'initial_stock' || movement.movement_type === 'stock_in') {
      check(!introducedBatches.has(batchId) && allocation.quantity_change === batch.received_quantity,
        'snapshot.stock_batches.received_quantity')
      check(sameTimestamp(movement.created_at, batch.created_at), 'snapshot.stock_batches.created_at')
      introducedBatches.add(batchId)
    } else if (movement.movement_type === 'positive_adjustment' &&
        allocation.quantity_change === batch.received_quantity &&
        sameTimestamp(movement.created_at, batch.created_at)) {
      // An adjustment can create a batch or add to an existing one. A match is only a candidate.
      adjustmentCandidates.add(batchId)
    }
    addQuantity(movementTotals, movementId, allocation.quantity_change)
    addQuantity(batchTotals, batchId, allocation.quantity_change)
  }
  for (const [id, movement] of movements) {
    check(movementTotals.get(id) === BigInt(movement.quantity_change), 'snapshot.stock_movements.quantity_change')
  }
  for (const [id, batch] of batches) {
    check(items.has(batch.item_id.toLowerCase()), 'snapshot.stock_batches.item_id')
    check(batchTotals.get(id) === BigInt(batch.remaining_quantity), 'snapshot.stock_batches.remaining_quantity')
    check(introducedBatches.has(id) || adjustmentCandidates.has(id), 'snapshot.stock_batches.received_quantity')
  }
  for (const [id, item] of items) {
    check((itemTotals.get(id) ?? 0n) === BigInt(item.available_quantity), 'snapshot.inventory_items.available_quantity')
  }
  return categories.size > 0
}

export function validateSnapshot(data, requestedReceiptIds = []) {
  fields(data, SNAPSHOT_FIELDS, 'snapshot')
  validateSnapshotMetadata(data, requestedReceiptIds)
  const nonempty = validateSnapshotInventory(data)
  return {
    snapshot: data,
    installable: false,
    installationBlocker: nonempty ? 'missing_authoritative_replay_order' : 'isolated_inspection_only',
  }
}
