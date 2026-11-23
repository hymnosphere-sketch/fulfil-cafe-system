import assert from 'node:assert/strict'
import test from 'node:test'
import { createIsolatedV2SyncClient } from '../src/api/client.js'
import { createIsolatedV2Client } from '../src/api/v2-client.js'
import { summarizeInventory } from '../src/services/inventory-summary.js'
import { quote } from './browser-cdp.mjs'
import { withIntegrationEnvironment } from './fe09f-environment.mjs'
import { makeProvisionalV2Snapshot } from './fixtures/api-v2-initialization.mjs'
import { queueCommands } from './fixtures/api-v2-queue.mjs'

function instrumentNetwork() {
  const fetchOriginal = window.fetch.bind(window)
  const openOriginal = XMLHttpRequest.prototype.open
  const beaconOriginal = navigator.sendBeacon.bind(navigator)
  window.api = { reads: [], posts: [], other: [], active: 0, peak: 0 }
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    window.api.other.push(String(url))
    return openOriginal.call(this, method, url, ...rest)
  }
  navigator.sendBeacon = (url, ...rest) => {
    window.api.other.push(String(url))
    return beaconOriginal(url, ...rest)
  }
  window.fetch = async (url, request) => {
    const path = new URL(url?.url ?? url, location.href).pathname
    if (path === '/api/v2/snapshot') {
      window.api.reads.push(String(url))
      const response = await fetchOriginal(url, request)
      if (window.snapshotOverride) {
        const packet = await response.json()
        const headers = new Headers(response.headers)
        if (window.snapshotOverride === 'generation') {
          packet.data.server_generation_id = '00000000-0000-4000-8000-000000009999'
        } else if (window.snapshotOverride === 'schema') {
          packet.data.schema_version = 3
        } else if (window.snapshotOverride === 'settings') {
          packet.data.settings.settings_version++
          headers.set('X-Inventory-Settings-Version', String(packet.data.settings.settings_version))
        } else {
          packet.data = window.snapshotOverride
        }
        headers.set('X-Inventory-Generation', packet.data.server_generation_id)
        return new Response(JSON.stringify(packet), { status: response.status, headers })
      }
      return response
    }
    if (path !== '/api/v2/sync') {
      window.api.other.push(String(url))
      return fetchOriginal(url, request)
    }
    const command = JSON.parse(request.body)
    window.api.posts.push({ command, generation: request.headers.get('X-Inventory-Generation') })
    window.api.active += 1
    window.api.peak = Math.max(window.api.active, window.api.peak)
    try {
      if (window.holdPost) await new Promise((resolve) => { window.releasePost = resolve })
      const response = await fetchOriginal(url, request)
      if (window.dropAcknowledgment) {
        window.dropAcknowledgment = false
        await response.arrayBuffer()
        throw new TypeError('Fictional connection lost after Flask committed.')
      }
      return response
    } finally {
      window.api.active -= 1
    }
  }
}

const evaluate = (page, fn, ...args) => page.evaluate('(' + fn.toString() + ')(' + args.map(quote).join(',') + ')')
const hasText = (page, selector, needle) =>
  page.until('document.querySelector(' + quote(selector) + ')?.textContent.includes(' + quote(needle) + ')', needle)
const badge = '.app-topbar [data-sync-state]'
const syncButton = '[data-integration-sync]'
const waitSync = (page, state) =>
  page.until('document.querySelector(' + quote(badge) + ')?.dataset.syncState === ' + quote(state), state)

function dumpStores(page, demo = false) {
  return evaluate(page, (demoMode) => new Promise((resolve, reject) => {
    const fixture = new URL(location.href).searchParams.get('fixture')
    const name = demoMode ? 'fulfil-cafe-demo-inventory' : 'fulfil-cafe-fe09f-integration-' + fixture
    const request = indexedDB.open(name)
    request.onupgradeneeded = () => request.transaction.abort()
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const names = [...database.objectStoreNames]
      const tx = database.transaction(names, 'readonly')
      const saved = {}
      for (const store of names) {
        const read = tx.objectStore(store).getAll()
        read.onsuccess = () => { saved[store] = read.result }
      }
      tx.oncomplete = () => { database.close(); resolve(saved) }
      tx.onabort = () => { database.close(); reject(tx.error) }
    }
  }), demo)
}

const queue = (stores) => stores.synchronization_queue.toSorted((a, b) => a.local_sequence - b.local_sequence)
const commandOnly = ({ operation_id, operation_type, entity_id, payload, created_at, local_sequence }) =>
  ({ operation_id, operation_type, entity_id, payload, created_at, local_sequence })
const metadata = (stores) => stores.application_settings.find(({ setting_key }) => setting_key === 'demo_repository')
const readServer = (baseUrl, receiptIds = []) => createIsolatedV2Client({ baseUrl }).snapshot({ receiptIds })

