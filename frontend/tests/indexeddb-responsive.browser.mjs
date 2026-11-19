import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import test from 'node:test'
import { connectBrowser, element, quote, visible } from './browser-cdp.mjs'

const app = process.env.INDEXEDDB_APP_URL ?? 'http://127.0.0.1:5196/'
const chrome = process.env.INDEXEDDB_CHROME_URL ?? 'http://127.0.0.1:9228'
const screenshots = process.argv[2] && resolve(process.argv[2])
const ready = '[data-storage-state="ready"]'
const menu = '[data-menu-toggle]'
const collapse = '[data-sidebar-toggle]'
const closeMenu = '.app-sidebar__close'
const title = '#page-title'

const routes = [
  ['dashboard', 'Dashboard', '[data-dashboard-results][aria-busy="false"]', '.dashboard-quick-actions .btn-primary'],
  ['inventory', 'Inventory', '[data-inventory-content][aria-busy="false"]', '[data-inventory-action="add-item"]'],
  ['categories', 'Categories', '[data-inventory-content][aria-busy="false"]', '[data-inventory-action="add-category"]'],
  ['stock', 'Stock Management', '[data-stock-content][aria-busy="false"]', '[data-stock-workflow="receive"]'],
  ['history', 'Transaction History', '[data-history-content][aria-busy="false"]', '[data-history-filters] [type="submit"]'],
  ['reports', 'Reports', '[data-report-content][aria-busy="false"]', '[data-report-filters] [type="submit"]'],
  ['settings', 'Settings', '[data-settings-queue-count]', null],
]

async function capture(page, filename, selector) {
  if (!screenshots) return
  await page.evaluate('document.fonts.ready.then(() => true)')
  const clip = selector && await page.evaluate(`(() => {
    const { x, y, width, height } = ${element(selector)}.getBoundingClientRect()
    return { x, y, width, height, scale: 1 }
  })()`)
  const { data } = await page.cdp('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: false, ...(clip && { clip }),
  })
  await writeFile(join(screenshots, filename), Buffer.from(data, 'base64'))
}

async function assertNoOverflow(page, detail) {
  assert.equal(await page.evaluate(
    'document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth',
  ), true, detail + ' fits the viewport')
}

async function targetSize(page, selector) {
  const size = await page.evaluate(`(() => {
    const rect = ${visible(selector)}?.getBoundingClientRect()
    return rect && { width: rect.width, height: rect.height }
  })()`)
  assert.ok(size?.width >= 48 && size.height >= 48, selector + ' meets the 48 × 48 primary touch target')
}

async function press(page, key, windowsVirtualKeyCode) {
  const options = { key, code: key, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode }
  if (key === 'Enter') {
    // Chromium's native Enter activation needs the character event as well as keydown.
    await page.cdp('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', unmodifiedText: '\r', ...options })
  } else {
    await page.cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...options })
  }
  await page.cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...options })
}

async function assertFocusVisible(page, selector) {
  await page.until(`(() => {
    const focus = document.activeElement
    if (focus !== ${element(selector)} || !focus.matches(':focus-visible')) return false
    const style = getComputedStyle(focus)
    return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2
  })()`, selector + ' visibly focused by keyboard')
}

async function checkNavigationControls(page, narrow, width) {
  const toggle = narrow ? menu : collapse
  await targetSize(page, toggle)
  await page.evaluate(element(toggle) + '.focus()')
  await press(page, 'Enter', 13)
  await page.until(element(toggle) + '.getAttribute("aria-expanded") === ' + (narrow ? '"true"' : '"false"'),
    'navigation toggled by keyboard')
  if (narrow) {
    await page.until('document.querySelector("#app-sidebar.show") && document.querySelector(".app-workspace").inert',
      'open drawer traps keyboard focus')
    await assertFocusVisible(page, closeMenu)
    await targetSize(page, closeMenu)
    await assertNoOverflow(page, 'navigation drawer')
    if (width === 390) await capture(page, 'navigation-drawer-narrow.png')
    await press(page, 'Escape', 27)
    await assertFocusVisible(page, menu)
    assert.equal(await page.evaluate('document.querySelector(".app-workspace").inert'), false)
  } else {
    assert.equal(await page.evaluate(element(collapse) + '.getAttribute("aria-label")'), 'Expand sidebar')
    await assertFocusVisible(page, collapse)
    await targetSize(page, '[data-route="dashboard"]')
    await press(page, 'Enter', 13)
    await page.until(element(collapse) + '.getAttribute("aria-expanded") === "true"', 'expanded sidebar restored')
  }
}

