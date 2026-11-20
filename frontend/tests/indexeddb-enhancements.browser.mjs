import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, normalize } from 'node:path'
import test from 'node:test'
import { connectBrowser, element, quote } from './browser-cdp.mjs'

const app = process.env.FE08_APP_URL ?? 'http://127.0.0.1:5196/'
const browser = await connectBrowser(process.env.FE08_CHROME_URL ?? 'http://127.0.0.1:9228')
const evidence = process.argv[2]
const phase = process.argv[3]
const itemForm = '[data-inventory-form]'
const categoryForm = '[data-inline-category-form]'
const categorySelect = '#demo-field-category_id'
const createCategory = categoryForm + ' [type="submit"]'
const saveItem = itemForm + ' [type="submit"]'
const confirmName = '[data-inventory-action="confirm-duplicate"]'
const duplicateWarning = '[data-duplicate-warning]'
const packaging = '00000000-0000-4000-8000-000000000004'
const cups = '00000000-0000-4000-8000-000000000109'
const ready = element('[data-storage-state=ready]')
const categoryName = '#demo-inline-category-name'
const description = '#demo-inline-category-description'
const contains = (selector, text) => element(selector) + '?.textContent.includes(' + quote(text) + ')'
const value = (selector) => element(selector) + '?.value'

async function withPage(probe, viewport) {
  const context = await browser.context()
  const pages = []
  const newPage = async (options) => {
    const page = await context.page(options)
    pages.push(page)
    await page.goto(app)
    await page.until(ready, 'fictional storage ready')
    return page
  }
  try {
    await probe(await newPage(viewport), newPage)
    for (const page of pages) {
      assert.deepEqual(page.exceptions, [])
      assert.deepEqual(page.consoleErrors, [])
    }
  } finally { await context.dispose() }
}

async function capture(page, filename, selector) {
  if (!evidence) return
  await page.cdp('Page.bringToFront')
  await page.evaluate('(async () => { await document.fonts.ready; ' + element(selector) +
    '.scrollIntoView({block:"center",behavior:"instant"}); await new Promise(requestAnimationFrame) })()')
  const { data } = await page.cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(evidence, filename + '.png'), Buffer.from(data, 'base64'))
}

function navigate(page, route) {
  return page.evaluate('location.hash = ' + quote('#/' + route))
}

async function prepareItem(page, name, id) {
  await navigate(page, 'inventory')
  await page.click(id ? '[data-inventory-action="edit-item"][data-id=' + quote(id) + ']' : '[data-inventory-action="add-item"]')
  await page.setField('#demo-field-name', name)
  if (!id) {
    await page.setField(categorySelect, packaging)
    await page.setField('#demo-field-unit_of_measurement', 'pieces')
  }
  await page.setField('#demo-field-minimum_stock_level', '27')
}

async function openCategory(page, name, details = 'Fictional description') {
  await page.setField(categorySelect, 'create-category')
  await page.until('document.activeElement.id === "demo-inline-category-name"', 'category name focused')
  assert.equal(await page.evaluate('document.querySelector("form form") === null'), true)
  await page.setField(categoryName, name)
  await page.setField(description, details)
}

async function selectSavedCategory(page, name) {
  await page.until(contains('[data-inline-category-feedback]', name) + ' && !' + element(categoryForm), 'category saved and selected')
  assert.equal(await page.evaluate(element(categorySelect) + '.selectedOptions[0].textContent'), name)
  return page.evaluate(value(categorySelect))
}

async function rawData() {
  const { openInventoryDatabase, runTransaction, requestResult } = await import('/src/db/database.js')
  const database = await openInventoryDatabase()
  const stores = [...database.objectStoreNames]
  try {
    return await runTransaction(database, stores, 'readonly', async (tx) => Object.fromEntries(await Promise.all(
      stores.map(async (store) => [store, await requestResult(tx.objectStore(store).getAll())]),
    )))
  } finally { database.close() }
}

const dump = (page) => page.evaluate('(' + rawData + ')()')
const marker = (state) => state.application_settings.find(({ setting_key }) => setting_key === 'demo_repository').last_sequence

function assertQueue(state, types) {
  assert.equal(Object.keys(state).length, 8)
  const entries = state.synchronization_queue.toSorted((a, b) => a.local_sequence - b.local_sequence)
  assert.deepEqual(entries.map(({ operation_type }) => operation_type), types)
  assert.deepEqual(entries.map(({ local_sequence }) => local_sequence), types.map((_, index) => index + 1))
  assert.ok(entries.every(({ fictional, upload_eligible }) => fictional && upload_eligible === false))
  assert.equal(marker(state), types.length)
}

async function savedItem(page) {
  await page.until(contains('[data-inventory-feedback]', 'item saved') + ' && !' + element(itemForm), 'item saved')
}

async function putStockReceiptFault(attemptId, fault) {
  const { openInventoryDatabase, runTransaction, requestResult } = await import('/src/db/database.js')
  const name = 'application_settings'
  const db = await openInventoryDatabase()
  try {
    await runTransaction(db, [name], 'readwrite', async (tx) => {
      const store = tx.objectStore(name)
      const receipt = await requestResult(store.get('demo_stock_attempt:' + attemptId))
      const { result } = receipt
      if (fault === 'quantity 10 to 91') result.movement.quantity_change = result.resultingQuantity = 91
      if (fault === 'movement identity') result.movement.movement_id = result.batch.batch_id
      if (fault === 'movement timestamp') result.movement.created_at = '2026-11-10T00:00:00.000Z'
      if (fault === 'allocation quantity') result.allocations[0].quantity_change = 91
      if (fault === 'missing allocation') result.allocations = []
      if (fault === 'duplicated allocation') result.allocations[1] = result.allocations[0]
      if (fault === 'allocation identity') result.allocations[0].allocation_id = result.batch.batch_id
      if (fault === 'batch reference') result.allocations[0].batch_id = result.movement.movement_id
      if (fault === 'batch metadata') result.batch.purchase_date = '2026-11-09'
      if (fault === 'historic resulting balance') result.resultingQuantity += 1
      await requestResult(store.put(receipt))
    })
  } finally { db.close() }
}

