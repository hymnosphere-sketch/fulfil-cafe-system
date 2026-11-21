import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { createInventoryApiClient } from '../src/api/client.js'
import { apiEndpoint, createJsonRequest } from '../src/api/http.js'

const baseUrl = 'http://127.0.0.1:5000'
const generation = 'a0000000-0000-4000-8000-000000000001'
const operationId = 'a0000000-0000-4000-8000-000000000002'
const categoryId = 'a0000000-0000-4000-8000-000000000003'
const timestamp = '2026-11-19T02:00:00Z'
const headers = {
  'Content-Type': 'application/json',
  'X-Inventory-Generation': generation,
  'X-Inventory-Settings-Version': '1',
}
const categoryName = 'Fictional cafe supplies'
const record = {
  wire_version: 1, fictional: false, upload_eligible: true,
  operation_id: operationId, operation_type: 'create_category', entity_id: categoryId,
  payload: { category_id: categoryId, name: categoryName, description: '\ufffd' },
  created_at: timestamp, local_sequence: 1,
}
const encoder = new TextEncoder()

function acknowledgementBytes(description) {
  return encoder.encode(JSON.stringify({
    success: true,
    data: {
      operation_id: operationId, outcome: 'accepted', processed_at: timestamp,
      result: {
        category_id: categoryId, name: categoryName, normalized_name: 'fictional cafe supplies',
        description, is_active: true, created_at: timestamp, updated_at: timestamp,
      },
    },
  }))
}

test('a valid replacement character and other UTF-8 sequences survive one-byte stream chunks', async () => {
  const description = '\ufffd Café 水 🌱'
  const response = new Response(new ReadableStream({
    start(controller) {
      for (const byte of acknowledgementBytes(description)) controller.enqueue(Uint8Array.of(byte))
      controller.close()
    },
  }), { headers })
  const api = createInventoryApiClient({ baseUrl, fetch: async () => response })
  const reply = await api.sync({ ...record, payload: { ...record.payload, description } }, { generation })
  assert.equal(reply.data.result.description, description)
})

test('an invalid lone byte cannot turn into an accepted replacement character', async () => {
  const valid = acknowledgementBytes('\ufffd')
  const offset = valid.indexOf(0xef)
  assert.notEqual(offset, -1)
  const malformed = Uint8Array.of(...valid.slice(0, offset), 0x80, ...valid.slice(offset + 3))
  let calls = 0
  const api = createInventoryApiClient({
    baseUrl,
    fetch() {
      calls++
      return new Response(malformed, { headers })
    },
  })
  await assert.rejects(api.sync(record, { generation }), {
    kind: 'invalid_json', outcome: 'unknown', retry: 'same_command',
  })
  assert.equal(calls, 1)
})

test('malformed UTF-8 and malformed JSON syntax fail without exposing body data', async () => {
  for (const encoded of [
    Uint8Array.of(...encoder.encode('{"secret":"'), 0xc0, 0xaf, ...encoder.encode('"}')),
    Uint8Array.of(...encoder.encode('{"secret":"'), 0xed, 0xa0, 0x80, ...encoder.encode('"}')),
    Uint8Array.of(...encoder.encode('{"secret":"'), 0xe2, 0x82),
    encoder.encode('{"secret":"valid UTF-8, missing JSON closing brace"'),
  ]) {
    const api = createInventoryApiClient({ baseUrl, fetch: () => new Response(encoded, { headers }) })
    await assert.rejects(api.sync(record, { generation }), (error) => {
      assert.equal(error.kind, 'invalid_json')
      assert.equal(error.outcome, 'unknown')
      assert.doesNotMatch(error.message + JSON.stringify(error), /secret|closing brace/)
      return true
    })
  }
})

