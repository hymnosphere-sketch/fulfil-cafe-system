import { closeInventoryDatabase, InventoryDatabaseError, openInventoryDatabase, requestResult, runTransaction } from '../db/database.js'
import { DEMO_DATABASE_NAME } from '../db/schema.js'
import { summarizeInventory } from '../services/inventory-summary.js'
import { buildDemoStockCandidate, DemoStockError } from '../services/stock-movements.js'
import { readDemoInventory } from './demo-data-provider.js'
import { demoBusinessDate } from './demo-inventory.js'
import { buildDemoCatalogCandidate, buildDemoStockPreview, createBrowserId, DemoRepositoryError } from './demo-inventory-rules.js'
import { buildDemoQueueRecord, catalogOperation, stockOperation } from './demo-operation-record.js'

const SETTINGS = 'application_settings'
const QUEUE = 'synchronization_queue'
const TEST_DATABASE_PREFIX = DEMO_DATABASE_NAME + '-test-'
const METADATA_KEY = 'demo_repository'
const EXPIRATION_SETTINGS_KEY = 'expiration_settings'
const FIXTURE_STORES = ['categories', 'inventory_items', 'stock_batches', 'stock_movements', 'batch_allocations']
const READ_STORES = [...FIXTURE_STORES, SETTINGS]
const MUTATION_STORES = [...READ_STORES, QUEUE]
const INITIALIZATION_STORES = [...MUTATION_STORES, 'staff_users']

const stalePreview = () => new DemoStockError(
  'STALE_PREVIEW', 'The stock review is out of date. Review the movement again before recording it.',
)

function getSetting(transaction, key) {
  return requestResult(transaction.objectStore(SETTINGS).get(key))
}

function verifyMetadata(metadata) {
  if (metadata?.dataset !== 'fictional' || metadata.business_date !== demoBusinessDate ||
    !Number.isSafeInteger(metadata.last_sequence) || metadata.last_sequence < 0) {
    throw new InventoryDatabaseError('DB_INVALID_METADATA', 'The saved demonstration inventory has invalid initialization metadata.')
  }
  return metadata
}

function writeRecords(transaction, writes) {
  return Promise.all(writes.map(async ([name, record, method = 'add']) =>
    requestResult(transaction.objectStore(name)[method](record))))
}

async function initialize(database, readFixture) {
  const existing = await runTransaction(database, [SETTINGS], 'readonly',
    (transaction) => getSetting(transaction, METADATA_KEY))
  if (existing) {
    verifyMetadata(existing)
    return
  }

  // Fetch and validate the fixture before opening the write transaction.
  const fixture = structuredClone(await readFixture())
  summarizeInventory(fixture, demoBusinessDate)
  await runTransaction(database, INITIALIZATION_STORES, 'readwrite', async (transaction) => {
    const initialized = await getSetting(transaction, METADATA_KEY)
    if (initialized) {
      verifyMetadata(initialized)
      return
    }
    const counts = await Promise.all(INITIALIZATION_STORES.map((name) =>
      requestResult(transaction.objectStore(name).count())))
    if (counts.some((count) => count > 0)) {
      throw new InventoryDatabaseError('DB_UNMARKED_DATA', 'The demonstration database already contains records without an initialization marker.')
    }
    const writes = FIXTURE_STORES.flatMap((name) => fixture[name].map((record, index, records) => [
      name, name === 'stock_movements' ? { ...record, demo_order: index - records.length } : record,
    ]))
    await writeRecords(transaction, [
      ...writes,
      [SETTINGS, { setting_key: EXPIRATION_SETTINGS_KEY, value: fixture.settings }],
      [SETTINGS, { setting_key: METADATA_KEY, dataset: 'fictional', business_date: demoBusinessDate, last_sequence: 0 }],
    ])
  })
}

