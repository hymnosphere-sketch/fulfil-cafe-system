// Fictional shared FE-09C v2 fixtures. Never upload to an operational café.
export const fixtureId = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
export const lastOperationId = fixtureId(90)
const t = '2026-11-18T02:00:00Z'
const receipt = '2026-11-18T03:05:00Z'

export function makeVerifiedV2Snapshot() {
  const category = fixtureId(1)
  const item = fixtureId(2)
  const batch = fixtureId(3)
  const incoming = fixtureId(4)
  const outgoing = fixtureId(5)
  return {
    schema_version: 2,
    server_generation_id: fixtureId(99),
    receipt_checks: [],
    snapshot_at: '2026-11-18T05:00:00Z',
    categories: [{
      category_id: category, name: 'Ingredients', normalized_name: 'ingredients',
      description: null, is_active: true, created_at: t, updated_at: t,
    }],
    inventory_items: [{
      item_id: item, category_id: category, name: 'Cups', normalized_name: 'cups',
      unit_of_measurement: 'piece', minimum_stock_level: 5, is_active: true,
      created_at: t, updated_at: t, available_quantity: 15, stock_status: 'sufficient',
    }],
    stock_batches: [{
      batch_id: batch, item_id: item, received_quantity: 20, purchase_date: null,
      purchase_cost: null, expiration_date: null,
      created_at: '2026-11-18T03:00:00Z', remaining_quantity: 15,
    }],
    stock_movements: [{
      movement_id: incoming, item_id: item, movement_type: 'stock_in',
      quantity_change: 20, reason: 'Delivery', recorded_by: null,
      created_at: '2026-11-18T03:00:00Z',
      commit_seq: 3, replay_status: 'verified',
    }, {
      movement_id: outgoing, item_id: item, movement_type: 'stock_out',
      quantity_change: -5, reason: 'Usage', recorded_by: null,
      created_at: '2026-11-18T01:00:00Z', // Backward timestamp: original commit sequence wins.
      commit_seq: 4, replay_status: 'verified',
    }],
    batch_allocations: [{
      allocation_id: fixtureId(6), movement_id: incoming, batch_id: batch,
      quantity_change: 20,
    }, {
      allocation_id: fixtureId(7), movement_id: outgoing, batch_id: batch,
      quantity_change: -5,
    }],
    settings: {
      settings_version: 1, business_timezone: 'Asia/Manila',
      expiration_warning_days: null,
    },
    sync: {
      last_committed_operation_id: lastOperationId,
      last_committed_at: receipt, last_commit_seq: 4,
    },
    backup: { last_successful_backup_at: null },
    migration: {
      status: 'verified', verified_receipt_count: 4, verified_legacy_count: 0,
      provisional_count: 0, unverified_receipt_count: 0,
      unassociated_stock_receipt_count: 0, unassociated_movement_count: 0,
      unverified_movement_count: 0,
    },
    replay: {
      status: 'authoritative', order: 'commit_seq', installation_blocked: false,
    },
  }
}
export function makeEmptyVerifiedV2Snapshot() {
  const snapshot = makeVerifiedV2Snapshot()
  for (const field of ['categories', 'inventory_items', 'stock_batches',
    'stock_movements', 'batch_allocations']) snapshot[field] = []
  snapshot.sync = {
    last_committed_operation_id: null, last_committed_at: null, last_commit_seq: null,
  }
  snapshot.migration.verified_receipt_count = 0
  return snapshot
}

export const extendedBalances = [
  { sequence: 3, item: 20, batches: [20] },
  { sequence: 4, item: 15, batches: [15] },
  { sequence: 5, item: 15, batches: [15] },
  { sequence: 6, item: 23, batches: [15, 8] },
  { sequence: 7, item: 13, batches: [9, 4] },
]

// Sequence 5 represents a catalog update. The adjustment introduces a second batch.
export function makeExtendedVerifiedV2Snapshot(through = 7) {
  const snapshot = makeVerifiedV2Snapshot()
  const [item] = snapshot.inventory_items
  const [batch] = snapshot.stock_batches
  const newBatch = fixtureId(20)
  const adjustment = fixtureId(21)
  const withdrawal = fixtureId(22)
  const created_at = '2026-11-18T03:10:00Z'
  snapshot.stock_batches.push({ ...batch, batch_id: newBatch, received_quantity: 8, created_at })
  snapshot.stock_movements.push(
    { ...snapshot.stock_movements[0], movement_id: adjustment, created_at,
      movement_type: 'positive_adjustment', reason: 'Recount', quantity_change: 8, commit_seq: 6 },
    { ...snapshot.stock_movements[1], movement_id: withdrawal, quantity_change: -10, commit_seq: 7 },
  )
  snapshot.batch_allocations.push(
    { allocation_id: fixtureId(23), movement_id: adjustment, batch_id: newBatch, quantity_change: 8 },
    { allocation_id: fixtureId(24), movement_id: withdrawal, batch_id: batch.batch_id, quantity_change: -6 },
    { allocation_id: fixtureId(25), movement_id: withdrawal, batch_id: newBatch, quantity_change: -4 },
  )
  const expected = extendedBalances.find(({ sequence }) => sequence === through)
  if (!expected) throw new RangeError('Choose a stock commit in the extended fixture.')
  snapshot.stock_movements = snapshot.stock_movements.filter(({ commit_seq }) => commit_seq <= through)
  const movementIds = new Set(snapshot.stock_movements.map(({ movement_id }) => movement_id))
  snapshot.batch_allocations = snapshot.batch_allocations.filter(({ movement_id }) => movementIds.has(movement_id))
  snapshot.stock_batches = snapshot.stock_batches.slice(0, expected.batches.length)
  snapshot.stock_batches.forEach((row, index) => { row.remaining_quantity = expected.batches[index] })
  item.available_quantity = expected.item
  if (through >= 5) {
    snapshot.categories[0].name = 'Fictional ingredients'
    snapshot.categories[0].normalized_name = 'fictional ingredients'
  }
  snapshot.sync.last_commit_seq = snapshot.migration.verified_receipt_count = through
  if (through !== 4) snapshot.sync.last_committed_operation_id = fixtureId(100 + through)
  return snapshot
}
export function makeProvisionalV2Snapshot() {
  const snapshot = makeVerifiedV2Snapshot()
  snapshot.replay = { status: 'provisional', order: null, installation_blocked: true }
  snapshot.sync = {
    last_committed_operation_id: null, last_committed_at: null, last_commit_seq: null,
  }
  snapshot.migration = {
    ...snapshot.migration,
    status: 'provisional', verified_receipt_count: 0, provisional_count: 4,
    unverified_movement_count: 2,
  }
  snapshot.stock_movements.forEach((row) => {
    row.commit_seq = null
    row.replay_status = 'provisional'
  })
  return snapshot
}
export function checkedReceipt(snapshot, id = lastOperationId) {
  const verified = snapshot.replay.status === 'authoritative'
  snapshot.receipt_checks = [{
    operation_id: id, status: 'accepted', processed_at: receipt,
    commit_seq: verified ? 4 : null,
    replay_status: verified ? 'verified' : 'provisional',
  }]
  return snapshot
}
