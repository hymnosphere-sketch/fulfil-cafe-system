// Launch against an isolated Vite origin and a disposable export of backend-dev.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { connectBrowser } from './browser-cdp.mjs'
import { queueCommands } from './fixtures/api-v2-queue.mjs'

const app = new URL(process.env.FE09D_APP_URL ?? 'http://127.0.0.1:5173/')
const chromeBin = process.env.FE09D_CHROME_BIN
const backendRoot = process.env.FE09D_BACKEND_ROOT
assert.equal(app.hostname, '127.0.0.1', 'Use a disposable loopback Vite origin')
assert.ok(chromeBin && backendRoot, 'Set FE09D_CHROME_BIN and FE09D_BACKEND_ROOT')
const temporary = await mkdtemp(join(tmpdir(), 'fulfil-fe09d-fixtures-'))
const { ordered, category, item, incoming, outgoing } = queueCommands()

async function startFlask() {
  const path = fileURLToPath(new URL('fe09d-flask.py', import.meta.url))
  const child = spawn(process.env.FE09D_PYTHON ?? 'python', ['-u', path, backendRoot, temporary, app.origin], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  const lines = createInterface({ input: child.stdout })
  const exited = once(child, 'exit')
  try {
    const line = await Promise.race([once(lines, 'line'), exited.then(() => { throw new Error('Flask did not start') })])
    async function stop() {
      child.stdin.end()
      const [code] = await exited
      assert.equal(code, 0)
    }
    return { urls: JSON.parse(line[0]), stop }
  } catch (error) {
    child.kill()
    throw error
  }
}

async function startChrome(profile) {
  await rm(join(profile, 'DevToolsActivePort'), { force: true })
  const child = spawn(chromeBin, [
    '--headless=new', '--disable-gpu', '--disable-background-networking', '--disable-extensions',
    '--no-first-run', '--enable-automation', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })
  await once(child, 'spawn')
  let endpoint
  let connection
  try {
    for (let attempt = 0; attempt < 140 && !connection; attempt++) {
      try {
        const port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0]
        endpoint = 'http://127.0.0.1:' + port
        if (child.exitCode === null) connection = await connectBrowser(endpoint)
      } catch { await delay(100) }
    }
    assert.ok(connection, 'Fresh Chrome exposes its loopback debugging socket')
    const { arguments: switches } = await connection.commandLine()
    assert.ok(switches.includes('--user-data-dir=' + profile))
    const context = await connection.context({ persistent: true })
    return {
      pid: child.pid, context,
      async stop() {
        await context.dispose()
        connection.close()
        const { webSocketDebuggerUrl } = await (await fetch(endpoint + '/json/version')).json()
        const socket = new WebSocket(webSocketDebuggerUrl)
        await once(socket, 'open')
        const exited = once(child, 'exit')
        socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
        const [code] = await exited
        socket.close()
        assert.equal(code, 0, 'Chrome exited gracefully and flushed IndexedDB')
      },
    }
  } catch (error) {
    connection?.close()
    child.kill()
    throw error
  }
}

const flask = await startFlask()
const profile = join(temporary, 'chrome')
await mkdir(profile)
let chrome
let page

function run(tab, body, ...args) {
  return tab.evaluate('(' + async function (source, urls, args) {
    const { FE09D_TEST_CONSENT, prepareIsolatedV2Queue, readIsolatedV2Queue } = await import('/src/db/v2-sync-queue.js')
    const { drainIsolatedV2Queue } = await import('/src/services/v2-ordered-sync.js')
    const { createIsolatedV2Client } = await import('/src/api/v2-client.js')
    const { INVENTORY_STORES, DEMO_DATABASE_NAME } = await import('/src/db/schema.js')
    const { openDatabase, runTransaction, requestResult, closeInventoryDatabase } = await import('/src/db/database.js')
    const seed = async (label, commands, override = {}) => {
      const baseUrl = urls[label]
      const { generation, settingsVersion } = await createIsolatedV2Client({ baseUrl }).snapshot()
      const config = { consent: FE09D_TEST_CONSENT, databaseName: 'fulfil-cafe-fe09d-queue-' + crypto.randomUUID(), baseUrl }
      await prepareIsolatedV2Queue({ ...config, generation, settingsVersion, commands, ...override })
      return config
    }
    const snapshot = (baseUrl, receiptIds = []) => createIsolatedV2Client({ baseUrl }).snapshot({ receiptIds })
    const read = async (config) => (await readIsolatedV2Queue(config)).operations
    const demo = async () => {
      const db = await openDatabase({ name: DEMO_DATABASE_NAME, version: 1 })
      try {
        const stores = Object.keys(INVENTORY_STORES)
        return await runTransaction(db, stores, 'readonly', (tx) =>
          Promise.all(stores.map((name) => requestResult(tx.objectStore(name).getAll()))))
      } finally { closeInventoryDatabase(db) }
    }
    return (0, eval)('(' + source + ')')({
      urls, seed, read, demo, snapshot, drain: drainIsolatedV2Queue, prepare: prepareIsolatedV2Queue,
    }, ...args)
  } + ')(' + [body.toString(), flask.urls, args].map((value) => JSON.stringify(value)).join(',') + ')')
}

