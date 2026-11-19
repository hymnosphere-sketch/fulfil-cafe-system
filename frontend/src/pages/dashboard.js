import { renderCard } from '../components/card.js'
import { renderMetricCard } from '../components/metric-card.js'
import { renderPageHeader } from '../components/page-header.js'
import { renderBadge, renderMessage } from '../components/status.js'
import { readDemoInventory } from '../data/demo-data-provider.js'
import { demoBusinessDate } from '../data/demo-inventory.js'
import { routeHref } from '../router.js'
import { summarizeInventory } from '../services/inventory-summary.js'
import { formatExpirationWindowEnd, formatQuantity, movementLabels } from '../utils/dashboard-format.js'

const ATTENTION_LIMIT = 5
const numberFormat = new Intl.NumberFormat('en-PH')
const percentFormat = new Intl.NumberFormat('en-PH', { style: 'percent', maximumFractionDigits: 1 })
const dateFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' })

const alertBadges = {
  'out-of-stock': { label: 'Out of stock', tone: 'error', icon: 'circle-alert' },
  'low-stock': { label: 'Low stock', tone: 'warning', icon: 'triangle-alert' },
  expired: { label: 'Expired stock', tone: 'error', icon: 'calendar-clock' },
  'expiring-soon': { label: 'Expiring soon', tone: 'warning', icon: 'calendar-clock' },
}

// Every record field interpolated into markup goes through escaping or number formatting.
function escapeText(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character])
}

function renderQuantity(quantity, unit, signed = false) {
  const display = formatQuantity(quantity, unit, { signed })
  return `<strong>${escapeText(display.amount)}</strong> ${escapeText(display.unit)}`
}

function renderMetrics(summary, businessDate, warningDays) {
  const { counts, expirationUnavailableReason } = summary
  const warningEnd = formatExpirationWindowEnd(businessDate, warningDays)
  const expirationDetail = {
    'warning-period-unset': 'The demo warning period is unset.',
    'no-dated-stock': 'No dated batches with stock remaining.',
  }[expirationUnavailableReason] ?? (
    warningEnd
      ? warningDays === 0 ? 'Expiring today.' : `Expiring today through ${warningEnd}.`
      : 'Active items with a batch in the warning window.'
  )

  const metrics = [
    { id: 'metric-total', label: 'Total active items', value: counts.totalActive, icon: 'package', tone: 'neutral', detail: 'Across all categories' },
    { id: 'metric-low', label: 'Low stock', value: counts.lowStock, icon: 'triangle-alert', tone: 'warning', detail: 'At or below minimum, with stock left' },
    { id: 'metric-out', label: 'Out of stock', value: counts.outOfStock, icon: 'circle-alert', tone: 'error', detail: 'No stock remaining' },
    { id: 'metric-expiring', label: 'Expiring soon', value: counts.expiringSoon, icon: 'calendar-clock', tone: counts.expiringSoon === null ? 'info' : 'warning', detail: expirationDetail },
  ]

  return `<div class="dashboard-metrics">${metrics.map((metric) => renderMetricCard({
    ...metric,
    value: metric.value === null ? null : numberFormat.format(metric.value),
  })).join('')}</div>`
}

function renderAttention(items) {
  const rows = items.slice(0, ATTENTION_LIMIT).map(({ name, quantity, unit, alerts }) => `
    <li>
      <div>
        <div class="dashboard-record__name">${escapeText(name)}</div>
        <div class="dashboard-alerts">${alerts.map((alert) => renderBadge(alertBadges[alert])).join('')}</div>
      </div>
      <span class="dashboard-record__quantity cafe-supporting">${renderQuantity(quantity, unit)}</span>
    </li>
  `)
  const more = items.length - rows.length
  return renderCard({
    id: 'dashboard-attention',
    title: 'Items requiring attention',
    content: rows.length ? `
      <ul class="dashboard-records list-unstyled">${rows.join('')}</ul>
      ${more > 0 ? `<p class="cafe-muted cafe-supporting mt-3 mb-0">Showing ${rows.length} of ${numberFormat.format(items.length)} items requiring attention.</p>` : ''}
    ` : '<p class="cafe-muted mb-0">No items require attention.</p>',
  })
}

function renderRecentMovements(movements, businessTimezone) {
  const timeFormat = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: businessTimezone,
  })
  const rows = movements.map(({ itemName, type, quantity, unit, timestamp }) => `
    <li>
      <div>
        <div class="dashboard-record__name">${escapeText(itemName)}</div>
        <span class="dashboard-record__detail cafe-muted cafe-supporting">
          ${movementLabels.get(type) ?? 'Stock movement'} · <time datetime="${escapeText(timestamp)}">${escapeText(timeFormat.format(new Date(timestamp)))}</time>
        </span>
      </div>
      <span class="dashboard-record__quantity cafe-supporting${quantity > 0 ? ' dashboard-record__quantity--received' : ''}">${renderQuantity(quantity, unit, true)}</span>
    </li>
  `)
  return renderCard({
    id: 'dashboard-recent',
    title: 'Recent stock movements',
    content: rows.length
      ? `<ol class="dashboard-records list-unstyled">${rows.join('')}</ol>`
      : '<p class="cafe-muted mb-0">No stock movements recorded.</p>',
  })
}

