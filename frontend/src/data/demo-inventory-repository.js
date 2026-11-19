import { summarizeInventory } from '../services/inventory-summary.js'
import { cleanDemoName, findDemoNameMatches, normalizeDemoName, parseDemoMinimumStockLevel } from '../utils/demo-catalog.js'
import { readDemoInventory } from './demo-data-provider.js'
import { demoBusinessDate, demoInventory } from './demo-inventory.js'

// Every unit in the fictional fixture uses scale 0. Production unit profiles are pending.
export const demoUnits = Object.freeze([
  ...new Set(demoInventory.inventory_items.map((item) => item.unit_of_measurement)),
].sort())

const ITEM_FIELDS = ['name', 'category_id', 'unit_of_measurement', 'minimum_stock_level']
const CATEGORY_FIELDS = ['name', 'description']

class DemoRepositoryError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'DemoRepositoryError'
    this.code = code
    Object.assign(this, details)
  }
}

function validateInputFields(input, allowedFields) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    Object.keys(input).some((field) => !allowedFields.includes(field))) {
    throw new DemoRepositoryError('VALIDATION', 'Only the editable form fields can be saved.')
  }
}

function requiredName(value, label) {
  const name = cleanDemoName(value)
  if (!name) {
    throw new DemoRepositoryError('VALIDATION', 'Enter the name for this ' + label + '.', { field: 'name' })
  }
  return name
}

function minimumStockLevel(value) {
  const quantity = parseDemoMinimumStockLevel(value)
  if (quantity === null) {
    throw new DemoRepositoryError('VALIDATION', 'Enter a whole number of 0 or more that the app can store exactly.', {
      field: 'minimum_stock_level',
    })
  }
  return quantity
}

function findActiveRecord(records, idField, id, label) {
  const record = records.find((entry) => entry[idField] === id)
  if (!record) {
    throw new DemoRepositoryError('RECORD_NOT_FOUND', 'This ' + label + ' is no longer available in this session.')
  }
  if (!record.is_active) {
    throw new DemoRepositoryError('RECORD_ARCHIVED', 'This ' + label + ' is archived and can only be viewed.')
  }
  return record
}

function createBrowserId() {
  const browserCrypto = globalThis.crypto
  if (typeof browserCrypto?.randomUUID === 'function') return browserCrypto.randomUUID()

  // getRandomValues is available even when a tablet opens Vite over its LAN address.
  if (typeof browserCrypto?.getRandomValues !== 'function') {
    throw new DemoRepositoryError('ID_UNAVAILABLE', 'This browser could not create a secure record identifier.')
  }
  const bytes = browserCrypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

function createUniqueId(createId, records, idField) {
  const id = createId()
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ||
    records.some((record) => record[idField] === id.toLowerCase())) {
    throw new DemoRepositoryError('ID_UNAVAILABLE', 'A unique record identifier could not be created. Try saving again.')
  }
  return id.toLowerCase()
}

function itemMetadata(snapshot, input, existing, allowDuplicate) {
  validateInputFields(input, ITEM_FIELDS)
  const name = requiredName(input.name, 'item')
  if (!snapshot.categories.some((category) => category.category_id === input.category_id && category.is_active)) {
    throw new DemoRepositoryError('VALIDATION', 'Choose an active category.', { field: 'category_id' })
  }

  const unit = input.unit_of_measurement === undefined ? existing?.unit_of_measurement : input.unit_of_measurement
  if (!demoUnits.includes(unit)) {
    throw new DemoRepositoryError('VALIDATION', 'Choose a unit from the demonstration list.', { field: 'unit_of_measurement' })
  }
  if (existing && unit !== existing.unit_of_measurement && (
    snapshot.stock_batches.some((batch) => batch.item_id === existing.item_id) ||
    snapshot.stock_movements.some((movement) => movement.item_id === existing.item_id)
  )) {
    throw new DemoRepositoryError('ITEM_UNIT_LOCKED', 'The unit is locked because this item has stock history.', {
      field: 'unit_of_measurement',
    })
  }
  const threshold = minimumStockLevel(input.minimum_stock_level)

  const matches = findDemoNameMatches(snapshot.inventory_items, name, {
    excludeId: existing?.item_id,
    idField: 'item_id',
  })
  if (matches.length && allowDuplicate !== true) {
    throw new DemoRepositoryError('POTENTIAL_DUPLICATE_ITEM', 'Review the items with matching names before confirming.', {
      field: 'name',
      matches,
    })
  }

  return {
    name,
    normalized_name: normalizeDemoName(name),
    category_id: input.category_id,
    unit_of_measurement: unit,
    minimum_stock_level: threshold,
  }
}