async function readSnapshot(transaction) {
  const [rows, settings] = await Promise.all([
    Promise.all(FIXTURE_STORES.map((name) => requestResult(transaction.objectStore(name).getAll()))),
    getSetting(transaction, EXPIRATION_SETTINGS_KEY),
  ])
  if (!settings) throw new InventoryDatabaseError('DB_INVALID_METADATA', 'The saved demonstration settings could not be found.')
  const snapshot = Object.fromEntries(FIXTURE_STORES.map((name, index) => [name, rows[index]]))
  // IndexedDB returns primary-key order. Stock replay needs the fixture prefix and
  // then the local commit order, even when the device clock moves backward.
  const movements = snapshot.stock_movements
  movements.sort((left, right) => left.demo_order - right.demo_order)
  const sessionStart = movements.findIndex(({ demo_order }) => demo_order > 0)
  snapshot.stock_movements = movements.map(({ demo_order, ...movement }) => movement)
  if (sessionStart !== -1) snapshot.demoSessionMovementStart = sessionStart
  snapshot.settings = settings.value
  return snapshot
}

function nextSequence({ last_sequence }) {
  const sequence = last_sequence + 1
  if (!Number.isSafeInteger(sequence)) {
    throw new InventoryDatabaseError('DB_SEQUENCE_EXHAUSTED', 'The demonstration database cannot allocate another exact operation sequence.')
  }
  return sequence
}

