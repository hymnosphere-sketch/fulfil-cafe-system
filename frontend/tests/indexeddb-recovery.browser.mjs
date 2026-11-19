import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { connectBrowser, element, quote } from './browser-cdp.mjs'

// Use a dedicated headless Chrome session. Each case uses its own disposable
// browser context with the actual app database name and no reset operation.
const app = process.env.FE08_APP_URL ?? 'http://127.0.0.1:5196/'
const endpoint = process.env.FE08_CHROME_URL ?? 'http://127.0.0.1:9228'
const screenshots = process.argv[2]
const browser = await connectBrowser(endpoint)
const databaseName = 'fulfil-cafe-demo-inventory'
const routes = {
  inventory: 'Inventory', categories: 'Categories', stock: 'Stock Management',
  settings: 'Settings', reports: 'Reports', history: 'Transaction History',
}
const form = '[data-inventory-form]'
const categoryName = form + ' [name="name"]'
const saveCategory = form + ' button[type="submit"]'
const ready = '[data-storage-state="ready"]'
const queueCount = '[data-settings-queue-count]'
const confirm = '[data-stock-confirm]'
const stockResult = '#stock-result-heading'

const phase = (name) => `Boolean(${element('[data-storage-panel="' + name + '"]')})`
const content = (selector, expected) => `${element(selector)}?.textContent.trim() === ${quote(expected)}`
const contains = (selector, expected) => `${element(selector)}?.textContent.includes(${quote(expected)})`

async function withContext(work) {
  const context = await browser.context()
  const pages = []
  try {
    await work(async (options) => {
      const page = await context.page(options)
      pages.push(page)
      return page
    })
    for (const page of pages) {
      assert.deepEqual(page.exceptions, [], 'uncaught page exceptions')
      assert.deepEqual(page.consoleErrors, [], 'unexpected console errors')
    }
  } finally {
    await context.dispose()
  }
}

async function capture(page, name, selector) {
  if (!screenshots) return
  await page.evaluate(`(async () => {
    await document.fonts.ready
    const target = document.querySelector(${quote(selector ?? 'main')})
    const topbar = document.querySelector('.app-topbar').getBoundingClientRect().height
    scrollTo({ top: scrollY + target.getBoundingClientRect().top - topbar - 12, behavior: 'instant' })
    await new Promise(resolve => requestAnimationFrame(resolve))
  })()`)
  const { data } = await page.cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(screenshots, name + '.png'), Buffer.from(data, 'base64'))
}

async function dashboard(page) {
  await page.goto(app)
  await page.until(`location.hash === "#/dashboard" && ${element(ready)} && ${element('[data-dashboard-results][aria-busy=false]')}`,
    'bare URL Dashboard and storage readiness')
}

async function navigate(page, id, parameters = {}) {
  const query = new URLSearchParams(parameters).toString()
  await page.evaluate('location.hash = ' + quote('#/' + id + (query ? '?' + query : '')))
  await page.until(content('#page-title', routes[id]), routes[id])
}

async function settings(page, count) {
  await navigate(page, 'settings')
  await page.until(`${content('[data-settings-schema-version]', '1')} && ${content(queueCount, String(count))}`, 'actual schema and queue count')
}

function installOpenFault(mode) {
  return `(() => {
    const original = IDBFactory.prototype.open
    window.qaOpenMode = ${quote(mode)}
    IDBFactory.prototype.open = function(name, version) {
      if (name === ${quote(databaseName)} && window.qaOpenMode === 'denied') {
        throw new DOMException('Injected storage denial', 'SecurityError')
      }
      if (name === ${quote(databaseName)} && window.qaOpenMode === 'blocked') {
        // An already-installed schema cannot need an upgrade to its own version.
        // Exercise the blocked request signal at this boundary. The native
        // IndexedDB suite separately holds a real connection across an upgrade.
        return window.qaOpenRequest = new EventTarget()
      }
      return original.call(this, name, version)
    }
  })()`
}

function abortOnAdd(store) {
  return `(() => {
    const original = IDBObjectStore.prototype.add
    IDBObjectStore.prototype.add = function(value, ...args) {
      const request = original.call(this, value, ...args)
      if (this.name === 'stock_movements') window.qaAttemptedMovement = value.movement_id
      if (this.name === ${quote(store)}) {
        IDBObjectStore.prototype.add = original
        request.addEventListener('success', () => this.transaction.abort(), { once: true })
      }
      return request
    }
  })()`
}

