import { isWireUuid, sameWireUuid } from '../api/commands.js'
import { validateV2Snapshot } from '../api/v2-snapshot.js'
import { requestResult, runTransaction } from './database.js'

export const FE09C_TEST_DATABASE = 'fulfil-cafe-fe09c-v2-isolated'
export const FE09C_TEST_CONSENT = 'ISOLATED_FE09C_TEST_ONLY'

const COLLECTIONS = {
  categories: 'category_id',
  inventory_items: 'item_id',
  stock_batches: 'batch_id',
  stock_movements: 'movement_id',
  batch_allocations: 'allocation_id',
}
const DATA_STORES = [...Object.keys(COLLECTIONS), 'application_settings', 'manifests']
const ALL_STORES = [...DATA_STORES, 'control']

export class IsolatedInitializationError extends Error {
  constructor(code) {
    super('Isolated FE-09C initialization could not be completed.')
    this.name = 'IsolatedInitializationError'
    this.code = code
  }
}

function openDatabase(factory, databaseName, { create = true } = {}) {
  return new Promise((resolve, reject) => {
    const req = factory.open(databaseName, 1)
    let absent = false
    let blocked = false
    req.onupgradeneeded = () => {
      if (!create || blocked) {
        absent = !create
        req.transaction.abort()
        return
      }
      const db = req.result
      for (const [name, id] of Object.entries(COLLECTIONS)) {
        db.createObjectStore(name, { keyPath: ['slot', id] }).createIndex('by_slot', 'slot')
      }
      db.createObjectStore('application_settings', { keyPath: ['slot', 'key'] }).createIndex('by_slot', 'slot')
      db.createObjectStore('manifests', { keyPath: 'slot' })
      db.createObjectStore('control', { keyPath: 'key' })
    }
    req.onsuccess = () => {
      const db = req.result
      db.onversionchange = () => db.close()
      if (blocked) db.close()
      else if (ALL_STORES.some((name) => !db.objectStoreNames.contains(name))) {
        db.close()
        reject(new IsolatedInitializationError('SCHEMA_CONFLICT'))
      } else resolve(db)
    }
    req.onerror = () => {
      if (absent) resolve(null)
      else reject(req.error ?? new Error('IndexedDB open failed.'))
    }
    req.onblocked = () => {
      blocked = true
      reject(new IsolatedInitializationError('DATABASE_BLOCKED'))
    }
  })
}

async function activeSlot(tx) {
  const current = await requestResult(tx.objectStore('control').get('active'))
  return current?.slot ?? null
}

function stage(db, slot, snapshot) {
  return runTransaction(db, DATA_STORES, 'readwrite', (tx) => {
    for (const name of Object.keys(COLLECTIONS)) {
      const store = tx.objectStore(name)
      snapshot[name].forEach((record, position) => store.add({ ...record, slot, position }))
    }
    const settings = tx.objectStore('application_settings')
    settings.add({ slot, key: 'server_generation_id', value: snapshot.server_generation_id })
    settings.add({ slot, key: 'settings', value: snapshot.settings })
    const { categories, inventory_items, stock_batches, stock_movements,
      batch_allocations, settings: _settings, server_generation_id: _generation,
      ...metadata } = snapshot
    tx.objectStore('manifests').add({ slot, metadata })
  })
}

async function readSlot(tx, slot) {
  // Observe every request before yielding, including failures thrown during scheduling.
  const readRows = async (name) => requestResult(tx.objectStore(name).index('by_slot').getAll(slot))
  const readManifest = async () => requestResult(tx.objectStore('manifests').get(slot))
  const collections = Object.keys(COLLECTIONS)
  const [records, settings, manifest] = await Promise.all([
    Promise.all(collections.map(readRows)), readRows('application_settings'), readManifest(),
  ])
  const values = Object.fromEntries(settings.map(({ key, value }) => [key, value]))
  if (!manifest || settings.length !== 2 || !Object.hasOwn(values, 'settings') ||
      !Object.hasOwn(values, 'server_generation_id')) {
    throw new IsolatedInitializationError('STAGING_INCOMPLETE')
  }
  const rows = Object.fromEntries(collections.map((name, index) => [name, records[index]
    .sort((a, b) => a.position - b.position)
    .map(({ slot: _slot, position, ...record }, expectedPosition) => {
      if (position !== expectedPosition) throw new IsolatedInitializationError('STAGING_INCOMPLETE')
      return record
    })]))
  return { ...manifest.metadata, ...rows,
    settings: values.settings, server_generation_id: values.server_generation_id }
}

// Snapshots contain wire objects and arrays. Compare their values without JSON coercion.
function sameSnapshotContents(left, right) {
  if (Object.is(left, right)) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  const prototype = Object.getPrototypeOf(left)
  if (prototype !== Object.getPrototypeOf(right)) return false
  if (prototype === Array.prototype) {
    if (left.length !== right.length) return false
  } else if (prototype !== Object.prototype) return false
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameSnapshotContents(left[key], right[key]))
}

