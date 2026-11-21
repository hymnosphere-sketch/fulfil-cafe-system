import { adaptQueueCommand, isWireUuid, sameWireUuid } from './commands.js'
import { ApiClientError, createJsonRequest, retryAfterDelay } from './http.js'
import { ApiProtocolError, validateAcknowledgment, validateHealth, validateSnapshot } from './responses.js'

export { ApiClientError } from './http.js'

const GENERATION = 'X-Inventory-Generation'
const SETTINGS_VERSION = 'X-Inventory-Settings-Version'
const INVALID_PROTOCOL = 'INVALID_PROTOCOL_RESPONSE'
const serverRejections = new Map([
  [404, new Set(['ITEM_NOT_FOUND', 'CATEGORY_NOT_FOUND', 'BATCH_NOT_FOUND', 'MOVEMENT_NOT_FOUND'])],
  [409, new Set(['RESOURCE_CONFLICT', 'DUPLICATE_ITEM', 'DUPLICATE_CATEGORY', 'CATEGORY_IN_USE', 'ITEM_HAS_STOCK'])],
  [422, new Set(['VALIDATION_ERROR', 'INVALID_BATCH_ALLOCATION', 'INVALID_QUANTITY', 'INSUFFICIENT_STOCK'])],
])

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readMetadata(headers) {
  const generation = headers.get(GENERATION)
  const rawVersion = headers.get(SETTINGS_VERSION)
  const version = /^[0-9]+$/.test(rawVersion ?? '') ? Number(rawVersion) : NaN
  return {
    generation: isWireUuid(generation) ? generation : null,
    settingsVersion: Number.isSafeInteger(version) && version > 0 ? version : null,
  }
}

function isPreprocessingError(details, command) {
  const keys = Object.keys(details)
  if (keys.length === 0) return true
  if (keys.length !== 1) return false
  if (keys[0] === 'key') return typeof details.key === 'string'

  const { fields } = details
  return keys[0] === 'fields' && Array.isArray(fields) &&
    fields.length === Object.keys(command).length && new Set(fields).size === fields.length &&
    fields.every((field) => typeof field === 'string' && Object.hasOwn(command, field))
}

function classify(packet, metadata, command, expectedGeneration, now) {
  const { status, data, format, headers } = packet
  const retryDelay = () => retryAfterDelay(headers?.get('Retry-After'), now())
  const error = (kind, { code = null, outcome, retry, retryAfterMs = null } = {}) =>
    new ApiClientError(kind, {
      ...metadata,
      code,
      status,
      outcome: command ? (outcome ?? 'unknown') : 'not_applicable',
      retry: retry ?? (command ? 'same_command' : 'none'),
      retryAfterMs,
    })

  const uncertain = (kind, code) => error(kind, {
    code,
    retryAfterMs: command ? retryDelay() : null,
  })
  const incompatible = () => uncertain('invalid_protocol', INVALID_PROTOCOL)
  if (format === 'redirect') return uncertain('redirect')
  if (!Number.isInteger(status) || status < 100 || status > 599 || format === 'invalid_protocol') {
    return incompatible()
  }
  if (format === 'invalid_json') return uncertain('invalid_json')
  if (status >= 200 && status < 300) {
    return incompatible()
  }

  if (format !== 'json') return uncertain('http_failure')
  const reply = data?.error
  if (
    !isObject(data) || Object.keys(data).length !== 2 || data.success !== false ||
    !isObject(reply) || Object.keys(reply).length !== 3 ||
    typeof reply.code !== 'string' || typeof reply.message !== 'string' || !isObject(reply.details)
  ) {
    return incompatible()
  }

  const { code, details } = reply
  const recovery = status === 409 && code === 'RECOVERY_REQUIRED'
  const accessDenied = (status === 401 && code === 'UNAUTHORIZED') || (status === 403 && code === 'FORBIDDEN')
  const temporaryFailure = status === 503 && code === 'SYNC_FAILED'
  const serverFailure = status === 500 && code === 'SERVER_ERROR'
  const preProcessing = command && status === 400 && code === 'INVALID_REQUEST'
  const operationConflict = status === 409 && code === 'OPERATION_ID_CONFLICT'
  const businessRejection = command && (operationConflict || serverRejections.get(status)?.has(code))
  const hasOperationContext = Object.hasOwn(details, 'operation_id') || Object.hasOwn(details, 'outcome')

  if (recovery && !(command && hasOperationContext)) {
    return error('recovery_required', { code, outcome: 'paused', retry: 'pause' })
  }
  if (command && metadata.generation && !sameWireUuid(metadata.generation, expectedGeneration)) {
    return error('recovery_required', { code: 'RECOVERY_REQUIRED', retry: 'pause' })
  }
  if (command && hasOperationContext && (recovery || accessDenied || temporaryFailure || serverFailure)) {
    return incompatible()
  }
  if (accessDenied) {
    return error('access_denied', { code, outcome: 'paused', retry: 'pause' })
  }
  if (temporaryFailure) {
    return error('temporary_failure', { code, retryAfterMs: retryDelay() })
  }
  if (serverFailure) return uncertain('http_failure', code)

  if (preProcessing || businessRejection) {
    if (!metadata.generation || !metadata.settingsVersion) return incompatible()
    if (preProcessing && !isPreprocessingError(details, command)) return incompatible()
    if (businessRejection && (!sameWireUuid(details.operation_id, command.operation_id) ||
        details.outcome !== 'rejected')) return incompatible()
    if (operationConflict) {
      return error('operation_id_conflict', { code, outcome: 'rejected', retry: 'pause' })
    }
    return error('server_rejection', { code, outcome: 'rejected', retry: 'none' })
  }
  return uncertain('http_failure')
}