test('byte decoding retains raw JSON number and nested duplicate-key checks', async () => {
  for (const text of [
    '{"values":[9007199254740991.1]}',
    '{"values":[{"key":1,"k\\u0065y":2}]}',
  ]) {
    const request = createJsonRequest({ baseUrl, fetch: () => new Response(encoder.encode(text), { headers }) })
    assert.equal((await request('health')).format, 'invalid_protocol')
  }
  const text = JSON.stringify({ values: ['"key": 9007199254740993', { key: -9007199254740991 }] })
  const request = createJsonRequest({ baseUrl, fetch: () => new Response(encoder.encode(text), { headers }) })
  assert.deepEqual((await request('health')).data, JSON.parse(text))
})

for (const [status, contentType, kind] of [
  [502, 'text/html', 'http_failure'],
  [307, 'application/json', 'redirect'],
]) {
  test(`a live unread ${status} response is cancelled without draining it or following redirects`, async () => {
    const requests = []
    let onClose
    const closed = new Promise((resolve) => { onClose = resolve })
    const server = createServer((request, response) => {
      requests.push(request.url)
      request.resume()
      if (request.url !== '/api/v1/sync') {
        response.end()
        return
      }
      response.once('close', onClose)
      response.writeHead(status, { 'Content-Type': contentType, Location: '/redirect-target' })
      response.write('incomplete body')
    })
    await once(server.listen(0, '127.0.0.1'), 'listening')
    try {
      const api = createInventoryApiClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 3_000 })
      await assert.rejects(api.sync(record, { generation }), { kind, status, outcome: 'unknown', retry: 'same_command' })
      await Promise.race([
        closed,
        once(AbortSignal.timeout(1_000), 'abort').then(() => assert.fail('The server still has an open body stream')),
      ])
      assert.deepEqual(requests, ['/api/v1/sync'])
    } finally {
      const serverClosed = once(server, 'close')
      server.close()
      server.closeAllConnections()
      await serverClosed
    }
  })
}

test('early response classification does not wait for an injected stream cancel promise', { timeout: 1_000 }, async () => {
  let cancelled = 0
  let cleared = 0
  const api = createInventoryApiClient({
    baseUrl,
    setTimer: () => 1,
    clearTimer: () => { cleared++ },
    fetch: () => new Response(new ReadableStream({
      cancel() {
        cancelled++
        return new Promise(() => {})
      },
    }), { status: 502, headers: { 'Content-Type': 'text/html' } }),
  })
  await assert.rejects(api.sync(record, { generation }), { kind: 'http_failure', outcome: 'unknown' })
  assert.equal(cancelled, 1)
  assert.equal(cleared, 1)
})

test('a response arriving after caller cancellation is discarded without reading its body', async () => {
  const transport = Promise.withResolvers()
  let discarded = 0
  let calls = 0
  const api = createInventoryApiClient({
    baseUrl,
    fetch() {
      calls++
      return transport.promise
    },
  })
  const controller = new AbortController()
  const pending = api.sync(record, { generation, signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, { kind: 'cancelled', outcome: 'unknown', retry: 'same_command' })
  transport.resolve(new Response(new ReadableStream({ cancel() { discarded++ } }), { headers }))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(discarded, 1)
  assert.equal(calls, 1)
})

test('endpoint validation rejects empty delimiters and normalized path aliases', () => {
  for (const value of [
    'https://example.test?', 'https://example.test/api/v1?#', 'https://example.test/api/v1#',
    'https://example.test/./api/v1', 'https://example.test/a/../api/v1',
    'https://example.test/a/%2e%2e/api/v1', 'https://example.test/api/v1/.',
    'https://example.test\\api\\v1', 'https://@example.test/api/v1',
  ]) assert.throws(() => apiEndpoint(value), TypeError, value)
  for (const value of ['https://example.test', 'https://example.test/', 'https://example.test/api/v1',
    new URL('https://example.test/api/v1/')]) {
    assert.equal(apiEndpoint(value).href, 'https://example.test/api/v1/')
  }
  assert.equal(apiEndpoint('http://[::1]:5173/api/v1/').href, 'http://[::1]:5173/api/v1/')
})