function categoryMetadata(snapshot, input, existing) {
  validateInputFields(input, CATEGORY_FIELDS)
  const name = requiredName(input.name, 'category')
  if (input.description != null && typeof input.description !== 'string') {
    throw new DemoRepositoryError('VALIDATION', 'Enter a description as text or leave it blank.', { field: 'description' })
  }
  // Demo category names are reserved by both active and archived records. Production policy is pending.
  const matches = findDemoNameMatches(snapshot.categories, name, {
    excludeId: existing?.category_id,
    idField: 'category_id',
  })
  if (matches.length) {
    throw new DemoRepositoryError('DUPLICATE_CATEGORY',
      'The demo requires a different name from every active or archived category.', { field: 'name' })
  }

  return {
    name,
    normalized_name: normalizeDemoName(name),
    description: input.description?.trim().normalize('NFC') || null,
  }
}

// The same asynchronous methods can sit in front of persistent storage in a later implementation.
export function createDemoInventoryRepository({
  readInitialSnapshot = readDemoInventory,
  createId = createBrowserId,
  now = () => new Date().toISOString(),
} = {}) {
  let snapshot
  let initialization

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

  async function mutate(change) {
    await initialize()
    // There is no await between copying the current state and publishing the validated candidate.
    const candidate = structuredClone(snapshot)
    const record = change(candidate)
    summarizeInventory(candidate, demoBusinessDate)
    const savedRecord = structuredClone(record)
    snapshot = candidate
    return savedRecord
  }

  return {
    read,
    createItem(input, { allowDuplicate = false } = {}) {
      return mutate((candidate) => {
        const metadata = itemMetadata(candidate, input, null, allowDuplicate)
        const timestamp = now()
        const item = {
          ...metadata,
          item_id: createUniqueId(createId, candidate.inventory_items, 'item_id'),
          is_active: true,
          created_at: timestamp,
          updated_at: timestamp,
        }
        candidate.inventory_items.push(item)
        return item
      })
    },
    updateItem(itemId, input, { allowDuplicate = false } = {}) {
      return mutate((candidate) => {
        const item = findActiveRecord(candidate.inventory_items, 'item_id', itemId, 'item')
        const metadata = itemMetadata(candidate, input, item, allowDuplicate)
        Object.assign(item, metadata, { updated_at: now() })
        return item
      })
    },
    archiveItem(itemId) {
      return mutate((candidate) => {
        const item = findActiveRecord(candidate.inventory_items, 'item_id', itemId, 'item')
        const { itemBalances } = summarizeInventory(candidate, demoBusinessDate)
        if (itemBalances.get(itemId) !== 0) {
          throw new DemoRepositoryError('ITEM_HAS_STOCK', 'The demo allows archival only when the item has zero stock.')
        }
        Object.assign(item, { is_active: false, updated_at: now() })
        return item
      })
    },
    createCategory(input) {
      return mutate((candidate) => {
        const metadata = categoryMetadata(candidate, input, null)
        const timestamp = now()
        const category = {
          ...metadata,
          category_id: createUniqueId(createId, candidate.categories, 'category_id'),
          is_active: true,
          created_at: timestamp,
          updated_at: timestamp,
        }
        candidate.categories.push(category)
        return category
      })
    },
    updateCategory(categoryId, input) {
      return mutate((candidate) => {
        const category = findActiveRecord(candidate.categories, 'category_id', categoryId, 'category')
        const metadata = categoryMetadata(candidate, input, category)
        Object.assign(category, metadata, { updated_at: now() })
        return category
      })
    },
    archiveCategory(categoryId) {
      return mutate((candidate) => {
        const category = findActiveRecord(candidate.categories, 'category_id', categoryId, 'category')
        if (candidate.inventory_items.some((item) => item.category_id === categoryId && item.is_active)) {
          throw new DemoRepositoryError('CATEGORY_IN_USE', 'The demo allows archival only when a category has no active items.')
        }
        Object.assign(category, { is_active: false, updated_at: now() })
        return category
      })
    },
  }
}