async function recordReceipt({ itemId, ids = [], followup = false }) {
  const { createPersistentInventoryRepository } = await import('/src/data/persistent-inventory-repository.js')
  const repo = createPersistentInventoryRepository({ createId: () => ids.shift() ?? crypto.randomUUID() })
  const fields = { itemId, unit: 'pieces', scale: 0 }
  try {
    const receipt = await repo.previewStockMovement({ ...fields, type: 'stock_in', quantity: 10 })
    const result = await repo.recordStockMovement(receipt.attemptId)
    if (followup) {
      const usage = await repo.previewStockMovement({ ...fields, type: 'stock_out', quantity: 3,
        allocations: [{ batchId: result.batch.batch_id, quantity: 3 }] })
      await repo.recordStockMovement(usage.attemptId)
    }
    return result
  } finally { await repo.close() }
}

async function replayReceipt(attemptId) {
  const { createPersistentInventoryRepository } = await import('/src/data/persistent-inventory-repository.js')
  const repo = createPersistentInventoryRepository()
  try { return await repo.recordStockMovement(attemptId) } catch (error) { return { code: error.code } }
  finally { await repo.close() }
}

async function runFocused() {
  if (evidence) await mkdir(evidence, { recursive: true })
  await test('inline Add commits one category, selects it, preserves the draft, then separately saves the item', () => withPage(async (page) => {
    await prepareItem(page, 'Fictional glass stirrers')
    assert.equal(await page.evaluate(element(categorySelect + ' option[value=create-category]') + '.textContent'), '+ Create new category')
    const before = await dump(page)
    await openCategory(page, 'Fictional beverage accessories')
    await capture(page, '01-category-dropdown-option', categorySelect)
    await capture(page, '02-inline-category-form', categoryForm)
    assert.deepEqual(await dump(page), before)
    await page.evaluate('(() => { const button = ' + element(createCategory) + '; button.click(); button.click() })()')
    const id = await selectSavedCategory(page, 'Fictional beverage accessories')
    assert.equal(await page.evaluate('document.activeElement.id'), 'demo-field-category_id')
    assert.deepEqual(await page.evaluate('[' + ['#demo-field-name', '#demo-field-unit_of_measurement', '#demo-field-minimum_stock_level'].map(value) + ']'),
      ['Fictional glass stirrers', 'pieces', '27'])
    await capture(page, '03-category-selected-with-draft', categorySelect)
    const added = await dump(page)
    assert.equal(added.categories.length, before.categories.length + 1)
    assert.deepEqual(added.inventory_items, before.inventory_items)
    assert.equal(added.categories.find((row) => row.category_id === id).description, 'Fictional description')
    assertQueue(added, ['create_category'])
    await page.click(saveItem)
    await savedItem(page)
    const completed = await dump(page)
    assertQueue(completed, ['create_category', 'create_item'])
    assert.equal(completed.inventory_items.find(({ name }) => name === 'Fictional glass stirrers').category_id, id)
    await page.reload()
    await page.until(contains('[data-inventory-results]', 'Fictional glass stirrers'), 'saved item after refresh')
    assert.deepEqual(await dump(page), completed)
  }))

  await test('editing an item can cancel inline creation, then save a category that survives cancelling the item', () => withPage(async (page) => {
    await prepareItem(page, 'Fictional cup reserve', cups)
    const before = await dump(page)
    await openCategory(page, 'Unused category draft')
    await page.click('[data-inventory-action="cancel-inline-category"]')
    assert.equal(await page.evaluate(value(categorySelect)), packaging)
    assert.equal(await page.evaluate('document.activeElement.id'), 'demo-field-category_id')
    assert.deepEqual(await dump(page), before)
    await openCategory(page, 'Retained accessory category')
    await page.click(createCategory)
    await selectSavedCategory(page, 'Retained accessory category')
    assert.equal(await page.evaluate(value('#demo-field-name')), 'Fictional cup reserve')
    await page.evaluate('window.confirm = message => { window.itemDiscard = message; return true }')
    await page.click('[data-inventory-action="cancel-form"]')
    await page.until('!'+element(itemForm), 'item draft closed')
    assert.match(await page.evaluate('window.itemDiscard'), /Discard unsaved changes/)
    const after = await dump(page)
    assertQueue(after, ['create_category'])
    assert.deepEqual(after.inventory_items, before.inventory_items)
    assert.equal(after.categories.length, before.categories.length + 1)
  }))

  await test('inline category rejects blank, active and archived names and preserves drafts on a native abort', () => withPage(async (page) => {
    const archived = await page.evaluate(`(async () => {
      const { createPersistentInventoryRepository } = await import('/src/data/persistent-inventory-repository.js')
      const repo = createPersistentInventoryRepository()
      try {
        const category = await repo.createCategory({name:'Archived fictional supplies'})
        await repo.archiveCategory(category.category_id)
        return category.name
      } finally { await repo.close() }
    })()`)
    await prepareItem(page, 'Fictional reusable basket')
    await openCategory(page, '   ')
    const before = await dump(page)
    for (const [name, message] of [['   ', 'Enter the name'], ['Packaging', 'different name'], [archived, 'different name']]) {
      await page.setField(categoryName, name)
      await page.click(createCategory)
      await page.until(contains(categoryName + '-error', message) + ' && document.activeElement.id === "demo-inline-category-name"', 'category validation focus')
      assert.match(await page.evaluate(element(categoryName) + '.getAttribute("aria-describedby")'), /name-error/)
      assert.equal(await page.evaluate(value('#demo-field-name')), 'Fictional reusable basket')
      assert.deepEqual(await dump(page), before)
    }
    await capture(page, '04-category-conflict-with-draft', categoryForm)
    await page.evaluate(`(() => {
      const add = IDBObjectStore.prototype.add
      IDBObjectStore.prototype.add = function (...args) {
        const request = add.apply(this, args)
        if (this.name === 'categories') {
          IDBObjectStore.prototype.add = add
          request.addEventListener('success', () => this.transaction.abort(), { once:true })
        }
        return request
      }
    })()`)
    await page.setField(categoryName, 'Fictional woven containers')
    await page.click(createCategory)
    await page.until(contains('[data-inline-category-error]', 'aborted'), 'native abort shown in inline form')
    assert.equal(await page.evaluate(value(categoryName)), 'Fictional woven containers')
    assert.equal(await page.evaluate(value(description)), 'Fictional description')
    assert.deepEqual(await dump(page), before)
    await page.click(createCategory)
    await selectSavedCategory(page, 'Fictional woven containers')
    assertQueue(await dump(page), ['create_category', 'archive_category', 'create_category'])
  }))

  await test('two tabs creating the same category serialize and the losing draft remains editable', () => withPage(async (a, newPage) => {
    const b = await newPage()
    await prepareItem(a, 'Fictional split tray')
    await prepareItem(b, 'Fictional storage jar')
    await openCategory(a, 'Fictional Novel Containers')
    await openCategory(b, '  fictional  novel containers ')
    await Promise.all([a.click(createCategory), b.click(createCategory)])
    for (const page of [a, b]) await page.until(element('[data-inline-category-feedback]') + ' || ' + element(categoryName + '-error'), 'one result for each tab')
    const outcomes = await Promise.all([a, b].map((page) => page.evaluate('Boolean(' + element('[data-inline-category-feedback]') + ')')))
    assert.equal(outcomes.filter(Boolean).length, 1)
    const failed = outcomes[0] ? b : a
    assert.match(await failed.evaluate(value('#demo-field-name')), /Fictional (split tray|storage jar)/)
    assertQueue(await dump(failed), ['create_category'])
  }))

  await test('a closed storage connection keeps both drafts through the application Retry gate', () => withPage(async (page) => {
    await prepareItem(page, 'Fictional tea holders')
    await openCategory(page, 'Fictional service containers')
    const before = await dump(page)
    await page.evaluate(`(() => {
      const transaction = IDBDatabase.prototype.transaction
      IDBDatabase.prototype.transaction = function (stores, mode, ...options) {
        if (mode === 'readwrite') {
          IDBDatabase.prototype.transaction = transaction
          throw new DOMException('Fictional connection closed', 'InvalidStateError')
        }
        return transaction.call(this, stores, mode, ...options)
      }
    })()`)
    await page.click(createCategory)
    await page.until(element('[data-storage-retry]'), 'storage recovery is offered')
    assert.deepEqual(await dump(page), before)
    await page.click('[data-storage-retry]')
    await page.until(ready + ' && ' + element(categoryForm), 'both forms reopen after Retry')
    assert.equal(await page.evaluate(value('#demo-field-name')), 'Fictional tea holders')
    assert.equal(await page.evaluate(value(categoryName)), 'Fictional service containers')
    assert.equal(await page.evaluate(value(description)), 'Fictional description')
    await page.click(createCategory)
    await selectSavedCategory(page, 'Fictional service containers')
    assertQueue(await dump(page), ['create_category'])
  }))

  await test('duplicate cards show compact and spelling reasons and cross-tab changes require new approval', () => withPage(async (a, newPage) => {
    await prepareItem(a, 'Chocolate Syrup')
    await a.click(saveItem)
    await savedItem(a)
    await prepareItem(a, 'Chocolatesyrup')
    await a.click(saveItem)
    await a.until(contains('[data-match-reason=compact]', 'Chocolate Syrup'), 'compact match for missing space')
    await capture(a, '07-chocolate-syrup-compact', duplicateWarning)
    await a.setField('#demo-field-name', 'Chocolate-Syrup')
    await a.click(saveItem)
    await a.until(contains('[data-match-reason=compact]', 'Chocolate Syrup'), 'hyphen compact match')
    await capture(a, '08-chocolate-hyphen-compact', duplicateWarning)
    await a.setField('#demo-field-name', 'Choclate Syrup')
    await a.click(saveItem)
    await a.until(contains('[data-match-reason=spelling]', 'Similar spelling'), 'spelling warning')
    await capture(a, '09-chocolate-spelling', duplicateWarning)

    const b = await newPage()
    await prepareItem(b, 'Chocolate-Syrup')
    await b.click(saveItem)
    await b.click(confirmName)
    await savedItem(b)
    const before = await dump(b)
    await a.click(confirmName)
    await a.until(contains(duplicateWarning, 'Review the updated list'), 'stale spelling approval rejected')
    assert.equal(await a.evaluate(value('#demo-field-name')), 'Choclate Syrup')
    assert.deepEqual(await dump(a), before)
    await capture(a, '11-renewed-duplicate-approval', duplicateWarning)
    await a.click(confirmName)
    await savedItem(a)
    assertQueue(await dump(a), ['create_item', 'create_item', 'create_item'])

    await prepareItem(a, 'Chocolate Syrup')
    await a.click(saveItem)
    await a.until('document.querySelectorAll("[data-match-reason]").length === 3', 'all reasons appear once')
    assert.deepEqual(await a.evaluate('Array.from(document.querySelectorAll("[data-match-reason]"), row => row.dataset.matchReason)'),
      ['normalized', 'compact', 'spelling'])
    await capture(a, '10-multiple-duplicate-reasons', duplicateWarning)
    await openCategory(a, 'Fictional syrup display shelf')
    await a.click(createCategory)
    await selectSavedCategory(a, 'Fictional syrup display shelf')
    assert.equal(await a.evaluate('Boolean('+element(duplicateWarning)+')'), false)
    await a.click(saveItem)
    await a.until(element(duplicateWarning), 'changed category requires a new duplicate review')
    assertQueue(await dump(a), ['create_item', 'create_item', 'create_item', 'create_category'])
  }))

  for (const [width, height] of [[1440, 900], [1280, 800], [800, 1280], [390, 844]]) {
    await test('inline category and duplicate controls fit at ' + width + ' × ' + height, () => withPage(async (page) => {
      await prepareItem(page, 'VanillaSyrup')
      await page.click(saveItem)
      await page.until(element(duplicateWarning), 'compact warning at the viewport')
      assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true)
      await openCategory(page, 'UnbrokenFictionalLabel'.repeat(6))
      assert.equal(await page.evaluate(`(() => {
        const panel = document.querySelector('[data-inline-category-form]')
        return panel.scrollWidth <= panel.clientWidth + 2 && document.documentElement.scrollWidth <= innerWidth &&
          [...panel.querySelectorAll('button,input,textarea')].every(control => control.getBoundingClientRect().height >= 48)
      })()`), true)
      await page.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
      await page.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
      assert.equal(await page.evaluate('document.activeElement.id'), 'demo-inline-category-description')
      assert.equal(await page.evaluate('document.activeElement.matches(":focus-visible")'), true)
      if (width === 800 || width === 390) await capture(page, width === 800 ? '05-inline-category-tablet' : '06-inline-category-mobile', categoryForm)
      await page.click(createCategory)
      await selectSavedCategory(page, 'UnbrokenFictionalLabel'.repeat(6))
      assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true)
    }, { width, height }))
  }

  await test('healthy confirmations return the original result after reopening and later movements', () => withPage(async (page) => {
    const result = await page.evaluate('(' + recordReceipt + ')({itemId:' + quote(cups) + ',followup:true})')
    const before = await dump(page)
    for (let retry = 0; retry < 2; retry += 1) {
      assert.deepEqual(await page.evaluate('(' + replayReceipt + ')(' + quote(result.movement.movement_id) + ')'), { ...result, alreadyRecorded: true })
    }
    assertQueue(before, ['record_stock_movement', 'record_stock_movement'])
    assert.deepEqual(await dump(page), before)
  }))

  for (const fault of ['quantity 10 to 91', 'movement identity', 'movement timestamp', 'allocation quantity', 'missing allocation',
    'duplicated allocation', 'allocation identity', 'batch reference', 'batch metadata', 'historic resulting balance']) {
    await test('receipt retry rejects ' + fault + ' and preserves every store', () => withPage(async (page) => {
      const result = await page.evaluate('(' + recordReceipt + ')({itemId:' + quote(cups) + '})')
      const id = quote(result.movement.movement_id)
      await page.evaluate('(' + putStockReceiptFault + ')(' + id + ',' + quote(fault) + ')')
      const before = await dump(page)
      assert.deepEqual(await page.evaluate('(' + replayReceipt + ')(' + id + ')'), { code: 'DB_INTEGRITY' })
      assert.deepEqual(await dump(page), before)
      assertQueue(before, ['record_stock_movement'])
    }))
  }

  await test('an invalid saved receipt gates the application and storage Retry never changes records', () => withPage(async (page) => {
    await navigate(page, 'stock?workflow=receive&item=' + cups)
    await page.setField('#stock-quantity', '10')
    await page.evaluate(`(() => {
      window.receiptPreviewIds = []
      const makeId = crypto.randomUUID.bind(crypto)
      crypto.randomUUID = () => { const id = makeId(); window.receiptPreviewIds.push(id); return id }
    })()`)
    await page.click('[data-stock-preview]')
    await page.until(element('[data-stock-confirmation]'), 'prepared receipt')
    const ids = await page.evaluate('window.receiptPreviewIds')
    assert.equal(ids.length, 3)
    const result = await page.evaluate('(' + recordReceipt + ')({itemId:' + quote(cups) + ',ids:' + quote(ids) + '})')
    assert.equal(result.movement.movement_id, ids[0])
    await page.evaluate('(' + putStockReceiptFault + ')(' + quote(ids[0]) + ',"quantity 10 to 91")')
    const before = await dump(page)
    await page.click('[data-stock-confirm]')
    await page.until(contains('[data-storage-panel=invalid]', 'could not be validated'), 'integrity error blocks recording')
    assert.equal(await page.evaluate('Boolean('+element('[data-stock-confirm]')+')'), false)
    await capture(page, '12-stock-receipt-integrity-gate', 'main')
    assert.deepEqual(await dump(page), before)
    await page.click('[data-storage-retry]')
    await page.until(contains('[data-storage-panel=invalid]', 'could not be validated'), 'retry still gates on the known damaged receipt')
    assert.deepEqual(await dump(page), before)
    assert.deepEqual(await page.evaluate('(' + replayReceipt + ')(' + quote(ids[0]) + ')'), { code: 'DB_INTEGRITY' })
    assert.deepEqual(await dump(page), before)
  }))
}

