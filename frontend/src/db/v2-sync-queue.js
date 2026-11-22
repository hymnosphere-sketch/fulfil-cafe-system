import { isWireUuid, validateWireCommand } from '../api/commands.js'
import { closeInventoryDatabase, openDatabase, requestResult, runTransaction } from './database.js'

export const FE09D_TEST_CONSENT = 'ISOLATED_FE09D_TEST_ONLY'

const CONTROL = 'control'
const QUEUE = 'synchronization_queue'
const CONFIG = 'fixture'
const STORES = [CONTROL, QUEUE]

async function openQueue({ consent, databaseName, indexedDB }) {
  if (consent !== FE09D_TEST_CONSENT || typeof databaseName !== 'string' ||
      !/^fulfil-cafe-fe09d-queue-[a-z0-9-]+$/.test(databaseName)) {
    throw new TypeError('FE-09D requires consent and a named disposable queue.')
  }
  return openDatabase({
    name: databaseName, version: 1, indexedDB,
    upgrade(db) {
      db.createObjectStore(CONTROL)
      const queue = db.createObjectStore(QUEUE, { keyPath: 'command.operation_id' })
      queue.createIndex('by_sequence', 'command.local_sequence', { unique: true })
    },
  })
}

/** Seed a new, explicitly named fictional queue. Existing queues cannot be replaced. */
export async function prepareIsolatedV2Queue({ generation, settingsVersion, commands, ...options } = {}) {
  if (!isWireUuid(generation) || !Number.isSafeInteger(settingsVersion) || settingsVersion < 1 ||
      !Array.isArray(commands)) throw new TypeError('Supply fixture generation, settings version, and commands.')
  const wire = Array.from(commands, validateWireCommand)
  if (new Set(wire.map((command) => command.operation_id.toLowerCase())).size !== wire.length) {
    throw new TypeError('Fixture operation IDs must be unique.')
  }
  const db = await openQueue(options)
  try {
    await runTransaction(db, STORES, 'readwrite', (tx) => {
      tx.objectStore(CONTROL).add({ generation, settingsVersion, count: wire.length }, CONFIG)
      const queue = tx.objectStore(QUEUE)
      for (const command of wire) {
        queue.add({
          command, status: 'pending', resolution_status: 'none', acknowledgment: null,
          retry_count: 0, retry_at: null, last_attempt_at: null, last_error: null,
        })
      }
    })
  } finally {
    closeInventoryDatabase(db)
  }
}

export async function withIsolatedV2Queue(options, work) {
  const db = await openQueue(options)
  try {
    return await work({
      read() {
        return runTransaction(db, STORES, 'readonly', async (tx) => {
          const [config, operations] = await Promise.all([
            requestResult(tx.objectStore(CONTROL).get(CONFIG)),
            requestResult(tx.objectStore(QUEUE).index('by_sequence').getAll()),
          ])
          if (!config || operations.length !== config.count ||
              !isWireUuid(config.generation) || !Number.isSafeInteger(config.settingsVersion) || config.settingsVersion < 1) {
            throw new Error('The isolated queue has missing or invalid configuration.')
          }
          return { ...config, operations }
        })
      },
      recordDelivery(entry, delivery) {
        return runTransaction(db, [QUEUE], 'readwrite', async (tx) => {
          const queue = tx.objectStore(QUEUE)
          const current = await requestResult(queue.get(entry.command.operation_id))
          if (current?.status !== 'pending' || current.resolution_status !== 'none' ||
              JSON.stringify(current.command) !== JSON.stringify(entry.command)) {
            throw new Error('The pending queue entry changed during delivery.')
          }
          await requestResult(queue.put({ ...current, ...delivery, command: current.command }))
        })
      },
    })
  } finally {
    closeInventoryDatabase(db)
  }
}

export function readIsolatedV2Queue(options) {
  return withIsolatedV2Queue(options, (queue) => queue.read())
}
