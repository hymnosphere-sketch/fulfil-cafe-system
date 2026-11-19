import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

// Start Vite and an isolated headless Chrome profile with a CDP port first.
const app = process.env.INDEXEDDB_APP_URL ?? 'http://127.0.0.1:5196/'
const chrome = process.env.INDEXEDDB_CHROME_URL ?? 'http://127.0.0.1:9228'
const testName = () => 'fulfil-cafe-demo-inventory-test-' + randomUUID()

async function newPage() {
  const response = await fetch(chrome + '/json/new?about:blank', { method: 'PUT' })
  assert.ok(response.ok, 'Chrome opened an isolated test tab')
  const target = await response.json()
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })

  const requests = new Map()
  let sequence = 0
  let pageLoaded
  const exceptions = []
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    if (message.method === 'Page.loadEventFired') pageLoaded?.()
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text)
    const request = requests.get(message.id)
    if (!request) return
    requests.delete(message.id)
    if (message.error) request.reject(new Error(message.error.message))
    else request.resolve(message.result)
  })

  function command(method, params = {}) {
    const id = ++sequence
    return new Promise((resolve, reject) => {
      requests.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async function load(method, params) {
    const loaded = new Promise((resolve) => { pageLoaded = resolve })
    const result = await command(method, params)
    assert.ok(!result.errorText, result.errorText)
    let timeout
    const deadline = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Chrome did not finish loading the test page.')), 10_000)
    })
    try {
      await Promise.race([loaded, deadline])
    } finally {
      clearTimeout(timeout)
      pageLoaded = undefined
    }
  }

  await command('Page.enable')
  await command('Runtime.enable')
  await load('Page.navigate', { url: app })
  return {
    exceptions,
    reload: () => load('Page.reload', { ignoreCache: true }),
    async run(callback, input) {
      const expression = `(async () => (${callback})(await (${browserTools})(), ${JSON.stringify(input)}))()`
      const { result, exceptionDetails } = await command('Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true,
      })
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
      return result.value
    },
    async close() {
      socket.close()
      await fetch(chrome + '/json/close/' + target.id)
    },
  }
}

// Runs in Chrome, using the page's native IndexedDB and the same modules as the app.
async function browserTools() {
  const { createPersistentInventoryRepository } = await import('/src/data/persistent-inventory-repository.js')
  const { readDemoInventory } = await import('/src/data/demo-data-provider.js')
  const { summarizeInventory } = await import('/src/services/inventory-summary.js')
  const { demoBusinessDate } = await import('/src/data/demo-inventory.js')
  const { openInventoryDatabase, openDatabase, runTransaction, requestResult } = await import('/src/db/database.js')
  const { DATABASE_VERSION } = await import('/src/db/schema.js')

  const repository = (databaseName, options) => createPersistentInventoryRepository({ ...options, databaseName })
  const open = (name) => openInventoryDatabase({ name })
  const queue = (records) => [...records.synchronization_queue].sort((a, b) => a.local_sequence - b.local_sequence)
  const stock = (itemId, type, quantity, batchId) => ({
    itemId, type, quantity, unit: 'pieces', scale: 0, reason: 'Fictional persistence test',
    allocations: batchId ? [{ batchId, quantity }] : [],
  })
  const balance = (snapshot, itemId) => summarizeInventory(snapshot, demoBusinessDate).itemBalances.get(itemId)

  async function dump(name) {
    const db = await open(name)
    const stores = [...db.objectStoreNames]
    try {
      return await runTransaction(db, stores, 'readonly', async (tx) => Object.fromEntries(await Promise.all(
        stores.map(async (store) => [store, await requestResult(tx.objectStore(store).getAll())]),
      )))
    } finally {
      db.close()
    }
  }

  async function failure(action) {
    try {
      await action()
      return null
    } catch (error) {
      return error.code ?? error.name
    }
  }

  async function submit(repo, draft) {
    const { attemptId } = await repo.previewStockMovement(draft)
    return repo.recordStockMovement(attemptId)
  }

  async function createItem(repo, name) {
    const { category_id: categoryId } = await repo.createCategory({ name: name + ' category' })
    const { item_id: itemId } = await repo.createItem({
      name, category_id: categoryId, unit_of_measurement: 'pieces', minimum_stock_level: '5',
    })
    return { categoryId, itemId }
  }

  function abortAfterWrite(storeName) {
    const prototype = IDBObjectStore.prototype
    const originals = { add: prototype.add, put: prototype.put }
    let fired = false
    for (const [method, original] of Object.entries(originals)) {
      prototype[method] = function (...args) {
        const request = original.apply(this, args)
        if (this.name === storeName && !fired) {
          fired = true
          request.addEventListener('success', () => this.transaction.abort(), { once: true })
        }
        return request
      }
    }
    return () => {
      Object.assign(prototype, originals)
      return fired
    }
  }

  return {
    repository, readDemoInventory, demoBusinessDate, balance, stock, submit, createItem, dump, queue, failure,
    abortAfterWrite, open, openDatabase, runTransaction, requestResult, DATABASE_VERSION,
  }
}

