import { demoBusinessDate, demoInventory } from '../data/demo-inventory.js'
import { parseDemoMinimumStockLevel } from '../utils/demo-catalog.js'
import {
  civilDay,
  classifyBatchExpiration,
  getMovementSign,
  movementTimestamp,
  summarizeInventory,
} from './inventory-summary.js'

export const DEMO_UNIT_SCALE = 0
export const demoUnits = Object.freeze([
  ...new Set(demoInventory.inventory_items.map(({ unit_of_measurement }) => unit_of_measurement)),
].sort())

const typesRequiringReason = new Set(['wastage', 'positive_adjustment', 'negative_adjustment'])
const supportedTypes = new Set(['stock_in', 'stock_out', ...typesRequiringReason])
const draftFields = new Set([
  'itemId', 'type', 'quantity', 'unit', 'scale', 'allocations', 'purchaseDate', 'expirationDate', 'reason',
])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function stockMovementRequiresReason(type) {
  return typesRequiringReason.has(type)
}

export class DemoStockError extends Error {
  constructor(code, message, field, batchId) {
    super(message)
    this.name = 'DemoStockError'
    this.code = code
    if (field !== undefined) this.field = field
    if (batchId !== undefined) this.batchId = batchId
  }
}

function positiveMagnitude(value, field, batchId) {
  const quantity = parseDemoMinimumStockLevel(value)
  if (quantity === null || quantity === 0) {
    throw new DemoStockError('INVALID_QUANTITY', 'Enter a positive whole number the app can store exactly.', field, batchId)
  }
  return quantity
}

function safeQuantitySum(left, right, field, batchId) {
  const total = left + right
  if (!Number.isSafeInteger(total)) {
    throw new DemoStockError('INVALID_QUANTITY', 'The resulting quantity is too large to store exactly.', field, batchId)
  }
  return total
}

function optionalDate(value, field, label) {
  if (value == null || value === '') return null
  try {
    civilDay(value)
  } catch {
    throw new DemoStockError('INVALID_DATE', 'Enter a valid ' + label + '.', field)
  }
  return value
}

export function validateDemoStockDates(purchase, expiration, type) {
  const purchaseDate = optionalDate(purchase, 'purchaseDate', 'purchase date')
  const expirationDate = optionalDate(expiration, 'expirationDate', 'expiration date')
  if (type !== 'stock_in' && (purchaseDate || expirationDate)) {
    throw new DemoStockError('INVALID_DATE', 'Purchase and expiration dates belong to new deliveries.', purchaseDate ? 'purchaseDate' : 'expirationDate')
  }
  if (purchaseDate && expirationDate && expirationDate < purchaseDate) {
    throw new DemoStockError('INVALID_DATE', 'The expiration date cannot precede the purchase date in this demo.', 'expirationDate')
  }
  return { purchaseDate, expirationDate }
}

// These batch rules are temporary demonstration policies. Observe the actual
// date even on a depleted batch, whose UI status can hide that it is expired.
export function getDemoBatchEligibility(batch, type, businessDate = demoBusinessDate) {
  if (!supportedTypes.has(type) || type === 'stock_in') {
    return { eligible: false, reason: 'This workflow does not use existing batches.' }
  }
  const expired = batch.expirationDate != null && civilDay(batch.expirationDate) < civilDay(businessDate)
  if (expired && (type === 'stock_out' || type === 'positive_adjustment')) {
    return { eligible: false, reason: 'This demo workflow excludes expired batches.', restriction: 'expired' }
  }
  if (getMovementSign(type) < 0 && batch.remainingQuantity === 0) {
    return { eligible: false, reason: 'This batch has no remaining stock.' }
  }
  return { eligible: true, reason: null }
}

// Uses the same per-batch policy as movement validation. Null totals mean the
// displayed snapshot cannot supply a reliable quantity.
export function getDemoStockAvailability(batches, type, businessDate = demoBusinessDate) {
  const unavailable = { eligibleQuantity: null, expiredExcludedQuantity: null }
  if (!Array.isArray(batches)) return unavailable
  let eligibleQuantity = 0
  let expiredExcludedQuantity = 0
  for (const batch of batches) {
    const quantity = batch?.remainingQuantity
    if (!Number.isSafeInteger(quantity) || quantity < 0 || batch.expirationDate === undefined) return unavailable
    let policy
    try {
      policy = getDemoBatchEligibility(batch, type, businessDate)
    } catch {
      return unavailable
    }
    if (policy.eligible) eligibleQuantity += quantity
    if (policy.restriction === 'expired') expiredExcludedQuantity += quantity
    if (!Number.isSafeInteger(eligibleQuantity) || !Number.isSafeInteger(expiredExcludedQuantity)) return unavailable
  }
  return { eligibleQuantity, expiredExcludedQuantity }
}

