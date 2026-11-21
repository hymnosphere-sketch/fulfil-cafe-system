import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { createLoopbackTestApiClient } from './api-v1-test-client.mjs'
import { connectBrowser } from './browser-cdp.mjs'

const python = process.argv[2] ?? process.env.FE09B_PYTHON ?? 'python'
const backendScript = fileURLToPath(new URL('./api-v1-python.py', import.meta.url))
const generationHeader = 'X-Inventory-Generation'
const settingsVersionHeader = 'X-Inventory-Settings-Version'
const eventTime = '2026-11-19T02:00:00Z'
let sequence = 0
let passed = 0

function command(client, operationType, entityId, payload, createdAt = eventTime) {
  return {
    operation_id: client.fixtureOperationId(),
    operation_type: operationType,
    entity_id: entityId,
    payload,
    created_at: createdAt,
    local_sequence: ++sequence,
  }
}

function category(client) {
  const categoryId = randomUUID()
  return command(client, 'create_category', categoryId, {
    category_id: categoryId, name: 'Integration category ' + categoryId,
  })
}

function item(client, categoryId, name, minimum = 0) {
  const itemId = randomUUID()
  return command(client, 'create_item', itemId, {
    item_id: itemId, category_id: categoryId, name, unit_of_measurement: 'piece',
    minimum_stock_level: minimum,
  })
}

function stock(client, itemId, batchId, type, quantity, movementId = randomUUID(), createdAt = eventTime) {
  return command(client, 'record_stock_movement', movementId, {
    item_id: itemId,
    movement_id: movementId,
    movement_type: type,
    quantity_change: quantity,
    allocations: [{ allocation_id: randomUUID(), batch_id: batchId, quantity_change: quantity }],
    ...(type === 'stock_in' ? { new_batches: [{ batch_id: batchId, received_quantity: quantity }] } : {}),
  }, createdAt)
}

async function check(label, run) {
  const result = await run()
  passed++
  console.log('PASS ' + label)
  return result
}

function expectedError(status, kind, code, outcome) {
  return { status, kind, code, outcome }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve('http://127.0.0.1:' + server.address().port)
    })
  })
}

async function close(server) {
  if (server.listening) await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}

async function exerciseBrowserCors(chromeEndpoint, baseUrl, generation, browserCategory) {
  const servePage = (_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end('<!doctype html><title>Disposable CORS probe</title>')
  }
  const approvedServer = createServer(servePage)
  const rejectedServer = createServer(servePage)
  let browser
  let context
  try {
    const approvedOrigin = await listen(approvedServer, 5173)
    const rejectedOrigin = await listen(rejectedServer, 0)
    browser = await connectBrowser(chromeEndpoint)
    context = await browser.context()
    const approvedPage = await context.page()
    await approvedPage.goto(approvedOrigin + '/')
    const evaluateRequests = async (base, command, expectedGeneration) => {
      const health = await fetch(base + 'health', { credentials: 'omit' })
      const write = await fetch(base + 'sync', {
        method: 'POST',
        credentials: 'omit',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json', 'X-Inventory-Generation': expectedGeneration },
        body: JSON.stringify(command),
      })
      return {
        health: health.status,
        write: write.status,
        generation: health.headers.get('X-Inventory-Generation'),
        settingsVersion: health.headers.get('X-Inventory-Settings-Version'),
        outcome: (await write.json()).data?.outcome,
      }
    }
    const response = await approvedPage.evaluate(
      '(' + evaluateRequests + ')(' + [baseUrl, browserCategory, generation]
        .map((argument) => JSON.stringify(argument)).join(',') + ')',
    )
    assert.deepEqual(response, {
      health: 200, write: 200, generation, settingsVersion: '1', outcome: 'accepted',
    })
    const deniedPage = await context.page()
    await deniedPage.goto(rejectedOrigin + '/')
    const denied = await deniedPage.evaluate(
      'fetch(' + JSON.stringify(baseUrl + 'health') + ', { credentials: "omit" }).then(() => false, () => true)',
    )
    assert.equal(denied, true)
  } finally {
    try {
      await context?.dispose()
    } finally {
      browser?.close()
      await Promise.all([close(approvedServer), close(rejectedServer)])
    }
  }
}

