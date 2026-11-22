// FE-09C: isolated read-only v2 client. No sync method, queue or app startup hook.
import { isWireUuid, sameWireUuid } from './commands.js'
import { ApiClientError, createJsonRequest, retryAfterDelay } from './http.js'
import { ApiProtocolError, validateHealth } from './responses.js'
import { validateV2Snapshot } from './v2-snapshot.js'

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function metadata(headers) {
  const generation = headers?.get('X-Inventory-Generation')
  const rawVersion = headers?.get('X-Inventory-Settings-Version')
  const version = /^[0-9]+$/.test(rawVersion ?? '') ? Number(rawVersion) : NaN
  return {
    generation: isWireUuid(generation) ? generation : null,
    settingsVersion: Number.isSafeInteger(version) && version > 0 ? version : null,
  }
}
function failure(packet, information, now) {
  const error = packet?.data?.error
  const valid = packet?.format === 'json' && object(packet.data) &&
    Object.keys(packet.data).length === 2 && packet.data.success === false &&
    object(error) && Object.keys(error).length === 3 &&
    typeof error.code === 'string' && typeof error.message === 'string' &&
    object(error.details)
  const code = valid ? error.code : 'INVALID_PROTOCOL_RESPONSE'
  let kind = 'http_failure'
  if (packet?.format === 'redirect') kind = 'redirect'
  else if (packet?.format === 'invalid_json') kind = 'invalid_json'
  else if (!valid) kind = 'invalid_protocol'
  else if (packet.status === 409 && code === 'RECOVERY_REQUIRED') kind = 'recovery_required'
  else if (packet.status === 503 && code === 'SYNC_FAILED') kind = 'temporary_failure'
  else if (packet.status === 400 && code === 'INVALID_REQUEST') kind = 'server_rejection'
  else if ((packet.status === 401 && code === 'UNAUTHORIZED') ||
           (packet.status === 403 && code === 'FORBIDDEN')) kind = 'access_denied'
  return new ApiClientError(kind, {
    ...information, code, status: packet?.status ?? null,
    outcome: 'not_applicable', retry: 'none',
    retryAfterMs: kind === 'temporary_failure'
      ? retryAfterDelay(packet.headers?.get('Retry-After'), now()) : null,
  })
}

/**
 * A read-only API v2 transport for explicit FE-09C test initialization.
 * Intentionally has no sync(), automatic polling, or runtime registration.
 */
export function createIsolatedV2Client({ now = Date.now, ...options } = {}) {
  if (typeof now !== 'function') throw new TypeError('Configure a callable clock.')
  const request = createJsonRequest({ ...options, apiVersion: 2 })
  // FE-09C is a local test-only path: never read an operational HTTPS host.
  const target = new URL(options.baseUrl instanceof URL ? options.baseUrl.href : options.baseUrl)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) {
    throw new TypeError('FE-09C requires a disposable loopback API endpoint.')
  }

  async function read(path, validate, signal) {
    const packet = await request(path, { signal })
    const info = metadata(packet.headers)
    if (packet.status !== 200 || packet.format !== 'json') throw failure(packet, info, now)
    try {
      if (!info.generation || !info.settingsVersion ||
          !object(packet.data) || Object.keys(packet.data).length !== 2 ||
          packet.data.success !== true || !Object.hasOwn(packet.data, 'data')) {
        throw new ApiProtocolError('v2.envelope')
      }
      const result = validate(packet.data.data, info)
      return { ...result, ...info }
    } catch (error) {
      if (!(error instanceof ApiProtocolError)) throw error
      throw new ApiClientError('invalid_protocol', {
        ...info, code: 'INVALID_PROTOCOL_RESPONSE',
        status: 200, outcome: 'not_applicable', retry: 'none',
      })
    }
  }

  return Object.freeze({
    health({ signal } = {}) {
      return read('health', (data) => ({ data: validateHealth(data) }), signal)
    },
    snapshot({ receiptIds = [], signal } = {}) {
      if (!Array.isArray(receiptIds) || receiptIds.length > 100 ||
          !receiptIds.every(isWireUuid)) {
        throw new ApiClientError('invalid_command', {
          code: 'INVALID_RECEIPT_IDS', outcome: 'not_sent',
        })
      }
      const query = new URLSearchParams()
      for (const id of receiptIds) query.append('receipt_id', id)
      const path = query.size ? `snapshot?${query}` : 'snapshot'
      return read(path, (data, info) => {
        const checked = validateV2Snapshot(data, receiptIds)
        if (!sameWireUuid(info.generation, data.server_generation_id) ||
            info.settingsVersion !== data.settings.settings_version) {
          throw new ApiProtocolError('snapshot.headers')
        }
        return checked
      }, signal)
    },
  })
}