function changeSavedQueueRow(tab, operationId, change) {
  async function update(id, transform) {
    const { INTEGRATION_DATABASE_PREFIX } = await import('/src/data/integration-inventory-repository.js')
    const { closeInventoryDatabase, openInventoryDatabase, requestResult, runTransaction } = await import('/src/db/database.js')
    const fixture = new URL(location.href).searchParams.get('fixture')
    if (!fixture) throw new Error('A disposable integration fixture is required.')
    const db = await openInventoryDatabase({ name: INTEGRATION_DATABASE_PREFIX + fixture })
    try {
      await runTransaction(db, ['synchronization_queue'], 'readwrite', async (tx) => {
        const store = tx.objectStore('synchronization_queue')
        const row = await requestResult(store.get(id))
        if (!row || row.dataset !== 'fe09f-fictional-integration') throw new Error('Integration queue row missing.')
        await requestResult(store.put(transform(row)))
      })
    } finally {
      closeInventoryDatabase(db)
    }
  }
  return tab.evaluate('(' + update.toString() + ')(' + quote(operationId) + ', ' + change.toString() + ')')
}

async function quiet(page) {
  const network = await page.evaluate('window.api')
  assert.deepEqual(network.reads, [])
  assert.deepEqual(network.posts, [])
  assert.deepEqual(network.other, [])
  assert.deepEqual(await evaluate(page, () => performance.getEntriesByType('resource')
    .filter((entry) => new URL(entry.name).pathname.startsWith('/api/')).map((entry) => entry.name)), [])
}

async function route(page, name) {
  await page.click('[data-route="' + name + '"]')
  await page.until('location.hash.split("?")[0] === ' + quote('#/' + name) + ' && !!document.querySelector("#page-title")', name)
}

async function createCategory(page, name) {
  await route(page, 'categories')
  await page.click('[data-inventory-action="add-category"]')
  await page.setField('[data-inventory-form] [name="name"]', name)
  await page.click('[data-inventory-form] [type="submit"]')
  await hasText(page, '[data-inventory-results]', name)
}

async function createItem(page, category, name, unit = 'piece') {
  await route(page, 'inventory')
  await page.click('[data-inventory-action="add-item"]')
  const field = (name) => '[data-inventory-form] [name="' + name + '"]'
  await page.setField(field('name'), name)
  await page.setField(field('category_id'), category)
  await page.setField(field('unit_of_measurement'), unit)
  await page.setField(field('minimum_stock_level'), '16')
  await page.click('[data-inventory-form] [type="submit"]')
  await hasText(page, '[data-inventory-results]', name)
}

async function prepareStock(page, workflow, item, quantity, { batch, reason, direction } = {}) {
  await route(page, 'stock')
  await page.click('[data-stock-workflow="' + workflow + '"]')
  await page.setField('#stock-item', item)
  if (direction) await page.setField('#stock-direction', direction)
  await page.setField('#stock-quantity', String(quantity))
  if (batch) await page.setField('[data-stock-batch-id="' + batch + '"]', String(quantity))
  if (reason) await page.setField('[name="reason"]', reason)
  await page.click('[data-stock-preview]')
}

async function confirmStock(page, balance, unit = 'piece') {
  await hasText(page, '[data-stock-confirmation] [data-stock-resulting-quantity]', balance + ' ' + unit)
  await page.click('[data-stock-confirm]')
  await hasText(page, '#stock-result-heading', 'Movement recorded')
}

async function synchronize(page, expected = 'synchronized') {
  await route(page, 'settings')
  await page.click(syncButton)
  await waitSync(page, expected)
}

function compareInventory(stores, server) {
  const volumes = { piece: 'piece', g: 'kg', mL: 'l' }
  const normalizedTimes = (row) => Object.fromEntries(Object.entries(row).map(([key, value]) =>
    [key, (key === 'created_at' || key === 'updated_at') ? new Date(value).toISOString() : value]))
  const ordered = (rows, field) => rows.map(normalizedTimes).sort((a, b) => a[field].localeCompare(b[field]))
  const compare = (key, field, local, remote) => assert.deepEqual(ordered(local, field), ordered(remote, field), key)
  compare('categories', 'category_id', stores.categories, server.categories)
  const movements = stores.stock_movements.toSorted((a, b) => a.demo_order - b.demo_order)
    .map(({ demo_order, ...row }) => row)
  compare('stock movements', 'movement_id', movements, server.stock_movements.map(({ commit_seq, replay_status, ...row }) => row))
  assert.deepEqual(movements.map(({ movement_id }) => movement_id), server.stock_movements.map(({ movement_id }) => movement_id))
  compare('allocations', 'allocation_id', stores.batch_allocations, server.batch_allocations)
  const settings = stores.application_settings.find(({ setting_key }) => setting_key === 'expiration_settings').value
  assert.deepEqual(settings, server.settings)
  const balances = summarizeInventory({ ...stores, stock_movements: movements, settings }, metadata(stores).business_date)
  compare('items', 'item_id', stores.inventory_items.map(({ unit_of_measurement, ...row }) => ({
    ...row, unit_of_measurement: volumes[unit_of_measurement],
    available_quantity: balances.itemBalances.get(row.item_id),
  })), server.inventory_items.map(({ stock_status, ...row }) => row))
  compare('batches', 'batch_id', stores.stock_batches.map((row) => ({
    ...row, remaining_quantity: balances.batchBalances.get(row.batch_id),
  })), server.stock_batches)
  return balances
}

