import { closeInventoryDatabase, InventoryDatabaseError, openInventoryDatabase, requestResult, runTransaction } from '../db/database.js'
import { DEMO_DATABASE_NAME } from '../db/schema.js'
import { summarizeInventory } from '../services/inventory-summary.js'
import { buildDemoStockCandidate, DemoStockError } from '../services/stock-movements.js'
import { readDemoInventory } from './demo-data-provider.js'
import { demoBusinessDate } from './demo-inventory.js'
import { buildDemoCatalogCandidate, buildDemoStockPreview, createBrowserId, DemoRepositoryError } from './demo-inventory-rules.js'
import { buildDemoQueueRecord, catalogOperation, stockOperation } from './demo-operation-record.js'
import { invalidLedger, reconstructStoredMovements, verifyStockReceipt } from './durable-demo-ledger.js'

const SETTINGS = 'application_settings'
const QUEUE = 'synchronization_queue'
const TEST_DATABASE_PREFIX = DEMO_DATABASE_NAME + '-test-'
const METADATA_KEY = 'demo_repository'
const EXPIRATION_SETTINGS_KEY = 'expiration_settings'
const STOCK_ATTEMPT_PREFIX = 'demo_stock_attempt:'
const FIXTURE_STORES = ['categories', 'inventory_items', 'stock_batches', 'stock_movements', 'batch_allocations']
const INVENTORY_STORES = [...FIXTURE_STORES, SETTINGS, QUEUE]
const INITIALIZATION_STORES = [...INVENTORY_STORES, 'staff_users']

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

const demoProfile = {
  verifyMetadata,
  buildQueueRecord: buildDemoQueueRecord,
  prepareSeed: (snapshot) => ({ snapshot, metadata: { dataset: 'fictional', business_date: demoBusinessDate } }),
}

async function initialize(database, readFixture, profile) {
  const existing = await runTransaction(database, [SETTINGS], 'readonly',
    (transaction) => getSetting(transaction, METADATA_KEY))
  if (existing) {
    profile.verifyMetadata(existing)
    return
  }

  // Fetch and validate the fixture before opening the write transaction.
  const { snapshot: fixture, metadata } = profile.prepareSeed(structuredClone(await readFixture()))
  summarizeInventory(fixture, metadata.business_date)
  await runTransaction(database, INITIALIZATION_STORES, 'readwrite', async (transaction) => {
    const initialized = await getSetting(transaction, METADATA_KEY)
    if (initialized) {
      profile.verifyMetadata(initialized)
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
      [SETTINGS, { ...metadata, setting_key: METADATA_KEY, last_sequence: 0 }],
    ])
  })
}

async function readCommittedInventory(transaction, profile) {
  const [rows, settings, metadata, queue] = await Promise.all([
    Promise.all(FIXTURE_STORES.map((name) => requestResult(transaction.objectStore(name).getAll()))),
    getSetting(transaction, EXPIRATION_SETTINGS_KEY),
    getSetting(transaction, METADATA_KEY).then(profile.verifyMetadata),
    requestResult(transaction.objectStore(QUEUE).getAll()),
  ])
  if (!settings) throw new InventoryDatabaseError('DB_INVALID_METADATA', 'The saved demonstration settings could not be found.')
  const snapshot = Object.fromEntries(FIXTURE_STORES.map((name, index) => [name, rows[index]]))
  snapshot.settings = settings.value
  profile.decorateSnapshot?.(snapshot, metadata)
  reconstructStoredMovements(snapshot, queue, metadata.last_sequence)
  try {
    summarizeInventory(snapshot, metadata.business_date)
  } catch (error) {
    throw invalidLedger('The saved inventory could not be replayed.', error)
  }
  return { snapshot, metadata }
}

function nextSequence({ last_sequence }) {
  const sequence = last_sequence + 1
  if (!Number.isSafeInteger(sequence)) {
    throw new InventoryDatabaseError('DB_SEQUENCE_EXHAUSTED', 'The demonstration database cannot allocate another exact operation sequence.')
  }
  return sequence
}

export function createPersistentInventoryRepository({
  databaseName = DEMO_DATABASE_NAME,
  readInitialSnapshot = readDemoInventory,
  ...options
} = {}) {
  if (databaseName !== DEMO_DATABASE_NAME && (typeof databaseName !== 'string' ||
    !databaseName.startsWith(TEST_DATABASE_PREFIX) || databaseName.length === TEST_DATABASE_PREFIX.length)) {
    throw new InventoryDatabaseError('DB_INVALID_NAME', 'The fictional repository needs a demonstration database name.')
  }
  return createInventoryRepository({ ...options, databaseName, readInitialSnapshot, profile: demoProfile })
}

