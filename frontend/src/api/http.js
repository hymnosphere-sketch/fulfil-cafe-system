const DEFAULT_TIMEOUT_MS = 10_000
const MAX_TIMEOUT_MS = 120_000
const FALLBACK_RETRY_MS = 2_000
const MAX_RETRY_MS = 60_000

const messages = {
  invalid_command: 'The command failed local validation.',
  invalid_protocol: 'The server response does not match the API contract.',
  invalid_json: 'The server did not return valid JSON.',
  redirect: 'The server returned an unexpected redirect.',
  server_rejection: 'The server rejected the command.',
  operation_id_conflict: 'The server has a different command under this operation ID.',
  recovery_required: 'Verify the server generation before resuming synchronization.',
  access_denied: 'Server access must be restored before continuing.',
  temporary_failure: 'The server reported a temporary failure.',
  http_failure: 'The server returned an unexpected HTTP error.',
  network_failure: 'The request could not be completed over the network.',
  timeout: 'The request exceeded its time limit.',
  cancelled: 'The request was cancelled by the caller.',
}

export class ApiClientError extends Error {
  constructor(kind, {
    code = null,
    status = null,
    outcome = 'not_applicable',
    retry = 'none',
    retryAfterMs = null,
    generation = null,
    settingsVersion = null,
  } = {}) {
    super(messages[kind])
    this.name = 'ApiClientError'
    this.kind = kind
    this.code = code
    this.status = status
    this.outcome = outcome
    this.retry = retry
    this.retryAfterMs = retryAfterMs
    this.generation = generation
    this.settingsVersion = settingsVersion
  }
}

export function apiEndpoint(baseUrl) {
  const address = baseUrl instanceof URL ? baseUrl.href : baseUrl
  // Check the supplied path before URL can remove dot segments or empty query and fragment delimiters.
  if (typeof address !== 'string' || address.trim() !== address ||
      !/^https?:\/\/[^/?#@\\\s]+(?:\/(?:api\/v1\/?)?)?$/i.test(address)) {
    throw new TypeError('Configure an explicit API origin or /api/v1 URL.')
  }
  let url
  try {
    url = new URL(address)
  } catch {
    throw new TypeError('Configure an explicit API origin or /api/v1 URL.')
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (
    (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
    url.username || url.password || url.search || url.hash ||
    !['/', '/api/v1', '/api/v1/'].includes(url.pathname)
  ) {
    throw new TypeError('Configure an HTTPS API or an HTTP loopback API without credentials, query, or fragment.')
  }
  return new URL('/api/v1/', url)
}

export function retryAfterDelay(header, now) {
  const value = header?.trim()
  if (/^[0-9]+$/.test(value ?? '')) return Math.min(Number(value) * 1_000, MAX_RETRY_MS)

  // HTTP dates come from HTTP headers. Do not parse arbitrary date strings or numeric prefixes.
  if (/^[A-Za-z]{3}, [0-9]{2} [A-Za-z]{3} [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/.test(value ?? '')) {
    const time = Date.parse(value)
    if (Number.isFinite(time) && new Date(time).toUTCString() === value) {
      return Math.min(Math.max(time - now, 0), MAX_RETRY_MS)
    }
  }
  return FALLBACK_RETRY_MS
}

function readJson(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return { format: 'invalid_json' }
  }
  // JSON.parse verifies the grammar, but it rounds numbers and keeps the last
  // occurrence of duplicate keys. Check those two properties in the original text.
  const tokens = /"(?:[^"\\]|\\[\s\S])*"(?:[ \t\r\n]*:)?|[{}]|-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g
  const objectKeys = []
  for (const [token] of text.matchAll(tokens)) {
    if (token === '{') {
      objectKeys.push(new Set())
    } else if (token === '}') {
      objectKeys.pop()
    } else if (token.startsWith('"')) {
      if (!token.endsWith(':')) continue
      const key = JSON.parse(token.slice(0, -1))
      const keys = objectKeys.at(-1)
      if (keys.has(key)) return { format: 'invalid_protocol' }
      keys.add(key)
    } else if (!/^-?[0-9]+$/.test(token) || !Number.isSafeInteger(Number(token))) {
      return { format: 'invalid_protocol' }
    }
  }
  return { format: 'json', data }
}

async function readJsonResponse(response) {
  const bytes = await response.arrayBuffer()
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { format: 'invalid_json' }
  }
  return readJson(text)
}