try {
  chrome = await startChrome(profile)
  page = await chrome.context.page()
  await page.goto(app.href)
  await page.until('!!document.querySelector("[data-storage-state=ready]")', 'demo storage ready')
  await page.click('[data-route="categories"]')
  await page.click('[data-inventory-action="add-category"]')
  await page.setField('[data-inventory-form] [name="name"]', 'FE-09D isolation fixture')
  await page.click('[data-inventory-form] [type="submit"]')
  await page.until('document.querySelector("[data-inventory-results]")?.textContent.includes("FE-09D isolation fixture")', 'fictional demo entry')
  const baseline = await run(page, ({ demo }) => demo())
  assert.ok(baseline.some((rows) => rows.some((row) => row.status === 'pending' && row.upload_eligible === false)))

  await test('a single real command persists a verified receipt and reseeding cannot replace the queue', async () => {
    const result = await run(page, async ({ seed, drain, read, prepare, snapshot }, command) => {
      const config = await seed('single', [command])
      const drained = await drain(config)
      const entries = await read(config)
      const { generation, settingsVersion, data } = await snapshot(config.baseUrl, [command.operation_id])
      let reseeded
      try { await prepare({ ...config, generation, settingsVersion, commands: [] }); reseeded = true }
      catch { reseeded = false }
      return { drained, entries, check: data.receipt_checks[0], reseeded, after: await read(config) }
    }, category)
    assert.deepEqual(result.drained, { status: 'complete', synchronized: 1 })
    assert.equal(result.entries[0].acknowledgment.outcome, 'accepted')
    assert.equal(result.entries[0].acknowledgment.replay_status, 'verified')
    assert.equal(result.check.status, 'accepted')
    assert.equal(result.reseeded, false)
    assert.deepEqual(result.entries, result.after)
  })

  await test('ordered Flask delivery awaits durable acknowledgment and stock effects occur once', async () => {
    const result = await run(page, async ({ seed, drain, read, snapshot }, commands) => {
      const config = await seed('ordered', commands.toReversed())
      const sent = []
      const previousReceipts = []
      let inFlight = 0
      let maximum = 0
      const out = await drain({ ...config, fetch: async (url, request) => {
        if (request.method !== 'POST') return fetch(url, request)
        inFlight++
        maximum = Math.max(inFlight, maximum)
        previousReceipts.push((await read(config)).filter((entry) => entry.status === 'synchronized').length)
        sent.push(JSON.parse(request.body))
        try { return await fetch(url, request) } finally { inFlight-- }
      } })
      const entries = await read(config)
      const { data } = await snapshot(config.baseUrl, commands.map(({ operation_id }) => operation_id))
      return { out, sent, previousReceipts, maximum, entries, data }
    }, ordered)
    assert.deepEqual(result.out, { status: 'complete', synchronized: 4 })
    assert.deepEqual(result.sent, ordered)
    assert.deepEqual(result.previousReceipts, [0, 1, 2, 3])
    assert.equal(result.maximum, 1)
    assert.deepEqual(result.entries.map(({ command }) => command), ordered)
    assert.deepEqual(result.entries.map(({ acknowledgment }) => acknowledgment.commit_seq), [1, 2, 3, 4])
    assert.deepEqual(result.data.receipt_checks.map(({ status }) => status), Array(4).fill('accepted'))
    assert.deepEqual(result.data.stock_movements.map(({ quantity_change }) => quantity_change), [20, -5])
    assert.equal(result.data.inventory_items[0].available_quantity, 15)
    assert.equal(result.data.stock_batches[0].remaining_quantity, 15)
  })

  await test('a second tab cannot deliver while an owner holds the lock and unavailable locks fail closed', async () => {
    const alternate = await chrome.context.page()
    try {
      await alternate.goto(app.href)
      const config = await run(page, async ({ seed, drain }, command) => {
        const config = await seed('owners', [command])
        const gate = Promise.withResolvers()
        window.releaseDelivery = gate.resolve
        window.ownerTask = drain({ ...config, fetch: async (url, request) => {
          if (request.method === 'POST') {
            window.ownerWaiting = true
            await gate.promise
          }
          return fetch(url, request)
        } })
        return config
      }, category)
      try {
        await page.until('window.ownerWaiting === true', 'owner paused in first POST')
        const contender = await run(alternate, async ({ drain }, cfg) => {
          let calls = 0
          const fetch = () => { calls++ }
          const result = await drain({ ...cfg, fetch })
          const own = Object.getOwnPropertyDescriptor(navigator, 'locks')
          Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined })
          try { return { result, unavailable: await drain({ ...cfg, fetch }), calls } }
          finally { if (own) Object.defineProperty(navigator, 'locks', own); else delete navigator.locks }
        }, config)
        assert.deepEqual(contender, {
          result: { status: 'busy', synchronized: 0 },
          unavailable: { status: 'lock_unavailable', synchronized: 0 }, calls: 0,
        })
      } finally { await page.evaluate('window.releaseDelivery()') }
      assert.deepEqual(await page.evaluate('window.ownerTask'), { status: 'complete', synchronized: 1 })
      assert.deepEqual(await run(alternate, ({ drain }, cfg) => drain(cfg), config), { status: 'complete', synchronized: 0 })
    } finally { await alternate.close() }
  })

  await test('aborting receipt persistence preserves the accepted command for replay before its dependent', async () => {
    const result = await run(page, async ({ seed, drain, read, snapshot }, commands) => {
      const config = await seed('persistence', commands)
      const put = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function (entry) {
        const request = put.call(this, entry)
        if (this.name === 'synchronization_queue' && entry.acknowledgment) {
          request.addEventListener('success', () => this.transaction.abort(), { once: true })
        }
        return request
      }
      let stopped
      try { stopped = await drain(config) } finally { IDBObjectStore.prototype.put = put }
      const before = await read(config)
      const first = (await snapshot(config.baseUrl)).data
      const resumed = await drain(config)
      return { stopped, before, first, resumed, after: await read(config), final: (await snapshot(config.baseUrl)).data }
    }, [category, item])
    assert.equal(result.stopped.status, 'storage_failure')
    assert.deepEqual(result.before.map(({ status, acknowledgment }) => [status, acknowledgment]), [['pending', null], ['pending', null]])
    assert.equal(result.first.sync.last_commit_seq, 1)
    assert.deepEqual(result.resumed, { status: 'complete', synchronized: 2 })
    assert.deepEqual(result.after.map(({ acknowledgment }) => acknowledgment.outcome), ['already_processed', 'accepted'])
    assert.equal(result.final.sync.last_commit_seq, 2)
  })

  await test('a definitive Flask rejection remains auditable and blocks dependent operations', async () => {
    const duplicate = { ...category, operation_id: item.operation_id, entity_id: item.entity_id, local_sequence: 2,
      payload: { ...category.payload, category_id: item.entity_id } }
    const dependent = { ...item, operation_id: incoming.operation_id, entity_id: incoming.entity_id, local_sequence: 3,
      payload: { ...item.payload, item_id: incoming.entity_id, category_id: duplicate.entity_id } }
    const result = await run(page, async ({ seed, drain, read, snapshot }, commands) => {
      const config = await seed('rejection', commands)
      const stopped = await drain(config)
      let retriedCalls = 0
      const next = await drain({ ...config, fetch: () => { retriedCalls++ } })
      return { stopped, next, retriedCalls, records: await read(config), head: (await snapshot(config.baseUrl)).data.sync.last_commit_seq }
    }, [category, duplicate, dependent])
    assert.equal(result.stopped.status, 'server_rejection')
    assert.equal(result.stopped.code, 'DUPLICATE_CATEGORY')
    assert.equal(result.next.status, 'blocked')
    assert.equal(result.retriedCalls, 0)
    assert.equal(result.head, 1)
    assert.deepEqual(result.records.map(({ status, resolution_status }) => [status, resolution_status]),
      [['synchronized', 'none'], ['failed', 'needs_review'], ['pending', 'none']])
    assert.deepEqual(result.records[1].command, duplicate)
  })

  await test('generation change pauses delivery before or during POST and stays paused on retry', async () => {
    const result = await run(page, async ({ seed, drain, read, snapshot, urls }, command) => {
      const wrong = (await snapshot(urls.other)).generation
      const mismatched = await seed('generation', [command], { generation: wrong })
      let posts = 0
      const preflight = await drain({ ...mismatched, fetch: (url, request) => {
        if (request.method === 'POST') posts++
        return fetch(url, request)
      } })
      const config = await seed('generation', [command])
      const changed = await drain({ ...config, fetch: (url, request) =>
        fetch(request.method === 'POST' ? new URL('/api/v2/sync', urls.other) : url, request) })
      let retriedCalls = 0
      const retry = await drain({ ...config, fetch: () => { retriedCalls++ } })
      return { preflight, changed, retry, posts, retriedCalls, entry: (await read(config))[0],
        heads: await Promise.all([urls.generation, urls.other].map(async (base) => (await snapshot(base)).data.sync.last_commit_seq)) }
    }, category)
    for (const outcome of [result.preflight, result.changed, result.retry]) {
      assert.equal(outcome.status, 'recovery_required')
      assert.equal(outcome.code, 'GENERATION_MISMATCH')
    }
    assert.equal(result.posts, 0)
    assert.equal(result.retriedCalls, 0)
    assert.equal(result.entry.status, 'pending')
    assert.deepEqual(result.heads, [null, null])
  })

  await test('a real SQLite lock returns 503 and persisted Retry-After delays manual retry', async () => {
    const result = await run(page, async ({ seed, drain, read, snapshot }, command) => {
      const config = await seed('temporary', [command])
      let time = Date.now()
      const now = () => time
      const stopped = await drain({ ...config, now })
      const before = await read(config)
      const early = await drain({ ...config, now })
      const oldHead = (await snapshot(config.baseUrl)).data.sync.last_commit_seq
      time = stopped.retryAt
      const resumed = await drain({ ...config, now })
      return { stopped, before, early, oldHead, resumed, after: await read(config) }
    }, category)
    assert.equal(result.stopped.status, 'temporary_failure')
    assert.equal(result.stopped.code, 'SYNC_FAILED')
    assert.equal(result.before[0].retry_at, result.stopped.retryAt)
    assert.equal(result.early.status, 'retry_later')
    assert.equal(result.oldHead, null)
    assert.deepEqual(result.resumed, { status: 'complete', synchronized: 1 })
    assert.equal(result.after[0].acknowledgment.outcome, 'accepted')
  })

  await test('an invalid acknowledgment leaves the original pending and can be replayed unchanged', async () => {
    const result = await run(page, async ({ seed, drain, read, snapshot }, command) => {
      const config = await seed('invalid', [command])
      let time = Date.now()
      const now = () => time
      const sent = []
      const stopped = await drain({ ...config, now, fetch: async (url, request) => {
        const response = await fetch(url, request)
        if (request.method !== 'POST') return response
        sent.push(request.body)
        const body = await response.json()
        body.data.commit_seq = 0
        return new Response(JSON.stringify(body), { headers: response.headers, status: response.status })
      } })
      const before = await read(config)
      time = stopped.retryAt
      const recovered = await drain({ ...config, now, fetch: (url, request) => {
        if (request.method === 'POST') sent.push(request.body)
        return fetch(url, request)
      } })
      return { stopped, before, sent, recovered, after: await read(config),
        head: (await snapshot(config.baseUrl)).data.sync.last_commit_seq }
    }, category)
    assert.equal(result.stopped.status, 'invalid_protocol')
    assert.equal(result.before[0].status, 'pending')
    assert.equal(result.before[0].acknowledgment, null)
    assert.equal(result.sent.length, 2)
    assert.equal(result.sent[0], result.sent[1])
    assert.deepEqual(JSON.parse(result.sent[0]), category)
    assert.equal(result.recovered.synchronized, 1)
    assert.equal(result.after[0].acknowledgment.outcome, 'already_processed')
    assert.equal(result.head, 1)
  })

  await test('a lost network acknowledgment stays pending through reload and retries the identical request', async () => {
    const lost = await run(page, async ({ seed, drain, read, snapshot }, command) => {
      const config = await seed('lost', [command])
      let sent
      const status = await drain({ ...config, fetch: async (url, request) => {
        const response = await fetch(url, request)
        if (request.method !== 'POST') return response
        sent = request.body
        await response.arrayBuffer()
        throw new TypeError('Fictional network loss after the server accepted')
      } })
      return { config, status, sent, entry: (await read(config))[0],
        backendHead: (await snapshot(config.baseUrl)).data.sync.last_commit_seq }
    }, category)
    assert.equal(lost.status.status, 'network_failure')
    assert.equal(lost.entry.status, 'pending')
    assert.equal(lost.entry.last_error.outcome, 'unknown')
    assert.equal(lost.backendHead, 1)
    await page.reload()
    const resumed = await run(page, async ({ drain, read, snapshot }, config, time) => {
      const before = (await read(config))[0]
      let sent
      const result = await drain({ ...config, now: () => time, fetch: (url, request) => {
        if (request.method === 'POST') sent = request.body
        return fetch(url, request)
      } })
      return { before, sent, result, receipt: (await read(config))[0].acknowledgment,
        backendHead: (await snapshot(config.baseUrl)).data.sync.last_commit_seq }
    }, lost.config, lost.status.retryAt)
    assert.deepEqual(resumed.before, lost.entry)
    assert.equal(resumed.sent, lost.sent)
    assert.deepEqual(JSON.parse(resumed.sent), category)
    assert.deepEqual(resumed.result, { status: 'complete', synchronized: 1 })
    assert.equal(resumed.receipt.outcome, 'already_processed')
    assert.equal(resumed.backendHead, 1)
  })

  await test('Chrome exits with an unresolved stock request and replays its exact command after restart', async () => {
    const config = await run(page, async ({ seed, drain }, commands) => {
      const config = await seed('restart', commands)
      window.interruptedDrain = drain({ ...config, fetch: async (url, request) => {
        const response = await fetch(url, request)
        if (request.method !== 'POST' || JSON.parse(request.body).local_sequence !== 6) return response
        const confirmed = await response.json()
        window.interruptedRequest = { body: request.body, data: confirmed.data }
        await new Promise(() => {})
      } })
      return config
    }, [category, item, incoming, outgoing])
    await page.until('!!window.interruptedRequest', 'Flask committed receipt before Chrome exit')
    const original = await page.evaluate('window.interruptedRequest')
    assert.equal(original.data.outcome, 'accepted')
    assert.deepEqual(JSON.parse(original.body), incoming)
    const before = await run(page, ({ read }, cfg) => read(cfg), config)
    assert.deepEqual(before.map(({ status }) => status), ['synchronized', 'synchronized', 'pending', 'pending'])
    assert.equal(before[2].acknowledgment, null)
    const pid = chrome.pid
    await chrome.stop()
    chrome = null
    chrome = await startChrome(profile)
    assert.notEqual(chrome.pid, pid)
    page = await chrome.context.page()
    await page.goto(app.href)
    const resumed = await run(page, async ({ drain, read, snapshot }, cfg) => {
      const before = await read(cfg)
      const bodies = []
      const drained = await drain({ ...cfg, fetch: (url, request) => {
        if (request.method === 'POST') bodies.push(request.body)
        return fetch(url, request)
      } })
      return { before, drained, bodies, after: await read(cfg), backend: (await snapshot(cfg.baseUrl)).data }
    }, config)
    assert.deepEqual(resumed.before, before)
    assert.deepEqual(resumed.drained, { status: 'complete', synchronized: 2 })
    assert.equal(resumed.bodies[0], original.body)
    assert.deepEqual(JSON.parse(resumed.bodies[1]), outgoing)
    const { server_generation_id, settings_version, ...receipt } = resumed.after[2].acknowledgment
    assert.equal(server_generation_id, resumed.backend.server_generation_id)
    assert.equal(settings_version, resumed.backend.settings.settings_version)
    assert.deepEqual(receipt, { ...original.data, outcome: 'already_processed' })
    assert.equal(resumed.backend.sync.last_commit_seq, 4)
    assert.equal(resumed.backend.stock_movements.length, 2)
    assert.equal(resumed.backend.inventory_items[0].available_quantity, 15)
    assert.equal(resumed.backend.stock_batches[0].remaining_quantity, 15)
  })

  await test('the isolated engine leaves all demo stores and its pending queue intact', async () => {
    await page.until('!!document.querySelector("[data-storage-state=ready]")', 'demo storage ready after restart')
    assert.deepEqual(await run(page, ({ demo }) => demo()), baseline)
    assert.deepEqual(page.exceptions, [])
    assert.deepEqual(page.consoleErrors, [])
  })
} finally {
  try { await chrome?.stop() } finally { await flask.stop() }
}
