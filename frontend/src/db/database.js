import { DATABASE_VERSION, DEMO_DATABASE_NAME, upgradeInventorySchema } from './schema.js'

export class InventoryDatabaseError extends Error {
  constructor(code, message, cause) {
    super(message, { cause })
    this.name = 'InventoryDatabaseError'
    this.code = code
  }
}

const nativeErrors = {
  AbortError: ['DB_TRANSACTION_ABORTED', 'The local inventory transaction was aborted.'],
  ConstraintError: ['DB_CONSTRAINT', 'A local inventory record conflicts with an existing key or index.'],
  DataCloneError: ['DB_INVALID_RECORD', 'The local inventory database could not store this record.'],
  DataError: ['DB_INVALID_RECORD', 'The local inventory record has an invalid key.'],
  InvalidStateError: ['DB_CONNECTION_CLOSED', 'The local inventory database connection is closed.'],
  NotAllowedError: ['DB_UNAVAILABLE', 'This browser could not grant access to local inventory storage.'],
  QuotaExceededError: ['DB_QUOTA', 'There is not enough browser storage to save these inventory changes.'],
  SecurityError: ['DB_UNAVAILABLE', 'This browser does not allow access to local inventory storage.'],
  TransactionInactiveError: ['DB_TRANSACTION_ABORTED', 'The local inventory transaction is no longer active.'],
  VersionError: ['DB_VERSION_UNSUPPORTED', 'The local inventory database uses a newer version. Update the app before continuing.'],
}

const closedConnections = new WeakMap()

function databaseError(error, code, message) {
  if (error instanceof InventoryDatabaseError) return error
  const nativeError = Object.hasOwn(nativeErrors, error?.name) && nativeErrors[error.name]
  const [mappedCode, mappedMessage] = nativeError || [code, message]
  return new InventoryDatabaseError(mappedCode, mappedMessage, error)
}

function connectionClosed(database, code, message) {
  if (!closedConnections.has(database)) {
    closedConnections.set(database, new InventoryDatabaseError(code, message))
  }
}

export function closeInventoryDatabase(database) {
  connectionClosed(database, 'DB_CONNECTION_CLOSED', 'The local inventory database connection is closed.')
  database.close()
}

// Upgrade callbacks run synchronously inside IndexedDB's version-change transaction.
export function openDatabase({ name, version, upgrade, indexedDB } = {}) {
  return new Promise((resolve, reject) => {
    let request
    try {
      const factory = indexedDB === undefined ? globalThis.indexedDB : indexedDB
      if (!factory?.open) {
        throw new InventoryDatabaseError('DB_UNAVAILABLE', 'This browser does not provide local inventory storage.')
      }
      request = factory.open(name, version)
    } catch (error) {
      reject(databaseError(error, 'DB_OPEN_FAILED', 'The local inventory database could not be opened.'))
      return
    }

    let blocked = false
    let upgradeError
    request.addEventListener('blocked', () => {
      blocked = true
      reject(new InventoryDatabaseError('DB_BLOCKED', 'Close other app tabs and retry the local inventory database upgrade.'))
    }, { once: true })
    request.addEventListener('upgradeneeded', (event) => {
      // A blocked open cannot be cancelled until it starts its upgrade transaction.
      if (blocked) {
        request.transaction.abort()
        return
      }
      try {
        upgrade?.(request.result, event.oldVersion, request.transaction)
      } catch (error) {
        upgradeError = databaseError(error, 'DB_UPGRADE_FAILED', 'The local inventory database upgrade failed.')
        request.transaction.abort()
      }
    }, { once: true })
    request.addEventListener('error', () => {
      reject(upgradeError ?? databaseError(request.error, 'DB_OPEN_FAILED', 'The local inventory database could not be opened.'))
    }, { once: true })
    request.addEventListener('success', () => {
      const database = request.result
      if (blocked) {
        closeInventoryDatabase(database)
        return
      }
      database.addEventListener('versionchange', () => {
        connectionClosed(database, 'DB_VERSION_CHANGED', 'The local inventory database version changed. Reload the app before continuing.')
        database.close()
      }, { once: true })
      database.addEventListener('close', () => {
        connectionClosed(database, 'DB_CONNECTION_CLOSED', 'The browser closed the local inventory database connection.')
      }, { once: true })
      resolve(database)
    }, { once: true })
  })
}

export function openInventoryDatabase({ name = DEMO_DATABASE_NAME, indexedDB } = {}) {
  return openDatabase({ name, version: DATABASE_VERSION, upgrade: upgradeInventorySchema, indexedDB })
}

export function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true })
    request.addEventListener('error', () => {
      reject(databaseError(request.error, 'DB_REQUEST_FAILED', 'The local inventory database request failed.'))
    }, { once: true })
  })
}

function waitForTransaction(transaction) {
  return new Promise((resolve) => {
    transaction.addEventListener('complete', () => resolve(null), { once: true })
    transaction.addEventListener('abort', () => {
      resolve(databaseError(transaction.error, 'DB_TRANSACTION_ABORTED', 'The local inventory transaction was aborted.'))
    }, { once: true })
  })
}

// Await only IndexedDB request promises from work while this transaction is active.
export async function runTransaction(database, storeNames, mode, work) {
  const closed = closedConnections.get(database)
  if (closed) throw closed

  let transaction
  try {
    const options = mode === 'readwrite' ? { durability: 'strict' } : undefined
    transaction = database.transaction(storeNames, mode, options)
  } catch (error) {
    throw databaseError(error, 'DB_TRANSACTION_FAILED', 'The local inventory transaction could not be started.')
  }
  const completion = waitForTransaction(transaction)

  let result
  try {
    result = await work(transaction)
  } catch (error) {
    try {
      transaction.abort()
    } catch {
      // A failed request can already have aborted the transaction.
    }
    await completion
    if (error instanceof DOMException) {
      throw databaseError(error, 'DB_REQUEST_FAILED', 'The local inventory database request failed.')
    }
    throw error
  }

  const failure = await completion
  if (failure) throw failure
  return result
}
