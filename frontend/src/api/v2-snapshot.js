// FE-09C: strict read-only API v2 snapshot inspection.
// The existing schema-1 decoder remains unchanged and is reused for data integrity.
import { isWireTimestamp, isWireUuid, sameWireUuid } from './commands.js'
import { ApiProtocolError, validateSnapshot } from './responses.js'

const SNAPSHOT_V2 = [
  'schema_version', 'server_generation_id', 'receipt_checks', 'snapshot_at',
  'categories', 'inventory_items', 'stock_batches', 'stock_movements',
  'batch_allocations', 'settings', 'sync', 'backup', 'migration', 'replay',
]
const REPLAY = ['status', 'order', 'installation_blocked']
const MIGRATION = [
  'status', 'verified_receipt_count', 'verified_legacy_count', 'provisional_count',
  'unverified_receipt_count', 'unassociated_stock_receipt_count',
  'unassociated_movement_count', 'unverified_movement_count',
]
const MOVEMENT = [
  'movement_id', 'item_id', 'movement_type', 'quantity_change',
  'reason', 'recorded_by', 'created_at',
]
const CHECK = ['operation_id', 'status', 'processed_at', 'commit_seq', 'replay_status']
const SYNC = ['last_committed_operation_id', 'last_committed_at', 'last_commit_seq']

function fail(path) {
  throw new ApiProtocolError(path)
}
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function exact(value, keys, path) {
  if (!object(value) || Object.keys(value).length !== keys.length ||
      !keys.every((key) => Object.hasOwn(value, key))) fail(path)
}
function positive(n) {
  return Number.isSafeInteger(n) && n > 0
}
function count(n) {
  return Number.isSafeInteger(n) && n >= 0
}
function equalTime(a, b) {
  return isWireTimestamp(a) && isWireTimestamp(b) &&
    a.replace('.000Z', 'Z') === b.replace('.000Z', 'Z')
}
function checkReceiptRows(receipts, expected, authoritative, sync) {
  if (!Array.isArray(expected) || expected.length > 100 ||
      !expected.every(isWireUuid) || !Array.isArray(receipts) ||
      receipts.length !== expected.length) fail('snapshot.receipt_checks')
  const byId = new Map()
  const bySequence = new Map()
  for (let index = 0; index < receipts.length; index += 1) {
    const row = receipts[index]
    exact(row, CHECK, 'snapshot.receipt_checks')
    if (!sameWireUuid(row.operation_id, expected[index]) ||
        !['accepted', 'missing'].includes(row.status)) fail('snapshot.receipt_checks')
    const accepted = row.status === 'accepted'
    if (accepted) {
      if (!isWireTimestamp(row.processed_at) ||
          (authoritative
            ? (!positive(row.commit_seq) || row.replay_status !== 'verified' ||
               row.commit_seq > sync.last_commit_seq)
            : row.commit_seq !== null || row.replay_status !== 'provisional')) {
        fail('snapshot.receipt_checks.accepted')
      }
      if (authoritative) {
        const previousId = bySequence.get(row.commit_seq)
        if (previousId && previousId !== row.operation_id.toLowerCase()) {
          fail('snapshot.receipt_checks.commit_seq')
        }
        bySequence.set(row.commit_seq, row.operation_id.toLowerCase())
      }
    } else if (row.processed_at !== null || row.commit_seq !== null ||
               row.replay_status !== null) {
      fail('snapshot.receipt_checks.missing')
    }
    const key = row.operation_id.toLowerCase()
    const previous = byId.get(key)
    if (previous && (previous.status !== row.status ||
        previous.commit_seq !== row.commit_seq ||
        (accepted && !equalTime(previous.processed_at, row.processed_at)))) {
      fail('snapshot.receipt_checks.duplicate')
    }
    byId.set(key, row)
    if (accepted && authoritative &&
        sameWireUuid(row.operation_id, sync.last_committed_operation_id) &&
        (row.commit_seq !== sync.last_commit_seq ||
         !equalTime(row.processed_at, sync.last_committed_at))) {
      fail('snapshot.receipt_checks.last_commit')
    }
  }
}
function v1Projection(data, authoritative) {
  // Do not mutate or reinterpret the v1 parser or the server response.
  const { migration, replay, ...common } = data
  return {
    ...common,
    schema_version: 1,
    sync: {
      last_committed_operation_id: common.sync.last_committed_operation_id,
      last_committed_at: common.sync.last_committed_at,
    },
    receipt_checks: authoritative
      ? common.receipt_checks.map(({ operation_id, status, processed_at }) =>
          ({ operation_id, status, processed_at }))
      : [], // Provisional last markers are null; v2 checks are verified separately.
    stock_movements: common.stock_movements.map(
      ({ commit_seq, replay_status, ...movement }) => movement,
    ),
  }
}

