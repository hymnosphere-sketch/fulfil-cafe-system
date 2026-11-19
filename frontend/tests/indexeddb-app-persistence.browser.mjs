import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, normalize } from 'node:path'
import test from 'node:test'
import { DATABASE_VERSION, DEMO_DATABASE_NAME, INVENTORY_STORES } from '../src/db/schema.js'
import { connectBrowser, element, quote, visible } from './browser-cdp.mjs'

// Use a fresh headless Chrome profile with --enable-automation. Run again with
// --reopen after restarting that same profile to compare every stored record.
const app = new URL(process.env.FE08_APP_URL ?? 'http://127.0.0.1:5196/')
const chrome = process.env.FE08_CHROME_URL ?? 'http://127.0.0.1:9228'
const profile = process.env.FE08_DEDICATED_PROFILE
const [output, phase] = process.argv.slice(2)
assert.ok(profile && isAbsolute(profile), 'Set FE08_DEDICATED_PROFILE to the dedicated test profile path')
assert.ok(output && isAbsolute(output), 'Pass an absolute evidence directory')
assert.ok(!phase || phase === '--reopen', 'Use --reopen only after restarting the dedicated Chrome profile')
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(app.hostname) && app.pathname === '/' && !app.search && !app.hash,
  'Use the local base URL without test controls or a hash')
const evidenceFile = join(output, 'persistence-records.json')
const categoryName = 'FE-08C fictional serving supplies'
const itemName = 'FE-08C fictional sample cups'
const expectedMovements = [
  { workflow: 'receive', type: 'stock_in', signed: 20, balance: 20 },
  { workflow: 'usage', type: 'stock_out', signed: -5, balance: 15 },
  { workflow: 'wastage', type: 'wastage', signed: -2, balance: 13 },
  { workflow: 'adjustment', direction: 'positive', type: 'positive_adjustment', signed: 1, balance: 14 },
  { workflow: 'adjustment', direction: 'negative', type: 'negative_adjustment', signed: -4, balance: 10 },
]

