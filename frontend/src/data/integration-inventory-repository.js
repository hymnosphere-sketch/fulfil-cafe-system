import { isWireDate, isWireUuid, validateWireCommand } from '../api/commands.js'
import { createIsolatedV2Client } from '../api/v2-client.js'
import { InventoryDatabaseError, openDatabase } from '../db/database.js'
import { DATABASE_VERSION, upgradeInventorySchema } from '../db/schema.js'
import { DemoRepositoryError, createUniqueId } from './demo-inventory-rules.js'
import { invalidLedger } from './durable-demo-ledger.js'
import { createInventoryRepository } from './persistent-inventory-repository.js'

export const INTEGRATION_DATABASE_PREFIX = 'fulfil-cafe-fe09f-integration-'
const DATASET = 'fe09f-fictional-integration'
const wireToLocal = { piece: 'piece', kg: 'g', l: 'mL' }
const localToWire = { piece: 'piece', g: 'kg', mL: 'l' }
const quantityUnits = Object.keys(localToWire)

export function integrationOrigin(port) {
  if (typeof port !== 'string' || !/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) {
    throw new TypeError('Enter the port printed by the disposable Flask fixture.')
  }
  return 'http://127.0.0.1:' + port
}

export function integrationFixtureFetch(url, options) {
  return globalThis.fetch(url, options).then((response) => {
    if (response.headers.get('X-Fulfil-Fixture') === 'FE-09F') return response
    void response.body?.cancel().catch(() => {})
    throw new Error('The server is missing the FE-09F disposable fixture marker.')
  })
}

function businessDate(timestamp, timezone) {
  const dateParts = new Intl.DateTimeFormat('en', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(timestamp))
  const { year, month, day } = Object.fromEntries(dateParts.map(({ type, value }) => [type, value]))
  return [year, month, day].join('-')
}

function prepareSeed(snapshot, baseUrl) {
  const { categories, inventory_items, stock_batches, stock_movements, batch_allocations, settings } = snapshot
  return {
    snapshot: {
      categories,
      inventory_items: inventory_items.map(({ available_quantity, stock_status, unit_of_measurement, ...row }) =>
        ({ ...row, unit_of_measurement: wireToLocal[unit_of_measurement] })),
      stock_batches: stock_batches.map(({ remaining_quantity, ...row }) => row),
      // FE-09C already validated the order and every inventory prefix.
      stock_movements: stock_movements.map(({ commit_seq, replay_status, ...row }) => row),
      batch_allocations,
      settings,
    },
    metadata: {
      dataset: DATASET,
      base_url: baseUrl,
      business_date: businessDate(snapshot.snapshot_at, settings.business_timezone),
      generation: snapshot.server_generation_id,
      settings_version: settings.settings_version,
      initial_commit: snapshot.sync.last_commit_seq ?? 0,
    },
  }
}

function wireCommand({ operation_id, operation_type, entity_id, payload, created_at, local_sequence }) {
  return validateWireCommand({ operation_id, operation_type, entity_id, payload, created_at, local_sequence })
}

function deliveryEntry(row) {
  if (row?.dataset !== DATASET) throw invalidLedger('The integration queue contains an unexpected record.')
  const { status, resolution_status, acknowledgment, last_error, retry_at } = row
  return { command: wireCommand(row), status, resolution_status, acknowledgment, last_error, retry_at }
}

const delivery = {
  read(metadata, rows) {
    const operations = rows.map(deliveryEntry)
    if (operations.some(({ command }, index) => command.local_sequence !== index + 1)) {
      throw invalidLedger('The integration queue is out of sequence.')
    }
    return { operations, generation: metadata.generation, settingsVersion: metadata.settings_version,
      initialCommit: metadata.initial_commit }
  },
  apply(current, entry, update) {
    const saved = deliveryEntry(current)
    if (saved.status !== 'pending' || saved.resolution_status !== 'none' ||
        JSON.stringify(saved.command) !== JSON.stringify(entry.command)) {
      throw invalidLedger('The pending integration command changed during delivery.')
    }
    return { ...current, ...update }
  },
}

function buildQueueRecord({ type, entityId, payload, createdAt }, sequence, createId) {
  const wirePayload = Object.hasOwn(payload, 'unit_of_measurement')
    ? { ...payload, unit_of_measurement: localToWire[payload.unit_of_measurement] }
    : payload
  return {
    ...wireCommand({ operation_id: createUniqueId(createId, new Set([entityId])), operation_type: type,
      entity_id: entityId, payload: wirePayload, created_at: createdAt, local_sequence: sequence }),
    dataset: DATASET, status: 'pending', resolution_status: 'none', acknowledgment: null,
    retry_count: 0, retry_at: null, last_attempt_at: null, last_error: null,
  }
}

function validateCatalog(snapshot, type, record) {
  if (type.endsWith('_item') && record.is_active && snapshot.inventory_items.some((item) =>
    item.is_active && item.item_id !== record.item_id && item.normalized_name === record.normalized_name &&
    item.category_id === record.category_id && item.unit_of_measurement === record.unit_of_measurement)) {
    throw new DemoRepositoryError('DUPLICATE_ITEM', 'An active item already has this name, category, and unit.', { field: 'name' })
  }
}

export function createIntegrationInventoryRepository({ fixtureId, port, allowInitialization = false, onConnectionError }) {
  if (!isWireUuid(fixtureId)) throw new TypeError('Choose a valid disposable integration fixture.')
  const baseUrl = integrationOrigin(port)
  const databaseName = INTEGRATION_DATABASE_PREFIX + fixtureId.toLowerCase()
  const profile = {
    openStorage: (options) => openDatabase({ ...options, version: DATABASE_VERSION,
      upgrade: (db, version) => upgradeInventorySchema(db, version, { reserveArchivedCategoryNames: false }) }),
    prepareSeed: (snapshot) => prepareSeed(snapshot, baseUrl),
    verifyMetadata(metadata) {
      if (metadata?.dataset !== DATASET || metadata.base_url !== baseUrl || !isWireDate(metadata.business_date) ||
          !isWireUuid(metadata.generation) || !Number.isSafeInteger(metadata.settings_version) || metadata.settings_version < 1 ||
          !Number.isSafeInteger(metadata.initial_commit) || metadata.initial_commit < 0 ||
          !Number.isSafeInteger(metadata.last_sequence) || metadata.last_sequence < 0) {
        throw new InventoryDatabaseError('DB_INVALID_METADATA', 'The saved integration fixture does not match this configuration.')
      }
      return metadata
    },
    decorateSnapshot(snapshot, metadata) {
      if (snapshot.settings.settings_version !== metadata.settings_version) {
        throw invalidLedger('The integration settings disagree with their verified version.')
      }
      snapshot.businessDate = metadata.business_date
      snapshot.quantityUnits = quantityUnits
    },
    buildQueueRecord,
    validateCatalog,
    delivery,
  }
  const repository = createInventoryRepository({
    databaseName, profile, onConnectionError,
    async readInitialSnapshot() {
      if (!allowInitialization) throw new InventoryDatabaseError('DB_UNAVAILABLE', 'No saved integration inventory exists for this fixture.')
      const client = createIsolatedV2Client({ baseUrl, fetch: integrationFixtureFetch })
      const response = await client.snapshot()
      if (!response.installable) throw new InventoryDatabaseError('DB_INVALID_METADATA', 'The Flask snapshot is provisional and could not be installed.')
      return response.data
    },
  })
  return { databaseName, baseUrl, repository }
}