async function navigate(page, [id, label, content, action], narrow) {
  if (narrow) {
    await page.click(menu)
    await page.until('document.querySelector("#app-sidebar.show")', 'navigation drawer displayed')
  }
  const link = '[data-route="' + id + '"]'
  await targetSize(page, link)
  assert.equal(await page.evaluate(element(link) + '.getAttribute("aria-label")'), label)
  await page.click(link)
  await page.until(`location.hash === ${quote('#/' + id)} && ${element(title)}?.textContent === ${quote(label)}
    && ${element(content)} && document.activeElement === ${element(title)}`, label + ' rendered and focused')
  assert.equal(await page.evaluate(element(link) + '.getAttribute("aria-current")'), 'page')
  assert.ok(await page.evaluate(element(ready)), label + ' shows ready local storage')
  await assertNoOverflow(page, label)
  if (action) await targetSize(page, action)
}

async function checkSettings(page) {
  const schema = await page.evaluate(`new Promise((resolve, reject) => {
    const request = indexedDB.open('fulfil-cafe-demo-inventory')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('synchronization_queue')
      const count = transaction.objectStore('synchronization_queue').count()
      transaction.onabort = () => { database.close(); reject(transaction.error) }
      transaction.oncomplete = () => {
        resolve({ version: database.version, count: count.result })
        database.close()
      }
    }
  })`)
  assert.deepEqual(schema, { version: 1, count: 0 })
  assert.equal(await page.evaluate(element('[data-settings-schema-version]') + '.textContent'), String(schema.version))
  assert.equal(await page.evaluate(element('[data-settings-queue-count]') + '.textContent'), String(schema.count))
  const text = await page.evaluate('document.querySelector("main").innerText')
  for (const label of [
    'Fictional demonstration', 'Local storage ready', 'IndexedDB', 'Queued fictional operations',
    'Sync not configured', 'Backups\nUnavailable', 'Demonstration business date\n2026-11-19',
    'ineligible for upload', 'browser data is cleared or lost',
  ]) assert.ok(text.includes(label), 'Settings explains ' + label)
  assert.equal(await page.evaluate('document.querySelectorAll("main button, main input").length'), 0,
    'ready Settings has no hidden mutation controls')
}

async function checkAnnouncements(page) {
  assert.equal(await page.evaluate(element('[data-storage-status]') + '.getAttribute("role")'), 'status')
  assert.equal(await page.evaluate(element('[data-browser-status]') + '.getAttribute("role")'), 'status')
  const { nodes } = await page.cdp('Accessibility.getFullAXTree')
  assert.ok(nodes.some(({ ignored, role, name }) =>
    !ignored && role.value === 'StaticText' && name?.value === 'Local storage ready'), 'storage status reaches the accessibility tree')
  assert.ok(nodes.some(({ ignored, role, name }) =>
    !ignored && role.value === 'StaticText' && name?.value === 'Browser online'), 'connectivity status reaches the accessibility tree')
}

const delayedOpen = `(() => {
  const open = IDBFactory.prototype.open
  IDBFactory.prototype.open = function () {
    const pending = new EventTarget()
    pending.error = new DOMException('Simulated storage permission error', 'SecurityError')
    window.completeTestFailure = () => {
      IDBFactory.prototype.open = open
      pending.dispatchEvent(new Event('error'))
    }
    return pending
  }
})()`