async function verifyInlineRestart() {
  assert.ok(phase === '--seed-restart' || phase === '--verify-restart')
  const profile = process.env.FE08_DEDICATED_PROFILE
  assert.ok(profile && isAbsolute(profile) && evidence && isAbsolute(evidence), 'Use dedicated profile and evidence directories')
  assert.equal(new URL(app).hostname, 'localhost', 'Use a separate origin from the 127.0.0.1 baseline scenario')
  const { arguments: switches } = await browser.commandLine()
  const declared = switches.find((arg) => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length)
  assert.ok(switches.some((arg) => /^--headless(?:=|$)/.test(arg)) && declared &&
    normalize(declared).toLowerCase() === normalize(profile).toLowerCase(), 'Use the isolated headless profile')
  const path = join(evidence, 'inline-restart-records.json')
  const category = 'Fictional retained serving tools'
  const renamed = 'Fictional iced tumblers'
  const context = await browser.context({ persistent: true })
  try {
    const page = await context.page()
    await page.goto(app)
    await page.until(ready, 'storage ready')
    if (phase === '--seed-restart') {
      await test('an inline category and its subsequent item edit persist before Chrome closes', async () => {
        assertQueue(await dump(page), [])
        await prepareItem(page, renamed, cups)
        await openCategory(page, category)
        await page.click(createCategory)
        const id = await selectSavedCategory(page, category)
        await page.click(saveItem)
        await savedItem(page)
        const data = await dump(page)
        assertQueue(data, ['create_category', 'update_item'])
        assert.equal(data.inventory_items.find(({ item_id }) => item_id === cups).category_id, id)
        await writeFile(path, JSON.stringify({ id, data }))
      })
    } else {
      await test('a full Chrome restart preserves the category, edited item and queue', async () => {
        const { id, data } = JSON.parse(await readFile(path, 'utf8'))
        const after = await dump(page)
        assert.deepEqual(after, data)
        assertQueue(after, ['create_category', 'update_item'])
        await prepareItem(page, renamed, cups)
        assert.equal(await page.evaluate(value(categorySelect)), id)
        assert.equal(await page.evaluate(element(categorySelect) + '.selectedOptions[0].textContent'), category)
        assert.deepEqual(await dump(page), data)
      })
    }
    assert.deepEqual(page.exceptions, [])
    assert.deepEqual(page.consoleErrors, [])
  } finally { await context.dispose() }
}