async function persisted(page) {
  return page.evaluate(`new Promise((resolve, reject) => {
    const open = indexedDB.open(${quote(databaseName)})
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const names = ['categories', 'inventory_items', 'stock_batches', 'stock_movements', 'batch_allocations',
        'application_settings', 'synchronization_queue']
      const transaction = db.transaction(names, 'readonly')
      const rows = Object.fromEntries(names.map(name => [name, transaction.objectStore(name).getAll()]))
      transaction.onabort = () => { db.close(); reject(transaction.error) }
      transaction.oncomplete = () => {
        const result = Object.fromEntries(names.map(name => [name, rows[name].result]))
        db.close()
        resolve(result)
      }
    }
  })`)
}

function commitSequence(data) {
  return data.application_settings.find(({ setting_key }) => setting_key === 'demo_repository').last_sequence
}

function fixtureItem(data) {
  const item = data.inventory_items.find(({ unit_of_measurement, is_active }) => unit_of_measurement === 'pieces' && is_active)
  assert.ok(item, 'active fictional item counted in pieces')
  return item.item_id
}

async function fillCategory(page, name) {
  await navigate(page, 'categories')
  await page.click('[data-inventory-action="add-category"]')
  await page.setField(categoryName, name)
}

async function savedCategory(page) {
  await page.until(contains('[data-inventory-feedback]', 'Demo category saved'), 'category success after commit')
}

async function prepareReceipt(page, itemId, quantity) {
  await navigate(page, 'stock', { workflow: 'receive', item: itemId })
  await page.setField('#stock-quantity', String(quantity))
  await page.click('[data-stock-preview]')
  await page.until(element('[data-stock-confirmation]'), 'receipt confirmation')
}

async function recordMovement(page) {
  await page.click(confirm)
  await page.until(content(stockResult, 'Movement recorded'), 'stock success after commit')
}

function assertOneReceipt(before, after, quantity) {
  const ids = new Set(before.stock_movements.map(({ movement_id }) => movement_id))
  const added = after.stock_movements.filter(({ movement_id }) => !ids.has(movement_id))
  assert.equal(added.length, 1)
  assert.equal(added[0].movement_type, 'stock_in')
  assert.equal(added[0].quantity_change, quantity)
  assert.equal(after.stock_batches.length, before.stock_batches.length + 1)
  assert.equal(after.batch_allocations.length, before.batch_allocations.length + 1)
  assert.equal(after.synchronization_queue.length, before.synchronization_queue.length + 1)
  assert.equal(commitSequence(after), commitSequence(before) + 1)
  return added[0].movement_id
}

