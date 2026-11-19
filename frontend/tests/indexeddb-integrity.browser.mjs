import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { connectBrowser, element, quote } from './browser-cdp.mjs'

const app = process.env.FE08_APP_URL ?? 'http://127.0.0.1:5196/'
const browser = await connectBrowser(process.env.FE08_CHROME_URL ?? 'http://127.0.0.1:9228')
const screenshots = process.argv[2]
const form = '[data-inventory-form]'
const submit = form + ' [type="submit"]'
const confirm = '[data-inventory-action="confirm-duplicate"]'
const warning = '[data-duplicate-warning]'
const packaging = '00000000-0000-4000-8000-000000000004'
const cleaning = '00000000-0000-4000-8000-000000000005'
const ready = element('[data-storage-state="ready"]')
const itemName = 'Fictional paper cup reserve'

async function withContext(run) {
  const context = await browser.context()
  const pages = []
  try {
    await run(async () => {
      const page = await context.page()
      pages.push(page)
      await page.goto(app)
      await page.until(ready, 'application storage ready')
      return page
    })
    for (const page of pages) {
      assert.deepEqual(page.exceptions, [])
      assert.deepEqual(page.consoleErrors, [])
    }
  } finally {
    await context.dispose()
  }
}

async function capture(page, filename, target) {
  if (!screenshots) return
  // Chrome can suspend animation frames in the tab behind the second window.
  await page.cdp('Page.bringToFront')
  await page.evaluate(`(async () => {
    await document.fonts.ready
    const node = ${element(target)}
    const topbar = document.querySelector('.app-topbar').getBoundingClientRect().height
    scrollTo({ top: scrollY + node.getBoundingClientRect().top - topbar - 12, behavior: 'instant' })
    await new Promise(resolve => requestAnimationFrame(resolve))
  })()`)
  const { data } = await page.cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(screenshots, filename + '.png'), Buffer.from(data, 'base64'))
}

function navigate(page, route) {
  return page.evaluate('location.hash = ' + quote('#/' + route))
}

async function prepareItem(page, name, category = packaging, unit = 'pieces') {
  await navigate(page, 'inventory')
  await page.click('[data-inventory-action="add-item"]')
  for (const [field, value] of Object.entries({
    name, category_id: category, unit_of_measurement: unit, minimum_stock_level: '5',
  })) await page.setField(form + ' [name="' + field + '"]', value)
  await page.click(submit)
}

async function saved(page) {
  await page.until(`!document.querySelector(${quote(form)}) && document.querySelector('[data-inventory-feedback]')?.textContent.includes('item saved')`,
    'successful item save')
}

const rows = (page) => page.evaluate(`Array.from(document.querySelectorAll(${quote(warning + ' li')}), row => row.innerText.replace(/\\s+/g, ' ').trim())`)

// Runs in Chrome and opens a separate connection in the test's disposable context.
async function rawState() {
  const { openInventoryDatabase, runTransaction, requestResult } = await import('/src/db/database.js')
  const db = await openInventoryDatabase()
  const stores = [...db.objectStoreNames]
  try {
    return await runTransaction(db, stores, 'readonly', async (tx) => Object.fromEntries(await Promise.all(
      stores.map(async (name) => [name, await requestResult(tx.objectStore(name).getAll())]),
    )))
  } finally {
    db.close()
  }
}

const dump = (page) => page.evaluate('(' + rawState + ')()')
const revision = (state) => state.application_settings.find(({ setting_key }) => setting_key === 'demo_repository').last_sequence

