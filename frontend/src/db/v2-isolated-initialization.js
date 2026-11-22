// FE-09C: explicitly invoked, disposable v2 snapshot initialization.
// This module is not imported by app startup and never touches the v1 demo DB.
import { validateV2Snapshot } from '../api/v2-snapshot.js'

export const FE09C_TEST_DATABASE = 'fulfil-cafe-fe09c-v2-isolated'
export const FE09C_TEST_CONSENT = 'ISOLATED_FE09C_TEST_ONLY'

const COLLECTIONS = Object.freeze({
  categories: 'category_id',
  inventory_items: 'item_id',
  stock_batches: 'batch_id',
  stock_movements: 'movement_id',
  batch_allocations: 'allocation_id',
})
const DATA_STORES = [...Object.keys(COLLECTIONS), 'application_settings', 'manifests']
const ALL_STORES = [...DATA_STORES, 'control']

export class IsolatedInitializationError extends Error {
  constructor(code) {
    super('Isolated FE-09C initialization could not be completed.')
    this.name = 'IsolatedInitializationError'
    this.code = code
  }
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'))
  })
}
function completed(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'))
    transaction.onerror = () => { /* onabort owns the final failure */ }
  })
}
function openDatabase(factory, databaseName) {
  return new Promise((resolve, reject) => {
    const req = factory.open(databaseName, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      for (const [name, id] of Object.entries(COLLECTIONS)) {
        const store = db.createObjectStore(name, { keyPath: ['slot', id] })
        store.createIndex('by_slot', 'slot')
      }
      const settings = db.createObjectStore('application_settings', { keyPath: ['slot', 'key'] })
      settings.createIndex('by_slot', 'slot')
      db.createObjectStore('manifests', { keyPath: 'slot' })
      db.createObjectStore('control', { keyPath: 'key' })
    }
    req.onsuccess = () => {
      const db = req.result
      db.onversionchange = () => db.close()
      if (ALL_STORES.some((name) => !db.objectStoreNames.contains(name))) {
        db.close()
        reject(new IsolatedInitializationError('SCHEMA_CONFLICT'))
      } else resolve(db)
    }
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed.'))
    req.onblocked = () => reject(new IsolatedInitializationError('DATABASE_BLOCKED'))
  })
}
async function activeSlot(db) {
  const tx = db.transaction(['control'], 'readonly')
  const done = completed(tx)
  const current = await requestResult(tx.objectStore('control').get('active'))
  await done
  return current?.slot ?? null
}
async function stage(db, slot, snapshot) {
  const tx = db.transaction(DATA_STORES, 'readwrite')
  const done = completed(tx)
  for (const [name, id] of Object.entries(COLLECTIONS)) {
    const store = tx.objectStore(name)
    snapshot[name].forEach((record, position) => {
      store.add({ ...record, slot, position, [id]: record[id] })
    })
  }
  const settings = tx.objectStore('application_settings')
  settings.add({ slot, key: 'server_generation_id', value: snapshot.server_generation_id })
  settings.add({ slot, key: 'settings', value: snapshot.settings })
  const { categories, inventory_items, stock_batches, stock_movements,
    batch_allocations, settings: _settings, server_generation_id: _generation,
    ...metadata } = snapshot
  tx.objectStore('manifests').add({ slot, metadata })
  await done
}
async function readSlot(db, slot) {
  const tx = db.transaction(DATA_STORES, 'readonly')
  const done = completed(tx)
  // Schedule every read before yielding, avoiding inactive IndexedDB transactions.
  const result = Object.fromEntries(Object.keys(COLLECTIONS).map((name) =>
    [name, requestResult(tx.objectStore(name).index('by_slot').getAll(slot))]))
  const settingsRead = requestResult(tx.objectStore('application_settings').index('by_slot').getAll(slot))
  const manifestRead = requestResult(tx.objectStore('manifests').get(slot))
  const rows = Object.fromEntries(await Promise.all(Object.entries(result).map(async ([name, promise]) =>
    [name, (await promise).sort((a, b) => a.position - b.position)
      .map(({ slot: _slot, position: _position, ...record }) => record)])))
  const settings = await settingsRead
  const manifest = await manifestRead
  await done
  if (!manifest || settings.length !== 2) throw new IsolatedInitializationError('STAGING_INCOMPLETE')
  const values = Object.fromEntries(settings.map(({ key, value }) => [key, value]))
  if (!Object.hasOwn(values, 'settings') ||
      !Object.hasOwn(values, 'server_generation_id')) {
    throw new IsolatedInitializationError('STAGING_INCOMPLETE')
  }
  return { ...manifest.metadata, ...rows,
    settings: values.settings, server_generation_id: values.server_generation_id }
}
function activate(db, previous, slot) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['control'], 'readwrite')
    const store = tx.objectStore('control')
    let conflict = false
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(new IsolatedInitializationError(
      conflict ? 'CONCURRENT_INITIALIZATION' : 'ACTIVATION_FAILED'))
    tx.onerror = () => {}
    const read = store.get('active')
    read.onsuccess = () => {
      if ((read.result?.slot ?? null) !== previous) {
        conflict = true
        tx.abort()
      } else if (slot === null) store.delete('active')
      else store.put({ key: 'active', slot })
    }
  })
}
function safeFactory(factory) {
  if (!factory || typeof factory.open !== 'function') {
    throw new IsolatedInitializationError('INDEXEDDB_UNAVAILABLE')
  }
  return factory
}
function validName(name) {
  return typeof name === 'string' &&
    /^fulfil-cafe-fe09c-v2-isolated(?:-[a-z0-9-]+)?$/.test(name)
}