async function exerciseBackend(baseUrl) {
  const client = createLoopbackTestApiClient({ baseUrl, timeoutMs: 5000 })
  const health = await check('1. Health and generation metadata', async () => {
    const reply = await client.health()
    assert.equal(reply.data.status, 'ok')
    assert.match(reply.generation, /^[0-9a-f-]{36}$/i)
    assert.equal(reply.settingsVersion, 1)
    return reply
  })
  const options = { generation: health.generation }

  await check('2. Empty snapshot and null warning period', async () => {
    const reply = await client.snapshot()
    assert.equal(reply.generation, health.generation)
    assert.equal(reply.data.schema_version, 1)
    assert.equal(reply.data.settings.expiration_warning_days, null)
    for (const field of ['categories', 'inventory_items', 'stock_batches', 'stock_movements', 'batch_allocations']) {
      assert.deepEqual(reply.data[field], [])
    }
  })

  const createCategory = category(client)
  const createItem = item(client, createCategory.entity_id, 'Integration item', 15)
  await check('3. Create category', async () => {
    const { data } = await client.syncFixture(createCategory, options)
    assert.equal(data.outcome, 'accepted')
    assert.equal(data.result.category_id, createCategory.entity_id)
  })
  await check('4. Create piece item with minimum 15', async () => {
    const { data } = await client.syncFixture(createItem, options)
    assert.equal(data.outcome, 'accepted')
    assert.equal(data.result.item_id, createItem.entity_id)
    assert.equal(data.result.minimum_stock_level, 15)
    assert.equal(data.result.unit_of_measurement, 'piece')
  })
  const itemId = createItem.entity_id
  const batchId = randomUUID()
  const [usageId, receiveId] = [randomUUID(), randomUUID()].sort()
  const receive = stock(client, itemId, batchId, 'stock_in', 20, receiveId)
  const usage = stock(client, itemId, batchId, 'stock_out', -5, usageId)
  const receipt = await check('5. Receive 20 pieces', async () => {
    const reply = await client.syncFixture(receive, options)
    assert.equal(reply.data.outcome, 'accepted')
    assert.equal(reply.data.result.quantity_change, 20)
    return reply.data
  })
  await check('6. Use 5 pieces', async () => {
    const { data } = await client.syncFixture(usage, options)
    assert.equal(data.outcome, 'accepted')
    assert.equal(data.result.quantity_change, -5)
  })
  const snapshot = await check('7. Recorded item and batch balances are both 15', async () => {
    const reply = await client.snapshot()
    assert.equal(reply.data.inventory_items[0].available_quantity, 15)
    assert.equal(reply.data.stock_batches[0].remaining_quantity, 15)
    return reply
  })
  await check('8. Quantity at its minimum is low stock', () => {
    assert.equal(snapshot.data.inventory_items[0].stock_status, 'low_stock')
  })
  await check('9. Identical command retries without duplicate stock or other writes', async () => {
    const { data } = await client.syncFixture(receive, options)
    assert.deepEqual(data, { ...receipt, outcome: 'already_processed' })
    assert.deepEqual((await client.snapshot()).data, snapshot.data)
  })
  const overdraft = stock(client, itemId, batchId, 'stock_out', -16)
  await check('10. Insufficient stock rejection leaves the snapshot identical', async () => {
    await assert.rejects(client.syncFixture(overdraft, options),
      expectedError(422, 'server_rejection', 'INSUFFICIENT_STOCK', 'rejected'))
    assert.deepEqual((await client.snapshot()).data, snapshot.data)
  })
  await check('11. Changed content using the accepted ID conflicts', async () => {
    const changed = { ...receive, payload: { ...receive.payload, reason: 'Different integration event' } }
    await assert.rejects(client.syncFixture(changed, options),
      { ...expectedError(409, 'operation_id_conflict', 'OPERATION_ID_CONFLICT', 'rejected'), retry: 'pause' })
    assert.deepEqual((await client.snapshot()).data, snapshot.data)
  })
  await check('12. Different generation pauses requests even for an accepted retry', async () => {
    await assert.rejects(client.syncFixture(receive, { generation: randomUUID() }),
      expectedError(409, 'recovery_required', 'RECOVERY_REQUIRED', 'paused'))
    assert.deepEqual((await client.snapshot()).data, snapshot.data)
  })
  await check('13. Receipt checks distinguish accepted and missing operations', async () => {
    const receiptIds = [createCategory, createItem, receive, usage, overdraft].map(({ operation_id }) => operation_id)
    const { data } = await client.snapshot({ receiptIds })
    assert.deepEqual(data.receipt_checks.map(({ operation_id }) => operation_id), receiptIds)
    assert.deepEqual(data.receipt_checks.map(({ status }) => status),
      ['accepted', 'accepted', 'accepted', 'accepted', 'missing'])
    assert.equal(data.receipt_checks.at(-1).processed_at, null)
  })
  await check('14. Nonempty snapshot remains blocked for installation', () => {
    assert.equal(snapshot.installable, false)
    assert.ok(snapshot.installationBlocker)
  })

  // Prove the chronological list cannot substitute for commit order. Never build a ledger from it.
  assert.deepEqual(snapshot.data.stock_movements.map(({ quantity_change }) => quantity_change), [-5, 20])
  console.log('KNOWN BACKEND GAP: equal timestamps returned usage before the committed receipt.')
  const backwardItem = item(client, createCategory.entity_id, 'Backward-clock integration item')
  await client.syncFixture(backwardItem, options)
  const backwardBatch = randomUUID()
  const earlierReceipt = stock(client, backwardItem.entity_id, backwardBatch, 'stock_in', 20)
  const laterUsage = stock(client, backwardItem.entity_id, backwardBatch, 'stock_out', -5, randomUUID(), '2026-11-19T01:59:00Z')
  await client.syncFixture(earlierReceipt, options)
  await client.syncFixture(laterUsage, options)
  const { data: backwardSnapshot } = await client.snapshot()
  assert.deepEqual(backwardSnapshot.stock_movements.filter(({ item_id }) => item_id === backwardItem.entity_id)
    .map(({ quantity_change }) => quantity_change), [-5, 20])
  console.log('KNOWN BACKEND GAP: a backward event clock also returned usage before receipt.')

  const chromeEndpoint = process.env.FE09B_CHROME_URL
  if (chromeEndpoint) {
    await exerciseBrowserCors(chromeEndpoint, baseUrl, health.generation, category(client))
    console.log('PASS browser CORS from approved 127.0.0.1:5173, including a real sync preflight and response')
    console.log('PASS browser CORS blocked an unlisted loopback origin')
  } else {
    console.log('SKIP 2 browser CORS probes. Set FE09B_CHROME_URL to an isolated Chrome debugging endpoint.')
  }

  await check('15. Client rejects an unsafe derived snapshot balance', async () => {
    const hugeItem = item(client, createCategory.entity_id, 'Unsafe aggregate integration item')
    await client.syncFixture(hugeItem, options)
    await client.syncFixture(stock(client, hugeItem.entity_id, randomUUID(), 'stock_in', Number.MAX_SAFE_INTEGER), options)
    await client.syncFixture(stock(client, hugeItem.entity_id, randomUUID(), 'stock_in', 2), options)
    const raw = await fetch(baseUrl + 'snapshot', { credentials: 'omit', redirect: 'error' })
    assert.equal(raw.status, 200)
    assert.match(await raw.text(), /"available_quantity"\s*:\s*9007199254740993(?:[,}])/)
    console.log('KNOWN BACKEND GAP: safe receipts yielded an unsafe 9007199254740993 response balance.')
    await assert.rejects(client.snapshot(), { kind: 'invalid_protocol', code: 'INVALID_PROTOCOL_RESPONSE' })
  })
}

const child = spawn(python, ['-B', backendScript, '--serve'], { stdio: ['pipe', 'pipe', 'inherit'] })
const closed = once(child, 'close')
const readyOutput = createInterface({ input: child.stdout })
try {
  const baseUrl = await Promise.race([
    once(readyOutput, 'line', { signal: AbortSignal.timeout(15_000) }).then(([line]) => line),
    closed.then(([code]) => { throw new Error('Disposable backend exited before readiness with code ' + code + '.') }),
  ])
  assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:[1-9]\d*\/api\/v1\/$/)
  await exerciseBackend(baseUrl)
  console.log(passed + ' of 15 localhost integration checks passed.')
} finally {
  readyOutput.close()
  child.stdin.end()
  const cutoff = setTimeout(() => child.kill(), 5000)
  try {
    const [code] = await closed
    assert.equal(code, 0, 'disposable server exit')
  } finally {
    clearTimeout(cutoff)
  }
}