const keyPaths = {
  application_settings: 'setting_key', batch_allocations: 'allocation_id', categories: 'category_id',
  inventory_items: 'item_id', staff_users: 'user_id', stock_batches: 'batch_id',
  stock_movements: 'movement_id', synchronization_queue: 'operation_id',
}

function byId(records, key) {
  return [...records].sort((a, b) => a[key].localeCompare(b[key]))
}

const page = await newPage()
try {
  await test('native schema and first-time fixture initialization preserve all IDs and enqueue nothing', async () => {
    const result = await page.run(async (t, name) => {
      const repo = t.repository(name)
      const snapshot = await repo.read()
      const raw = await t.dump(name)
      const db = await t.open(name)
      const stores = [...db.objectStoreNames]
      const schema = await t.runTransaction(db, stores, 'readonly', (tx) => stores.map((name) => {
        const store = tx.objectStore(name)
        const indexes = [...store.indexNames].map((indexName) => {
          const index = store.index(indexName)
          return [index.keyPath, index.unique]
        })
        return [name, store.keyPath, indexes]
      }))
      db.close()
      await repo.close()
      return { snapshot, raw, schema, fixture: await t.readDemoInventory(), date: t.demoBusinessDate }
    }, testName())
    assert.deepEqual(Object.fromEntries(result.schema.map(([name, key]) => [name, key])), keyPaths)
    for (const [, key, indexes] of result.schema) {
      const expected = {
        category_id: [['normalized_name', true]],
        item_id: [['normalized_name', false], ['category_id', false]],
        batch_id: [['item_id', false], ['expiration_date', false]],
        movement_id: [[['item_id', 'created_at'], false], [['movement_type', 'created_at'], false], ['created_at', false]],
        allocation_id: [['movement_id', false], ['batch_id', false], [['movement_id', 'batch_id'], true]],
        operation_id: [['local_sequence', true], [['status', 'local_sequence'], false]],
      }[key] ?? []
      for (const index of expected) assert.ok(indexes.some((entry) => JSON.stringify(entry) === JSON.stringify(index)), key + ' index ' + index)
    }
    assert.deepEqual(result.snapshot.settings, result.fixture.settings)
    for (const [store, records] of Object.entries(result.fixture)) {
      if (store !== 'settings') assert.deepEqual(byId(result.snapshot[store], keyPaths[store]), byId(records, keyPaths[store]))
    }
    assert.deepEqual(result.raw.staff_users, [])
    assert.deepEqual(result.raw.synchronization_queue, [])
    const marker = result.raw.application_settings.find(({ setting_key }) => setting_key === 'demo_repository')
    assert.equal(marker.dataset, 'fictional')
    assert.equal(marker.business_date, result.date)
    assert.equal(marker.last_sequence, 0)
  })

  await test('two browser tabs can initialize concurrently without duplicate fixture records', async () => {
    const peer = await newPage()
    try {
      const name = testName()
      const read = async (t, name) => {
        const repo = t.repository(name, {
          readInitialSnapshot: async () => {
            await new Promise((resolve) => setTimeout(resolve, 100))
            return t.readDemoInventory()
          },
        })
        const snapshot = await repo.read()
        await repo.close()
        return snapshot
      }
      const [left, right] = await Promise.all([page.run(read, name), peer.run(read, name)])
      assert.deepEqual(left, right)
      const raw = await page.run((t, name) => t.dump(name), name)
      assert.equal(raw.inventory_items.length, 13)
      assert.equal(raw.stock_movements.length, 22)
      assert.deepEqual(raw.synchronization_queue, [])
      assert.deepEqual(peer.exceptions, [])
    } finally {
      await peer.close()
    }
  })

  await test('an initialized empty inventory stays empty and reopening never invokes the fixture provider', async () => {
    const result = await page.run(async (t, name) => {
      const original = t.repository(name, { readInitialSnapshot: () => t.readDemoInventory({ scenario: 'empty' }) })
      const seeded = await original.read()
      await original.close()
      const reopened = t.repository(name, { readInitialSnapshot: () => { throw new Error('Fixture provider should not run') } })
      const after = await reopened.read()
      const raw = await t.dump(name)
      await reopened.close()
      return { seeded, after, raw }
    }, testName())
    assert.deepEqual(result.seeded, result.after)
    for (const key of ['categories', 'inventory_items', 'stock_batches', 'stock_movements', 'batch_allocations']) {
      assert.deepEqual(result.after[key], [])
    }
    assert.deepEqual(result.raw.synchronization_queue, [])
  })

  await test('startup preserves unmarked existing records and refuses a production database name', async () => {
    const result = await page.run(async (t, name) => {
      const invalidName = await t.failure(() => t.repository('fulfil-cafe-production'))
      const db = await t.open(name)
      const existing = { ...(await t.readDemoInventory()).categories[0], name: 'Existing record' }
      await t.runTransaction(db, ['categories'], 'readwrite', (tx) =>
        t.requestResult(tx.objectStore('categories').add(existing)))
      db.close()
      const repo = t.repository(name)
      const unmarked = await t.failure(() => repo.read())
      await repo.close()
      return { invalidName, unmarked, existing, raw: await t.dump(name) }
    }, testName())
    assert.equal(result.invalidName, 'DB_INVALID_NAME')
    assert.equal(result.unmarked, 'DB_UNMARKED_DATA')
    assert.deepEqual(result.raw.categories, [result.existing])
    assert.ok(Object.entries(result.raw).every(([store, rows]) => store === 'categories' || rows.length === 0))
  })

  await test('a native initialization abort leaves no partial fixture and a new connection can retry', async () => {
    const result = await page.run(async (t, name) => {
      const repo = t.repository(name)
      const restore = t.abortAfterWrite('categories')
      let code
      let injected
      try {
        code = await t.failure(() => repo.read())
      } finally {
        injected = restore()
      }
      const beforeRetry = await t.dump(name)
      await repo.close()
      const retry = t.repository(name)
      const afterRetry = await retry.read()
      await retry.close()
      return { code, injected, beforeRetry, afterRetry }
    }, testName())
    assert.equal(result.injected, true)
    assert.equal(result.code, 'DB_TRANSACTION_ABORTED')
    assert.ok(Object.values(result.beforeRetry).every((rows) => rows.length === 0))
    assert.equal(result.afterRetry.stock_movements.length, 22)
  })

  await test('catalog edits and archival survive reopening and snapshots are detached', async () => {
    const result = await page.run(async (t, name) => {
      const repo = t.repository(name)
      const { categoryId, itemId } = await t.createItem(repo, 'Catalog persistence cups')
      const category = await repo.updateCategory(categoryId, { name: 'Edited material', description: '  trimmed  ' })
      const item = await repo.updateItem(itemId, {
        name: 'Edited cups', category_id: categoryId, unit_of_measurement: 'pieces', minimum_stock_level: '7',
      })
      const duplicate = await t.failure(() => repo.createCategory({ name: 'edited  material' }))
      const blockedArchive = await t.failure(() => repo.archiveCategory(categoryId))
      await repo.archiveItem(itemId)
      await repo.archiveCategory(categoryId)
      const detached = await repo.read()
      detached.inventory_items.find(({ item_id }) => item_id === itemId).name = 'Changed by reader'
      detached.categories.length = 0
      detached.settings.expiration_warning_days = 999
      item.name = 'Changed returned item'
      category.name = 'Changed returned category'
      await repo.close()
      const reopen = t.repository(name, { readInitialSnapshot: () => { throw new Error('Reopened with existing records') } })
      const persisted = await reopen.read()
      await reopen.close()
      return {
        category: persisted.categories.find(({ category_id }) => category_id === categoryId),
        item: persisted.inventory_items.find(({ item_id }) => item_id === itemId),
        settings: persisted.settings, duplicate, blockedArchive, queue: t.queue(await t.dump(name)),
      }
    }, testName())
    assert.equal(result.category.name, 'Edited material')
    assert.equal(result.category.description, 'trimmed')
    assert.equal(result.category.is_active, false)
    assert.equal(result.item.name, 'Edited cups')
    assert.equal(result.item.minimum_stock_level, 7)
    assert.equal(result.item.is_active, false)
    assert.notEqual(result.settings.expiration_warning_days, 999)
    assert.equal(result.duplicate, 'DUPLICATE_CATEGORY')
    assert.equal(result.blockedArchive, 'CATEGORY_IN_USE')
    assert.deepEqual(result.queue.map((entry) => entry.operation_type), [
      'create_category', 'create_item', 'update_category', 'update_item', 'archive_item', 'archive_category',
    ])
    assert.deepEqual(result.queue.map((entry) => entry.local_sequence), [1, 2, 3, 4, 5, 6])
  })

  await test('the seven-mutation stock scenario and attempt receipt survive fresh connections and a browser reload', async () => {
    const name = testName()
    const entered = await page.run(async (t, name) => {
      const repo = t.repository(name)
      const { categoryId, itemId } = await t.createItem(repo, 'Fictional scenario cups')
      const balances = [t.balance(await repo.read(), itemId)]
      const results = []
      let batchId
      for (const [type, quantity] of [
        ['stock_in', 20], ['stock_out', 5], ['wastage', 2], ['positive_adjustment', 1], ['negative_adjustment', 4],
      ]) {
        const result = await t.submit(repo, t.stock(itemId, type, quantity, batchId))
        if (!batchId) batchId = result.batch.batch_id
        balances.push(t.balance(await repo.read(), itemId))
        results.push(result)
      }
      const before = await t.dump(name)
      const rejected = await t.failure(() => repo.previewStockMovement(t.stock(itemId, 'stock_out', 11, batchId)))
      const invalid = await t.failure(() => repo.previewStockMovement(t.stock(itemId, 'stock_in', 0)))
      const { attemptId: pendingId } = await repo.previewStockMovement(t.stock(itemId, 'stock_in', 1))
      const { attemptId: discardedId } = await repo.previewStockMovement(t.stock(itemId, 'stock_in', 2))
      repo.discardStockPreview(discardedId)
      const discarded = await t.failure(() => repo.recordStockMovement(discardedId))
      await repo.close()
      return { categoryId, itemId, batchId, results, balances, rejected, invalid, discarded, pendingId, before }
    }, name)
    assert.deepEqual(entered.balances, [0, 20, 15, 13, 14, 10])
    assert.equal(entered.rejected, 'INSUFFICIENT_STOCK')
    assert.equal(entered.invalid, 'INVALID_QUANTITY')
    assert.equal(entered.discarded, 'STALE_PREVIEW')

    await page.reload()
    const { itemId, categoryId, batchId, before } = entered
    const committedId = entered.results[0].movement.movement_id
    const reopened = await page.run(async (t, { name, committedId, pendingId, itemId }) => {
      const repo = t.repository(name)
      const replay = await repo.recordStockMovement(committedId)
      const abandoned = await t.failure(() => repo.recordStockMovement(pendingId))
      const after = await t.dump(name)
      const balance = t.balance(await repo.read(), itemId)
      await repo.close()
      return { replay, abandoned, after, balance, queue: t.queue(after) }
    }, { name, committedId, pendingId: entered.pendingId, itemId })
    assert.deepEqual(reopened.after, before)
    assert.equal(reopened.balance, 10)
    assert.equal(reopened.abandoned, 'STALE_PREVIEW')
    assert.deepEqual(reopened.replay, { ...entered.results[0], alreadyRecorded: true })
    const movements = reopened.after.stock_movements.filter((row) => row.item_id === itemId)
    assert.equal(movements.length, 5)
    assert.deepEqual(reopened.after.stock_batches.filter((row) => row.item_id === itemId), [entered.results[0].batch])
    assert.equal(reopened.after.batch_allocations.filter((row) => row.batch_id === batchId).length, 5)
    assert.deepEqual(reopened.queue.map((row) => row.local_sequence), [1, 2, 3, 4, 5, 6, 7])
    assert.deepEqual(reopened.queue.map((row) => row.operation_type), ['create_category', 'create_item', ...Array(5).fill('record_stock_movement')])
    assert.deepEqual(reopened.queue.map((row) => row.entity_id), [categoryId, itemId, ...entered.results.map((result) => result.movement.movement_id)])
    assert.equal(new Set(reopened.queue.map((row) => row.operation_id)).size, 7)
    assert.equal(reopened.queue[0].payload.category_id, categoryId)
    assert.equal(reopened.queue[1].payload.item_id, itemId)
    for (const [index, row] of reopened.queue.entries()) {
      assert.equal(row.status, 'pending')
      assert.equal(row.resolution_status, 'none')
      assert.equal(row.retry_count, 0)
      assert.equal(row.wire_version, 1)
      assert.equal(row.fictional, true)
      assert.equal(row.upload_eligible, false)
      for (const key of ['last_attempt_at', 'last_error', 'synchronized_at', 'resolution_audit']) assert.equal(row[key], null)
      assert.ok(Number.isFinite(Date.parse(row.created_at)))
      assert.notEqual(row.operation_id, row.entity_id)
      if (index < 2) continue
      const expected = entered.results[index - 2]
      assert.equal(row.payload.movement_id, expected.movement.movement_id)
      assert.equal(row.payload.quantity_change, expected.movement.quantity_change)
      assert.equal(row.payload.allocations[0].allocation_id, expected.allocations[0].allocation_id)
      assert.equal(row.payload.allocations[0].batch_id, batchId)
    }
    const duplicateCodes = await page.run(async (t, name) => {
      const before = await t.dump(name)
      const db = await t.open(name)
      const cases = [
        ['synchronization_queue', 'operation_id'],
        ['batch_allocations', 'allocation_id'],
      ]
      const codes = []
      for (const [store, key] of cases) {
        const twin = { ...before[store][0], [key]: crypto.randomUUID() }
        codes.push(await t.failure(() => t.runTransaction(db, [store], 'readwrite',
          (tx) => t.requestResult(tx.objectStore(store).add(twin)))))
      }
      db.close()
      return { codes, after: await t.dump(name) }
    }, name)
    assert.deepEqual(duplicateCodes.codes, ['DB_CONSTRAINT', 'DB_CONSTRAINT'])
    assert.deepEqual(duplicateCodes.after, before)
  })

  await test('stock commit rolls back inventory, queue, sequence, and confirmation receipt after a native abort', async () => {
    const result = await page.run(async (t, name) => {
      const repo = t.repository(name)
      const { itemId } = await t.createItem(repo, 'Interrupted receipt cups')
      const before = await t.dump(name)
      const draft = t.stock(itemId, 'stock_in', 5)
      const { attemptId } = await repo.previewStockMovement(draft)
      const restore = t.abortAfterWrite('synchronization_queue')
      let aborted
      let injected
      try {
        aborted = await t.failure(() => repo.recordStockMovement(attemptId))
      } finally {
        injected = restore()
      }
      const afterAbort = await t.dump(name)
      await repo.close()
      const retry = t.repository(name)
      const didCommit = await t.failure(() => retry.recordStockMovement(attemptId))
      const recovered = await t.submit(retry, draft)
      await retry.close()
      return { aborted, injected, before, afterAbort, didCommit, recovered, queue: t.queue(await t.dump(name)) }
    }, testName())
    assert.equal(result.injected, true)
    assert.equal(result.aborted, 'DB_TRANSACTION_ABORTED')
    assert.deepEqual(result.afterAbort, result.before)
    assert.equal(result.didCommit, 'STALE_PREVIEW')
    assert.equal(result.recovered.resultingQuantity, 5)
    assert.deepEqual(result.queue.map((row) => row.local_sequence), [1, 2, 3])
  })

  await test('two tabs serialize catalog writes and stale a competing stock preview without losing committed stock', async () => {
    const peer = await newPage()
    try {
      const name = testName()
      const setup = await page.run(async (t, name) => {
        const repo = t.repository(name)
        const { itemId } = await t.createItem(repo, 'Concurrent cups')
        const receipt = await t.submit(repo, t.stock(itemId, 'stock_in', 10))
        await repo.close()
        return { name, itemId, batchId: receipt.batch.batch_id }
      }, name)
      const createCategory = async (t, { name, label }) => {
        const repo = t.repository(name)
        try {
          return await repo.createCategory({ name: label })
        } finally {
          await repo.close()
        }
      }
      const [first, second] = await Promise.all([
        page.run(createCategory, { name, label: 'Concurrent category left' }),
        peer.run(createCategory, { name, label: 'Concurrent category right' }),
      ])
      const prepare = async (t, { name, itemId, batchId }) => {
        const repo = t.repository(name)
        const draft = t.stock(itemId, 'stock_out', 6, batchId)
        const { attemptId } = await repo.previewStockMovement(draft)
        globalThis.indexeddbTestPending = { repo, attemptId, draft }
        return attemptId
      }
      const previews = await Promise.all([page.run(prepare, setup), peer.run(prepare, setup)])
      assert.notEqual(previews[0], previews[1])
      const confirm = async (t) => {
        const { repo, attemptId, draft } = globalThis.indexeddbTestPending
        const confirmation = await t.failure(() => repo.recordStockMovement(attemptId))
        const reevaluated = await t.failure(() => repo.previewStockMovement(draft))
        await repo.close()
        delete globalThis.indexeddbTestPending
        return { confirmation, reevaluated }
      }
      const receipts = await Promise.all([page.run(confirm), peer.run(confirm)])
      assert.equal(receipts.filter(({ confirmation }) => confirmation === null).length, 1)
      assert.equal(receipts.filter(({ confirmation }) => confirmation === 'STALE_PREVIEW').length, 1)
      assert.ok(receipts.every(({ reevaluated }) => reevaluated === 'INSUFFICIENT_STOCK'))
      const result = await peer.run(async (t, { name, itemId }) => {
        const repo = t.repository(name)
        const snapshot = await repo.read()
        const balance = t.balance(snapshot, itemId)
        await repo.close()
        return { balance, categories: snapshot.categories, queue: t.queue(await t.dump(name)) }
      }, setup)
      assert.equal(result.balance, 4)
      assert.ok(result.categories.some(({ category_id }) => category_id === first.category_id))
      assert.ok(result.categories.some(({ category_id }) => category_id === second.category_id))
      assert.deepEqual(result.queue.map((row) => row.local_sequence), [1, 2, 3, 4, 5, 6])
      assert.deepEqual(peer.exceptions, [])
    } finally {
      await peer.close()
    }
  })

  await test('equal and backward device timestamps preserve stock replay order across connections', async () => {
    const result = await page.run(async (t, name) => {
      let clock = '2026-11-19T01:00:00.000Z'
      const repo = t.repository(name, { now: () => clock })
      const { itemId } = await t.createItem(repo, 'Clock rollback cups')
      const receipt = await t.submit(repo, t.stock(itemId, 'stock_in', 3))
      const sameTime = await t.submit(repo, t.stock(itemId, 'stock_out', 1, receipt.batch.batch_id))
      clock = '2026-11-17T01:00:00.000Z'
      const earlier = await t.submit(repo, t.stock(itemId, 'stock_out', 1, receipt.batch.batch_id))
      await repo.close()
      const reopen = t.repository(name)
      const snapshot = await reopen.read()
      await reopen.close()
      return {
        balance: t.balance(snapshot, itemId), timestamps: [receipt, sameTime, earlier].map((row) => row.movement.created_at),
        queue: t.queue(await t.dump(name)),
      }
    }, testName())
    assert.equal(result.balance, 1)
    assert.equal(result.timestamps[0], result.timestamps[1])
    assert.ok(result.timestamps[2] < result.timestamps[0])
    assert.deepEqual(result.queue.map((row) => row.local_sequence), [1, 2, 3, 4, 5])
  })

  await test('native blocked upgrades and version changes preserve records and prevent writes through stale handles', async () => {
    const result = await page.run(async (t, name) => {
      const repo = t.repository(name)
      const { itemId } = await t.createItem(repo, 'Schema version cups')
      await repo.close()
      const hold = await t.requestResult(indexedDB.open(name, t.DATABASE_VERSION))
      const blocked = await t.failure(() => t.openDatabase({ name, version: t.DATABASE_VERSION + 1 }))
      hold.close()
      const previous = await t.open(name)
      const oldVersion = previous.version
      const upgraded = await t.openDatabase({ name, version: t.DATABASE_VERSION + 1 })
      const stale = await t.failure(() => t.runTransaction(previous, ['inventory_items'], 'readonly', () => undefined))
      const incompatible = await t.failure(() => t.open(name))
      const keys = await t.runTransaction(upgraded, ['inventory_items', 'synchronization_queue'], 'readonly', (tx) => Promise.all([
        t.requestResult(tx.objectStore('inventory_items').get(itemId)),
        t.requestResult(tx.objectStore('synchronization_queue').count()),
      ]))
      upgraded.close()
      return { oldVersion, blocked, stale, incompatible, keys }
    }, testName())
    assert.equal(result.oldVersion, 1)
    assert.equal(result.blocked, 'DB_BLOCKED')
    assert.equal(result.stale, 'DB_VERSION_CHANGED')
    assert.equal(result.incompatible, 'DB_VERSION_UNSUPPORTED')
    assert.equal(result.keys[0].name, 'Schema version cups')
    assert.equal(result.keys[1], 2)
  })

  await test('denied storage and unavailable fixture errors do not start a partial repository', async () => {
    const result = await page.run(async (t, name) => {
      const denied = t.repository(name, {
        indexedDB: { open() { throw new DOMException('Test storage denied', 'SecurityError') } },
      })
      const code = await t.failure(() => denied.read())
      const faultyFixture = t.repository(name, {
        readInitialSnapshot: () => Promise.reject(new Error('Injected fixture error')),
      })
      const fixtureError = await t.failure(() => faultyFixture.read())
      await faultyFixture.close()
      const raw = await t.dump(name)
      const retry = t.repository(name)
      const inventory = await retry.read()
      await retry.close()
      return { code, fixtureError, raw, movementCount: inventory.stock_movements.length }
    }, testName())
    assert.equal(result.code, 'DB_UNAVAILABLE')
    assert.ok(result.fixtureError)
    assert.ok(Object.values(result.raw).every((rows) => rows.length === 0))
    assert.equal(result.movementCount, 22)
  })

  assert.deepEqual(page.exceptions, [], 'no uncaught exceptions in the test tab')
} finally {
  await page.close()
}