function checkCancelled(signal) {
  if (signal?.aborted) throw new IsolatedInitializationError('CANCELLED')
}

async function activate(db, previous, slot, expectedSnapshot, signal) {
  let abortOnCancel
  let cancelled = false
  try {
    return await runTransaction(db, ALL_STORES, 'readwrite', async (tx) => {
      checkCancelled(signal)
      abortOnCancel = () => {
        try {
          tx.abort()
          cancelled = true
        } catch {
          // A transaction that has already finished determines the outcome.
        }
      }
      signal?.addEventListener('abort', abortOnCancel, { once: true })
      if ((await activeSlot(tx)) !== previous) {
        throw new IsolatedInitializationError('CONCURRENT_INITIALIZATION')
      }
      const restored = await readSlot(tx, slot)
      if (!sameSnapshotContents(restored, expectedSnapshot) || !validateV2Snapshot(restored, []).installable) {
        throw new IsolatedInitializationError('STAGING_MISMATCH')
      }
      checkCancelled(signal)
      if (slot !== previous) await requestResult(tx.objectStore('control').put({ key: 'active', slot }))
      return restored
    })
  } catch (error) {
    if (cancelled) throw new IsolatedInitializationError('CANCELLED')
    throw error
  } finally {
    if (abortOnCancel) signal?.removeEventListener('abort', abortOnCancel)
  }
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

function readActive(db) {
  return runTransaction(db, ALL_STORES, 'readonly', async (tx) => {
    const slot = await activeSlot(tx)
    if (!slot) return null
    const snapshot = await readSlot(tx, slot)
    if (!validateV2Snapshot(snapshot, []).installable) {
      throw new IsolatedInitializationError('ACTIVE_SNAPSHOT_INVALID')
    }
    return { slot, snapshot }
  })
}

async function readExisting(factory, databaseName) {
  // Browsers with databases() can avoid even opening an absent namespace.
  const databases = await factory.databases?.()
  if (databases && !databases.some(({ name }) => name === databaseName)) return null
  const db = await openDatabase(factory, databaseName, { create: false })
  if (!db) return null
  try {
    return await readActive(db)
  } finally {
    db.close()
  }
}

/** Install an authoritative snapshot only in an explicitly opted-in FE-09C test database. */
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
  checkCancelled(signal)
  const previous = await readExisting(factory, databaseName)
  checkCancelled(signal)
  const response = await client.snapshot({ receiptIds: [], signal })
  checkCancelled(signal)
  const checked = validateV2Snapshot(response.data, [])
  if (!checked.installable || response.installable !== true) {
    throw new IsolatedInitializationError('SNAPSHOT_NOT_AUTHORITATIVE')
  }
  if (!isWireUuid(response.generation) || !sameWireUuid(response.generation, response.data.server_generation_id) ||
      response.settingsVersion !== response.data.settings.settings_version) {
    throw new IsolatedInitializationError('SNAPSHOT_HEADER_MISMATCH')
  }
  const snapshot = structuredClone(checked.data)
  const previousSlot = previous?.slot ?? null
  let slot
  let expectedSnapshot = snapshot
  if (previous) {
    if (!sameWireUuid(previous.snapshot.server_generation_id, snapshot.server_generation_id)) {
      throw new IsolatedInitializationError('GENERATION_MISMATCH')
    }
    const previousCommit = previous.snapshot.sync.last_commit_seq ?? 0
    const incomingCommit = snapshot.sync.last_commit_seq ?? 0
    if (incomingCommit < previousCommit) throw new IsolatedInitializationError('STALE_SNAPSHOT')
    if (incomingCommit === previousCommit) {
      const comparable = { ...snapshot, snapshot_at: previous.snapshot.snapshot_at }
      expectedSnapshot = previous.snapshot
      if (!sameSnapshotContents(comparable, expectedSnapshot)) {
        throw new IsolatedInitializationError('SNAPSHOT_CONFLICT')
      }
      slot = previousSlot
    }
  }

  if (!slot) {
    slot = createSlot()
    if (typeof slot !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(slot) || previousSlot === slot) {
      throw new IsolatedInitializationError('INVALID_SLOT')
    }
    const db = await openDatabase(factory, databaseName)
    try {
      await stage(db, slot, structuredClone(snapshot))
    } finally {
      db.close()
    }
  }

  // Verify content and compare-and-swap the pointer in one transaction after reopening.
  const db = await openDatabase(factory, databaseName, { create: false })
  if (!db) throw new IsolatedInitializationError('STAGING_INCOMPLETE')
  try {
    const restored = await activate(db, previousSlot, slot, expectedSnapshot, signal)
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

/** Read an active snapshot from the isolated test namespace. */
export async function readIsolatedV2({
  indexedDB: factory = globalThis.indexedDB,
  databaseName = FE09C_TEST_DATABASE,
} = {}) {
  if (!validName(databaseName)) throw new IsolatedInitializationError('INVALID_TEST_CONFIGURATION')
  return readExisting(safeFactory(factory), databaseName)
}