async function duplicateScenario(makePage, change) {
  const a = await makePage()
  await prepareItem(a, itemName)
  await saved(a)
  const root = (await dump(a)).inventory_items.find(({ name }) => name === itemName)
  const b = await makePage()
  const draftName = 'FICTIONAL   paper cup reserve'
  await prepareItem(a, draftName)
  await a.until(element(warning), 'original duplicate warning')
  assert.match((await rows(a))[0], /Packaging.*0 pieces/)
  if (change === 'add') {
    await capture(a, 'duplicate-original-warning', warning)
    await prepareItem(b, itemName, cleaning, 'packs')
    await b.click(confirm)
  } else {
    await navigate(b, 'inventory')
    await b.click('[data-inventory-action="edit-item"][data-id="' + root.item_id + '"]')
    if (change === 'edit') {
      await b.setField(form + ' [name="category_id"]', cleaning)
      await b.setField(form + ' [name="unit_of_measurement"]', 'packs')
    } else {
      await b.setField(form + ' [name="name"]', 'Fictional renamed cups')
    }
    await b.click(submit)
  }
  await saved(b)
  const before = await dump(b)
  assert.equal(revision(before), 2)
  assert.equal(before.synchronization_queue.length, 2)
  assert.equal((await rows(a)).length, 1, 'background reads do not replace the reviewed rows')
  await a.click(confirm)
  if (change === 'rename') {
    await a.until(`!${element(warning)} && ${element('[data-form-error]')}?.textContent.includes('use Save item')`,
      'expired approval returns to ordinary submission')
  } else {
    await a.until(`${element(warning)}?.textContent.includes('Review the updated list')`, 'renewed warning renders')
    const updated = await rows(a)
    assert.equal(updated.length, change === 'add' ? 2 : 1)
    assert.ok(updated.some((row) => /Cleaning supplies.*0 packs/.test(row)))
    await capture(a, change === 'add' ? 'duplicate-added-match' : 'duplicate-material-change', warning)
    if (change === 'add') await capture(a, 'duplicate-preserved-draft', form)
  }
  assert.equal(await a.evaluate(element(form + ' [name="name"]') + '.value'), draftName)
  assert.deepEqual(await dump(a), before)
  await a.click(change === 'rename' ? submit : confirm)
  await saved(a)
  const after = await dump(a)
  assert.equal(revision(after), 3)
  assert.equal(after.synchronization_queue.length, 3)
  assert.equal(after.inventory_items.length, before.inventory_items.length + 1)
  if (change === 'add') await capture(a, 'duplicate-renewed-save', '[data-inventory-feedback]')
}

async function faultProbe({ storeName, field, value }) {
  const { createPersistentInventoryRepository } = await import('/src/data/persistent-inventory-repository.js')
  const { openInventoryDatabase, runTransaction, requestResult } = await import('/src/db/database.js')
  const repo = createPersistentInventoryRepository()
  const category = await repo.createCategory({ name: 'Fictional integrity supplies' })
  const item = await repo.createItem({
    name: 'Fictional integrity cups', category_id: category.category_id, unit_of_measurement: 'pieces', minimum_stock_level: '5',
  })
  const common = { itemId: item.item_id, unit: 'pieces', scale: 0 }
  const receive = await repo.previewStockMovement({ ...common, type: 'stock_in', quantity: 10 })
  const result = await repo.recordStockMovement(receive.attemptId)
  const usage = { ...common, type: 'stock_out', quantity: 3, allocations: [{ batchId: result.batch.batch_id, quantity: 3 }] }
  const oldPreview = await repo.previewStockMovement(usage)
  const raw = await openInventoryDatabase()
  const stores = [...raw.objectStoreNames]
  const dump = () => runTransaction(raw, stores, 'readonly', async (tx) => Object.fromEntries(await Promise.all(
    stores.map(async (name) => [name, await requestResult(tx.objectStore(name).getAll())]),
  )))
  const markerKey = 'demo_repository'
  const original = await dump()
  const command = original.synchronization_queue.find((entry) => entry.entity_id === receive.attemptId)
  const key = storeName === 'stock_movements' ? receive.attemptId : storeName === 'application_settings' ? markerKey : command.operation_id
  try {
    await runTransaction(raw, [storeName], 'readwrite', async (tx) => {
      const store = tx.objectStore(storeName)
      if (field === 'delete-row') {
        await requestResult(store.delete(key))
        return
      }
      const row = await requestResult(store.get(key))
      if (field === 'delete-order') delete row.demo_order
      else row[field] = value
      await requestResult(store.put(row))
    })
    const before = await dump()
    const failure = (operation) => operation().then(() => 'saved', (error) => error.code)
    const codes = [
      await failure(() => repo.createCategory({ name: 'Must not save' })),
      await failure(() => repo.recordStockMovement(oldPreview.attemptId)),
    ]
    await repo.close()
    const reopened = createPersistentInventoryRepository()
    codes.push(
      await failure(() => reopened.read()),
      await failure(() => reopened.previewStockMovement(usage)),
      await failure(() => reopened.recordStockMovement(receive.attemptId)),
    )
    await reopened.close()
    return { codes, before, after: await dump() }
  } finally {
    raw.close()
    await repo.close()
  }
}

