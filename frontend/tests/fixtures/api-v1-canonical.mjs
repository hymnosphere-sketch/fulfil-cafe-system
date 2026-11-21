import { normalizeWireDisplayText, validateWireCommand } from '../../src/api/commands.js'

// This comparison mirrors json.dumps(sort_keys=True, ensure_ascii=False) at
// the pinned commit. It is used only for the shared fixtures.
export function compareCodePoints(left, right) {
  const leftPoints = [...left]
  const rightPoints = [...right]
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index++) {
    const difference = leftPoints[index].codePointAt(0) - rightPoints[index].codePointAt(0)
    if (difference !== 0) return difference
  }
  return leftPoints.length - rightPoints.length
}

export function serializeFixture(value, compareKeys = compareCodePoints) {
  if (Array.isArray(value)) {
    return '[' + value.map((entry) => serializeFixture(entry, compareKeys)).join(',') + ']'
  }
  if (value !== null && typeof value === 'object') {
    const members = Object.keys(value).sort(compareKeys).map((key) =>
      JSON.stringify(key) + ':' + serializeFixture(value[key], compareKeys))
    return '{' + members.join(',') + '}'
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || Number.isSafeInteger(value)) {
    return JSON.stringify(value)
  }
  throw new TypeError('The fixture serializer expects JSON with safe integers.')
}

function textOrNull(value) {
  return value == null ? null : normalizeWireDisplayText(value) || null
}

function compareIds(field) {
  return (left, right) => compareCodePoints(left[field], right[field])
}

function canonicalMovement(payload) {
  return {
    ...payload,
    reason: textOrNull(payload.reason),
    recorded_by: null,
    allocations: payload.allocations.map((allocation) => ({
      ...allocation,
      allocation_id: allocation.allocation_id.toLowerCase(),
      batch_id: allocation.batch_id.toLowerCase(),
    })).sort(compareIds('allocation_id')),
    new_batches: (payload.new_batches ?? []).map((batch) => ({
      batch_id: batch.batch_id.toLowerCase(),
      received_quantity: batch.received_quantity,
      purchase_date: batch.purchase_date ?? null,
      purchase_cost: batch.purchase_cost ?? null,
      expiration_date: batch.expiration_date ?? null,
    })).sort(compareIds('batch_id')),
  }
}

export function canonicalFixtureCommand(source) {
  const command = validateWireCommand(source)
  const { operation_type: operation, payload } = command
  for (const field of ['category_id', 'item_id', 'movement_id']) {
    if (Object.hasOwn(payload, field)) payload[field] = payload[field].toLowerCase()
  }
  if (Object.hasOwn(payload, 'name')) payload.name = normalizeWireDisplayText(payload.name)
  if (operation === 'create_category' || Object.hasOwn(payload, 'description')) {
    payload.description = textOrNull(payload.description)
  }
  return {
    command_schema_version: 1,
    operation_type: operation,
    entity_id: command.entity_id.toLowerCase(),
    created_at: new Date(command.created_at).toISOString(),
    payload: operation === 'record_stock_movement' ? canonicalMovement(payload) : payload,
  }
}