// Hold delivery of a real IndexedDB outcome after the native transaction has
// already settled. Other tabs and fresh reads continue to use committed data.
async function holdTransactionResult(page, event, mode = 'readwrite', { statusOnly = false, release = 'releaseTestTransaction' } = {}) {
  await page.evaluate(`(() => {
    const prototype = IDBTransaction.prototype
    const listen = prototype.addEventListener
    window[${quote(release)}] = null
    prototype.addEventListener = function (type, listener, options) {
      const matchesStores = ${statusOnly}
        ? this.objectStoreNames.length === 2 && this.objectStoreNames.contains('synchronization_queue')
        : this.objectStoreNames.contains('inventory_items')
      if (type !== ${quote(event)} || this.mode !== ${quote(mode)} || !matchesStores) return listen.call(this, type, listener, options)
      prototype.addEventListener = listen
      return listen.call(this, type, function (result) {
        window[${quote(release)}] = () => listener.call(this, result)
      }, options)
    }
  })()`)
}

async function submitWithHeldResult(page, event) {
  await holdTransactionResult(page, event)
  await page.evaluate(`(() => {
    const button = ${element(createCategory)}
    button.click()
    button.click()
  })()`)
  await page.until('typeof window.releaseTestTransaction === "function"', 'native write settled before app receives its result')
}

