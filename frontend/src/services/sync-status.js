import { isWireTimestamp, sameWireUuid } from '../api/commands.js'

const numberFormat = new Intl.NumberFormat('en-PH')
const messages = {
  not_configured: ['Sync not configured', 'Inventory changes stay in this browser.', 'disabled', 'info'],
  loading: ['Reading sync status', 'Checking the saved synchronization queue.', 'info', 'refresh-cw'],
  ready: ['Ready to sync', 'There are no queued changes.', 'info', 'info'],
  synchronizing: ['Synchronizing', 'Checking for confirmation of queued changes.', 'info', 'refresh-cw'],
  synchronized: ['All changes synced', 'The server confirmed every queued change.', 'success', 'circle-check'],
  retry_delayed: ['Retry pending', 'Your changes are saved. You can retry when the delay ends.', 'warning', 'calendar-clock'],
  temporary_failure: ['Sync could not finish', 'Your changes are saved. Try synchronizing again when you are ready.', 'warning', 'triangle-alert'],
  needs_review: ['Sync needs review', 'Review the rejected change before later changes can synchronize.', 'error', 'circle-alert'],
  recovery_required: ['Recovery required', 'Synchronization is paused to protect your inventory records. Ask for help before retrying.', 'warning', 'triangle-alert'],
  unavailable: ['Sync status unavailable', 'The saved synchronization status could not be read. Try refreshing the status.', 'warning', 'triangle-alert'],
}

function verifiedReceipt(entry, queue) {
  const receipt = entry.acknowledgment
  return receipt?.replay_status === 'verified' &&
    ['accepted', 'already_processed'].includes(receipt.outcome) &&
    Number.isSafeInteger(receipt.commit_seq) && receipt.commit_seq > 0 &&
    Number.isSafeInteger(queue.settingsVersion) && queue.settingsVersion > 0 &&
    receipt.settings_version === queue.settingsVersion &&
    sameWireUuid(receipt.server_generation_id, queue.generation) &&
    sameWireUuid(receipt.operation_id, entry.command?.operation_id) &&
    isWireTimestamp(receipt.processed_at)
}

function readQueueStatus(queue) {
  if (!Array.isArray(queue?.operations)) return null
  const counts = { pending: 0, synchronized: 0, review: 0 }
  let lastConfirmed = null
  let head = null
  for (const entry of queue.operations) {
    if (entry?.status === 'synchronized' && verifiedReceipt(entry, queue)) {
      counts.synchronized++
      const confirmedAt = entry.acknowledgment.processed_at
      if (!lastConfirmed || Date.parse(confirmedAt) > Date.parse(lastConfirmed)) lastConfirmed = confirmedAt
    } else if (entry?.status === 'pending' || (entry?.status === 'failed' && entry.resolution_status === 'needs_review')) {
      if (entry.status === 'pending') counts.pending++
      else counts.review++
      head ??= entry
    } else {
      return null
    }
  }
  const retryAt = head?.retry_at
  return { counts, lastConfirmed, head,
    retryAt: Number.isSafeInteger(retryAt) && retryAt > 0 && Number.isFinite(new Date(retryAt).getTime()) ? retryAt : null }
}

function status(state, { counts = null, lastConfirmed = null, retryAt = null, now, message } = {}) {
  const [label, detail, tone, icon] = messages[state]
  return { state, label, message: message ?? detail, tone, icon, counts, lastConfirmed, retryAt,
    canRetry: retryAt !== null && retryAt <= now }
}

export function deriveSyncStatus({ configured = false, queue, loading = false, unavailable = false,
  active = false, result, now = Date.now() } = {}) {
  if (!configured) return status('not_configured')
  if (loading) return status('loading')
  const saved = unavailable ? null : readQueueStatus(queue)
  if (!saved) return status('unavailable')
  const { head, counts, retryAt } = saved
  const context = { ...saved, now }
  if (active) return status('synchronizing', context)
  if (head?.last_error?.kind === 'recovery_required' || result?.status === 'recovery_required') {
    return status('recovery_required', context)
  }
  if (counts.review > 0) return status('needs_review', context)
  if (result?.status === 'storage_failure') {
    return status('unavailable', { ...context, message: 'The confirmation could not be saved. Refresh before trying again.' })
  }
  if (result?.status === 'lock_unavailable' || result?.status === 'busy') {
    const message = result.status === 'busy'
      ? 'Another window is using synchronization. Try again when it has finished.'
      : 'Synchronization is unavailable in this browser. Your changes are still saved.'
    return status('unavailable', { ...context, message })
  }
  if (retryAt !== null && retryAt > now) return status('retry_delayed', context)
  if (head?.last_error) {
    const kind = head.last_error.kind
    if (kind === 'access_denied' || kind === 'invalid_protocol') {
      return status('unavailable', { ...context, message: kind === 'access_denied'
        ? 'Server access is unavailable. Ask for help before trying again.'
        : 'The server confirmation could not be verified. Your changes are still saved.' })
    }
    return status('temporary_failure', context)
  }
  if (counts.pending > 0) {
    const count = numberFormat.format(counts.pending)
    const singular = counts.pending === 1
    return { ...status('ready', context), state: 'pending', tone: 'warning', icon: 'clock',
      label: singular ? '1 change pending' : count + ' changes pending',
      message: singular ? '1 inventory change is waiting to synchronize.' : count + ' inventory changes are waiting to synchronize.' }
  }
  return status(counts.synchronized > 0 ? 'synchronized' : 'ready', context)
}

/** Publish only the newest explicitly requested storage read. */
export function createSyncStatusRefresh(read, publish) {
  let revision = 0
  return async function refresh(queueName) {
    const current = ++revision
    publish({ loading: true })
    let state
    try { state = { queue: await read(queueName) } } catch { state = { unavailable: true } }
    if (current === revision) publish(state)
  }
}