// Both repository profiles use the same transaction, preview, and replay code.
export function createInventoryRepository({
  indexedDB, databaseName, readInitialSnapshot, profile,
  createId = createBrowserId, now = () => new Date().toISOString(), onConnectionError = () => {},
}) {
  let connection
  let connectionGeneration = 0
  const reservedAttemptIds = new Set()
  const stockPreviews = new Map()
  const readInventory = (transaction) => readCommittedInventory(transaction, profile)

  function getConnection() {
    if (!connection) {
      const open = profile.openStorage ?? openInventoryDatabase
      const opening = open({ name: databaseName, indexedDB }).then(async (database) => {
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
          await initialize(database, readInitialSnapshot, profile)
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

  async function read({ confirmationAttempt } = {}) {
    return runTransaction(await getConnection(), INVENTORY_STORES, 'readonly', async (transaction) => {
      const [{ snapshot }, receipt] = await Promise.all([
        readInventory(transaction),
        confirmationAttempt ? getSetting(transaction, STOCK_ATTEMPT_PREFIX + confirmationAttempt) : undefined,
      ])
      if (receipt) verifyStockReceipt(snapshot, confirmationAttempt, receipt.result)
      return snapshot
    })
  }

  async function readStatus() {
    const database = await getConnection()
    return runTransaction(database, [SETTINGS, QUEUE], 'readonly', async (transaction) => {
      const store = transaction.objectStore(QUEUE)
      const [metadata, records] = await Promise.all([
        getSetting(transaction, METADATA_KEY).then(profile.verifyMetadata),
        requestResult(profile.delivery ? store.index('local_sequence').getAll() : store.count()),
      ])
      const queueCount = profile.delivery ? records.length : records
      if (queueCount !== metadata.last_sequence) throw invalidLedger('The saved queue and committed sequence disagree.')
      const status = { schemaVersion: database.version, queueCount, revision: metadata.last_sequence }
      if (profile.delivery) {
        status.queue = profile.delivery.read(metadata, records)
        status.businessDate = metadata.business_date
      }
      return status
    })
  }

  function writeOperation(transaction, writes, operation, metadata, sequence) {
    return writeRecords(transaction, [
      ...writes,
      [QUEUE, profile.buildQueueRecord(operation, sequence, createId)],
      [SETTINGS, { ...metadata, last_sequence: sequence }, 'put'],
    ])
  }

  async function mutateCatalog(type, args) {
    return runTransaction(await getConnection(), INVENTORY_STORES, 'readwrite', async (transaction) => {
      const { snapshot, metadata } = await readInventory(transaction)
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
      profile.validateCatalog?.(snapshot, type, record)
      await writeOperation(transaction, [[store, record, type.startsWith('create_') ? 'add' : 'put']],
        catalogOperation(type, record, snapshot), metadata, nextSequence(metadata))
      return record
    })
  }

  async function previewStockMovement(draft) {
    const generation = connectionGeneration
    const { snapshot, metadata } = await runTransaction(await getConnection(), INVENTORY_STORES, 'readonly', readInventory)
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
    const receiptKey = STOCK_ATTEMPT_PREFIX + attemptId
    try {
      const result = await runTransaction(await getConnection(), INVENTORY_STORES, 'readwrite', async (transaction) => {
        const [{ snapshot, metadata }, receipt] = await Promise.all([
          readInventory(transaction),
          getSetting(transaction, receiptKey),
        ])
        const preview = stockPreviews.get(attemptId)
        if (receipt) {
          verifyStockReceipt(snapshot, attemptId, receipt.result)
          if (preview && preview.signature !== receipt.signature) throw stalePreview()
          return { ...receipt.result, alreadyRecorded: true }
        }
        if (!preview) throw stalePreview()
        if (preview.revision !== metadata.last_sequence) throw stalePreview()
        // The next sequence follows every validated movement. The shared
        // candidate builder appends and replays in that same durable order.
        const sequence = nextSequence(metadata)
        const { result } = buildDemoStockCandidate(snapshot, preview.draft, {
          ...preview.identifiers, timestamp: now(), businessDate: metadata.business_date,
        })
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
    ...(profile.delivery && {
      withDeliveryQueue: async (work) => {
        const database = await getConnection()
        return work({
          read: async () => (await readStatus()).queue,
          recordDelivery: (entry, delivery) => runTransaction(database, [QUEUE], 'readwrite', async (transaction) => {
            const store = transaction.objectStore(QUEUE)
            const current = await requestResult(store.get(entry.command.operation_id))
            await requestResult(store.put(profile.delivery.apply(current, entry, delivery)))
          }),
        })
      },
    }),
    previewStockMovement,
    recordStockMovement,
    discardStockPreview(attemptId) { stockPreviews.delete(attemptId) },
    createItem(input, { duplicateApproval } = {}) {
      return mutateCatalog('create_item', { input, duplicateApproval })
    },
    updateItem(id, input, { duplicateApproval, expected } = {}) {
      return mutateCatalog('update_item', { id, input, duplicateApproval, expected })
    },
    archiveItem(id, { expected } = {}) { return mutateCatalog('archive_item', { id, expected }) },
    createCategory(input) { return mutateCatalog('create_category', { input }) },
    updateCategory(id, input, { expected } = {}) { return mutateCatalog('update_category', { id, input, expected }) },
    archiveCategory(id, { expected } = {}) { return mutateCatalog('archive_category', { id, expected }) },
  }
}