function validateAllocations(snapshot, summary, item, draft, sign, quantity, businessDate) {
  if (!Array.isArray(draft.allocations) || draft.allocations.length === 0) {
    throw new DemoStockError('INVALID_BATCH_ALLOCATION', 'Assign a quantity to at least one existing batch.', 'allocations')
  }
  const batches = new Map(snapshot.stock_batches.map((batch) => [batch.batch_id, batch]))
  const selected = new Set()
  const assignments = []
  let total = 0
  for (const allocation of draft.allocations) {
    const batchId = allocation?.batchId
    const batch = batches.get(batchId)
    if (!batch || batch.item_id !== item.item_id || selected.has(batchId) || Array.isArray(allocation) ||
      Object.keys(allocation).some((field) => field !== 'batchId' && field !== 'quantity')) {
      throw new DemoStockError('INVALID_BATCH_ALLOCATION', 'Select each batch once from the chosen item.', 'allocations', batchId)
    }
    selected.add(batchId)
    const remainingQuantity = summary.batchBalances.get(batchId)
    const expirationDate = batch.expiration_date ?? null
    const expirationStatus = summary.batchExpirationStatuses.get(batchId)
    const eligibility = getDemoBatchEligibility({ expirationDate, remainingQuantity }, draft.type, businessDate)
    if (!eligibility.eligible) {
      throw new DemoStockError('INVALID_BATCH_ALLOCATION', eligibility.reason, 'allocations', batchId)
    }
    const assigned = positiveMagnitude(allocation.quantity, 'allocations', batchId)
    const quantityChange = sign * assigned
    const resultingQuantity = safeQuantitySum(remainingQuantity, quantityChange, 'allocations', batchId)
    if (resultingQuantity < 0) {
      throw new DemoStockError('INSUFFICIENT_STOCK', 'The selected batch does not have enough stock.', 'allocations', batchId)
    }
    total = safeQuantitySum(total, assigned, 'allocations')
    assignments.push({ batchId, quantityChange, remainingQuantity, resultingQuantity, expirationDate, expirationStatus, isNew: false })
  }
  if (total !== quantity) {
    throw new DemoStockError('INVALID_BATCH_ALLOCATION', 'Assigned quantities must add up to the requested quantity.', 'allocations')
  }
  return assignments
}

// Takes the current demo snapshot and a form draft with positive magnitudes.
// Returns the normalized confirmation plan without changing records or allocating IDs.
export function validateDemoStockMovement(snapshot, draft, businessDate = demoBusinessDate) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft) ||
    Object.keys(draft).some((field) => !draftFields.has(field))) {
    throw new DemoStockError('VALIDATION_ERROR', 'The stock movement contains unsupported fields.')
  }
  const { itemId, type, unit, scale } = draft
  const item = snapshot.inventory_items.find(({ item_id }) => item_id === itemId)
  if (!item) throw new DemoStockError('ITEM_NOT_FOUND', 'Choose an existing inventory item.', 'itemId')
  if (!item.is_active) throw new DemoStockError('ITEM_ARCHIVED', 'Archived items cannot receive stock movements.', 'itemId')
  if (!supportedTypes.has(type)) {
    throw new DemoStockError('INVALID_MOVEMENT_TYPE', 'Choose a supported demo stock movement.', 'type')
  }
  if (unit !== item.unit_of_measurement || !demoUnits.includes(unit)) {
    throw new DemoStockError('INVALID_UNIT', 'Use the unit assigned to the selected item.', 'unit')
  }
  if (scale !== DEMO_UNIT_SCALE) {
    throw new DemoStockError('INVALID_UNIT', 'Demo stock movements use whole quantities.', 'scale')
  }
  const quantity = positiveMagnitude(draft.quantity, 'quantity')
  if (draft.reason != null && typeof draft.reason !== 'string') {
    throw new DemoStockError('VALIDATION_ERROR', 'Enter the reason as text.', 'reason')
  }
  const reason = draft.reason?.trim() || null
  if (stockMovementRequiresReason(type) && !reason) {
    throw new DemoStockError('REASON_REQUIRED', 'Enter a reason for this stock movement.', 'reason')
  }
  const { purchaseDate, expirationDate } = validateDemoStockDates(draft.purchaseDate, draft.expirationDate, type)

  const summary = summarizeInventory(snapshot, businessDate)
  const currentQuantity = summary.itemBalances.get(itemId)
  const sign = getMovementSign(type)
  const quantityChange = sign * quantity
  const resultingQuantity = safeQuantitySum(currentQuantity, quantityChange, 'quantity')
  if (resultingQuantity < 0) {
    throw new DemoStockError('INSUFFICIENT_STOCK', 'The selected item does not have enough stock.', 'quantity')
  }
  if (type === 'stock_in' && draft.allocations != null &&
    (!Array.isArray(draft.allocations) || draft.allocations.length > 0)) {
    throw new DemoStockError('INVALID_BATCH_ALLOCATION', 'A delivery creates its own batch and allocation.', 'allocations')
  }
  const assignments = type === 'stock_in'
    ? [{
        batchId: null,
        quantityChange,
        remainingQuantity: 0,
        resultingQuantity: quantity,
        expirationDate,
        expirationStatus: classifyBatchExpiration(
          { expiration_date: expirationDate }, quantity, civilDay(businessDate), snapshot.settings?.expiration_warning_days ?? null,
        ),
        isNew: true,
      }]
    : validateAllocations(snapshot, summary, item, draft, sign, quantity, businessDate)
  const category = snapshot.categories.find(({ category_id }) => category_id === item.category_id)
  return {
    item: { itemId, name: item.name, categoryName: category.name, unit },
    type,
    currentQuantity,
    quantityChange,
    resultingQuantity,
    reason,
    purchaseDate,
    expirationDate,
    assignments,
  }
}

