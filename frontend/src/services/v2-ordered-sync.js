import { ApiClientError, createIsolatedV2SyncClient } from '../api/client.js'
import { sameWireUuid } from '../api/commands.js'
import { createIsolatedV2Client } from '../api/v2-client.js'
import { isVerifiedStoredReceipt } from '../api/v2-stored-receipt.js'
import { FE09D_TEST_CONSENT, withIsolatedV2Queue } from '../db/v2-sync-queue.js'

const LOCK = 'fulfil-cafe-fe09d-ordered-sync'

function recovery(code) {
  return new ApiClientError('recovery_required', { code, outcome: 'paused', retry: 'pause' })
}

function validateDeliveryOrder({ operations, initialCommit = 0, generation, settingsVersion }) {
  let next = 0
  let lastCommit = initialCommit
  for (const entry of operations) {
    if (entry.status === 'synchronized' && entry.resolution_status === 'none') {
      const receipt = entry.acknowledgment
      if (entry !== operations[next] || !isVerifiedStoredReceipt(entry, { generation, settingsVersion }) ||
          receipt.commit_seq <= lastCommit) {
        throw new Error('Stored acknowledgments do not match queue order.')
      }
      lastCommit = receipt.commit_seq
      next++
    } else if (entry.acknowledgment !== null ||
               !((entry.status === 'pending' && entry.resolution_status === 'none') ||
                 (entry === operations[next] && entry.status === 'failed' && entry.resolution_status === 'needs_review'))) {
      throw new Error('The isolated queue has an invalid delivery state.')
    }
  }
  return { next, lastCommit }
}

async function drainQueue(queue, { client, reader, signal, now, progress }, finish) {
  const saved = await queue.read()
  const { generation, settingsVersion, operations, initialCommit } = saved
  const { next, lastCommit } = validateDeliveryOrder(saved)
  let commit = lastCommit
  let verified = false

  for (const entry of operations.slice(next)) {
    const operationId = entry.command.operation_id
    if (signal?.aborted) return finish('cancelled', { operationId })
    if (entry.status === 'failed') {
      return finish('blocked', { operationId, code: entry.last_error?.code })
    }
    if (entry.last_error?.kind === 'recovery_required') {
      return finish('recovery_required', { operationId, code: entry.last_error.code })
    }

    const attemptedAt = now()
    if (entry.retry_at > attemptedAt) return finish('retry_later', { operationId, retryAt: entry.retry_at })
    const last_attempt_at = new Date(attemptedAt).toISOString()
    let sending = false
    let reply
    try {
      if (!verified) {
        const current = await reader.snapshot({ signal })
        if (!sameWireUuid(current.generation, generation)) throw recovery('GENERATION_MISMATCH')
        if (current.settingsVersion !== settingsVersion) throw recovery('SETTINGS_VERSION_MISMATCH')
        if (!current.installable) throw recovery('PROVISIONAL_HISTORY')
        if (initialCommit !== undefined && (current.data.sync.last_commit_seq ?? 0) < lastCommit) {
          throw recovery('STALE_SERVER_HISTORY')
        }
        verified = true
      }
      if (signal?.aborted) return finish('cancelled', { operationId })
      sending = true
      reply = await client.sync(entry.command, { generation, settingsVersion, signal })
      if (reply.data.commit_seq <= commit) throw recovery('RECEIPT_ORDER_MISMATCH')
    } catch (error) {
      if (!(error instanceof ApiClientError)) throw error
      // A rejected server operation remains the head until supervised review.
      const rejected = sending && error.outcome === 'rejected'
      const code = error.kind === 'recovery_required' && error.generation &&
        !sameWireUuid(error.generation, generation) ? 'GENERATION_MISMATCH' : error.code
      const retryAt = error.retryAfterMs > 0 ? now() + error.retryAfterMs : null
      await queue.recordDelivery(entry, {
        status: rejected ? 'failed' : 'pending',
        resolution_status: rejected ? 'needs_review' : 'none',
        last_attempt_at,
        last_error: { kind: error.kind, code, outcome: sending ? error.outcome : 'not_sent' },
        retry_at: retryAt,
        retry_count: entry.retry_count + 1,
      })
      return finish(error.kind, { operationId, code, retryAt })
    }

    await queue.recordDelivery(entry, {
      status: 'synchronized', last_attempt_at, last_error: null, retry_at: null,
      acknowledgment: { ...reply.data, server_generation_id: reply.generation, settings_version: reply.settingsVersion },
    })
    // A confirmed receipt changes queue state only. Inventory was applied when the command was created.
    commit = reply.data.commit_seq
    progress.synchronized += 1
  }
  return finish('complete')
}

/** Explicit one-shot drain for a fictional queue. Web Locks are origin scoped across tabs. */
export async function drainIsolatedV2Queue({
  consent, databaseName, indexedDB, baseUrl, fetch, timeoutMs, now = Date.now, signal,
} = {}) {
  if (consent !== FE09D_TEST_CONSENT) throw new TypeError('FE-09D requires isolated test consent.')
  return drainOrderedV2Queue({
    baseUrl, fetch, timeoutMs, now, signal,
    withQueue: (work) => withIsolatedV2Queue({ consent, databaseName, indexedDB }, work),
  })
}

// Storage supplies the committed rows and saves delivery evidence in its own transaction.
export async function drainOrderedV2Queue({ withQueue, baseUrl, fetch, timeoutMs, now = Date.now, signal }) {
  const progress = { synchronized: 0 }
  const finish = (status, details) => ({ status, ...progress, ...details })
  if (signal?.aborted) return finish('cancelled')
  const locks = globalThis.navigator?.locks
  if (typeof locks?.request !== 'function') return finish('lock_unavailable')

  const client = createIsolatedV2SyncClient({ baseUrl, fetch, timeoutMs, now })
  const reader = createIsolatedV2Client({ baseUrl, fetch, timeoutMs, now })
  try {
    return await locks.request(LOCK, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
      if (!lock) return finish('busy')
      if (signal?.aborted) return finish('cancelled')
      try {
        return await withQueue((queue) =>
          drainQueue(queue, { client, reader, signal, now, progress }, finish))
      } catch (error) {
        return finish('storage_failure', { code: error.code ?? null })
      }
    })
  } catch {
    return finish('lock_unavailable')
  }
}
