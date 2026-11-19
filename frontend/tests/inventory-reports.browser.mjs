import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

// Run against Vite and an isolated headless Chrome with CDP enabled.
// Pass a directory as the first argument to save screenshots.
const app = process.env.REPORTS_APP_URL ?? 'http://127.0.0.1:5196/'
const chrome = process.env.REPORTS_CHROME_URL ?? 'http://127.0.0.1:9228'
const screenshots = process.argv[2]
const response = await fetch(chrome + '/json/new?about:blank', { method: 'PUT' })
assert.ok(response.ok, 'Chrome opened a test tab')
const target = await response.json()
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

const pending = new Map()
const exceptions = []
let nextCommand = 0
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data)
  if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text)
  const command = pending.get(message.id)
  if (!command) return
  pending.delete(message.id)
  if (message.error) command.reject(new Error(message.error.message))
  else command.resolve(message.result)
})

function cdp(method, params = {}) {
  const id = ++nextCommand
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const { result, exceptionDetails } = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
  return result.value
}

async function until(expression, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await evaluate(expression).catch(() => false)) return
    await delay(50)
  }
  assert.fail('Timed out waiting for ' + label + '. Page content: ' + await evaluate('document.querySelector("main")?.innerText.slice(0, 400)'))
}

const quote = JSON.stringify
const element = (selector) => 'document.querySelector(' + quote(selector) + ')'
const visible = (selector) => 'Array.from(document.querySelectorAll(' + quote(selector) + ')).find(node => node.getClientRects().length)'
const click = async (selector) => {
  await until(visible(selector), selector)
  await evaluate(visible(selector) + '.click()')
}
const setField = async (selector, value) => {
  await until(element(selector), selector)
  await evaluate(`(() => {
    const field = ${element(selector)}
    field.value = ${quote(value)}
    field.dispatchEvent(new Event(field.matches('select') ? 'change' : 'input', { bubbles: true }))
  })()`)
}
const route = (hash) => evaluate('location.hash = ' + quote('#/' + hash))
const reportForm = '[data-report-filters]'
const reportCount = element('[data-report-count]') + '?.textContent'
const reportNotice = element('[data-report-filter-notice]')
const params = 'Object.fromEntries(new URLSearchParams(location.hash.split("?")[1]))'
const allMovements = 'Showing 22 of 22 movement records in 22 groups'
const fixtureId = (number) => '00000000-0000-4000-8000-' + String(number).padStart(12, '0')
const reportHash = (view, filters) => 'reports?' + new URLSearchParams({ view, ...filters })

async function checkReset(field) {
  await until(`${reportCount} === ${quote(allMovements)} && ${reportNotice}?.hidden === false`, 'reset notice and baseline results')
  assert.deepEqual(await evaluate(params), { view: 'movements' })
  assert.equal(await evaluate(element(field) + '.value'), '')
  assert.equal(await evaluate(element('#report-item-selection') + '.hidden'), true)
  assert.equal(await evaluate(reportNotice + '.textContent'), 'Unavailable saved filters were cleared.')
  assert.equal(await evaluate('document.documentElement.scrollWidth === document.documentElement.clientWidth'), true)
}

async function capture(name) {
  if (!screenshots) return
  await evaluate(`(async () => {
    await document.fonts.ready
    const panel = document.querySelector('[data-report-filters]').closest('section')
    const topbar = document.querySelector('.app-topbar').getBoundingClientRect().height
    scrollTo({ top: scrollY + panel.getBoundingClientRect().top - topbar - 12, behavior: 'instant' })
    await new Promise(resolve => requestAnimationFrame(resolve))
  })()`)
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(screenshots, name + '.png'), Buffer.from(data, 'base64'))
}

async function checkRefreshedRecord(kind, size) {
  const isItem = kind === 'item'
  const name = 'Session-only report ' + kind
  const field = isItem ? '#report-itemId' : '#report-categoryId'
  const key = isItem ? 'itemId' : 'categoryId'
  const routeName = isItem ? 'inventory' : 'categories'
  const form = '[data-inventory-form]'
  await route(routeName)
  await click(`[data-inventory-action="add-${kind}"]`)
  await setField(form + ' [name="name"]', name)
  if (isItem) {
    await setField(form + ' [name="category_id"]', fixtureId(4))
    await setField(form + ' [name="unit_of_measurement"]', 'pieces')
    await setField(form + ' [name="minimum_stock_level"]', '5')
  }
  await click(form + ' button[type="submit"]')
  await until(`document.querySelector('[data-inventory-feedback]')?.textContent.includes(${quote('Demo ' + kind + ' saved')})`, 'session record saved')
  await route(reportHash('movements'))
  await until(`${reportCount} === ${quote(allMovements)}`, 'unfiltered fixture')
  const recordId = await evaluate(`Array.from(${element(field)}.options).find(option => option.text.includes(${quote(name)}))?.value`)
  assert.ok(recordId)
  await setField(field, recordId)
  await click(reportForm + ' [type="submit"]')
  assert.equal(await evaluate(params + '.' + key), recordId)
  assert.equal(await evaluate(reportCount), 'Showing 0 of 22 movement records')
  assert.equal(await evaluate(reportNotice + '.hidden'), true)
  if (isItem) assert.ok((await evaluate(element('#report-item-selection') + '.textContent')).includes(recordId))

  const historyLength = await evaluate('history.length')
  await cdp('Page.reload')
  await checkReset(field)
  assert.equal(await evaluate('history.length'), historyLength)
  await capture(`stock-movements-cleared-${kind}-${size}`)
}