export function createPersistentInventoryRepository({
  indexedDB,
  databaseName = DEMO_DATABASE_NAME,
  readInitialSnapshot = readDemoInventory,
  createId = createBrowserId,
  now = () => new Date().toISOString(),
  onConnectionError = () => {},
} = {}) {
  if (databaseName !== DEMO_DATABASE_NAME && (typeof databaseName !== 'string' ||
    !databaseName.startsWith(TEST_DATABASE_PREFIX) || databaseName.length === TEST_DATABASE_PREFIX.length)) {
    throw new InventoryDatabaseError('DB_INVALID_NAME', 'The fictional repository needs a demonstration database name.')
  }

  let connection
  let connectionGeneration = 0
  const reservedAttemptIds = new Set()
  const stockPreviews = new Map()

  function getConnection() {
    if (!connection) {
      const opening = openInventoryDatabase({ name: databaseName, indexedDB }).then(async (database) => {
        const reportClosure = (code, message) => {
          if (connection === opening) onConnectionError(new InventoryDatabaseError(code, message))
        }
        database.addEventListener('versionchange', () => {
          reportClosure('DB_VERSION_CHANGED', 'The local inventory database changed version. Reload the application before continuing.')
        }, { once: true })
        database.addEventListener('close', () => {
          reportClosure('DB_CONNECTION_CLOSED', 'The browser closed local inventory storage.')
        }, { once: true })
        try {
          await initialize(database, readInitialSnapshot)
          return database
        } catch (error) {
          closeInventoryDatabase(database)
          throw error
        }
      }).catch((error) => {
        if (connection === opening) connection = undefined
        throw error
      })
      connection = opening
    }
    return connection
  }

  async function close() {
    connectionGeneration += 1
    stockPreviews.clear()
    const opening = connection
    connection = undefined
    const database = await opening?.catch(() => undefined)
    if (database) closeInventoryDatabase(database)
  }

  async function read() {
    return runTransaction(await getConnection(), READ_STORES, 'readonly', readSnapshot)
  }

  async function readStatus() {
    const database = await getConnection()
    return runTransaction(database, [SETTINGS, QUEUE], 'readonly', async (transaction) => {
      const [metadata, queueCount] = await Promise.all([
        getSetting(transaction, METADATA_KEY).then(verifyMetadata),
        requestResult(transaction.objectStore(QUEUE).count()),
      ])
      return { schemaVersion: database.version, queueCount, revision: metadata.last_sequence }
    })
  }

  function writeOperation(transaction, writes, operation, metadata, sequence) {
    return writeRecords(transaction, [
      ...writes,
      [QUEUE, buildDemoQueueRecord(operation, sequence, createId)],
      [SETTINGS, { ...metadata, last_sequence: sequence }, 'put'],
    ])
  }

  async function mutateCatalog(type, args) {
    return runTransaction(await getConnection(), MUTATION_STORES, 'readwrite', async (transaction) => {
      const [snapshot, metadata] = await Promise.all([
        readSnapshot(transaction),
        getSetting(transaction, METADATA_KEY).then(verifyMetadata),
      ])
      const category = type.endsWith('_category')
      const store = category ? 'categories' : 'inventory_items'
      if (args.expected) {
        const idField = category ? 'category_id' : 'item_id'
        const current = snapshot[store].find((record) => record[idField] === args.id)
        if (current && Object.entries(args.expected).some(([field, value]) =>
          String(current[field] ?? '') !== String(value ?? ''))) {
          throw new DemoRepositoryError('RECORD_CHANGED', 'This record changed after you opened it. Reopen it to review the latest values before saving.')
        }
      }
      const { record } = buildDemoCatalogCandidate(snapshot, type, { ...args, createId, now })
      await writeOperation(transaction, [[store, record, type.startsWith('create_') ? 'add' : 'put']],
        catalogOperation(type, record, snapshot), metadata, nextSequence(metadata))
      return record
    })
  }

  async function previewStockMovement(draft) {
    const generation = connectionGeneration
    const { snapshot, metadata } = await runTransaction(await getConnection(), READ_STORES, 'readonly', async (transaction) => {
      const [snapshot, metadata] = await Promise.all([
        readSnapshot(transaction),
        getSetting(transaction, METADATA_KEY).then(verifyMetadata),
      ])
      return { snapshot, metadata }
    })
    if (generation !== connectionGeneration) throw stalePreview()
    const { preview, result } = buildDemoStockPreview(snapshot, draft, { createId, reservedAttemptIds })
    reservedAttemptIds.add(result.attemptId)
    stockPreviews.set(result.attemptId, {
      ...preview,
      // Every committed inventory change advances the queue sequence.
      revision: metadata.last_sequence,
      signature: JSON.stringify([result, preview.identifiers.allocationIds]),
    })
    return result
  }

  async function recordStockMovement(attemptId) {
    if (typeof attemptId !== 'string' || !attemptId) throw stalePreview()
    const receiptKey = 'demo_stock_attempt:' + attemptId
    try {
      const result = await runTransaction(await getConnection(), MUTATION_STORES, 'readwrite', async (transaction) => {
        const receipt = await getSetting(transaction, receiptKey)
        const preview = stockPreviews.get(attemptId)
        if (receipt) {
          if (preview && preview.signature !== receipt.signature) throw stalePreview()
          return { ...receipt.result, alreadyRecorded: true }
        }
        if (!preview) throw stalePreview()
        const metadata = verifyMetadata(await getSetting(transaction, METADATA_KEY))
        if (preview.revision !== metadata.last_sequence) throw stalePreview()
        const snapshot = await readSnapshot(transaction)
        if (stockPreviews.get(attemptId) !== preview) throw stalePreview()

        const { result } = buildDemoStockCandidate(snapshot, preview.draft, {
          ...preview.identifiers, timestamp: now(), businessDate: demoBusinessDate,
        })
        const sequence = nextSequence(metadata)
        const writes = [
          ['stock_movements', { ...result.movement, demo_order: sequence }],
          ...result.allocations.map((allocation) => ['batch_allocations', allocation]),
          [SETTINGS, { setting_key: receiptKey, result, signature: preview.signature }],
        ]
        if (result.batch) writes.push(['stock_batches', result.batch])
        await writeOperation(transaction, writes, stockOperation(result), metadata, sequence)
        return result
      })
      stockPreviews.delete(attemptId)
      return result
    } catch (error) {
      if (error.code === 'STALE_PREVIEW') stockPreviews.delete(attemptId)
      throw error
    }
  }

  return {
    read,
    readStatus,
    close,
    previewStockMovement,
    recordStockMovement,
    discardStockPreview(attemptId) { stockPreviews.delete(attemptId) },
    createItem(input, { allowDuplicate = false } = {}) {
      return mutateCatalog('create_item', { input, allowDuplicate })
    },
    updateItem(id, input, { allowDuplicate = false, expected } = {}) {
      return mutateCatalog('update_item', { id, input, allowDuplicate, expected })
    },
    archiveItem(id, { expected } = {}) { return mutateCatalog('archive_item', { id, expected }) },
    createCategory(input) { return mutateCatalog('create_category', { input }) },
    updateCategory(id, input, { expected } = {}) { return mutateCatalog('update_category', { id, input, expected }) },
    archiveCategory(id, { expected } = {}) { return mutateCatalog('archive_category', { id, expected }) },
  }
}