async function checkLoadingAndRetry(context, width, height, narrow) {
  const page = await context.page({ width, height, script: delayedOpen })
  try {
    await page.goto(app)
    await page.until(element('[data-storage-panel="opening"] [role="status"]'), 'accessible opening panel')
    assert.equal(await page.evaluate('document.querySelector("[data-dashboard-results]")'), null)
    await assertNoOverflow(page, 'opening panel')
    if (narrow) {
      await page.click(menu)
      await page.until('document.querySelector("#app-sidebar.show")', 'drawer while storage is opening')
    }
    await page.click('[data-route="inventory"]')
    await page.until(`location.hash === "#/inventory" && document.activeElement === ${element(title)}`,
      'inventory route navigates while storage is opening')
    assert.equal(await page.evaluate('document.querySelector("[data-inventory-action=add-item]")'), null)
    await page.evaluate('window.completeTestFailure()')
    await page.until(element('[data-storage-panel="unavailable"] [role="alert"]'), 'accessible storage error panel')
    assert.equal(await page.evaluate('document.querySelector("[data-inventory-action=add-item]")'), null)
    await assertNoOverflow(page, 'storage error panel')
    await targetSize(page, '[data-storage-retry]')
    await press(page, 'Tab', 9)
    await assertFocusVisible(page, '[data-storage-retry]')
    await press(page, 'Enter', 13)
    await page.until(`${element(ready)} && ${element('[data-inventory-content][aria-busy="false"]')}`,
      'retry unlocks Inventory and reads local contents')
    assert.equal(await page.evaluate('document.activeElement.id'), 'page-title')
    assert.deepEqual(page.exceptions, [])
    assert.deepEqual(page.consoleErrors, [])
  } finally {
    await page.close()
  }
}

async function runViewport(browser, width, height) {
  const context = await browser.context()
  try {
    const page = await context.page({ width, height })
    await page.goto(app)
    await page.until(`location.hash === "#/dashboard" && ${element(ready)} && ${element(routes[0][2])}`,
      'hashless base opens the fully initialized Dashboard')
    const narrow = width < 992
    await assertNoOverflow(page, 'Dashboard')
    await checkAnnouncements(page)
    assert.match(await page.evaluate('document.querySelector(".app-topbar").innerText'), /Sync not configured/)
    if (width === 1440) {
      await capture(page, 'initialized-dashboard-desktop.png')
      await capture(page, 'storage-connectivity-status-desktop.png', '.app-topbar__statuses')
    }
    if (width === 390) await capture(page, 'dashboard-narrow.png')

    await checkNavigationControls(page, narrow, width)
    for (const route of routes) await navigate(page, route, narrow)
    await checkSettings(page)
    const settingsScreenshot = {
      1440: 'settings-desktop.png',
      1280: 'settings-tablet-landscape.png',
      800: 'settings-tablet-portrait.png',
    }[width]
    if (settingsScreenshot) await capture(page, settingsScreenshot)
    assert.deepEqual(page.exceptions, [])
    assert.deepEqual(page.consoleErrors, [])
    await page.close()
    await checkLoadingAndRetry(context, width, height, narrow)
  } finally {
    await context.dispose()
  }
}

if (screenshots) {
  const fromTemp = relative(tmpdir(), screenshots)
  assert.ok(fromTemp && !fromTemp.startsWith('..') && !isAbsolute(fromTemp), 'evidence must be in a dedicated temporary folder')
  await mkdir(screenshots, { recursive: true })
}

const browser = await connectBrowser(chrome)
try {
  for (const [width, height] of [[1440, 900], [1280, 800], [800, 1280], [390, 844]]) {
    await test('persistent app responsive navigation and storage readiness at ' + width + ' × ' + height, () =>
      runViewport(browser, width, height))
  }
} finally {
  browser.close()
}