function assertUniqueIds(ids, records, field) {
  const occupied = new Set(records.map((record) => record[field]?.toLowerCase()))
  for (const id of ids) {
    if (typeof id !== 'string' || !UUID.test(id) || occupied.has(id.toLowerCase())) {
      throw new DemoStockError('ID_UNAVAILABLE', 'A unique stock record identifier could not be created. Review the movement again.')
    }
    occupied.add(id.toLowerCase())
  }
}

// Revalidate immediately against the supplied current snapshot. Clone and append
// the whole transaction, then verify replay before returning the candidate.
export function buildDemoStockCandidate(snapshot, draft, {
  movementId,
  batchId,
  allocationIds,
  timestamp,
  businessDate = demoBusinessDate,
}) {
  const plan = validateDemoStockMovement(snapshot, draft, businessDate)
  const isReceipt = plan.type === 'stock_in'
  if (!Array.isArray(allocationIds) || allocationIds.length !== plan.assignments.length || (!isReceipt && batchId != null)) {
    throw new DemoStockError('ID_UNAVAILABLE', 'Stock record identifiers do not match the confirmed allocations.')
  }
  assertUniqueIds([movementId], snapshot.stock_movements, 'movement_id')
  if (isReceipt) assertUniqueIds([batchId], snapshot.stock_batches, 'batch_id')
  assertUniqueIds(allocationIds, snapshot.batch_allocations, 'allocation_id')
  try {
    movementTimestamp(timestamp)
  } catch {
    throw new DemoStockError('INVALID_TIMESTAMP', 'The device could not provide a valid stock recording timestamp.')
  }

  const movement = {
    movement_id: movementId.toLowerCase(),
    item_id: plan.item.itemId,
    movement_type: plan.type,
    quantity_change: plan.quantityChange,
    reason: plan.reason,
    recorded_by: null,
    created_at: timestamp,
  }
  const batch = isReceipt ? {
    batch_id: batchId.toLowerCase(),
    item_id: plan.item.itemId,
    received_quantity: plan.quantityChange,
    purchase_date: plan.purchaseDate,
    purchase_cost: null,
    expiration_date: plan.expirationDate,
    created_at: timestamp,
  } : null
  const allocations = plan.assignments.map(({ batchId: existingBatchId, quantityChange }, index) => ({
    allocation_id: allocationIds[index].toLowerCase(),
    movement_id: movement.movement_id,
    batch_id: batch?.batch_id ?? existingBatchId,
    quantity_change: quantityChange,
  }))

  const candidate = structuredClone(snapshot)
  candidate.demoSessionMovementStart ??= candidate.stock_movements.length
  candidate.stock_movements.push(movement)
  if (batch) candidate.stock_batches.push(batch)
  for (const allocation of allocations) candidate.batch_allocations.push(allocation)
  const summary = summarizeInventory(candidate, businessDate)
  if (summary.itemBalances.get(movement.item_id) !== plan.resultingQuantity ||
    plan.assignments.some((assignment, index) =>
      summary.batchBalances.get(allocations[index].batch_id) !== assignment.resultingQuantity)) {
    throw new DemoStockError('INVALID_BATCH_ALLOCATION', 'The stock replay did not match the reviewed balance.', 'allocations')
  }
  return {
    candidate,
    result: {
      movement, batch, allocations, currentQuantity: plan.currentQuantity, resultingQuantity: plan.resultingQuantity, alreadyRecorded: false,
    },
  }
}
