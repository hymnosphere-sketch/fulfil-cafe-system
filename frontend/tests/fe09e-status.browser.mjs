import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { connectBrowser, quote } from './browser-cdp.mjs'

const app = new URL(process.env.FE09E_APP_URL ?? 'http://127.0.0.1:5173/')
const production = new URL(process.env.FE09E_PRODUCTION_URL ?? app)
const endpoint = process.env.FE09E_CHROME_URL ?? 'http://127.0.0.1:9222'
const evidence = process.env.FE09E_EVIDENCE
const reopening = process.argv.includes('--verify-restart')
assert.ok(!reopening || evidence, 'Restart verification requires a temporary evidence path')
assert.equal(app.hostname, '127.0.0.1')
assert.equal(production.hostname, '127.0.0.1')
const previewURL = new URL('/tests/fe09e-preview.html', app)
const browser = await connectBrowser(endpoint)
const context = await browser.context({ persistent: Boolean(evidence) })
const instrumentation = String.raw`
  window.previewRequests = [];
  window.previewDBOpens = [];
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    window.previewRequests.push(String(args[0]?.url ?? args[0]));
    return originalFetch.apply(this, args);
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (...args) {
    window.previewRequests.push(String(args[1]));
    return originalOpen.apply(this, args);
  };
  const originalBeacon = navigator.sendBeacon.bind(navigator);
  navigator.sendBeacon = (url, ...args) => {
    window.previewRequests.push(String(url));
    return originalBeacon(url, ...args);
  };
  const open = IDBFactory.prototype.open;
  IDBFactory.prototype.open = function (name, ...args) {
    window.previewDBOpens.push(name);
    return open.call(this, name, ...args);
  };
`
const page = await context.page({ script: instrumentation })
const badgeSelector = '[data-preview-badge] [data-sync-state]'
const panelSelector = '[data-preview-panel]'
const syncSelector = (field) => panelSelector + ' [data-sync-' + field + ']'

function run(tab, body, ...args) {
  return tab.evaluate('(' + body.toString() + ')(' + args.map(quote).join(',') + ')')
}

function status(tab, state) {
  return tab.until('document.querySelector(' + quote(badgeSelector) + ')?.dataset.syncState === ' + quote(state), state)
}

function field(tab, name) {
  return tab.evaluate('document.querySelector(' + quote(syncSelector(name)) + ')?.textContent')
}

async function counts(tab) {
  return Promise.all(['pending', 'confirmed', 'review'].map((name) => field(tab, name)))
}

function queueName(tab) {
  return tab.evaluate('new URL(location.href).searchParams.get("queue")')
}

async function createFixture(tab) {
  const previous = await queueName(tab)
  await tab.click('[data-create-fixture]')
  await tab.until('new URL(location.href).searchParams.get("queue") !== ' + quote(previous), 'new fixture queue')
  await status(tab, 'pending')
  return queueName(tab)
}

async function deliverFixture(tab, outcome, expected) {
  await tab.setField('#fixture-outcome', outcome)
  await tab.click('[data-run-fixture]')
  await status(tab, expected)
}

function demoRecords(tab) {
  return run(tab, async () => {
    const { DEMO_DATABASE_NAME, INVENTORY_STORES } = await import('/src/db/schema.js')
    const { openDatabase, runTransaction, requestResult, closeInventoryDatabase } = await import('/src/db/database.js')
    const db = await openDatabase({ name: DEMO_DATABASE_NAME, version: 1 })
    try {
      const stores = Object.keys(INVENTORY_STORES)
      const rows = await runTransaction(db, stores, 'readonly', (tx) =>
        Promise.all(stores.map((name) => requestResult(tx.objectStore(name).getAll()))))
      return Object.fromEntries(stores.map((name, index) => [name, rows[index]]))
    } finally { closeInventoryDatabase(db) }
  })
}