try {
  await cdp('Runtime.enable')
  if (screenshots) await mkdir(screenshots, { recursive: true })
  await cdp('Page.navigate', { url: app })
  for (const [width, height] of [[1440, 900], [1280, 800], [800, 1280], [390, 844]]) {
    const size = width + 'x' + height
    await test('refresh normalizes session item and category filters at ' + size, async () => {
      await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
      await checkRefreshedRecord('item', size)
      await checkRefreshedRecord('category', size)
    })
  }

  await test('browser history preserves valid selections and replaces a stale entry without adding an entry', async () => {
    const itemId = fixtureId(101)
    const hash = reportHash('movements', { itemId, type: 'stock_in' })
    await route(hash)
    const matchesSavedSelection = `${element('#report-itemId')}?.value === ${quote(itemId)} && ${element('#report-type')}?.value === "stock_in"`
    await until(matchesSavedSelection, 'saved movement and item')
    const historyLength = await evaluate('history.length')
    await route(reportHash('restocking', { categoryId: 'unavailable' }))
    await until(`${reportNotice}?.hidden === false && location.hash === "#/reports?view=restocking"`, 'canonical restocking entry')
    assert.equal(await evaluate('history.length'), historyLength + 1)
    await evaluate('history.back()')
    await until(matchesSavedSelection, 'Back restored the valid movement filters')
    assert.ok((await evaluate(element('#report-item-selection') + '.textContent')).includes(itemId))
    await evaluate('history.forward()')
    await until(`${reportCount} === "Showing 5 of 5 restocking items"`, 'Forward restored corrected results')
    assert.equal(await evaluate('location.hash'), '#/reports?view=restocking')
  })

  await test('date validation survives URL repair and focuses the invalid bound on submission', async () => {
    await route(reportHash('movements', { categoryId: 'unavailable', fromDate: '2026-02-30' }))
    await until(`${element('#report-fromDate-error')}?.textContent === "Enter a valid start date."`, 'malformed calendar date')
    assert.deepEqual(await evaluate(params), { view: 'movements', fromDate: '2026-02-30' })
    await setField('#report-fromDate', '2026-11-20')
    await setField('#report-toDate', '2026-11-19')
    await click(reportForm + ' [type="submit"]')
    assert.equal(await evaluate(element('#report-toDate-error') + '.textContent'), 'Enter an end date on or after the start date.')
    assert.equal(await evaluate('document.activeElement.id'), 'report-toDate')
  })

  await test('retry after a failed repository read cleans up a stale saved selection', async () => {
    await evaluate(`(async () => {
      const { createReportsWorkspace } = await import('/src/pages/reports-workspace.js')
      const { createDemoInventoryRepository } = await import('/src/data/demo-inventory-repository.js')
      const fixture = createDemoInventoryRepository()
      const saved = new URLSearchParams({ view: 'movements', itemId: 'unavailable' })
      history.replaceState(history.state, '', '#/reports?' + saved)
      let firstRead = true
      const repository = { read: () => {
        if (firstRead) {
          firstRead = false
          throw new Error('Simulated read failure')
        }
        return fixture.read()
      } }
      createReportsWorkspace({ repository, renderIcons: () => {} }).mount(document.querySelector('main'), saved)
    })()`)
    await click('[data-report-retry]')
    await checkReset('#report-itemId')
    assert.equal(await evaluate(element('[data-report-content]') + '.getAttribute("aria-busy")'), 'false')
  })

  await test('the accessibility tree distinguishes receipt and usage links and History keeps exact filters', async () => {
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
    const fromDate = '2026-11-01'
    const toDate = '2026-11-30'
    const selector = 'a[aria-label^="View history for Whole milk"]'
    await route(reportHash('movements', { fromDate, toDate }))
    await until(visible(selector), 'Whole milk report groups')
    const { nodes } = await cdp('Accessibility.getFullAXTree')
    const names = nodes.filter(({ role, name }) => role?.value === 'link' && name?.value.startsWith('View history for Whole milk'))
      .map(({ name }) => name.value)
    assert.equal(names.length, 2)
    assert.ok(names.some((name) => /Item \S+ · Stock received · cartons · Transaction History/.test(name)))
    assert.ok(names.some((name) => /Item \S+ · Usage recorded · cartons · Transaction History/.test(name)))
    const usage = selector + '[href*="type=stock_out"]'
    assert.equal(await evaluate(visible(usage) + '.textContent'), 'View history')
    const href = await evaluate(visible(usage) + '.getAttribute("href")')
    const expected = new URLSearchParams(href.split('?')[1])
    await click(usage)
    await until(element('[data-history-count]') + '?.textContent === "1 movement found"', 'History drill-down result')
    assert.deepEqual(await evaluate(`['history-item', 'history-type', 'history-from', 'history-to'].map(id => document.getElementById(id).value)`),
      [expected.get('item'), 'stock_out', fromDate, toDate])
  })
  assert.deepEqual(exceptions, [], 'no uncaught browser exceptions')
} finally {
  socket.close()
  await fetch(chrome + '/json/close/' + target.id)
}
