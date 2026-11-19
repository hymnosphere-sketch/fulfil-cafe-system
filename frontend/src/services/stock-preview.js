import { parseDemoMinimumStockLevel } from '../utils/demo-catalog.js'
import { getMovementSign } from './inventory-summary.js'
import { getDemoBatchEligibility, getDemoStockAvailability, stockMovementRequiresReason, validateDemoStockDates } from './stock-movements.js'

function assessAssignments(allocations, batches, type, businessDate) {
  const byId = new Map((batches ?? []).map((batch) => [batch.batchId, batch]))
  let total = 0
  let issue = null
  for (const [batchId, value] of allocations) {
    const quantity = parseDemoMinimumStockLevel(value)
    if (quantity === null || quantity === 0 || !Number.isSafeInteger(total + quantity)) {
      return { total: null, issue: { state: 'invalid-input', message: 'Enter an exact, positive whole quantity for each assigned batch.' } }
    }
    total += quantity
    const batch = byId.get(batchId)
    if (issue) continue
    if (!batch || !Number.isSafeInteger(batch.remainingQuantity) || batch.remainingQuantity < 0 || batch.expirationDate === undefined) {
      issue = { state: 'unavailable', message: 'The assigned batch balance or expiration status is unavailable.' }
      continue
    }
    let policy
    try {
      policy = getDemoBatchEligibility(batch, type, businessDate)
    } catch {
      issue = { state: 'unavailable', message: 'The assigned batch expiration status is unavailable.' }
      continue
    }
    const sign = getMovementSign(type)
    if (policy.restriction === 'expired') {
      issue = { state: 'invalid-input', message: policy.reason }
    } else if (sign < 0 && quantity > batch.remainingQuantity) {
      issue = {
        state: 'insufficient-batch', message: 'An assigned batch does not have enough stock.',
        available: batch.remainingQuantity, requested: quantity,
      }
    } else if (!policy.eligible || !Number.isSafeInteger(batch.remainingQuantity + sign * quantity)) {
      issue = { state: 'invalid-input', message: policy.reason ?? 'The resulting batch quantity is too large to store exactly.' }
    }
  }
  return { total, issue }
}

// A display-only calculation over the selected item. Confirmation still runs the ledger validator.
export function calculateStockPreview(draft, item, type, businessDate, { hasInvalidDateInput = false } = {}) {
  const requested = parseDemoMinimumStockLevel(draft.quantity)
  const sign = getMovementSign(type)
  const usesBatches = draft.workflow !== 'receive'
  const available = type === 'stock_out' ? getDemoStockAvailability(item?.batches, type, businessDate) : null
  const allocations = usesBatches && type ? assessAssignments(draft.allocations, item?.batches, type, businessDate) : null
  const assigned = allocations?.total ?? null
  const recorded = Number.isSafeInteger(item?.availableQuantity) && item.availableQuantity >= 0 ? item.availableQuantity : null
  const change = sign && requested > 0 ? sign * requested : null
  const result = change !== null && recorded !== null ? recorded + change : null
  const remaining = requested > 0 && assigned !== null ? requested - assigned : null
  const progress = remaining !== null && remaining >= 0 ? { assigned, requested } : null
  const totals = { recorded, change, assigned, remaining, progress, available }
  const expected = Number.isSafeInteger(result) && result >= 0 ? result : null

  if (!item) return { ...totals, expected: null, state: 'incomplete', message: 'Choose an item to see its balance.' }
  if (hasInvalidDateInput) return { ...totals, expected: null, state: 'invalid-input', message: 'Finish entering the date or clear the field.' }
  if (draft.quantity !== '' && (requested === null || requested === 0)) {
    return { ...totals, expected: null, state: 'invalid-input', message: 'Enter a positive whole quantity the app can store exactly.' }
  }
  try {
    validateDemoStockDates(draft.purchaseDate, draft.expirationDate, type)
  } catch (error) {
    return { ...totals, expected: null, state: 'invalid-input', message: error.message }
  }
  if (recorded === null || (available && (available.eligibleQuantity === null ||
    available.eligibleQuantity + available.expiredExcludedQuantity !== recorded))) {
    return { ...totals, available: null, expected: null, state: 'unavailable', message: 'The current recorded or eligible balance is unavailable.' }
  }
  if (change === null) return { ...totals, expected: null, state: 'incomplete', message: 'Choose the movement direction, if required, and enter a quantity.' }
  if (result < 0) {
    return { ...totals, expected: null, state: 'insufficient-item', message: 'The selected item does not have enough stock.', availableForDeduction: recorded, requested }
  }
  if (available && requested > available.eligibleQuantity) {
    return { ...totals, expected: null, state: 'insufficient-eligible', message: 'There is not enough stock eligible for ordinary usage.', availableForDeduction: available.eligibleQuantity, requested }
  }
  if (expected === null) return { ...totals, expected, state: 'unavailable', message: 'The resulting quantity is too large to store exactly.' }
  if (allocations?.issue) {
    const { available: availableForDeduction, ...issue } = allocations.issue
    return { ...totals, expected: null, availableForDeduction, ...issue }
  }
  if (remaining < 0) return { ...totals, expected: null, state: 'excessive-allocation', message: 'Assigned quantities exceed the requested quantity.' }
  if (remaining > 0) return { ...totals, expected, state: 'incomplete-allocation', message: 'Assign the remaining quantity to eligible batches.' }
  if (stockMovementRequiresReason(type) && !draft.reason?.trim()) {
    return { ...totals, expected, state: 'incomplete', message: 'Enter a reason to complete this draft.' }
  }
  return { ...totals, expected, state: 'valid', message: 'Ready to review.' }
}