async function releaseResult(page, release = 'releaseTestTransaction') {
  await page.evaluate('new Promise(resolve => { window[' + quote(release) + '](); setTimeout(resolve, 0) })')
}

async function itemDraftValues(page) {
  return page.evaluate('[' + ['#demo-field-name', '#demo-field-unit_of_measurement', '#demo-field-minimum_stock_level'].map(value) + ']')
}

function committedInlineCategory(before, after, name) {
  assertQueue(after, ['create_category'])
  assert.equal(after.categories.length, before.categories.length + 1)
  assert.deepEqual(after.inventory_items, before.inventory_items)
  const { entity_id, payload } = after.synchronization_queue[0]
  assert.equal(payload.name, name)
  assert.equal(after.categories.find(({ category_id }) => category_id === entity_id).name, name)
  return entity_id
}

async function archiveInAnotherTab(page, id) {
  await navigate(page, 'categories')
  await page.click('[data-inventory-action="archive-category"][data-id=' + quote(id) + ']')
  await page.click('[data-inventory-action="confirm-archive"]')
  await page.until(contains('[data-inventory-feedback]', 'category archived'), 'archive committed in second tab')
}

async function processRefreshWhileBusy(page, change) {
  const release = 'releaseTestStatus'
  await holdTransactionResult(page, 'complete', 'readonly', { statusOnly: true, release })
  await change()
  await page.until('typeof window[' + quote(release) + '] === "function"', 'cross-tab status read ready')
  await releaseResult(page, release)
  assert.equal(await page.evaluate(element(categoryForm + ' fieldset') + '.disabled'), true)
}

async function addInlineCategory(page, name) {
  await openCategory(page, name)
  await page.click(createCategory)
  return selectSavedCategory(page, name)
}

async function addCategoryInAnotherTab(page, name) {
  await navigate(page, 'categories')
  await page.click('[data-inventory-action="add-category"]')
  await page.setField('#demo-field-name', name)
  await page.click(itemForm + ' [type="submit"]')
  await page.until(contains('[data-inventory-feedback]', 'category saved'), 'unrelated category committed in another tab')
}