function noRequests(tab) {
  return run(tab, () => ({
    calls: window.previewRequests,
    resources: performance.getEntriesByType('resource').filter((entry) => /^\/api\//.test(new URL(entry.name).pathname))
      .map((entry) => entry.name),
  })).then((traffic) => assert.deepEqual(traffic, { calls: [], resources: [] }))
}

const normal = await context.page({ script: instrumentation })
try {
  if (reopening) {
    const saved = JSON.parse(await readFile(evidence, 'utf8'))
    await test('Chrome restart reconstructs confirmed status and its timestamp from IndexedDB', async () => {
      const url = new URL(previewURL)
      url.searchParams.set('queue', saved.queueName)
      assert.equal(url.origin, saved.origin)
      await page.goto(url.href)
      await status(page, 'synchronized')
      assert.deepEqual(await counts(page), ['0', '2', '0'])
      assert.equal(await field(page, 'last-success'), saved.confirmedAt)
      await normal.goto(app.href)
      await normal.until('!!document.querySelector("[data-storage-state=ready]")', 'restored demo database')
      assert.deepEqual(await demoRecords(normal), saved.demoRecords)
      await noRequests(page)
      await noRequests(normal)
    })
  } else {
    await normal.goto(app.href)
    await normal.until('!!document.querySelector("[data-storage-state=ready]")', 'demo database ready')
    await normal.click('[data-route="categories"]')
    await normal.click('[data-inventory-action="add-category"]')
    await normal.setField('[data-inventory-form] [name="name"]', 'FE-09E isolation fixture')
    await normal.click('[data-inventory-form] [type="submit"]')
    await normal.until('document.querySelector("[data-inventory-results]")?.textContent.includes("FE-09E isolation fixture")',
      'fictional demo category queued')
    const beforeDemo = await demoRecords(normal)
    assert.equal(beforeDemo.synchronization_queue.length, 1)
    assert.equal(beforeDemo.synchronization_queue[0].upload_eligible, false)

    await test('preview starts unconfigured and an actual prepared fixture shows pending counts', async () => {
      await page.goto(previewURL.href)
      await status(page, 'not_configured')
      assert.match(await page.evaluate('document.querySelector(".preview-label").textContent'), /Development Preview/)
      assert.equal(await field(page, 'last-success'), 'Not yet synchronized')
      assert.equal(await page.evaluate('window.previewDBOpens.length'), 0)
      await createFixture(page)
      assert.deepEqual(await counts(page), ['2', '0', '0'])
      assert.equal(await field(page, 'last-success'), 'Not yet synchronized')
    })

    let confirmedFixture
    await test('explicit FE-09D delivery in a second tab updates the first only on refresh', async () => {
      confirmedFixture = await queueName(page)
      const url = new URL(previewURL)
      url.searchParams.set('queue', confirmedFixture)
      const other = await context.page({ script: instrumentation })
      try {
        await other.goto(url.href)
        await status(other, 'pending')
        await run(other, (selector) => {
          window.observedSyncStates = []
          new MutationObserver(() => {
            window.observedSyncStates.push(document.querySelector(selector).dataset.syncState)
          }).observe(document.querySelector('[data-preview-badge]'), { childList: true })
        }, badgeSelector)
        await deliverFixture(other, 'accepted', 'synchronized')
        assert.ok((await other.evaluate('window.observedSyncStates')).includes('synchronizing'))
        assert.equal(await page.evaluate('document.querySelector(' + quote(badgeSelector) + ').dataset.syncState'), 'pending')
        await page.click('[data-preview-form] button[type="submit"]')
        await status(page, 'synchronized')
        assert.deepEqual(await counts(page), ['0', '2', '0'])
        const datetime = await page.evaluate('document.querySelector("[data-sync-last-success] time")?.dateTime')
        assert.equal(datetime, '2026-11-19T02:00:00.000Z')
        await noRequests(other)
      } finally { await other.close() }
      await page.reload()
      await status(page, 'synchronized')
      assert.deepEqual(await counts(page), ['0', '2', '0'])
    })

    await test('retry delay and temporary failure reflect the saved retry guidance', async () => {
      await createFixture(page)
      await deliverFixture(page, 'retry', 'retry_delayed')
      assert.deepEqual(await counts(page), ['1', '1', '0'])
      assert.equal(await page.evaluate('!!document.querySelector("[data-sync-retry] time")'), true)
      assert.equal(await page.evaluate('document.querySelector("[data-run-fixture]").disabled'), true)
      assert.doesNotMatch(await page.evaluate('document.querySelector("[data-preview-panel]").textContent'), /automatically/i)
      await createFixture(page)
      await deliverFixture(page, 'temporary', 'temporary_failure')
      assert.deepEqual(await counts(page), ['1', '1', '0'])
    })

    await test('rejection and recovery are distinct and use safe staff-facing explanations', async () => {
      await createFixture(page)
      await deliverFixture(page, 'rejected', 'needs_review')
      assert.deepEqual(await counts(page), ['0', '1', '1'])
      assert.match(await page.evaluate('document.querySelector("[data-preview-panel]").textContent'), /Review the rejected change/)
      await createFixture(page)
      await deliverFixture(page, 'recovery', 'recovery_required')
      assert.deepEqual(await counts(page), ['1', '1', '0'])
      assert.match(await page.evaluate('document.querySelector("[data-preview-panel]").textContent'), /paused to protect/)
      assert.doesNotMatch(await page.evaluate('document.querySelector("[data-preview-panel]").textContent'),
        /RECOVERY_REQUIRED|DUPLICATE_ITEM|Fictional response|Fictional supplies/)
    })

    await test('an unavailable status read shows safe feedback and does not create a database', async () => {
      const missing = 'fulfil-cafe-fe09d-queue-missing-' + randomUUID()
      await page.setField('#queue-name', missing)
      await page.click('[data-preview-form] button[type="submit"]')
      await status(page, 'unavailable')
      assert.deepEqual(await counts(page), ['—', '—', '—'])
      assert.equal(await run(page, async (name) => (await indexedDB.databases()).some((db) => db.name === name), missing), false)
      assert.doesNotMatch(await page.evaluate('document.querySelector("[data-preview-panel]").textContent'), /AbortError|IndexedDB|DOMException/)
    })

    await test('tablet and desktop layouts fit, controls are named, keyboard focus is visible, and warning text has contrast', async () => {
      await createFixture(page)
      await deliverFixture(page, 'recovery', 'recovery_required')
      for (const [width, height] of [[768, 1024], [1024, 768], [1440, 900]]) {
        await page.resize(width, height)
        const layout = await run(page, () => ({
          viewport: window.innerWidth,
          usableWidth: document.documentElement.clientWidth,
          content: document.documentElement.scrollWidth,
          controlWidth: document.querySelector('[data-run-fixture]').getBoundingClientRect().width,
          targets: [...document.querySelectorAll('button:not(:disabled), input, select')].map((node) => node.getBoundingClientRect().height),
        }))
        assert.equal(layout.viewport, width)
        assert.ok(layout.content <= layout.usableWidth, 'No horizontal scroll at viewport ' + width)
        assert.ok(layout.controlWidth >= 44)
        assert.ok(layout.targets.every((target) => target >= 44))
      }
      await page.evaluate('document.querySelector("#queue-name").focus()')
      await page.cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
      const focused = await run(page, () => {
        const element = document.activeElement
        return { text: element.textContent, keyboard: element.matches(':focus-visible'), outline: getComputedStyle(element).outlineStyle }
      })
      assert.deepEqual(focused, { text: 'Refresh status', keyboard: true, outline: 'solid' })
      const { nodes } = await page.cdp('Accessibility.getFullAXTree')
      assert.ok(nodes.some((node) => node.role.value === 'textbox' && node.name.value === 'Queue name'))
      assert.ok(nodes.some((node) => node.role.value === 'combobox' && node.name.value === 'Fixture outcome'))
      assert.ok(nodes.some((node) => node.role.value === 'status'))
      const contrast = await run(page, (selector) => {
        const badge = document.querySelector(selector + ' .cafe-badge')
        const { color, backgroundColor } = getComputedStyle(badge)
        const luminance = (rgb) => rgb.match(/\d+/g).slice(0, 3).map(Number)
          .map((channel) => channel / 255).map((channel) => channel <= 0.04045
            ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
          .reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0)
        const light = [luminance(color), luminance(backgroundColor)].sort((a, b) => b - a)
        return (light[0] + 0.05) / (light[1] + 0.05)
      }, badgeSelector)
      assert.ok(contrast >= 4.5, 'Warning badge contrast ' + contrast)
      if (evidence) {
        await page.resize(768, 1024)
        const { data } = await page.cdp('Page.captureScreenshot', { format: 'png' })
        await writeFile(join(dirname(evidence), 'fe09e-tablet.png'), Buffer.from(data, 'base64'))
      }
    })

    await test('production navigation remains local and the development preview preserves the actual demo queue', async () => {
      const prod = await context.page({ script: instrumentation })
      try {
        await prod.goto(production.href)
        await prod.until('!!document.querySelector("[data-storage-state=ready]")', 'production storage ready')
        assert.equal(await prod.evaluate('document.querySelector(".app-topbar [data-sync-state]").textContent.trim()'), 'Sync not configured')
        assert.ok(await prod.evaluate('!!document.querySelector("#sync-summary-title")'))
        for (const [width, height, toggle] of [[768, 1024, '[data-menu-toggle]'], [1024, 768, '[data-sidebar-toggle]']]) {
          await prod.resize(width, height)
          const visible = await run(prod, (selector) => {
            const toggle = document.querySelector(selector).getBoundingClientRect()
            const sync = document.querySelector('.app-topbar [data-sync-state]').getBoundingClientRect()
            return toggle.width >= 44 && sync.width > 0 && sync.right <= document.documentElement.clientWidth &&
              document.documentElement.scrollWidth <= document.documentElement.clientWidth
          }, toggle)
          assert.equal(visible, true, 'Topbar and navigation fit at ' + width)
        }
        await prod.resize(1440, 900)
        for (const route of ['inventory', 'stock', 'categories', 'history', 'reports', 'settings', 'dashboard']) {
          await prod.click('[data-route="' + route + '"]')
          await prod.until('location.hash === ' + quote('#/' + route) + ' && !!document.querySelector("#page-title")', route)
          if (route === 'settings') {
            assert.ok(await prod.evaluate('!!document.querySelector("#sync-panel-title")'))
            assert.equal(await prod.evaluate('document.querySelector("[data-sync-last-success]").textContent'), 'Not yet synchronized')
          }
        }
        assert.equal(await prod.evaluate('document.querySelector("[data-browser-status-label]").textContent'), 'Browser online')
        await run(prod, () => {
          Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
          window.dispatchEvent(new Event('offline'))
        })
        assert.equal(await prod.evaluate('document.querySelector("[data-browser-status-label]").textContent'), 'Browser offline')
        assert.equal(await prod.evaluate('document.querySelector(".app-topbar [data-sync-state]").dataset.syncState'), 'not_configured')
        assert.ok(await prod.evaluate('!!document.querySelector("[data-storage-state=ready]")'))
        assert.equal(await prod.evaluate('window.previewDBOpens.some(name => name.startsWith("fulfil-cafe-fe09d"))'), false)
        await noRequests(prod)
        if (production.origin !== app.origin) {
          const response = await fetch(new URL(previewURL.pathname, production))
          assert.doesNotMatch(await response.text(), /data-preview-form|Run fixture sync/)
        }
      } finally { await prod.close() }
      assert.deepEqual(await demoRecords(normal), beforeDemo)
      assert.equal(await normal.evaluate('window.previewDBOpens.some(name => name.startsWith("fulfil-cafe-fe09d"))'), false)
      await noRequests(normal)
      await noRequests(page)
      if (evidence) {
        const url = new URL(previewURL)
        url.searchParams.set('queue', confirmedFixture)
        await page.goto(url.href)
        await status(page, 'synchronized')
        await writeFile(evidence, JSON.stringify({ queueName: confirmedFixture, origin: url.origin,
          confirmedAt: await field(page, 'last-success'), demoRecords: beforeDemo }))
      }
    })
  }
  assert.deepEqual(page.exceptions, [])
  assert.deepEqual(page.consoleErrors, [])
} finally {
  try { await context.dispose() } finally { browser.close() }
}
