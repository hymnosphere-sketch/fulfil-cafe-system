export const DATABASE_VERSION = 1
export const DEMO_DATABASE_NAME = 'fulfil-cafe-demo-inventory'

export const INVENTORY_STORES = {
  categories: {
    keyPath: 'category_id',
    // The fictional catalog reserves names even after a category is archived.
    indexes: [['normalized_name', 'normalized_name', { unique: true }]],
  },
  inventory_items: {
    keyPath: 'item_id',
    indexes: [['normalized_name', 'normalized_name'], ['category_id', 'category_id']],
  },
  stock_batches: {
    keyPath: 'batch_id',
    indexes: [['item_id', 'item_id'], ['expiration_date', 'expiration_date']],
  },
  stock_movements: {
    keyPath: 'movement_id',
    indexes: [
      ['item_created_at', ['item_id', 'created_at']],
      ['type_created_at', ['movement_type', 'created_at']],
      ['created_at', 'created_at'],
    ],
  },
  batch_allocations: {
    keyPath: 'allocation_id',
    indexes: [
      ['movement_id', 'movement_id'],
      ['batch_id', 'batch_id'],
      ['movement_batch', ['movement_id', 'batch_id'], { unique: true }],
    ],
  },
  staff_users: { keyPath: 'user_id', indexes: [] },
  synchronization_queue: {
    keyPath: 'operation_id',
    indexes: [
      ['local_sequence', 'local_sequence', { unique: true }],
      ['status_local_sequence', ['status', 'local_sequence']],
    ],
  },
  application_settings: { keyPath: 'setting_key', indexes: [] },
}

export function upgradeInventorySchema(database, oldVersion) {
  if (oldVersion < 1) {
    for (const [storeName, { keyPath, indexes }] of Object.entries(INVENTORY_STORES)) {
      const store = database.createObjectStore(storeName, { keyPath })
      for (const [name, indexKeyPath, options] of indexes) {
        store.createIndex(name, indexKeyPath, options)
      }
    }
  }
}