try {
  if (screenshots) await mkdir(screenshots, { recursive: true })

  for (const [fault, state, filename] of [
    ['denied', 'unavailable', 'storage-opening-failure-1440x900'],
    ['blocked', 'blocked', 'storage-upgrade-blocked-1440x900'],
  ]) {
    await test(`storage ${fault} gates inventory and retry preserves prior data and queue`, () => withContext(async (makePage) => {
      const original = await makePage()
      await dashboard(original)
      await fillCategory(original, 'Retained recovery check')
      await original.click(saveCategory)
      await savedCategory(original)
      const before = await persisted(original)
      await original.close()

      const page = await makePage({ script: installOpenFault(fault) })
      await page.goto(app)
      if (fault === 'blocked') {
        await page.until(`${phase('opening')} && window.qaOpenRequest`, 'waiting for local storage')
        assert.equal(await page.evaluate(`Boolean(${element('[data-dashboard-results]')})`), false)
        await page.evaluate('window.qaOpenRequest.dispatchEvent(new Event("blocked"))')
      }
      await page.until(phase(state), 'storage error')
      await capture(page, filename, '[data-storage-panel]')
      await navigate(page, 'inventory')
      await page.until(phase(state), 'inventory remains gated')
      assert.equal(await page.evaluate(`Boolean(${element('[data-inventory-action=add-item], [data-inventory-count]')})`), false)
      await page.evaluate('window.qaOpenMode = null')
      await page.click('[data-storage-retry]')
      await page.until(`${element(ready)} && ${contains('[data-inventory-count]', '12 items')}`, 'inventory after retry')
      await settings(page, 1)
      assert.deepEqual(await persisted(page), before)
    }))
  }

  await test('an aborted fixture initialization can retry without partial fixture or seed queue', () => withContext(async (makePage) => {
    const page = await makePage({ script: abortOnAdd('categories') })
    await page.goto(app)
    await page.until(phase('transaction-failed'), 'initialization transaction failure')
    await capture(page, 'storage-initialization-aborted-1440x900', '[data-storage-panel]')
    const empty = await persisted(page)
    assert.ok(Object.values(empty).every((rows) => rows.length === 0))
    await page.click('[data-storage-retry]')
    await page.until(`${element(ready)} && ${element('[data-dashboard-results][aria-busy=false]')}`, 'initialized dashboard after retry')
    const seeded = await persisted(page)
    assert.equal(seeded.stock_movements.length, 22)
    assert.equal(seeded.synchronization_queue.length, 0)
    assert.equal(commitSequence(seeded), 0)
  }))

  await test('aborted catalog save retains the form and committed state until a deliberate retry', () => withContext(async (makePage) => {
    const page = await makePage()
    await dashboard(page)
    const before = await persisted(page)
    await fillCategory(page, 'Category retained after failed save')
    await page.evaluate(abortOnAdd('synchronization_queue'))
    await page.click(saveCategory)
    await page.until(element('[data-form-error][role=alert]'), 'catalog write failure')
    assert.equal(await page.evaluate(element(categoryName) + '.value'), 'Category retained after failed save')
    assert.doesNotMatch(await page.evaluate(element('[data-inventory-feedback]') + '.textContent'), /saved/)
    assert.deepEqual(await persisted(page), before)
    await capture(page, 'failed-catalog-save-1440x900', '[data-form-error]')
    await page.click(saveCategory)
    await savedCategory(page)
    const after = await persisted(page)
    assert.equal(after.categories.length, before.categories.length + 1)
    assert.equal(after.synchronization_queue.length, 1)
    assert.equal(commitSequence(after), 1)
  }))

  await test('aborted receipt rolls back every store and repeat clicks commit the same reviewed movement once', () => withContext(async (makePage) => {
    const page = await makePage()
    await dashboard(page)
    const before = await persisted(page)
    await prepareReceipt(page, fixtureItem(before), 2)
    await page.evaluate(abortOnAdd('synchronization_queue'))
    await page.click(confirm)
    await page.until(element('[data-stock-confirm-error][role=alert]'), 'receipt transaction failure')
    assert.equal(await page.evaluate(element(confirm) + '.textContent.trim()'), 'Retry confirmation')
    assert.equal(await page.evaluate(`Boolean(${element(stockResult)})`), false)
    const reviewedId = await page.evaluate('window.qaAttemptedMovement')
    assert.ok(reviewedId)
    assert.deepEqual(await persisted(page), before)
    await capture(page, 'failed-local-transaction-1440x900', '[data-stock-confirm-error]')
    const pending = await page.evaluate(`(() => {
      const button = ${element(confirm)}
      button.click()
      const disabled = button.disabled
      button.click()
      return disabled
    })()`)
    assert.equal(pending, true)
    await page.until(content(stockResult, 'Movement recorded'), 'retried receipt recorded')
    const movementId = assertOneReceipt(before, await persisted(page), 2)
    assert.equal(movementId, reviewedId)
    await settings(page, 1)
  }))

  await test('another tab invalidates a reviewed draft and returning refreshes filtered Reports from IndexedDB', () => withContext(async (makePage) => {
    const first = await makePage()
    const second = await makePage()
    await dashboard(first)
    await dashboard(second)
    const before = await persisted(first)
    const itemId = fixtureItem(before)
    await prepareReceipt(first, itemId, 2)
    await prepareReceipt(second, itemId, 3)
    await recordMovement(second)
    const committed = await persisted(second)
    assertOneReceipt(before, committed, 3)
    await first.click(confirm)
    await first.until(contains('[data-stock-form-error][role=alert]', 'out of date'), 'stale confirmation rejected')
    assert.equal(await first.evaluate(element('#stock-quantity') + '.value'), '2')
    assert.deepEqual(await persisted(first), committed)

    const filters = { view: 'movements', itemId }
    await navigate(first, 'reports', filters)
    const matches = committed.stock_movements.filter(({ item_id }) => item_id === itemId).length
    const count = '[data-report-count]'
    await first.until(contains(count, `Showing ${matches} of 23 movement records`), 'filtered committed report')

    await second.click('[data-stock-new]')
    await second.setField('#stock-quantity', '4')
    await second.click('[data-stock-preview]')
    await recordMovement(second)
    assertOneReceipt(committed, await persisted(second), 4)
    await first.cdp('Page.bringToFront')
    await first.evaluate('window.dispatchEvent(new Event("focus"))')
    const updated = contains(count, `Showing ${matches + 1} of 24 movement records`)
    await first.until(updated, 'updated filtered report on return')
    await first.reload()
    await first.until(`${updated} && ${element('#report-itemId')}?.value === ${quote(itemId)}`, 'persisted filter after refresh')
    await navigate(first, 'reports', { view: 'movements', itemId: 'missing', categoryId: 'unknown', type: 'invalid' })
    await first.until(`location.hash === "#/reports?view=movements" && ${contains(count, 'Showing 24 of 24 movement records')}`,
      'missing and invalid saved selections repaired')
  }))

  await test('retry after a status read failure restores the latest Reports and History filters', () => withContext(async (makePage) => {
    const page = await makePage()
    await dashboard(page)
    const before = await persisted(page)
    const itemId = fixtureItem(before)
    for (const [view, parameters, itemField, typeField, filters, savedItem] of [
      ['reports', { view: 'movements' }, '#report-itemId', '#report-type', '[data-report-filters]', 'itemId'],
      ['history', {}, '#history-item', '#history-type', '[data-history-filters]', 'item'],
    ]) {
      await navigate(page, view, parameters)
      await page.setField(itemField, itemId)
      await page.setField(typeField, 'stock_in')
      await page.click(filters + ' button[type="submit"]')
      const latest = await page.evaluate('location.hash')
      const latestParams = new URLSearchParams(latest.split('?')[1])
      assert.equal(latestParams.get(savedItem), itemId)
      assert.equal(latestParams.get('type'), 'stock_in')
      await page.cdp('Page.bringToFront')
      await page.evaluate(`(() => {
        const original = IDBDatabase.prototype.transaction
        IDBDatabase.prototype.transaction = function(stores, mode, ...options) {
          if (this.name === ${quote(databaseName)} && mode === 'readonly' && stores.includes('synchronization_queue')) {
            IDBDatabase.prototype.transaction = original
            throw new DOMException('Injected status read failure', 'SecurityError')
          }
          return original.call(this, stores, mode, ...options)
        }
        window.dispatchEvent(new Event('focus'))
      })()`)
      await page.until(phase('unavailable'), 'storage read error')
      await page.click('[data-storage-retry]')
      await page.until(`${element(ready)} && ${element(itemField)}?.value === ${quote(itemId)} && ${element(typeField)}?.value === "stock_in"`,
        'most recently applied filters after retry')
      assert.equal(await page.evaluate('location.hash'), latest)
      assert.deepEqual(await persisted(page), before)
    }
  }))

  await test('a loaded application records inventory and stock while browser networking is disabled', () => withContext(async (makePage) => {
    const page = await makePage()
    await dashboard(page)
    const before = await persisted(page)
    await page.cdp('Network.enable')
    const conditions = { latency: 0, downloadThroughput: -1, uploadThroughput: -1 }
    await page.cdp('Network.emulateNetworkConditions', { ...conditions, offline: true })
    try {
      await page.until(content('[data-browser-status-label]', 'Browser offline'), 'browser-reported offline status')
      assert.match(await page.evaluate(element('.app-topbar') + '.textContent'), /Sync not configured/)
      await capture(page, 'loaded-app-browser-offline-1440x900')
      await fillCategory(page, 'Category saved while disconnected')
      await page.click(saveCategory)
      await savedCategory(page)
      const categorized = await persisted(page)
      assert.equal(categorized.categories.length, before.categories.length + 1)
      assert.equal(commitSequence(categorized), 1)
      const itemId = fixtureItem(before)
      const originalBalance = before.stock_movements.filter(({ item_id }) => item_id === itemId)
        .reduce((sum, { quantity_change }) => sum + quantity_change, 0)
      await prepareReceipt(page, itemId, 2)
      await recordMovement(page)
      assertOneReceipt(categorized, await persisted(page), 2)
      await navigate(page, 'inventory', { item: itemId })
      await page.until(`Array.from(document.querySelectorAll('[aria-labelledby=item-details-title] dt'))
        .some(label => label.textContent === 'Available quantity' && label.nextElementSibling?.textContent.trim() === ${quote(originalBalance + 2 + ' pieces')})`,
        'updated inventory balance while offline')
      await settings(page, 2)
    } finally {
      await page.cdp('Network.emulateNetworkConditions', { ...conditions, offline: false })
    }
    await page.until(content('[data-browser-status-label]', 'Browser online'), 'browser-reported online status')
  }))
} finally {
  browser.close()
}
