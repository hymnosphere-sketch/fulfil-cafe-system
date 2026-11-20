import { createPersistentInventoryRepository } from '../data/persistent-inventory-repository.js'
import { InventoryDatabaseError } from '../db/database.js'

const mutationMethods = [
  'createItem', 'updateItem', 'archiveItem',
  'createCategory', 'updateCategory', 'archiveCategory',
  'recordStockMovement',
]

// A failed individual write can be retried in the form. Lost connections or
// invalid storage stop the session and require recovery before further writes.
const closedStorage = new Set([
  'DB_BLOCKED', 'DB_CONNECTION_CLOSED', 'DB_VERSION_CHANGED', 'DB_VERSION_UNSUPPORTED',
  'DB_UNAVAILABLE', 'DB_INVALID_METADATA', 'DB_INTEGRITY', 'DB_UNMARKED_DATA',
])

export function createLocalInventorySession({ onUpdate, onCommit }) {
  let state = 'opening'
  let generation = 0
  let statusRequest = 0
  let refreshRequested = false
  let confirmationToRecheck
  const storage = createPersistentInventoryRepository({ onConnectionError: fail })

  function publish(detail, refreshViews = false) {
    state = detail.state
    onUpdate(detail, refreshViews)
  }

  function fail(error) {
    generation += 1
    refreshRequested = false
    publish({ state: 'error', error })
  }

  async function initialize({ reopen = false } = {}) {
    const current = ++generation
    publish({ state: 'opening' })
    try {
      if (reopen) await storage.close()
      await storage.read({ confirmationAttempt: confirmationToRecheck })
      const status = await storage.readStatus()
      if (current === generation) {
        confirmationToRecheck = undefined
        publish({ state: 'ready', ...status })
      }
    } catch (error) {
      if (current === generation) fail(error)
    }
  }

  async function refresh(refreshViews = false) {
    if (state !== 'ready') return
    refreshRequested ||= refreshViews
    const current = generation
    const request = ++statusRequest
    try {
      const status = await storage.readStatus()
      if (current !== generation || request !== statusRequest) return
      const refreshActiveView = refreshRequested
      refreshRequested = false
      publish({ state: 'ready', ...status }, refreshActiveView)
    } catch (error) {
      if (current === generation && request === statusRequest) fail(error)
    }
  }

  function access(method) {
    return async (...args) => {
      if (state !== 'ready') {
        throw new InventoryDatabaseError('DB_UNAVAILABLE', 'Local storage must be ready before accessing inventory.')
      }
      const current = generation
      try {
        return await storage[method](...args)
      } catch (error) {
        if (current === generation && (method === 'read' || closedStorage.has(error.code))) {
          if (method === 'recordStockMovement' && error.code === 'DB_INTEGRITY') confirmationToRecheck = args[0]
          fail(error)
        }
        throw error
      }
    }
  }

  function trackMutation(method) {
    const operation = access(method)
    return async (...args) => {
      const result = await operation(...args)
      if (!result.alreadyRecorded) {
        try { onCommit() } catch {
          // Cross-tab notification is optional and runs after the durable save.
        }
      }
      // Read back the committed count. A status-read failure cannot change the
      // outcome of the write we have already acknowledged.
      void refresh(!result.alreadyRecorded)
      return result
    }
  }

  const repository = {
    read: access('read'),
    previewStockMovement: access('previewStockMovement'),
    discardStockPreview: storage.discardStockPreview,
    ...Object.fromEntries(mutationMethods.map((method) => [method, trackMutation(method)])),
  }
  return { repository, initialize, refresh }
}
