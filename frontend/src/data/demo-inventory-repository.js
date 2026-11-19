import { buildDemoStockCandidate, demoUnits, DemoStockError } from '../services/stock-movements.js'
import { readDemoInventory } from './demo-data-provider.js'
import { buildDemoCatalogCandidate, buildDemoStockPreview, createBrowserId } from './demo-inventory-rules.js'
import { demoBusinessDate } from './demo-inventory.js'

export { demoUnits }

export function createDemoInventoryRepository({
  readInitialSnapshot = readDemoInventory,
  createId = createBrowserId,
  now = () => new Date().toISOString(),
} = {}) {
  let snapshot
  let initialization
  let revision = 0
  const stockAttemptIds = new Set()
  const stockPreviews = new Map()
  const recordedStockAttempts = new Map()

  function initialize() {
    if (!initialization) {
      initialization = Promise.resolve()
        .then(() => readInitialSnapshot())
        .then((initialSnapshot) => { snapshot = structuredClone(initialSnapshot) })
        .catch((error) => {
          initialization = undefined
          throw error
        })
    }
    return initialization
  }

  async function read() {
    await initialize()
    return structuredClone(snapshot)
  }

  async function mutate(operationType, args) {
    await initialize()
    // No await separates validating the latest state and publishing the candidate.
    const { candidate, record } = buildDemoCatalogCandidate(snapshot, operationType, { ...args, createId, now })
    const savedRecord = structuredClone(record)
    snapshot = candidate
    revision += 1
    return savedRecord
  }

  async function previewStockMovement(draft) {
    await initialize()
    const { preview, result } = buildDemoStockPreview(snapshot, draft, { createId, reservedAttemptIds: stockAttemptIds })
    // Keep canceled and stale attempts reserved so an old confirmation cannot refer to a different preview.
    stockAttemptIds.add(result.attemptId)
    stockPreviews.set(result.attemptId, { ...preview, revision })
    return result
  }

  async function recordStockMovement(attemptId) {
    await initialize()
    const recorded = recordedStockAttempts.get(attemptId)
    if (recorded) return { ...structuredClone(recorded), alreadyRecorded: true }

    const preview = stockPreviews.get(attemptId)
    if (!preview || preview.revision !== revision) {
      stockPreviews.delete(attemptId)
      throw new DemoStockError('STALE_PREVIEW', 'The stock review is out of date. Review the movement again before recording it.')
    }
    // Validation, clone, and publication run synchronously after initialization.
    const { candidate, result } = buildDemoStockCandidate(snapshot, preview.draft, {
      ...preview.identifiers,
      timestamp: now(),
      businessDate: demoBusinessDate,
    })
    const resultForCaller = structuredClone(result)
    snapshot = candidate
    revision += 1
    stockPreviews.delete(attemptId)
    recordedStockAttempts.set(attemptId, result)
    return resultForCaller
  }

  return {
    read,
    previewStockMovement,
    recordStockMovement,
    discardStockPreview(attemptId) {
      stockPreviews.delete(attemptId)
    },
    createItem(input, { allowDuplicate = false } = {}) {
      return mutate('create_item', { input, allowDuplicate })
    },
    updateItem(id, input, { allowDuplicate = false } = {}) {
      return mutate('update_item', { id, input, allowDuplicate })
    },
    archiveItem(id) {
      return mutate('archive_item', { id })
    },
    createCategory(input) {
      return mutate('create_category', { input })
    },
    updateCategory(id, input) {
      return mutate('update_category', { id, input })
    },
    archiveCategory(id) {
      return mutate('archive_category', { id })
    },
  }
}