await withIntegrationEnvironment(async ({ app, production, urls, page, restartChrome }) => {
  const entry = new URL('/tests/fe09f-integration.html', app)
  const observers = { script: '(' + instrumentNetwork.toString() + ')()', width: 1024, height: 768 }
  const fresh = async () => {
    const tab = await page(observers)
    await tab.goto(entry.href)
    return tab
  }
  async function initialize(tab, url) {
    await tab.setField('#fixture-port', new URL(url).port)
    const form = '[data-integration-initialize]'
    assert.deepEqual(await evaluate(tab, (selector) => {
      const input = document.querySelector(selector).elements.port
      return { value: input.value, valid: input.validity.valid }
    }, form), { value: new URL(url).port, valid: true })
    const startingDocument = await tab.evaluate('performance.timeOrigin')
    await tab.click(form + ' button')
    const submitted = await tab.evaluate('({stamp:performance.timeOrigin, text:document.querySelector("[data-integration-message]")?.textContent, active:document.querySelector("#fixture-port")?.value})')
    try {
      await waitSync(tab, 'ready')
    } catch (error) {
      throw new Error('Initialization UI failed. ' + JSON.stringify({
        exceptions: tab.exceptions, errors: tab.consoleErrors, startingDocument, submitted,
        state: await tab.evaluate('({stamp:performance.timeOrigin,url:location.href,input:document.querySelector("#fixture-port")?.value,api:window.api})'),
      }), { cause: error })
    }
    await hasText(tab, '.app-topbar', 'Integration Test')
  }

  let core, demo, baselineDemo, coreUrl, category, item, batch, pendingCore
  let offline, offlineUrl, offlineBeforeRestart

  await test('1. The actual UI initializes an empty authoritative Flask snapshot in a separate database', async () => {
    demo = await page(observers)
    await demo.goto(app)
    await demo.until('!!document.querySelector("[data-storage-state=ready]")', 'demo storage')
    await createCategory(demo, 'Fictional demo isolation record')
    baselineDemo = await dumpStores(demo, true)
    assert.equal(baselineDemo.synchronization_queue[0].upload_eligible, false)
    core = await fresh()
    await quiet(core)
    await initialize(core, urls.core)
    coreUrl = await core.evaluate('location.href')
    const saved = await dumpStores(core)
    const server = await readServer(urls.core)
    assert.equal(server.installable, true)
    assert.equal(metadata(saved).generation, server.generation)
    assert.equal(metadata(saved).settings_version, server.settingsVersion)
    assert.equal(metadata(saved).last_sequence, 0)
    assert.deepEqual(queue(saved), [])
    compareInventory(saved, server.data)
    assert.equal((await core.evaluate('window.api')).reads.length, 1)
  })

  await test('2. Category and dependent item are immediately visible and queued in creation order', async () => {
    await createCategory(core, 'Integration supplies')
    category = (await dumpStores(core)).categories[0].category_id
    await createItem(core, category, 'Integration cups')
    const saved = await dumpStores(core)
    item = saved.inventory_items[0].item_id
    assert.equal(saved.inventory_items[0].category_id, category)
    assert.deepEqual(queue(saved).map((row) => [row.local_sequence, row.operation_type, row.entity_id]), [
      [1, 'create_category', category], [2, 'create_item', item],
    ])
    assert.equal(queue(saved)[1].payload.category_id, category)
    await waitSync(core, 'pending')
    assert.equal((await core.evaluate('window.api')).posts.length, 0)
  })

  await test('3. Receiving 20 locally rolls back a failed queue write, then records one movement and batch', async () => {
    const before = await dumpStores(core)
    await prepareStock(core, 'receive', item, 20)
    await evaluate(core, () => {
      const add = IDBObjectStore.prototype.add
      IDBObjectStore.prototype.add = function (row, ...extra) {
        const request = add.call(this, row, ...extra)
        if (this.name === 'synchronization_queue' && row.dataset === 'fe09f-fictional-integration') {
          IDBObjectStore.prototype.add = add
          const transaction = this.transaction
          queueMicrotask(() => transaction.abort())
        }
        return request
      }
    })
    await core.click('[data-stock-confirm]')
    await hasText(core, '[data-stock-confirm-error]', 'Could not confirm')
    assert.deepEqual(await dumpStores(core), before)
    await confirmStock(core, 20)
    const saved = await dumpStores(core)
    batch = saved.stock_batches[0].batch_id
    assert.equal(saved.stock_batches[0].received_quantity, 20)
    assert.deepEqual(saved.stock_movements.map(({ quantity_change }) => quantity_change), [20])
    assert.equal(saved.batch_allocations[0].batch_id, batch)
    assert.equal(queue(saved)[2].payload.quantity_change, 20)
    assert.equal(queue(saved).length, 3)
  })

  await test('4. Usage blocks an overdraw, then records −5 and displays 15 across inventory and reports', async () => {
    const before = await dumpStores(core)
    await prepareStock(core, 'usage', item, 21, { batch })
    await hasText(core, '[data-stock-field-error]', 'enough stock')
    assert.deepEqual(await dumpStores(core), before)
    await core.setField('#stock-quantity', '5')
    await core.setField('[data-stock-batch-id="' + batch + '"]', '5')
    await core.click('[data-stock-preview]')
    await confirmStock(core, 15)
    pendingCore = await dumpStores(core)
    assert.deepEqual(queue(pendingCore).map(({ payload }) => payload.quantity_change ?? null), [null, null, 20, -5])
    assert.equal(queue(pendingCore)[3].payload.allocations[0].batch_id, batch)
    await route(core, 'inventory')
    await hasText(core, '[data-inventory-results]', '15 piece')
    await hasText(core, '[data-inventory-results]', 'Low stock')
    await route(core, 'history')
    await hasText(core, '[data-history-count]', '2 movements found')
    await route(core, 'reports')
    await hasText(core, '[data-report-rows]', 'Integration cups')
    await route(core, 'dashboard')
    await hasText(core, '[data-app-sync-summary]', '4 changes pending')
    await hasText(core, '.dashboard-results', 'Integration cups')
    const traffic = await core.evaluate('window.api')
    assert.equal(traffic.reads.length, 1)
    assert.deepEqual(traffic.posts, [])
  })

  await test('5. Settings drains the four actual UI commands in order with one in flight and verified receipts', async () => {
    await route(core, 'settings')
    await hasText(core, '[data-sync-pending]', '4')
    await core.evaluate('window.holdPost = true')
    await core.click(syncButton)
    await waitSync(core, 'synchronizing')
    await core.until('typeof window.releasePost === "function"', 'first sync request')
    assert.equal(await core.evaluate('document.querySelector(' + quote(syncButton) + ').disabled'), true)
    await core.evaluate('document.querySelector(' + quote(syncButton) + ').click(); window.holdPost = false; window.releasePost()')
    await waitSync(core, 'synchronized')
    const saved = await dumpStores(core)
    const operations = queue(saved)
    const commands = queue(pendingCore).map(commandOnly)
    const traffic = await core.evaluate('window.api')
    assert.equal(traffic.peak, 1)
    assert.deepEqual(traffic.posts.map(({ command }) => command), commands)
    assert.ok(traffic.posts.every(({ generation }) => generation === metadata(saved).generation))
    assert.deepEqual(operations.map(commandOnly), commands)
    assert.deepEqual(operations.map((row) => row.status), Array(4).fill('synchronized'))
    assert.deepEqual(operations.map((row) => row.acknowledgment.commit_seq), [1, 2, 3, 4])
    assert.ok(operations.every((row) => row.acknowledgment.replay_status === 'verified'))
    assert.deepEqual(saved.stock_movements, pendingCore.stock_movements)
    const time = Math.max(...operations.map((row) => Date.parse(row.acknowledgment.processed_at)))
    assert.equal(await core.evaluate('document.querySelector("[data-sync-last-success] time").dateTime'), new Date(time).toISOString())
    await hasText(core, '[data-sync-confirmed]', '4')
  })

  await test('6. Browser loses connectivity, saves a valid withdrawal locally, then explicitly synchronizes once', async () => {
    offline = await fresh()
    await initialize(offline, urls.offline)
    await createCategory(offline, 'Offline supplies')
    const cat = (await dumpStores(offline)).categories[0].category_id
    await createItem(offline, cat, 'Offline lids')
    const itemId = (await dumpStores(offline)).inventory_items[0].item_id
    await prepareStock(offline, 'receive', itemId, 20)
    await confirmStock(offline, 20)
    await synchronize(offline)
    const batchId = (await dumpStores(offline)).stock_batches[0].batch_id
    await offline.cdp('Network.enable')
    const setOffline = (value) => offline.cdp('Network.emulateNetworkConditions', {
      offline: value, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    })
    await setOffline(true)
    try {
      await hasText(offline, '[data-browser-status-label]', 'Browser offline')
      await prepareStock(offline, 'usage', itemId, 5, { batch: batchId })
      await confirmStock(offline, 15)
      await waitSync(offline, 'pending')
      const saved = await dumpStores(offline)
      assert.equal(queue(saved)[3].acknowledgment, null)
      assert.equal((await readServer(urls.offline)).data.inventory_items[0].available_quantity, 20)
      await synchronize(offline, 'temporary_failure')
      const attempt = queue(await dumpStores(offline))[3]
      assert.equal(attempt.status, 'pending')
      assert.equal(attempt.retry_count, 1)
      // Earlier FE-09F builds stored NaN when the adapter omitted the previous count.
      await changeSavedQueueRow(offline, attempt.operation_id, (row) => ({ ...row, retry_count: NaN }))
      await synchronize(offline, 'temporary_failure')
      assert.equal(queue(await dumpStores(offline))[3].retry_count, 2)
    } finally {
      await setOffline(false)
    }
    await synchronize(offline)
    assert.equal((await readServer(urls.offline)).data.inventory_items[0].available_quantity, 15)
    await prepareStock(offline, 'usage', itemId, 1, { batch: batchId })
    await confirmStock(offline, 14)
    await waitSync(offline, 'pending')
    offlineBeforeRestart = await dumpStores(offline)
    offlineUrl = await offline.evaluate('location.href')
  })

  await test('7. Losing a committed withdrawal response replays the identical command without duplicate stock', async () => {
    const tab = await fresh()
    await initialize(tab, urls.lost)
    await createCategory(tab, 'Lost reply pantry')
    await createItem(tab, (await dumpStores(tab)).categories[0].category_id, 'Lost reply trays')
    const itemId = (await dumpStores(tab)).inventory_items[0].item_id
    await prepareStock(tab, 'receive', itemId, 20)
    await confirmStock(tab, 20)
    await synchronize(tab)
    await prepareStock(tab, 'usage', itemId, 5, { batch: (await dumpStores(tab)).stock_batches[0].batch_id })
    await confirmStock(tab, 15)
    const original = commandOnly(queue(await dumpStores(tab))[3])
    await tab.evaluate('window.dropAcknowledgment = true')
    await synchronize(tab, 'temporary_failure')
    const unresolved = queue(await dumpStores(tab))[3]
    assert.equal(unresolved.status, 'pending')
    assert.equal(unresolved.acknowledgment, null)
    assert.deepEqual(commandOnly(unresolved), original)
    const first = await readServer(urls.lost, [original.operation_id])
    assert.equal(first.data.receipt_checks[0].status, 'accepted')
    await synchronize(tab)
    const receipt = queue(await dumpStores(tab))[3].acknowledgment
    assert.equal(receipt.outcome, 'already_processed')
    assert.equal(receipt.commit_seq, first.data.receipt_checks[0].commit_seq)
    const sent = (await tab.evaluate('window.api')).posts.slice(-2)
    assert.deepEqual(sent.map(({ command }) => command), [original, original])
    const final = await readServer(urls.lost)
    assert.equal(final.data.inventory_items[0].available_quantity, 15)
    assert.equal(final.data.stock_movements.length, 2)
    await tab.close()
  })

  await test('8. A real Flask business rejection is retained and blocks the dependent local command', async () => {
    const tab = await fresh()
    await initialize(tab, urls.rejected)
    const state = await readServer(urls.rejected)
    const command = queueCommands().category
    await createIsolatedV2SyncClient({ baseUrl: urls.rejected }).sync(command, state)
    await createCategory(tab, command.payload.name)
    const localCategory = (await dumpStores(tab)).categories[0].category_id
    await createItem(tab, localCategory, 'Blocked dependent item')
    const before = await dumpStores(tab)
    await synchronize(tab, 'needs_review')
    await hasText(tab, '[data-sync-review]', '1')
    const saved = await dumpStores(tab)
    assert.deepEqual(saved.categories, before.categories)
    assert.deepEqual(saved.inventory_items, before.inventory_items)
    assert.equal(await tab.evaluate('document.querySelector(' + quote(syncButton) + ').disabled'), true)
    assert.deepEqual(queue(saved).map(({ status }) => status), ['failed', 'pending'])
    assert.equal(queue(saved)[0].last_error.code, 'DUPLICATE_CATEGORY')
    assert.deepEqual(queue(saved).map(commandOnly), queue(before).map(commandOnly))
    assert.equal((await tab.evaluate('window.api')).posts.length, 1)
    assert.equal((await readServer(urls.rejected)).data.inventory_items.length, 0)
    await tab.close()
  })

  await test('9. A new Chrome process restores exact records and pending identities, then resumes explicit delivery', async () => {
    await restartChrome()
    offline = await page(observers)
    await offline.goto(offlineUrl)
    await waitSync(offline, 'pending')
    assert.deepEqual(await dumpStores(offline), offlineBeforeRestart)
    await quiet(offline)
    await route(offline, 'history')
    await hasText(offline, '[data-history-count]', '3 movements found')
    await synchronize(offline)
    const saved = await dumpStores(offline)
    const server = await readServer(urls.offline)
    compareInventory(saved, server.data)
    assert.equal(server.data.inventory_items[0].available_quantity, 14)
    assert.equal(queue(saved).length, 5)
  })

  await test('10. Generation mismatch persists a recovery pause without writes or snapshot replacement', async () => {
    const tab = await fresh()
    await initialize(tab, urls.recovery)
    await createCategory(tab, 'Recovery test pantry')
    const before = await dumpStores(tab)
    await tab.evaluate('window.snapshotOverride = "generation"')
    await synchronize(tab, 'recovery_required')
    assert.equal(await tab.evaluate('document.querySelector(' + quote(syncButton) + ').disabled'), true)
    assert.equal((await tab.evaluate('window.api')).posts.length, 0)
    const saved = await dumpStores(tab)
    assert.deepEqual(saved.categories, before.categories)
    assert.deepEqual(metadata(saved), metadata(before))
    assert.equal(queue(saved)[0].last_error.code, 'GENERATION_MISMATCH')
    assert.equal(queue(saved)[0].status, 'pending')
    await tab.reload()
    await waitSync(tab, 'recovery_required')
    await quiet(tab)
    assert.deepEqual(await dumpStores(tab), saved)
    await tab.close()
  })

  await test('11. The seven ordinary routes show no integration records or network requests and preserve demo storage', async () => {
    for (const origin of [app, production]) {
      const tab = await page(observers)
      await tab.goto(origin)
      await tab.until('!!document.querySelector("[data-storage-state=ready]")', 'ordinary demo storage')
      const baseline = await dumpStores(tab, true)
      if (origin === app) assert.deepEqual(baseline, baselineDemo)
      for (const name of ['dashboard', 'categories', 'inventory', 'stock', 'history', 'reports', 'settings']) {
        await route(tab, name)
        await waitSync(tab, 'not_configured')
        assert.equal(await tab.evaluate('document.querySelector("main").textContent.includes("Integration cups")'), false)
        assert.equal(await tab.evaluate('!!document.querySelector(' + quote(syncButton) + ')'), false)
      }
      await quiet(tab)
      assert.deepEqual(await dumpStores(tab, true), baseline)
      await tab.close()
    }
    const response = await fetch(new URL(entry.pathname, production))
    assert.doesNotMatch(await response.text(), /data-integration-initialize|fe09f-integration\.mjs/)
  })

  await test('12. Reopened local inventory reconciles every identity and quantity with the authoritative Flask snapshot', async () => {
    core = await page(observers)
    await core.goto(coreUrl)
    await waitSync(core, 'synchronized')
    await quiet(core)
    const saved = await dumpStores(core)
    const operations = queue(saved)
    const ids = operations.map((row) => row.operation_id)
    assert.equal(new Set(ids).size, 4)
    const server = await readServer(urls.core, ids)
    assert.equal(server.installable, true)
    assert.equal(server.generation, metadata(saved).generation)
    assert.deepEqual(server.data.receipt_checks.map(({ status }) => status), Array(4).fill('accepted'))
    assert.deepEqual(server.data.receipt_checks.map(({ operation_id }) => operation_id), ids)
    assert.equal(server.data.sync.last_commit_seq, 4)
    assert.deepEqual(operations.map(commandOnly), queue(pendingCore).map(commandOnly))
    const balances = compareInventory(saved, server.data)
    assert.equal(balances.itemBalances.get(item), 15)
    assert.equal(server.data.inventory_items[0].available_quantity, 15)
    assert.deepEqual(server.data.stock_movements.map(({ quantity_change }) => quantity_change), [20, -5])
    assert.equal(server.data.stock_batches[0].remaining_quantity, 15)
    assert.equal(server.data.batch_allocations.length, 2)
    assert.deepEqual(core.exceptions, [])
    console.log('CORE EVIDENCE', JSON.stringify({ local: 15, flask: 15, batch: 15, movements: 2, synchronized: 4, pending: 0 }))
  })

  await test('Provisional and invalid snapshots fail before writing inventory, and a prior fixture stays intact', async () => {
    const saved = await dumpStores(core)
    const tab = await fresh()
    await tab.setField('#fixture-port', new URL(urls.seed).port)
    await tab.evaluate('window.snapshotOverride = ' + quote(makeProvisionalV2Snapshot()))
    await tab.click('[data-integration-initialize] button')
    await hasText(tab, '[data-integration-message]', 'Initialization failed')
    await tab.evaluate('window.snapshotOverride = "schema"')
    await tab.click('[data-integration-initialize] button')
    await tab.until('!document.querySelector("[data-integration-initialize] button").disabled', 'invalid snapshot refused')
    await hasText(tab, '[data-integration-message]', 'Initialization failed')
    assert.equal(await tab.evaluate('location.search.includes("fixture=")'), false)
    const names = await evaluate(tab, async () => (await indexedDB.databases()).map(({ name }) => name))
    const newDatabases = names.filter((name) => name.startsWith('fulfil-cafe-fe09f-integration-'))
    const uninitialized = await evaluate(tab, async (databases) => {
      const { openDatabase, requestResult, runTransaction } = await import('/src/db/database.js')
      const counts = await Promise.all(databases.map(async (name) => {
        const db = await openDatabase({ name })
        try {
          const stores = [...db.objectStoreNames]
          return await runTransaction(db, stores, 'readonly', (tx) =>
            Promise.all(stores.map((store) => requestResult(tx.objectStore(store).count()))))
        } finally { db.close() }
      }))
      return counts.filter((counts) => counts.every((count) => count === 0)).length
    }, newDatabases)
    assert.equal(uninitialized, 2)
    assert.deepEqual(await dumpStores(core), saved)
    await tab.close()
  })

  await test('A populated Flask snapshot replays by commit order and exposes scale-three units as exact minor units', async () => {
    const { ordered } = queueCommands()
    ordered[1].payload.unit_of_measurement = 'kg'
    ordered[3].created_at = ordered[0].created_at
    const server = await readServer(urls.seed)
    const client = createIsolatedV2SyncClient({ baseUrl: urls.seed })
    for (const command of ordered) await client.sync(command, server)
    const tab = await fresh()
    await initialize(tab, urls.seed)
    const saved = await dumpStores(tab)
    const loaded = await readServer(urls.seed)
    assert.equal(metadata(saved).initial_commit, 4)
    assert.deepEqual(queue(saved), [])
    compareInventory(saved, loaded.data)
    await route(tab, 'inventory')
    await hasText(tab, '[data-inventory-results]', '15 g')
    await prepareStock(tab, 'wastage', saved.inventory_items[0].item_id, 2, {
      batch: saved.stock_batches[0].batch_id, reason: 'Fictional spill',
    })
    await confirmStock(tab, 13, 'g')
    await synchronize(tab)
    const final = await readServer(urls.seed)
    compareInventory(await dumpStores(tab), final.data)
    assert.equal(final.data.stock_movements.at(-1).commit_seq, 5)
    assert.equal(final.data.inventory_items[0].available_quantity, 13)
    assert.equal(ordered[1].payload.unit_of_measurement, 'kg')
    await tab.close()
  })

  await test('FE-09G: a receipt write abort preserves ordered retry after an overlapping tab and a reload', async () => {
    const tab = await fresh()
    await initialize(tab, urls.receipt_abort)
    await createCategory(tab, 'Interrupted receipt supplies')
    await createItem(tab, (await dumpStores(tab)).categories[0].category_id, 'Interrupted receipt cups')
    await synchronize(tab)
    const itemId = (await dumpStores(tab)).inventory_items[0].item_id
    await prepareStock(tab, 'receive', itemId, 20)
    await confirmStock(tab, 20)
    await prepareStock(tab, 'usage', itemId, 5, { batch: (await dumpStores(tab)).stock_batches[0].batch_id })
    await confirmStock(tab, 15)
    const before = await dumpStores(tab)
    const [incoming, outgoing] = queue(before).slice(2).map(commandOnly)
    await route(tab, 'settings')
    await evaluate(tab, (operationId) => {
      const put = IDBObjectStore.prototype.put
      window.holdPost = true
      IDBObjectStore.prototype.put = function (row, ...keys) {
        const request = put.call(this, row, ...keys)
        if (this.name === 'synchronization_queue' && row.operation_id === operationId &&
            row.status === 'synchronized' && row.acknowledgment?.replay_status === 'verified') {
          IDBObjectStore.prototype.put = put
          const transaction = this.transaction
          queueMicrotask(() => transaction.abort())
        }
        return request
      }
    }, incoming.operation_id)
    await tab.click(syncButton)
    await waitSync(tab, 'synchronizing')
    await tab.until('typeof window.releasePost === "function"', 'receiving request held by first tab')
    const other = await page(observers)
    try {
      await other.goto(await tab.evaluate('location.href'))
      await waitSync(other, 'pending')
      await synchronize(other, 'unavailable')
      await hasText(other, '[data-app-sync-panel]', 'Another window is using synchronization')
      await quiet(other)
    } finally {
      await other.close()
      await tab.evaluate('window.holdPost = false; window.releasePost()')
    }
    await waitSync(tab, 'unavailable')
    await hasText(tab, '[data-sync-pending]', '2')
    assert.deepEqual(await dumpStores(tab), before)
    assert.deepEqual((await tab.evaluate('window.api')).posts.slice(2).map(({ command }) => command), [incoming])
    const partial = (await readServer(urls.receipt_abort, [incoming.operation_id, outgoing.operation_id])).data
    assert.deepEqual(partial.receipt_checks.map(({ status }) => status), ['accepted', 'missing'])
    assert.equal(partial.inventory_items[0].available_quantity, 20)

    await tab.reload()
    await waitSync(tab, 'pending')
    await quiet(tab)
    assert.deepEqual(await dumpStores(tab), before)
    await synchronize(tab)
    assert.deepEqual((await tab.evaluate('window.api')).posts.map(({ command }) => command), [incoming, outgoing])
    const saved = await dumpStores(tab)
    assert.equal(queue(saved)[2].acknowledgment.outcome, 'already_processed')
    assert.equal(queue(saved)[2].acknowledgment.commit_seq, partial.receipt_checks[0].commit_seq)
    const final = (await readServer(urls.receipt_abort)).data
    compareInventory(saved, final)
    assert.equal(final.inventory_items[0].available_quantity, 15)
    assert.equal(final.stock_movements.length, 2)
    assert.equal(final.sync.last_commit_seq, 4)
    await tab.close()
  })

  await test('FE-09G: an inconsistent saved receipt hides success after reload and keeps local inventory usable', async () => {
    const tab = await fresh()
    await initialize(tab, urls.saved_receipt)
    await createCategory(tab, 'Saved receipt supplies')
    await synchronize(tab)
    const saved = await dumpStores(tab)
    const [row] = queue(saved)
    await changeSavedQueueRow(tab, row.operation_id, (entry) => ({
      ...entry, acknowledgment: { ...entry.acknowledgment, result: { ...entry.acknowledgment.result, name: 'Mismatched name' } },
    }))
    await tab.reload()
    await waitSync(tab, 'unavailable')
    await hasText(tab, '[data-app-sync-panel]', 'Sync status unavailable')
    assert.equal(await tab.evaluate('!!document.querySelector("[data-sync-last-success] time")'), false)
    assert.equal(await tab.evaluate('document.querySelector(' + quote(syncButton) + ').disabled'), true)
    await route(tab, 'dashboard')
    await hasText(tab, '[data-app-sync-summary]', 'Sync status unavailable')
    await createItem(tab, saved.categories[0].category_id, 'Local work after unreadable receipt')
    const after = await dumpStores(tab)
    assert.deepEqual(after.categories, saved.categories)
    assert.deepEqual(commandOnly(queue(after)[0]), commandOnly(row))
    assert.equal(queue(after)[1].status, 'pending')
    await route(tab, 'settings')
    assert.equal(await tab.evaluate('document.querySelector(' + quote(syncButton) + ').disabled'), true)
    await quiet(tab)
    assert.equal((await readServer(urls.saved_receipt)).data.inventory_items.length, 0)
    await tab.close()
  })

  await test('FE-09G: verified settings mismatch preserves pending work and blocks POST after reload', async () => {
    const tab = await fresh()
    await initialize(tab, urls.settings)
    await createCategory(tab, 'Saved settings supplies')
    await synchronize(tab)
    await createItem(tab, (await dumpStores(tab)).categories[0].category_id, 'Settings pause cups')
    const before = await dumpStores(tab)
    await tab.evaluate('window.snapshotOverride = "settings"')
    await synchronize(tab, 'recovery_required')
    const paused = await dumpStores(tab)
    assert.deepEqual(paused.inventory_items, before.inventory_items)
    assert.deepEqual(paused.application_settings, before.application_settings)
    assert.deepEqual(queue(paused).map(commandOnly), queue(before).map(commandOnly))
    assert.equal(queue(paused)[1].last_error.code, 'SETTINGS_VERSION_MISMATCH')
    assert.equal(queue(paused)[1].status, 'pending')
    assert.equal((await tab.evaluate('window.api')).posts.length, 1)
    await tab.reload()
    await waitSync(tab, 'recovery_required')
    assert.equal(await tab.evaluate('document.querySelector(' + quote(syncButton) + ').disabled'), true)
    await quiet(tab)
    assert.deepEqual(await dumpStores(tab), paused)
    await tab.close()
  })
})