function verifyStockChronology(data) {
  // The server supplies an authoritative commit order. The client also checks
  // each inventory prefix before accepting that order for isolated storage.
  const batches = new Map(data.stock_batches.map((row) => [row.batch_id.toLowerCase(), row]))
  const allocations = new Map()
  for (const row of data.batch_allocations) {
    const key = row.movement_id.toLowerCase()
    if (!allocations.has(key)) allocations.set(key, [])
    allocations.get(key).push(row)
  }
  const introduced = new Set()
  const batchTotals = new Map()
  const itemTotals = new Map()
  const safe = BigInt(Number.MAX_SAFE_INTEGER)
  for (const movement of data.stock_movements) {
    const kind = movement.movement_type
    const positive = kind === 'stock_in' || kind === 'initial_stock' ||
      kind === 'positive_adjustment'
    const itemId = movement.item_id.toLowerCase()
    for (const allocation of allocations.get(movement.movement_id.toLowerCase()) ?? []) {
      const bid = allocation.batch_id.toLowerCase()
      const batch = batches.get(bid)
      if (!batch) fail('snapshot.stock_batches')
      if (!introduced.has(bid)) {
        if (!positive || allocation.quantity_change !== batch.received_quantity ||
            !equalTime(movement.created_at, batch.created_at)) {
          fail('snapshot.stock_batches.introduction_order')
        }
        introduced.add(bid)
        batchTotals.set(bid, 0n)
      } else if (kind === 'initial_stock' || kind === 'stock_in') {
        // A receipt movement may never introduce the same batch twice.
        fail('snapshot.stock_batches.duplicate_introduction')
      }
      const next = batchTotals.get(bid) + BigInt(allocation.quantity_change)
      if (next < 0n || next > safe) fail('snapshot.stock_batches.historical_balance')
      batchTotals.set(bid, next)
    }
    const nextItem = (itemTotals.get(itemId) ?? 0n) + BigInt(movement.quantity_change)
    if (nextItem < 0n || nextItem > safe) fail('snapshot.inventory_items.historical_balance')
    itemTotals.set(itemId, nextItem)
  }
  for (const batch of data.stock_batches) {
    if (batchTotals.get(batch.batch_id.toLowerCase()) !== BigInt(batch.remaining_quantity)) {
      fail('snapshot.stock_batches.final_balance')
    }
  }
  for (const item of data.inventory_items) {
    if ((itemTotals.get(item.item_id.toLowerCase()) ?? 0n) !== BigInt(item.available_quantity)) {
      fail('snapshot.inventory_items.final_balance')
    }
  }
}

/**
 * Inspect a v2 snapshot without changing existing FE-09B v1 parsing.
 * Returns installable=true ONLY for fully authoritative, coherent evidence.
 * Installation itself is handled by the isolated FE-09C database module.
 */
export function validateV2Snapshot(data, requestedReceiptIds = []) {
  exact(data, SNAPSHOT_V2, 'snapshot')
  if (data.schema_version !== 2) fail('snapshot.schema_version')
  exact(data.replay, REPLAY, 'snapshot.replay')
  exact(data.migration, MIGRATION, 'snapshot.migration')
  exact(data.sync, SYNC, 'snapshot.sync')
  const authoritative = data.replay.status === 'authoritative'
  const provisional = data.replay.status === 'provisional'
  if (!authoritative && !provisional) fail('snapshot.replay.status')
  if (authoritative
    ? (data.replay.order !== 'commit_seq' || data.replay.installation_blocked !== false ||
       data.migration.status !== 'verified')
    : (data.replay.order !== null || data.replay.installation_blocked !== true ||
       data.migration.status !== 'provisional')) fail('snapshot.replay')
  if (MIGRATION.slice(1).some((key) => !count(data.migration[key]))) {
    fail('snapshot.migration')
  }
  const last = data.sync.last_commit_seq
  if (authoritative) {
    if (last !== null && !positive(last)) fail('snapshot.sync.last_commit_seq')
    if (data.migration.verified_receipt_count !== (last ?? 0) ||
        data.migration.verified_legacy_count !== 0 ||
        data.migration.provisional_count !== 0 ||
        data.migration.unverified_receipt_count !== 0 ||
        data.migration.unassociated_stock_receipt_count !== 0 ||
        data.migration.unassociated_movement_count !== 0 ||
        data.migration.unverified_movement_count !== 0) fail('snapshot.migration')
    if (last === null) {
      if (data.sync.last_committed_operation_id !== null ||
          data.sync.last_committed_at !== null ||
          ['categories', 'inventory_items', 'stock_batches', 'stock_movements',
            'batch_allocations'].some((field) => !Array.isArray(data[field]) ||
              data[field].length !== 0)) fail('snapshot.sync.empty')
    } else if (!isWireUuid(data.sync.last_committed_operation_id) ||
               !isWireTimestamp(data.sync.last_committed_at)) {
      fail('snapshot.sync')
    }
  } else if (last !== null || data.sync.last_committed_operation_id !== null ||
             data.sync.last_committed_at !== null ||
             data.migration.verified_receipt_count !== 0 ||
             data.migration.verified_legacy_count !== 0 ||
             data.migration.unverified_receipt_count !== 0) {
    fail('snapshot.sync.provisional')
  }

  checkReceiptRows(data.receipt_checks, requestedReceiptIds, authoritative, data.sync)
  if (!Array.isArray(data.stock_movements)) fail('snapshot.stock_movements')
  let previousSequence = 0
  for (const row of data.stock_movements) {
    exact(row, [...MOVEMENT, 'commit_seq', 'replay_status'], 'snapshot.stock_movements')
    if (authoritative) {
      if (!positive(row.commit_seq) || row.commit_seq <= previousSequence ||
          row.commit_seq > last || row.replay_status !== 'verified') {
        fail('snapshot.stock_movements.commit_seq')
      }
      previousSequence = row.commit_seq
    } else if (row.commit_seq !== null || row.replay_status !== 'provisional') {
      fail('snapshot.stock_movements.provisional')
    }
  }
  if (authoritative && data.migration.unverified_movement_count !== 0) {
    fail('snapshot.migration.unverified_movement_count')
  }
  if (provisional && data.migration.unverified_movement_count !== data.stock_movements.length) {
    fail('snapshot.migration.unverified_movement_count')
  }

  // The v1 checker provides strict catalog, quantity, batch, allocation and
  // derived-balance validation, even when v2's provisional order is withheld.
  validateSnapshot(v1Projection(data, authoritative),
    authoritative ? requestedReceiptIds : [])
  if (authoritative) verifyStockChronology(data)
  return {
    data,
    installable: authoritative,
    installationBlocker: authoritative ? null : 'provisional_history',
  }
}