const browser = await connectBrowser(chrome)
let context
try {
  const { arguments: switches } = await browser.commandLine()
  const actualProfile = switches.find((arg) => arg.startsWith('--user-data-dir='))?.split('=').slice(1).join('=')
  const samePath = (path) => process.platform === 'win32' ? normalize(path).toLowerCase() : normalize(path)
  assert.ok(switches.some((arg) => /^--headless(?:=|$)/.test(arg)) && actualProfile &&
    samePath(actualProfile) === samePath(profile), 'Chrome is running headless in the explicitly designated test profile')
  context = await browser.context({ persistent: true })
  const page = await context.page()

  async function route(name, params) {
    const hash = '#/' + name + (params ? '?' + new URLSearchParams(params) : '')
    await page.evaluate('location.hash = ' + quote(hash))
    await page.until('location.hash === ' + quote(hash), name + ' route')
  }

  async function capture(name, selector) {
    await page.evaluate(`(async () => {
      await document.fonts.ready
      const target = ${selector ? visible(selector) : 'null'}
      if (target) target.scrollIntoView({ block: 'center', behavior: 'instant' })
      else window.scrollTo({ top: 0, behavior: 'instant' })
      await new Promise(requestAnimationFrame)
    })()`)
    const { data } = await page.cdp('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(output, name + '.png'), Buffer.from(data, 'base64'))
  }

  async function ready() {
    await page.goto(app.href)
    await page.until('location.hash === "#/dashboard" && document.querySelector("[data-storage-state=ready]") && document.querySelector("[data-dashboard-results][aria-busy=false]")',
      'default Dashboard after IndexedDB opens')
  }

  async function readRecords() {
    return page.evaluate(`(async () => {
      const keys = ${quote(Object.fromEntries(Object.entries(INVENTORY_STORES).map(([store, schema]) => [store, schema.keyPath])))}
      const request = indexedDB.open(${quote(DEMO_DATABASE_NAME)})
      const database = await new Promise((resolve, reject) => {
        request.onupgradeneeded = () => request.transaction.abort()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      try {
        const stores = Object.keys(keys)
        const transaction = database.transaction(stores)
        const contents = await Promise.all(stores.map(async (store) => {
          const request = transaction.objectStore(store).getAll()
          const records = await new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
          })
          return [store, records.sort((a, b) => String(a[keys[store]]).localeCompare(String(b[keys[store]])))]
        }))
        return { version: database.version, ...Object.fromEntries(contents) }
      } finally {
        database.close()
      }
    })()`)
  }

  async function balance(item, quantity) {
    await route('inventory', { item })
    await page.until(`document.querySelector('#item-details-title')?.textContent === ${quote(itemName)} &&
      Array.from(document.querySelectorAll('[aria-labelledby="item-details-title"] dt')).some(dt =>
        dt.textContent === 'Available quantity' && dt.nextElementSibling.textContent.trim() === ${quote(quantity + ' pieces')})`,
    'Inventory balance of ' + quantity + ' pieces')
  }

  async function agreement(item, afterReload) {
    await route('dashboard')
    await page.until(`document.querySelector('[data-dashboard-results][aria-busy=false]')?.textContent.includes(${quote(itemName)})`,
      'Dashboard recent movements use the committed item')
    await route('categories')
    await page.until(`document.querySelector('[data-inventory-results]')?.textContent.includes(${quote(categoryName)})`, 'Categories shows the committed record')
    await route('history', { item })
    await page.until('document.querySelector("[data-history-count]")?.textContent === "5 movements found"', 'Transaction History shows five movements')
    if (afterReload) await capture('transaction-history-after-refresh')
    await route('reports', { view: 'movements', itemId: item })
    await page.until(`document.querySelector('#report-itemId')?.value === ${quote(item)} &&
      document.querySelector('[data-report-count]')?.textContent.startsWith('Showing 5 of ')`, 'Reports shows the five committed movements')
    if (afterReload) await capture('reports-after-refresh')
    await route('settings')
    await page.until(`document.querySelector('[data-settings-schema-version]')?.textContent === ${quote(String(DATABASE_VERSION))} &&
      document.querySelector('[data-settings-queue-count]')?.textContent === '7'`, 'Settings shows the database version and seven queued operations')
    if (afterReload) await capture('settings-queue-seven')
  }

  async function prepareStock(item, batch, movement) {
    await route('stock', { workflow: movement.workflow, item })
    await page.until(`document.querySelector('#stock-item')?.value === ${quote(item)}`, 'Stock form for the committed item')
    if (movement.direction) await page.setField('#stock-direction', movement.direction)
    await page.setField('#stock-quantity', String(Math.abs(movement.signed)))
    if (batch) await page.setField('[data-stock-batch-id=' + quote(batch) + ']', String(Math.abs(movement.signed)))
    await page.setField('#stock-reason', 'FE-08C fictional ' + movement.workflow)
    await page.click('[data-stock-preview]')
  }

  function checkQueue(records, category, item) {
    const queue = [...records.synchronization_queue].sort((a, b) => a.local_sequence - b.local_sequence)
    assert.deepEqual(queue.map((entry) => entry.local_sequence), [1, 2, 3, 4, 5, 6, 7])
    assert.equal(records.application_settings.find((setting) => setting.setting_key === 'demo_repository').last_sequence, 7)
    const movementIds = queue.slice(2).map((entry) => entry.entity_id)
    assert.deepEqual(queue.map((entry) => entry.entity_id), [category, item, ...movementIds])
    assert.equal(new Set(queue.map((entry) => entry.operation_id)).size, 7)
    assert.deepEqual(queue.map((entry) => entry.operation_type), ['create_category', 'create_item', ...expectedMovements.map(() => 'record_stock_movement')])
    for (const entry of queue) {
      assert.ok(entry.operation_id && entry.operation_id !== entry.entity_id && entry.created_at)
      assert.deepEqual(
        [entry.wire_version, entry.status, entry.resolution_status, entry.retry_count, entry.last_attempt_at, entry.last_error, entry.fictional, entry.upload_eligible],
        [1, 'pending', 'none', 0, null, null, true, false],
      )
    }
    assert.equal(queue[0].payload.category_id, category)
    assert.equal(queue[1].payload.item_id, item)
    assert.equal(queue[1].payload.category_id, category)
    assert.equal(queue[1].payload.minimum_stock_level, 5)
    assert.equal(records.categories.find((record) => record.category_id === category)?.name, categoryName)
    assert.equal(records.inventory_items.find((record) => record.item_id === item)?.name, itemName)
    assert.equal(records.stock_movements.filter((movement) => movement.item_id === item).length, 5)
    const batches = records.stock_batches.filter((batch) => batch.item_id === item)
    assert.equal(batches.length, 1)
    const movements = movementIds.map((id) => records.stock_movements.find((movement) => movement.movement_id === id))
    assert.deepEqual(movements.map((movement) => [movement.item_id, movement.movement_type, movement.quantity_change]),
      expectedMovements.map(({ type, signed }) => [item, type, signed]))
    const allocations = records.batch_allocations.filter((allocation) => movementIds.includes(allocation.movement_id))
    assert.equal(allocations.length, 5)
    assert.ok(allocations.every((allocation) => allocation.batch_id === batches[0].batch_id))
    assert.equal(allocations.reduce((sum, { quantity_change }) => sum + quantity_change, 0), 10)
    queue.slice(2).forEach((entry, index) => {
      const { payload } = entry
      assert.equal(payload.movement_id, movements[index].movement_id)
      assert.equal(payload.quantity_change, movements[index].quantity_change)
      const allocation = allocations.find((row) => row.movement_id === payload.movement_id)
      assert.deepEqual(payload.allocations, [{
        allocation_id: allocation.allocation_id, batch_id: allocation.batch_id, quantity_change: allocation.quantity_change,
      }])
    })
  }

  if (phase === '--reopen') {
    await test('Chrome process reopen retains all committed records and application balances', async () => {
      const saved = JSON.parse(await readFile(evidenceFile, 'utf8'))
      assert.equal(saved.origin, app.origin)
      await ready()
      assert.deepEqual(await readRecords(), saved.records)
      checkQueue(saved.records, saved.category, saved.item)
      await balance(saved.item, 10)
      await agreement(saved.item, false)
    })
  } else {
    await test('application UI saves the seven-operation stock sequence across refresh', async () => {
      await mkdir(output, { recursive: true })
      await ready()
      const initial = await readRecords()
      assert.equal(initial.version, DATABASE_VERSION)
      assert.equal(initial.inventory_items.length, 13)
      assert.equal(initial.stock_movements.length, 22)
      assert.deepEqual(initial.synchronization_queue, [], 'Use a fresh dedicated test profile')
      await capture('dashboard-initialized')
      await route('categories')
      await page.click('[data-inventory-action="add-category"]')
      await page.setField('[data-inventory-form] [name="name"]', categoryName)
      await page.click('[data-inventory-form] [type="submit"]')
      await page.until(`document.querySelector('[data-inventory-results]')?.textContent.includes(${quote(categoryName)})`, 'category created through the application')
      const category = (await readRecords()).categories.find((record) => record.name === categoryName).category_id

      await route('inventory')
      await page.click('[data-inventory-action="add-item"]')
      await page.setField('[data-inventory-form] [name="name"]', itemName)
      await page.setField('[data-inventory-form] [name="category_id"]', category)
      await page.setField('[data-inventory-form] [name="unit_of_measurement"]', 'pieces')
      await page.setField('[data-inventory-form] [name="minimum_stock_level"]', '5')
      await capture('inventory-item-creation', '[data-inventory-form]')
      await page.click('[data-inventory-form] [type="submit"]')
      await page.until(`document.querySelector('[data-inventory-results]')?.textContent.includes(${quote(itemName)})`, 'item created through the application')
      const item = (await readRecords()).inventory_items.find((record) => record.name === itemName).item_id
      let batch
      for (const movement of expectedMovements) {
        await prepareStock(item, batch, movement)
        await page.until(`document.querySelector('[data-stock-confirmation] [data-stock-resulting-quantity]')?.textContent.trim() === ${quote(movement.balance + ' pieces')}`,
          movement.workflow + ' preview balance')
        if (!batch) await capture('stock-movement-confirmation', '[data-stock-confirmation]')
        await page.evaluate(`(() => {
          const confirm = document.querySelector('[data-stock-confirm]')
          confirm.click()
          confirm.click()
        })()`)
        await page.until(element('#stock-result-heading') + '?.textContent === "Movement recorded"', movement.workflow + ' saved')
        if (!batch) batch = (await readRecords()).stock_batches.find((record) => record.item_id === item).batch_id
        await balance(item, movement.balance)
      }

      await capture('inventory-ten-before-refresh', '[aria-labelledby="item-details-title"]')
      const committed = await readRecords()
      checkQueue(committed, category, item)
      await prepareStock(item, batch, { workflow: 'usage', signed: -11 })
      await page.until('document.querySelector("[data-stock-field-error], [data-stock-form-error]")?.textContent.includes("does not have enough stock")', '11-piece deduction rejected')
      assert.equal(await page.evaluate('Boolean(document.querySelector("[data-stock-confirmation]"))'), false)
      assert.deepEqual(await readRecords(), committed)
      await agreement(item, false)

      await balance(item, 10)
      await page.reload()
      await page.until('document.querySelector("[data-storage-state=ready]")', 'IndexedDB ready after refresh')
      await balance(item, 10)
      await capture('inventory-ten-after-refresh', '[aria-labelledby="item-details-title"]')
      await agreement(item, true)
      assert.deepEqual(await readRecords(), committed)
      await writeFile(evidenceFile, JSON.stringify({ origin: app.origin, category, item, records: committed }, null, 2))
    })
  }
  assert.deepEqual(page.exceptions, [], 'no uncaught browser exceptions')
  assert.deepEqual(page.consoleErrors, [], 'no browser console errors')
} finally {
  await context?.dispose()
  browser.close()
}
