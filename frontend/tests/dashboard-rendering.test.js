import assert from 'node:assert/strict'
import { test } from 'node:test'

import { readDemoInventory } from '../src/data/demo-data-provider.js'
import { loadDashboard, renderDashboard, renderDashboardResults } from '../src/pages/dashboard.js'
import { summarizeInventory } from '../src/services/inventory-summary.js'

const context = { businessDate: '2026-11-19', businessTimezone: 'Asia/Manila' }

test('renders names and units containing HTML special characters as escaped dashboard text', () => {
  const itemName = 'Milk & <cream>'
  const unit = 'cups & <paper>'
  const markup = renderDashboardResults({
    counts: { totalActive: 1, lowStock: 1, outOfStock: 0, sufficient: 0, expiringSoon: 0 },
    expirationUnavailableReason: null,
    attentionItems: [{ itemId: 'test-item', name: itemName, unit, quantity: 2, alerts: ['low-stock'] }],
    recentMovements: [{
      movementId: 'test-movement',
      itemName,
      type: 'stock_out',
      quantity: -1,
      unit,
      timestamp: '2026-11-19T02:00:00Z',
    }],
  }, context)

  assert.ok(!markup.includes(itemName))
  assert.ok(!markup.includes(unit))
  assert.ok((markup.match(/Milk &amp; &lt;cream&gt;/g)?.length ?? 0) >= 2)
  assert.ok((markup.match(/cups &amp; &lt;paper&gt;/g)?.length ?? 0) >= 2)
})

function dashboardPage() {
  const announcement = { textContent: '' }
  const results = {
    initialMarkup: renderDashboard(),
    innerHTML: '',
    isConnected: true,
    attributes: new Map(),
    setAttribute(name, value) {
      this.attributes.set(name, value)
    },
    querySelector() {
      return null
    },
  }
  const page = {
    querySelector(selector) {
      return selector === '[data-dashboard-results]' ? results : announcement
    },
  }
  return { page, results, announcement }
}

test('renders real empty inventory separately from unavailable expiration information', async () => {
  const { page, results, announcement } = dashboardPage()
  await loadDashboard(page, { scenario: 'empty', renderIcons() {} })
  assert.match(results.innerHTML, /No inventory items yet/)
  assert.match(results.innerHTML, /Use Inventory to add demo items/)
  assert.match(results.innerHTML, /No active items to summarize/)
  assert.doesNotMatch(results.innerHTML, /dashboard-distribution__segment|NaN%|0%/)
  assert.match(results.innerHTML, /No items require attention/)
  assert.match(results.innerHTML, /No stock movements recorded/)
  assert.match(results.innerHTML, /Unavailable/)
  assert.equal(results.attributes.get('aria-busy'), 'false')
  assert.match(announcement.textContent, /No active items/)

  await loadDashboard(page, { scenario: 'unavailable', renderIcons() {} })
  assert.match(results.innerHTML, /The demo warning period is unset/)
  assert.doesNotMatch(results.innerHTML, /Expiring today through/)
  assert.match(results.innerHTML, /Expired stock/)
  assert.doesNotMatch(results.innerHTML, /No active items to summarize/)
})

test('keeps stock groups separate from expiration and renders signed movement labels', async () => {
  const snapshot = await readDemoInventory()
  const summary = summarizeInventory(snapshot, context.businessDate)
  const markup = renderDashboardResults(summary, { ...context, warningDays: 7 })
  assert.match(markup, /Expiring today through 26 Nov\./)
  assert.match(markup, /dashboard-tone--warning" aria-labelledby="metric-expiring"/)
  assert.match(markup, /Share of 12 active items by stock status/)
  assert.match(markup, /Sufficient stock <strong>7<\/strong> \(58\.3%\)/)
  assert.match(markup, /Low stock <strong>3<\/strong> \(25%\)/)
  assert.match(markup, /Out of stock <strong>2<\/strong> \(16\.7%\)/)
  assert.match(markup, /<strong>\+1<\/strong> bottle\b/)
  assert.equal(markup.match(/dashboard-distribution__segment/g)?.length, 3)
  assert.match(markup, /Showing 5 of 7 items requiring attention/)
  assert.equal(markup.match(/<time datetime="[^"]+T/g)?.length, 5)
})

test('an archived-only inventory keeps historical movements visible', async () => {
  const snapshot = await readDemoInventory()
  snapshot.inventory_items.forEach((item) => { item.is_active = false })
  const summary = summarizeInventory(snapshot, context.businessDate)
  const markup = renderDashboardResults(summary, { ...context, warningDays: 7 })
  assert.match(markup, /No active inventory items/)
  assert.match(markup, /Seasonal drink mix/)
  assert.doesNotMatch(markup, /No stock movements recorded/)
})

test('a rejected read replaces loading with a retryable error and no counts', async () => {
  const { page, results } = dashboardPage()
  assert.match(results.initialMarkup, /Loading demo inventory/)
  assert.doesNotMatch(results.initialMarkup, /dashboard-metric__value/)
  await loadDashboard(page, { scenario: 'error', renderIcons() {} })
  assert.match(results.innerHTML, /role="alert"/)
  assert.match(results.innerHTML, /data-dashboard-retry/)
  assert.doesNotMatch(results.innerHTML, /dashboard-metric__value|No active items to summarize/)
  assert.equal(results.attributes.get('aria-busy'), 'false')
})

test('a completed mock read cannot render into a page that was left during loading', async () => {
  const { page, results, announcement } = dashboardPage()
  const snapshot = await readDemoInventory()
  let finishRead
  const pending = loadDashboard(page, {
    readSnapshot: () => new Promise((resolve) => { finishRead = resolve }),
    renderIcons() { assert.fail('Detached results should never render icons') },
  })
  assert.equal(announcement.textContent, 'Loading demo inventory.')
  results.isConnected = false
  finishRead(snapshot)
  await pending
  assert.equal(results.innerHTML, '')
  assert.equal(results.attributes.size, 0)
})

test('dashboard uses the balance data when the expiration settings record is absent', async () => {
  const { page, results } = dashboardPage()
  const snapshot = await readDemoInventory()
  delete snapshot.settings
  await loadDashboard(page, { readSnapshot: async () => snapshot, renderIcons() {} })
  assert.match(results.innerHTML, /The demo warning period is unset/)
  assert.match(results.innerHTML, /Share of 12 active items/)
  assert.doesNotMatch(results.innerHTML, /Could not load demo inventory/)
})