export function createInventoryApiClient({ now = Date.now, ...options } = {}) {
  if (typeof now !== 'function') throw new TypeError('Configure a callable clock.')
  const request = createJsonRequest(options)

  async function invoke(path, { command, generation, signal, validate }) {
    const packet = await request(path, { body: command, generation, signal })
    const metadata = packet.headers ? readMetadata(packet.headers) : {}
    if (packet.status !== 200 || packet.format !== 'json') {
      throw classify(packet, metadata, command, generation, now)
    }

    try {
      if (!metadata.generation || !metadata.settingsVersion) throw new ApiProtocolError('headers')
      if (command && !sameWireUuid(metadata.generation, generation)) {
        throw new ApiClientError('recovery_required', {
          ...metadata,
          code: 'RECOVERY_REQUIRED',
          status: 200,
          outcome: 'unknown',
          retry: 'pause',
        })
      }
      const envelope = packet.data
      if (!isObject(envelope) || Object.keys(envelope).length !== 2 || envelope.success !== true ||
          !Object.hasOwn(envelope, 'data')) throw new ApiProtocolError('envelope')
      return { ...validate(envelope.data, metadata), ...metadata }
    } catch (error) {
      if (!(error instanceof ApiProtocolError)) throw error
      throw classify(packet, metadata, command, generation, now)
    }
  }

  return Object.freeze({
    health({ signal } = {}) {
      return invoke('health', { signal, validate: (data) => ({ data: validateHealth(data) }) })
    },
    async snapshot({ receiptIds = [], signal } = {}) {
      if (!Array.isArray(receiptIds) || receiptIds.length > 100 || !Array.from(receiptIds).every(isWireUuid)) {
        throw new ApiClientError('invalid_command', { code: 'INVALID_RECEIPT_IDS', outcome: 'not_sent' })
      }
      const ids = [...receiptIds]
      const query = new URLSearchParams()
      for (const id of ids) query.append('receipt_id', id)
      const path = query.size > 0 ? `snapshot?${query}` : 'snapshot'
      return invoke(path, {
        signal,
        validate(data, metadata) {
          const { snapshot, installable, installationBlocker } = validateSnapshot(data, ids)
          if (!sameWireUuid(snapshot.server_generation_id, metadata.generation) ||
              snapshot.settings.settings_version !== metadata.settingsVersion) {
            throw new ApiProtocolError('snapshot.headers')
          }
          return { data: snapshot, installable, installationBlocker }
        },
      })
    },
    async sync(record, { generation, signal } = {}) {
      if (!isWireUuid(generation)) {
        throw new ApiClientError('invalid_command', { code: 'INVALID_GENERATION', outcome: 'not_sent' })
      }
      let command
      try {
        command = adaptQueueCommand(record)
      } catch {
        throw new ApiClientError('invalid_command', { code: 'INVALID_QUEUE_COMMAND', outcome: 'not_sent' })
      }
      return invoke('sync', {
        command,
        generation,
        signal,
        validate: (data) => ({ data: validateAcknowledgment(data, command) }),
      })
    },
  })
}