const dataFaults = [
  ['order 3 becomes 1000', 'stock_movements', 'demo_order', 1000],
  ['duplicate order in the fixture prefix', 'stock_movements', 'demo_order', -1],
  ['missing order', 'stock_movements', 'delete-order'],
  ['zero order', 'stock_movements', 'demo_order', 0],
  ['fractional order', 'stock_movements', 'demo_order', 2.5],
  ['string order', 'stock_movements', 'demo_order', '3'],
  ['unsafe order', 'stock_movements', 'demo_order', Number.MAX_SAFE_INTEGER + 1],
  ['inconsistent committed sequence', 'application_settings', 'last_sequence', 4],
  ['invalid sequence metadata', 'application_settings', 'last_sequence', -1, 'DB_INVALID_METADATA'],
  ['missing stock command', 'synchronization_queue', 'delete-row'],
  ['command refers to a different movement', 'synchronization_queue', 'entity_id', '00000000-0000-4000-8000-000000000301'],
  ['local order disagrees with command sequence', 'stock_movements', 'demo_order', 2],
]

try {
  if (screenshots) await mkdir(screenshots, { recursive: true })
  for (const [change, description] of [
    ['add', 'adding a new match'], ['edit', 'editing a match category and unit'], ['rename', 'renaming the match away'],
  ]) {
    await test('two tabs require renewed duplicate approval after ' + description,
      () => withContext((makePage) => duplicateScenario(makePage, change)))
  }
  await test('both repositories require the same renewed approval after material changes', () => withContext(async (makePage) => {
    const page = await makePage()
    const reviews = await page.evaluate(`(async () => {
      const { createDemoInventoryRepository } = await import('/src/data/demo-inventory-repository.js')
      const { createPersistentInventoryRepository } = await import('/src/data/persistent-inventory-repository.js')
      const memory = createDemoInventoryRepository()
      const persistent = createPersistentInventoryRepository()
      const draft = { name: 'Single origin beans', category_id: ${quote(packaging)}, unit_of_measurement: 'bags', minimum_stock_level: '5' }
      const getWarning = (repo, duplicateApproval) => repo.createItem(draft, { duplicateApproval })
        .then(() => null, (error) => error.duplicateReview)
      const check = async (repo) => {
        const original = await getWarning(repo)
        await repo.updateCategory(original.matches[0].categoryId, { name: 'Fictional coffee reserve' })
        const movement = await repo.previewStockMovement({
          type: 'stock_in', itemId: original.matches[0].itemId, quantity: 1, unit: 'bags', scale: 0,
        })
        await repo.recordStockMovement(movement.attemptId)
        const before = JSON.stringify(await repo.read())
        const renewed = await getWarning(repo, original.approval)
        const unchanged = JSON.stringify(await repo.read()) === before
        const saved = await repo.createItem(draft, { duplicateApproval: renewed.approval })
        return { original, renewed, unchanged, savedName: saved.name }
      }
      try { return await Promise.all([check(memory), check(persistent)]) }
      finally { await persistent.close() }
    })()`)
    assert.ok(reviews[0].unchanged)
    assert.equal(reviews[0].renewed.matches[0].categoryName, 'Fictional coffee reserve')
    assert.equal(reviews[0].renewed.matches[0].availableQuantity, 7)
    assert.deepEqual(reviews[0], reviews[1])
  }))

  for (const [label, storeName, field, value, error = 'DB_INTEGRITY'] of dataFaults) {
    await test('native IndexedDB rejects inconsistent inventory with ' + label, () => withContext(async (makePage) => {
      const page = await makePage()
      const result = await page.evaluate(`(${faultProbe})(${quote({ storeName, field, value })})`)
      assert.deepEqual(result.codes, Array(5).fill(error))
      assert.equal(revision(result.before), storeName === 'application_settings' ? value : 3)
      assert.deepEqual(result.before, result.after)
      if (value !== 1000) return

      await page.reload()
      const gate = '[data-storage-panel="invalid"]'
      await page.until(element(gate), 'storage integrity error')
      await navigate(page, 'inventory')
      await page.until(element(gate) + ' && document.querySelector("#page-title")?.textContent === "Inventory"', 'inventory remains gated')
      assert.equal(await page.evaluate('document.querySelector("[data-inventory-action=add-item], [data-inventory-count]") === null'), true)
      await capture(page, 'storage-integrity-gate', 'main')
      await page.click('[data-storage-retry]')
      await page.until(element(gate), 'retry safely rejects the same corruption')
      assert.deepEqual(await dump(page), result.before)
    }))
  }
} finally {
  browser.close()
}