async function runDeferredRefresh() {
  if (evidence) await mkdir(evidence, { recursive: true })
  const status = '[data-inline-category-status]'
  const rejection = contains(categoryName + '-error', 'different name') + ' && !' + element(categoryForm + ' fieldset[disabled]')
  const archivedSelectionCleared = value(categorySelect) + ' === "" && ' + contains(status, 'no longer available')
  const categoryOption = (id) => element(categorySelect + ' option[value=' + quote(id) + ']')

  for (const { mode, itemId, viewport } of [
    { mode: 'Add item' }, { mode: 'Edit item on mobile', itemId: cups, viewport: { width: 390, height: 844 } },
  ]) await test('archiving the selected category during a second rejected creation clears it on cancel in ' + mode, () => withPage(async (a, open) => {
    const b = await open()
    const item = 'Fictional coffee tasting tumblers'
    const category = 'Fictional coffee tasting glassware'
    await prepareItem(a, item, itemId)
    const before = await dump(a)
    const id = await addInlineCategory(a, category)
    assert.equal(committedInlineCategory(before, await dump(a), category), id)
    if (!itemId) await capture(a, '01-original-category-selected', itemForm)
    await openCategory(a, 'Packaging', 'Fictional second category draft')
    await submitWithHeldResult(a, 'abort')
    if (!itemId) await capture(a, '02-second-category-creating', categoryForm)
    await processRefreshWhileBusy(a, () => archiveInAnotherTab(b, id))
    const archived = await dump(b)
    assertQueue(archived, ['create_category', 'archive_category'])
    assert.equal(archived.categories.find(({ category_id }) => category_id === id).is_active, false)
    assert.deepEqual(archived.inventory_items, before.inventory_items)
    assert.deepEqual(archived.stock_movements, before.stock_movements)
    assert.deepEqual(archived.batch_allocations, before.batch_allocations)

    await releaseResult(a)
    await a.until(rejection, 'rejection visible with controls restored')
    assert.equal(await a.evaluate(value(description)), 'Fictional second category draft')
    if (!itemId) await capture(a, '03-duplicate-rejection-recovery', categoryForm)
    await a.click('[data-inventory-action="cancel-inline-category"]')
    await a.until('!' + element(categoryForm) + ' && ' + element('[data-inventory-content][aria-busy=false]'), 'item form restored')
    assert.equal(await a.evaluate(value(categorySelect)), '', 'archived category must not remain selected')
    assert.equal(await a.evaluate(element(categorySelect) + '.selectedOptions[0].textContent'), 'Choose an active category')
    assert.equal(await a.evaluate('Boolean(' + categoryOption(id) + ')'), false)
    assert.equal(await a.evaluate(contains(status, 'no longer available')), true)
    assert.equal(await a.evaluate('document.activeElement.id'), 'demo-field-category_id')
    assert.deepEqual(await itemDraftValues(a), [item, 'pieces', '27'])
    assert.deepEqual(await dump(a), archived)
    if (itemId) {
      assert.equal(await a.evaluate('document.documentElement.scrollWidth <= innerWidth && ' +
        element(categorySelect) + '.getBoundingClientRect().height >= 48'), true)
      await capture(a, '06-mobile-recovery-state', status)
      return
    }
    await capture(a, '04-archive-cleared-after-cancel', itemForm)

    const alternative = 'Fictional replacement glassware'
    await addInlineCategory(a, alternative)
    const after = await dump(a)
    assertQueue(after, ['create_category', 'archive_category', 'create_category'])
    assert.equal(after.categories.length, archived.categories.length + 1)
    assert.deepEqual(after.inventory_items, before.inventory_items)
    await capture(a, '05-alternative-category-selected', itemForm)
  }, viewport))

  await test('multiple unrelated category notifications coalesce into one reconciliation and leave a valid selection intact', () => withPage(async (a, open) => {
    const b = await open()
    const category = 'Fictional lasting serviceware'
    await prepareItem(a, 'Fictional tasting spoons')
    const id = await addInlineCategory(a, category)
    await openCategory(a, 'Packaging')
    await submitWithHeldResult(a, 'abort')
    await a.evaluate(`(() => {
      const transaction = IDBDatabase.prototype.transaction
      window.reconciliationReads = 0
      IDBDatabase.prototype.transaction = function (stores, mode, ...options) {
        if (mode === 'readonly' && stores.includes('inventory_items') && !stores.includes('staff_users')) window.reconciliationReads++
        return transaction.call(this, stores, mode, ...options)
      }
    })()`)
    for (const name of ['Fictional unrelated spice pockets', 'Fictional unrelated spoon cubbies']) {
      await processRefreshWhileBusy(a, () => addCategoryInAnotherTab(b, name))
    }
    assert.equal(await a.evaluate('window.reconciliationReads'), 0)
    const unrelated = await dump(b)
    assertQueue(unrelated, ['create_category', 'create_category', 'create_category'])
    await releaseResult(a)
    await a.until(rejection, 'failure restored after the deferred read')
    await a.click('[data-inventory-action="cancel-inline-category"]')
    assert.equal(await selectSavedCategory(a, category), id)
    assert.equal(await a.evaluate('window.reconciliationReads'), 1)
    assert.deepEqual(await dump(a), unrelated)
  }))

  await test('a successful second creation selects the valid new category after the original is archived', () => withPage(async (a, open) => {
    const b = await open()
    await prepareItem(a, 'Fictional reusable pitchers')
    const before = await dump(a)
    const prior = await addInlineCategory(a, 'Fictional old serving reserve')
    const category = 'Fictional replacement serving reserve'
    await openCategory(a, category)
    await submitWithHeldResult(a, 'complete')
    await processRefreshWhileBusy(a, () => archiveInAnotherTab(b, prior))
    const committed = await dump(b)
    assertQueue(committed, ['create_category', 'create_category', 'archive_category'])
    assert.equal(committed.categories.length, before.categories.length + 2)
    assert.deepEqual(committed.inventory_items, before.inventory_items)
    await releaseResult(a)
    const selected = await selectSavedCategory(a, category)
    assert.equal(committed.categories.find(({ category_id }) => category_id === selected).is_active, true)
    assert.equal(await a.evaluate('Boolean(' + categoryOption(prior) + ')'), false)
    assert.deepEqual(await itemDraftValues(a), ['Fictional reusable pitchers', 'pieces', '27'])
    assert.deepEqual(await dump(a), committed)
  }))

  await test('a held reconciliation cannot overwrite a returning draft or newer keyboard selection', () => withPage(async (a, open) => {
    const b = await open()
    await prepareItem(a, 'Fictional service jars', cups)
    const id = await addInlineCategory(a, 'Fictional outgoing serving supplies')
    await openCategory(a, 'Packaging', 'Fictional pending label draft')
    await submitWithHeldResult(a, 'abort')
    await processRefreshWhileBusy(a, () => addCategoryInAnotherTab(b, 'Fictional unrelated storage trays'))
    const delayedRead = 'releaseTestInventoryRead'
    await holdTransactionResult(a, 'complete', 'readonly', { release: delayedRead })
    await releaseResult(a)
    await a.until('typeof window[' + quote(delayedRead) + '] === "function"', 'reconciliation read captured before it can render')
    assert.equal(await a.evaluate(contains(status, 'saved and selected')), false)
    const name = '#demo-field-name'
    await a.setField(name, 'Fictional service jars updated')
    await navigate(a, 'dashboard')
    await a.until(contains('#page-title', 'Dashboard'), 'left during reconciliation')
    await navigate(a, 'inventory')
    await a.until(rejection, 'returning form renders the settled error')
    await a.evaluate(element(name) + '.focus(); ' + element(name) + '.setSelectionRange(10, 17)')
    await archiveInAnotherTab(b, id)
    await a.until('!' + categoryOption(id), 'returning mount reconciles a newer archive')
    await releaseResult(a, delayedRead)
    assert.equal(await a.evaluate('Boolean(' + categoryOption(id) + ')'), false)
    assert.deepEqual(await a.evaluate('[document.activeElement.id, document.activeElement.selectionStart, document.activeElement.selectionEnd]'),
      ['demo-field-name', 10, 17])
    assert.equal(await a.evaluate(value(description)), 'Fictional pending label draft')
    const latest = await dump(b)
    assertQueue(latest, ['create_category', 'create_category', 'archive_category'])
    await a.click('[data-inventory-action="cancel-inline-category"]')
    await a.until(archivedSelectionCleared, 'item draft reflects archived category')
    assert.deepEqual(await itemDraftValues(a), ['Fictional service jars updated', 'pieces', '27'])
    assert.deepEqual(await dump(a), latest)
  }))

  await test('a failed reconciliation read uses storage Retry and retains both drafts without writes', () => withPage(async (a, open) => {
    const b = await open()
    await prepareItem(a, 'Fictional cup carrying trays')
    const id = await addInlineCategory(a, 'Fictional carryout reserve')
    await openCategory(a, 'Packaging', 'Fictional retained category description')
    await submitWithHeldResult(a, 'abort')
    await processRefreshWhileBusy(a, () => archiveInAnotherTab(b, id))
    const archived = await dump(b)
    await a.evaluate(`(() => {
      const transaction = IDBDatabase.prototype.transaction
      IDBDatabase.prototype.transaction = function (stores, mode, ...options) {
        if (mode === 'readonly' && stores.includes('inventory_items')) {
          IDBDatabase.prototype.transaction = transaction
          throw new DOMException('Fictional reconciliation read failure', 'InvalidStateError')
        }
        return transaction.call(this, stores, mode, ...options)
      }
    })()`)
    await releaseResult(a)
    await a.until(element('[data-storage-retry]') + ' && !' + element(categorySelect), 'storage gate replaces the stale draft view')
    assert.deepEqual(await dump(a), archived)
    await a.click('[data-storage-retry]')
    await a.until(ready + ' && ' + rejection, 'Retry restores the draft and its validation')
    assert.equal(await a.evaluate(value(categoryName)), 'Packaging')
    assert.equal(await a.evaluate(value(description)), 'Fictional retained category description')
    await a.click('[data-inventory-action="cancel-inline-category"]')
    await a.until(archivedSelectionCleared, 'Retry uses the archived definition')
    assert.deepEqual(await itemDraftValues(a), ['Fictional cup carrying trays', 'pieces', '27'])
    assertQueue(archived, ['create_category', 'archive_category'])
    assert.deepEqual(await dump(a), archived)
  }))
}