function cancelUnreadBody(response) {
  const stream = response?.body
  if (!stream || stream.locked || response.bodyUsed) return
  // Start cleanup without waiting for an untrusted stream to settle.
  void stream.cancel().catch(() => {})
}

export function createJsonRequest({
  baseUrl,
  apiVersion = 1,
  fetch: transport = (...args) => globalThis.fetch(...args),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  setTimer = globalThis.setTimeout.bind(globalThis),
  clearTimer = globalThis.clearTimeout.bind(globalThis),
}) {
  // The v1 endpoint remains the default; v2 is an explicit, isolated opt-in.
  if (apiVersion !== 1 && apiVersion !== 2) throw new TypeError('Unsupported API version.')
  const endpoint = apiEndpoint(baseUrl)
  if (apiVersion === 2) endpoint.pathname = '/api/v2/'
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError('Request timeout must be 1–120,000 milliseconds.')
  }
  if ([transport, setTimer, clearTimer].some((fn) => typeof fn !== 'function')) {
    throw new TypeError('Configure callable transport and timer functions.')
  }

  return async function request(path, { body, generation, signal } = {}) {
    const mutation = body !== undefined
    if (signal?.aborted) {
      throw new ApiClientError('cancelled', { outcome: mutation ? 'not_sent' : 'not_applicable' })
    }

    const controller = new AbortController()
    let failDeadline
    let timer
    const deadline = new Promise((_, reject) => { failDeadline = reject })
    const interruption = (kind) => {
      // Once Fetch starts, even an abort cannot prove that the server did not commit.
      failDeadline(new ApiClientError(kind, {
        outcome: mutation ? 'unknown' : 'not_applicable',
        retry: mutation ? 'same_command' : 'none',
        retryAfterMs: mutation && kind === 'timeout' ? FALLBACK_RETRY_MS : null,
      }))
      controller.abort()
    }
    const onCancel = () => interruption('cancelled')
    signal?.addEventListener('abort', onCancel, { once: true })

    async function send() {
      const headers = new Headers({ Accept: 'application/json' })
      if (mutation) {
        headers.set('Content-Type', 'application/json')
        headers.set('X-Inventory-Generation', generation)
      }
      let response
      try {
        response = await transport(new URL(path, endpoint), {
          method: mutation ? 'POST' : 'GET',
          headers,
          body: mutation ? JSON.stringify(body) : undefined,
          signal: controller.signal,
          credentials: 'omit',
          redirect: 'manual',
        })
        controller.signal.throwIfAborted()
        const { status, type, redirected, headers: responseHeaders } = response
        if (redirected || type === 'opaqueredirect' || (status >= 300 && status < 400)) {
          return { status, format: 'redirect' }
        }
        const media = responseHeaders.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() ?? ''
        const json = media === 'application/json' || /^application\/[a-z0-9.+-]+\+json$/.test(media)
        return {
          status,
          headers: responseHeaders,
          ...(json ? await readJsonResponse(response) : { format: 'not_json' }),
        }
      } catch {
        throw new ApiClientError('network_failure', {
          outcome: mutation ? 'unknown' : 'not_applicable',
          retry: mutation ? 'same_command' : 'none',
          retryAfterMs: mutation ? FALLBACK_RETRY_MS : null,
        })
      } finally {
        cancelUnreadBody(response)
      }
    }

    try {
      timer = setTimer(() => interruption('timeout'), timeoutMs)
      return await Promise.race([deadline, send()])
    } finally {
      clearTimer(timer)
      signal?.removeEventListener('abort', onCancel)
    }
  }
}