function renderDistribution({ sufficient, lowStock, outOfStock, totalActive }) {
  const groups = [
    { label: 'Sufficient stock', count: sufficient, tone: 'success' },
    { label: 'Low stock', count: lowStock, tone: 'warning' },
    { label: 'Out of stock', count: outOfStock, tone: 'error' },
  ]

  return renderCard({
    id: 'dashboard-distribution',
    title: 'Inventory stock status',
    content: totalActive > 0 ? `
      <div class="dashboard-distribution" aria-hidden="true">
        ${groups.filter(({ count }) => Number.isSafeInteger(count) && count > 0).map(({ count, tone }) => `
          <span class="dashboard-distribution__segment dashboard-tone--${tone}" style="--dashboard-stock-count: ${count}"></span>
        `).join('')}
      </div>
      <ul class="dashboard-legend list-unstyled cafe-supporting" aria-label="Share of ${numberFormat.format(totalActive)} active items by stock status">
        ${groups.map(({ label, count, tone }) => `
          <li class="dashboard-tone--${tone}">
            <span>${label} <strong>${numberFormat.format(count)}</strong> (${percentFormat.format(count / totalActive)})</span>
          </li>
        `).join('')}
      </ul>
    ` : '<p class="cafe-muted mb-0">No active items to summarize.</p>',
  })
}

function renderQuickActions() {
  return renderCard({
    id: 'dashboard-quick-actions',
    title: 'Quick actions',
    content: `
      <p class="cafe-muted cafe-supporting" id="dashboard-actions-note">Stock movements use fictional data and reset when the page is refreshed.</p>
      <div class="dashboard-quick-actions d-flex flex-wrap gap-2">
        <a class="btn btn-primary" href="${routeHref('stock', { workflow: 'receive' })}" aria-describedby="dashboard-actions-note">
          <i data-lucide="package-plus" aria-hidden="true"></i> Receive stock
        </a>
        <a class="btn btn-outline-primary" href="${routeHref('stock', { workflow: 'usage' })}" aria-describedby="dashboard-actions-note">
          <i data-lucide="package-minus" aria-hidden="true"></i> Record usage
        </a>
      </div>
    `,
  })
}

export function renderDashboardResults(summary, {
  businessDate = demoBusinessDate,
  businessTimezone = 'Asia/Manila',
  warningDays,
} = {}) {
  const demoDate = dateFormat.format(new Date(`${businessDate}T00:00:00Z`))
  const hasHistory = summary.recentMovements.length > 0
  return `
    <p class="dashboard-context cafe-muted">
      <span class="dashboard-data-label">Fictional demonstration data</span>
      <span>Demo date <time datetime="${escapeText(businessDate)}">${escapeText(demoDate)}</time> · ${escapeText(businessTimezone)}</span>
    </p>
    ${renderMetrics(summary, businessDate, warningDays)}
    ${summary.counts.totalActive === 0 ? renderMessage({
      tone: 'info',
      icon: 'info',
      title: hasHistory ? 'No active inventory items' : 'No inventory items yet',
      message: hasHistory
        ? 'Historical movements remain visible below. Use Inventory to add demo items.'
        : 'Inventory items, stock alerts, and recent movements will appear here once records are available. Use Inventory to add demo items.',
    }) : ''}
    <div class="dashboard-panel-grid">
      ${renderAttention(summary.attentionItems)}
      ${renderRecentMovements(summary.recentMovements, businessTimezone)}
    </div>
    <div class="dashboard-panel-grid">
      ${renderDistribution(summary.counts)}
      ${renderQuickActions()}
    </div>
  `
}

export function renderDashboard() {
  return `
    <div class="inventory-dashboard">
      ${renderPageHeader({
        title: 'Dashboard',
        description: 'Review the demo inventory, stock requiring attention, and recent movements.',
      })}
      <p class="visually-hidden" role="status" data-dashboard-announcement></p>
      <div class="dashboard-results" data-dashboard-results aria-busy="true">
        <div class="dashboard-state">
          ${renderMessage({ tone: 'info', icon: 'info', title: 'Loading demo inventory', message: 'Preparing the inventory summary.' })}
        </div>
      </div>
    </div>
  `
}

function renderReadError() {
  return `
    <div class="dashboard-state">
      <div role="alert">
        ${renderMessage({ tone: 'error', icon: 'circle-alert', title: 'Could not load demo inventory', message: 'The inventory summary is unavailable. Try reading the demo data again.' })}
      </div>
      <button class="btn btn-outline-primary mt-3" type="button" data-dashboard-retry>Retry</button>
    </div>
  `
}

export async function loadDashboard(page, { scenario, renderIcons, readSnapshot = readDemoInventory }) {
  const results = page.querySelector('[data-dashboard-results]')
  const announcement = page.querySelector('[data-dashboard-announcement]')
  announcement.textContent = 'Loading demo inventory.'

  let markup
  try {
    const snapshot = await readSnapshot({ scenario })
    if (!results.isConnected) return

    const summary = summarizeInventory(snapshot, demoBusinessDate)
    markup = renderDashboardResults(summary, {
      businessDate: demoBusinessDate,
      businessTimezone: snapshot.settings?.business_timezone,
      warningDays: snapshot.settings?.expiration_warning_days,
    })
    announcement.textContent = summary.counts.totalActive === 0
      ? 'Demo inventory loaded. No active items.'
      : 'Demo inventory loaded.'
  } catch {
    if (!results.isConnected) return

    markup = renderReadError()
    announcement.textContent = ''
  }

  results.innerHTML = markup
  results.setAttribute('aria-busy', 'false')
  results.querySelector('[data-dashboard-retry]')?.addEventListener('click', () => {
    // Keep focus on the page while the retry replaces its content.
    page.querySelector('#page-title').focus({ preventScroll: true })
    results.setAttribute('aria-busy', 'true')
    results.innerHTML = '<p class="cafe-muted mb-0">Loading demo inventory…</p>'
    void loadDashboard(page, { scenario, renderIcons, readSnapshot })
  }, { once: true })
  renderIcons(results)
}