async function runInlineLifecycle() {
  if (evidence) await mkdir(evidence, { recursive: true })
  const status = '[data-inline-category-status]'
  const error = categoryName + '-error'
  const unavailable = contains(status, 'no longer available') + ' && ' + value(categorySelect) + ' === ""'
  const busy = element(categoryForm + ' fieldset[disabled]') + ' && ' + contains(createCategory, 'Creating')

  for (const { label, returns, viewport, screenshot } of [
    { label: 'without navigation', returns: 0 },
    { label: 'after returning to Inventory', returns: 1, screenshot: 'desktop' },
    { label: 'after repeated navigation on mobile', returns: 2, viewport: { width: 390, height: 844 }, screenshot: 'mobile' },
  ]) {
    await test('duplicate category failure restores controls and both drafts ' + label, () => withPage(async (page) => {
      const item = 'Fictional durable trays'
      await prepareItem(page, item)
      await openCategory(page, 'Packaging', 'Fictional preserved category draft')
      const before = await dump(page)
      await submitWithHeldResult(page, 'abort')
      assert.deepEqual(await dump(page), before)
      for (let pass = 0; pass < returns; pass += 1) {
        await navigate(page, 'dashboard')
        await page.until(contains('#page-title', 'Dashboard'), 'left Inventory')
        await navigate(page, 'inventory')
        await page.until(busy, 'returning form reflects the still-pending operation')
      }
      if (screenshot === 'desktop') await capture(page, '01-creating-after-return', categoryForm)
      await releaseResult(page)
      await page.until(contains(error, 'different name') + ' && !' + element(categoryForm + ' fieldset[disabled]') +
        ' && document.activeElement.id === "demo-inline-category-name"', 'error shown and invalid field focused without leaving again')
      assert.equal(await page.evaluate(element(error) + '.getAttribute("role")'), 'alert')
      assert.match(await page.evaluate(element(categoryName) + '.getAttribute("aria-describedby")'), /name-error/)
      assert.equal(await page.evaluate(value(categoryName)), 'Packaging')
      assert.equal(await page.evaluate(value(description)), 'Fictional preserved category draft')
      assert.deepEqual(await itemDraftValues(page), [item, 'pieces', '27'])
      assert.deepEqual(await dump(page), before)
      if (screenshot === 'desktop') await capture(page, '02-failure-restores-controls', categoryForm)
      if (screenshot === 'mobile') {
        assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth && ' +
          element(createCategory) + '.getBoundingClientRect().height >= 48'), true)
        await capture(page, '06-mobile-validation-recovery', categoryForm)
      }
    }, viewport))
  }

  await test('returning Add item receives a committed category with focus and keeps a separate item save', () => withPage(async (page) => {
    const item = 'Fictional reserve baskets'
    const category = 'Fictional reserve service'
    await prepareItem(page, item)
    await openCategory(page, category)
    const before = await dump(page)
    await submitWithHeldResult(page, 'complete')
    await navigate(page, 'dashboard')
    await page.until(contains('#page-title', 'Dashboard'), 'dashboard opened')
    await navigate(page, 'inventory')
    await page.until(busy, 'pending form remounted')
    await releaseResult(page)
    const id = await selectSavedCategory(page, category)
    assert.equal(await page.evaluate('document.activeElement.id'), 'demo-field-category_id')
    assert.deepEqual(await itemDraftValues(page), [item, 'pieces', '27'])
    assert.equal(committedInlineCategory(before, await dump(page), category), id)
    await capture(page, '03-successful-completion-preserves-draft', itemForm)
    await page.setField(categorySelect, packaging)
    assert.equal(await page.evaluate(contains(status, 'saved and selected')), false)
    assert.equal(await page.evaluate('document.activeElement.id'), 'demo-field-category_id')
    await capture(page, '04-manual-selection-clears-feedback', itemForm)
    await page.setField(categorySelect, id)
    await selectSavedCategory(page, category)
    await page.click(saveItem)
    await savedItem(page)
    const after = await dump(page)
    assertQueue(after, ['create_category', 'create_item'])
    assert.equal(after.inventory_items.find(({ name }) => name === item).category_id, id)
  }))

  await test('returning Edit item keeps newer keyboard focus and text selection after repeated navigation', () => withPage(async (page) => {
    const initial = await dump(page)
    const category = 'Fictional tray reserve'
    await prepareItem(page, 'Fictional chilled cups', cups)
    await openCategory(page, category)
    await submitWithHeldResult(page, 'complete')
    for (const route of ['dashboard', 'categories']) {
      await navigate(page, route)
      await page.until('location.hash === ' + quote('#/' + route) + ' && !' + element(categoryForm), 'visited another module')
      await navigate(page, 'inventory')
      await page.until(busy, 'pending edit returned')
    }
    const item = 'Fictional chilled mugs'
    await page.setField('#demo-field-name', item)
    await page.evaluate(`${element('#demo-field-name')}.focus(); ${element('#demo-field-name')}.setSelectionRange(10, 17)`)
    await releaseResult(page)
    const id = await selectSavedCategory(page, category)
    assert.deepEqual(await page.evaluate('[document.activeElement.id, document.activeElement.selectionStart, document.activeElement.selectionEnd]'),
      ['demo-field-name', 10, 17])
    assert.deepEqual(await itemDraftValues(page), [item, 'pieces', '27'])
    assert.equal(committedInlineCategory(initial, await dump(page), category), id)
    await page.click(saveItem)
    await savedItem(page)
    const after = await dump(page)
    assertQueue(after, ['create_category', 'update_item'])
    assert.equal(after.inventory_items.find(({ item_id }) => item_id === cups).category_id, id)
  }))

  await test('an inline save can complete while a separate Categories draft retains its values and focus', () => withPage(async (a, open) => {
    const b = await open()
    const category = 'Fictional transit shelf'
    const initial = await dump(a)
    await prepareItem(a, 'Fictional transit tongs')
    await openCategory(a, category)
    await submitWithHeldResult(a, 'complete')
    await navigate(a, 'categories')
    await a.click('[data-inventory-action="add-category"]')
    await a.setField('#demo-field-name', 'Unrelated category draft')
    await a.evaluate(element('#demo-field-name') + '.focus()')
    await b.evaluate(`window.inlineCommit = new Promise(resolve => {
      const channel = new BroadcastChannel('fulfil-cafe-demo-inventory')
      channel.addEventListener('message', () => { channel.close(); resolve(true) }, { once: true })
    }); true`)
    await releaseResult(a)
    assert.equal(await b.evaluate('window.inlineCommit'), true)
    assert.equal(await a.evaluate('location.hash'), '#/categories')
    assert.equal(await a.evaluate(value('#demo-field-name')), 'Unrelated category draft')
    assert.equal(await a.evaluate('document.activeElement.id'), 'demo-field-name')
    assert.equal(await a.evaluate('Boolean(' + element(status) + ')'), false)
    await navigate(a, 'inventory')
    const id = await selectSavedCategory(a, category)
    assert.equal(committedInlineCategory(initial, await dump(a), category), id)
  }))

  await test('inline completion leaves a linked item detail visible and returns to the updated draft', () => withPage(async (page) => {
    const category = 'Fictional linked serving shelf'
    const before = await dump(page)
    await prepareItem(page, 'Fictional linked serving tools')
    await openCategory(page, category)
    await submitWithHeldResult(page, 'complete')
    await navigate(page, 'inventory?item=' + cups)
    await page.until(element('#item-details-title'), 'linked detail replaced the form')
    const back = '[data-inventory-action="back-item"]'
    await page.evaluate(element(back) + '.focus()')
    await releaseResult(page)
    await page.until(element('[data-inventory-content][aria-busy=false]'), 'linked detail settled')
    assert.equal(await page.evaluate(element('#item-details-title') + '.textContent'), 'Iced cups')
    assert.equal(await page.evaluate('Boolean(' + element(itemForm) + ')'), false)
    assert.equal(await page.evaluate('document.activeElement === ' + element(back)), true)
    await page.click(back)
    const id = await selectSavedCategory(page, category)
    assert.equal(committedInlineCategory(before, await dump(page), category), id)
  }))

  await test('a category archived before acknowledgement is unavailable and another choice recovers the item', () => withPage(async (a, open) => {
    const b = await open()
    const category = 'Fictional rotating dry goods'
    const before = await dump(a)
    await prepareItem(a, 'Fictional storage platter')
    await openCategory(a, category)
    await submitWithHeldResult(a, 'complete')
    const id = committedInlineCategory(before, await dump(b), category)
    await archiveInAnotherTab(b, id)
    await releaseResult(a)
    await a.until(unavailable, 'archived result explained without claiming selection')
    assert.deepEqual(await itemDraftValues(a), ['Fictional storage platter', 'pieces', '27'])
    await capture(a, '05-category-unavailable-at-completion', itemForm)
    const archived = await dump(a)
    await a.click(saveItem)
    await a.until(contains('#demo-field-category_id-error', 'Choose an active category'), 'invalid category cannot be saved')
    assert.deepEqual(await dump(a), archived)
    await a.setField(categorySelect, packaging)
    assert.equal(await a.evaluate(contains(status, 'no longer available')), false)
    await a.click(saveItem)
    await savedItem(a)
    const after = await dump(a)
    assertQueue(after, ['create_category', 'archive_category', 'create_item'])
    assert.equal(after.inventory_items.find(({ name }) => name === 'Fictional storage platter').category_id, packaging)
  }))

  await test('cross-tab archive updates a focused selector and a late older read cannot restore stale feedback', () => withPage(async (a, open) => {
    const b = await open()
    const category = 'Fictional seasonal warehouse'
    await prepareItem(a, 'Fictional seasonal trays')
    await openCategory(a, category)
    await a.click(createCategory)
    const id = await selectSavedCategory(a, category)
    assert.equal(await a.evaluate('document.activeElement.id'), 'demo-field-category_id')
    await holdTransactionResult(a, 'complete', 'readonly')
    await b.evaluate(`(() => {
      const channel = new BroadcastChannel('fulfil-cafe-demo-inventory')
      channel.postMessage('inventory-committed')
      channel.close()
    })()`)
    await a.until('typeof window.releaseTestTransaction === "function"', 'read with active category held before rendering')
    await archiveInAnotherTab(b, id)
    await a.until(unavailable, 'newer read shows the archived category')
    await releaseResult(a)
    assert.equal(await a.evaluate(unavailable), true)
    assert.equal(await a.evaluate('document.activeElement.id'), 'demo-field-category_id')
    assert.deepEqual(await itemDraftValues(a), ['Fictional seasonal trays', 'pieces', '27'])
    assertQueue(await dump(a), ['create_category', 'archive_category'])
  }))

  await test('storage Retry rechecks a saved category and preserves the draft when it is no longer available', () => withPage(async (a, open) => {
    const b = await open()
    const category = 'Fictional replenishment cupboard'
    await prepareItem(a, 'Fictional reserve teaspoons')
    await openCategory(a, category)
    await a.click(createCategory)
    const id = await selectSavedCategory(a, category)
    await a.evaluate(`(() => {
      const transaction = IDBDatabase.prototype.transaction
      IDBDatabase.prototype.transaction = function (stores, mode, ...options) {
        if (stores.length === 2 && stores.includes('synchronization_queue')) {
          IDBDatabase.prototype.transaction = transaction
          throw new DOMException('Fictional connection closed', 'InvalidStateError')
        }
        return transaction.call(this, stores, mode, ...options)
      }
    })()`)
    await archiveInAnotherTab(b, id)
    await a.until(element('[data-storage-retry]'), 'storage recovery available')
    await a.click('[data-storage-retry]')
    await a.until(ready + ' && ' + unavailable, 'Retry uses current category status')
    assert.deepEqual(await itemDraftValues(a), ['Fictional reserve teaspoons', 'pieces', '27'])
    assertQueue(await dump(a), ['create_category', 'archive_category'])
  }))
}

try {
  if (phase === '--deferred-refresh') await runDeferredRefresh()
  else if (phase === '--lifecycle') await runInlineLifecycle()
  else if (phase) await verifyInlineRestart()
  else await runFocused()
} finally { browser.close() }