/**
 * This is the only opt-in installation entry point. It can never write to the
 * application's existing 'fulfil-cafe-demo-inventory' database.
 * A unique staged slot is fully verified after reopening the DB, BEFORE
 * changing the active pointer. Aborted staging preserves the prior slot.
 */
export async function initializeIsolatedV2({
  client, consent, indexedDB: factory = globalThis.indexedDB,
  databaseName = FE09C_TEST_DATABASE,
  createSlot = () => globalThis.crypto.randomUUID(),
  signal,
} = {}) {
  if (consent !== FE09C_TEST_CONSENT || !validName(databaseName)) {
    throw new IsolatedInitializationError('EXPLICIT_TEST_CONSENT_REQUIRED')
  }
  if (!client || typeof client.snapshot !== 'function' || typeof createSlot !== 'function') {
    throw new IsolatedInitializationError('INVALID_TEST_CONFIGURATION')
  }
  safeFactory(factory)
  if (signal?.aborted) throw new IsolatedInitializationError('CANCELLED')
  const response = await client.snapshot({ receiptIds: [], signal })
  // Validate again at the storage boundary even when an injected client claims success.
  const checked = validateV2Snapshot(response.data, [])
  if (!checked.installable || response.installable !== true) {
    throw new IsolatedInitializationError('SNAPSHOT_NOT_AUTHORITATIVE')
  }
  if (response.generation?.toLowerCase() !== response.data.server_generation_id.toLowerCase() ||
      response.settingsVersion !== response.data.settings.settings_version) {
    throw new IsolatedInitializationError('SNAPSHOT_HEADER_MISMATCH')
  }
  if (signal?.aborted) throw new IsolatedInitializationError('CANCELLED')
  const slot = createSlot()
  if (typeof slot !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(slot)) {
    throw new IsolatedInitializationError('INVALID_SLOT')
  }

  let db = await openDatabase(factory, databaseName)
  let previous
  try {
    previous = await activeSlot(db)
    if (previous === slot) throw new IsolatedInitializationError('INVALID_SLOT')
    await stage(db, slot, checked.data)
  } finally {
    db.close()
  }

  // Reopen and independently recheck every persisted collection and metadata.
  db = await openDatabase(factory, databaseName)
  try {
    const restored = await readSlot(db, slot)
    if (!validateV2Snapshot(restored, []).installable) {
      throw new IsolatedInitializationError('STAGING_NOT_AUTHORITATIVE')
    }
    if (signal?.aborted) throw new IsolatedInitializationError('CANCELLED')
    // Only the atomic pointer flip makes this version visible to readers.
    await activate(db, previous, slot)
    if (await activeSlot(db) !== slot) {
      throw new IsolatedInitializationError('ACTIVATION_FAILED')
    }
    return Object.freeze({
      slot, databaseName, generation: restored.server_generation_id,
      settingsVersion: restored.settings.settings_version,
      categoryCount: restored.categories.length,
      itemCount: restored.inventory_items.length,
      movementCount: restored.stock_movements.length,
    })
  } finally {
    db.close()
  }
}

/** Read a previously installed isolated snapshot; never touch demo storage. */
export async function readIsolatedV2({
  indexedDB: factory = globalThis.indexedDB,
  databaseName = FE09C_TEST_DATABASE,
} = {}) {
  if (!validName(databaseName)) throw new IsolatedInitializationError('INVALID_TEST_CONFIGURATION')
  const db = await openDatabase(safeFactory(factory), databaseName)
  try {
    const slot = await activeSlot(db)
    if (!slot) return null
    const snapshot = await readSlot(db, slot)
    if (!validateV2Snapshot(snapshot, []).installable) {
      throw new IsolatedInitializationError('ACTIVE_SNAPSHOT_INVALID')
    }
    return { slot, snapshot }
  } finally {
    db.close()
  }
}
