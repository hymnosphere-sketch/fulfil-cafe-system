import { renderMetricCard } from '../components/metric-card.js'
import { renderPageHeader } from '../components/page-header.js'
import { renderBadge, renderMessage } from '../components/status.js'
import { routeHref } from '../router.js'
import { expirationMonitoring, inventoryOverview, movementReport, restockingItems } from '../services/inventory-reports.js'
import { catalogItemLabels, shortRecordReferences } from '../utils/catalog-display.js'
import { movementLabels } from '../utils/dashboard-format.js'
import { escapeInventoryText as escape, renderDemoContext, renderInventoryQuantity, renderOption } from './inventory-rendering.js'

export const reportTitles = {
  inventory: 'Inventory Overview',
  restocking: 'Low Stock and Restocking',
  expiration: 'Expiration Monitoring',
  movements: 'Stock Movements',
}

export const reportDefaults = {
  inventory: { query: '', categoryId: '', stockStatus: '', sort: 'name-asc' },
  restocking: { categoryId: '', stockScope: '' },
  expiration: { categoryId: '', status: '' },
  movements: { itemId: '', categoryId: '', type: '', fromDate: '', toDate: '' },
}

const stockStatus = {
  sufficient: { label: 'Sufficient stock', tone: 'success', icon: 'package' },
  'low-stock': { label: 'Low stock', tone: 'warning', icon: 'triangle-alert' },
  'out-of-stock': { label: 'Out of stock', tone: 'error', icon: 'circle-alert' },
}

const expirationStatus = {
  expired: { label: 'Expired', tone: 'error', icon: 'calendar-clock' },
  'expiring-soon': { label: 'Expiring soon', tone: 'warning', icon: 'calendar-clock' },
  current: { label: 'Outside warning window', tone: 'success', icon: 'calendar-clock' },
  undated: { label: 'Undated (unclassified)', tone: 'neutral', icon: 'info' },
  'warning-period-unset': { label: 'Warning period unavailable', tone: 'info', icon: 'info' },
}

const counts = new Intl.NumberFormat('en-PH')
const date = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' })

function formatCount(value, singular, plural = singular + 's') {
  return counts.format(value) + ' ' + (value === 1 ? singular : plural)
}

function calendarDate(value) {
  if (value === null) return 'Not recorded'
  const timestamp = Date.parse(value + 'T00:00:00Z')
  return Number.isFinite(timestamp) ? `<time datetime="${escape(value)}">${date.format(timestamp)}</time>` : 'Not recorded'
}

function reportMetric(id, label, value, tone, icon, detail) {
  return renderMetricCard({ id, label, value: value === null ? null : counts.format(value), tone, icon, detail })
}

function reportSummary(title, description, cards) {
  return `<section class="report-stack" aria-labelledby="report-summary-title">
    <div>
      <h2 class="mb-1" id="report-summary-title">${title}</h2>
      <p class="cafe-muted cafe-supporting mb-0">${description}</p>
    </div>
    ${cards}
  </section>`
}

function inventoryMetrics({ totalActive, sufficient, lowStock, outOfStock }) {
  return reportSummary('Overall inventory summary',
    'These cards count all active items. The filters apply to the results below.',
    `<div class="report-metrics report-metrics--inventory">
    ${reportMetric('report-active', 'Active items', totalActive, 'neutral', 'package', 'Current catalog')}
    ${reportMetric('report-sufficient', 'Sufficient stock', sufficient, 'success', 'package', 'Above minimum')}
    ${reportMetric('report-low', 'Low stock', lowStock, 'warning', 'triangle-alert', 'Positive balance at or below minimum')}
    ${reportMetric('report-out', 'Out of stock', outOfStock, 'error', 'circle-alert', 'Zero balance')}
  </div>`)
}

export function renderReportsPage(view, storageMode) {
  return `<div class="reports-workspace">
    ${renderPageHeader({ title: 'Reports', description: 'Review inventory levels, restocking needs, expiration, and stock movements.' })}
    <div class="report-stack">
      <div data-report-context>${renderDemoContext(null, 'reports', storageMode)}</div>
      <nav aria-label="Report views" class="report-nav">
        ${Object.entries(reportTitles).map(([id, title]) => `<a class="btn ${id === view ? 'btn-primary' : 'btn-outline-primary'}"
          href="${routeHref('reports', { view: id })}" data-report-view="${id}"${id === view ? ' aria-current="page"' : ''}>${title}</a>`).join('')}
      </nav>
      <div data-report-content class="report-stack" aria-busy="true">${renderReportLoading()}</div>
    </div>
  </div>`
}

export function renderReportLoading() {
  return '<p class="mb-0 cafe-muted" role="status">Loading report records…</p>'
}

export function renderReportReadError() {
  return `<div role="alert">${renderMessage({
    tone: 'error', icon: 'circle-alert', title: 'Reports could not be loaded',
    message: 'Try reading the saved local inventory again.',
  })}</div>
  <div><button type="button" class="btn btn-outline-primary" data-report-retry>Retry</button></div>`
}

function selectFilter(name, label, options, value) {
  return `<div>
    <label for="report-${name}" class="form-label">${label}</label>
    <select class="form-select" id="report-${name}" name="${name}">
      ${options.map(([key, text]) => renderOption(key, text, value)).join('')}
    </select>
  </div>`
}

function reportDateField(name, label, value) {
  return `<div>
    <label for="report-${name}" class="form-label">${label}</label>
    <input class="form-control" type="date" id="report-${name}" name="${name}" value="${escape(value)}" aria-describedby="report-date-help">
    <p class="report-field-error cafe-supporting mb-0" id="report-${name}-error" hidden></p>
  </div>`
}

export function reportSelectOptions(view, { categories, items }) {
  const categoryId = [['', 'All categories'], ...categories
    .filter((category) => category.isActive || view === 'movements')
    .map(({ categoryId, name, isActive }) => [categoryId, name + (isActive ? '' : ' (archived)')])]
  if (view === 'inventory') return {
    categoryId,
    stockStatus: [['', 'Any status'], ...Object.entries(stockStatus).map(([key, value]) => [key, value.label])],
    sort: [
      ['name-asc', 'Name (A–Z)'], ['name-desc', 'Name (Z–A)'],
      ['quantity-asc', 'Quantity low–high'], ['quantity-desc', 'Quantity high–low'],
    ],
  }
  if (view === 'restocking') return {
    categoryId,
    stockScope: [['', 'Low stock and out of stock'], ['low-only', 'Low stock only']],
  }
  if (view === 'expiration') return {
    categoryId,
    status: [
      ['', 'All remaining batches'], ['alerts', 'All expiration alerts'], ['expired', 'Expired'], ['expiring-soon', 'Expiring soon'],
      ['undated', 'Undated'], ['current', 'Outside warning window'], ['warning-period-unset', 'Warning period unavailable'],
    ],
  }
  const labels = catalogItemLabels(items, { referenceFirst: true })
  return {
    itemId: [['', 'All items'], ...items.map(({ itemId }) => [itemId, labels.get(itemId)])],
    categoryId,
    type: [['', 'All movement types'], ...movementLabels],
  }
}

export function normalizeReportFilters(view, values, options) {
  const defaults = reportDefaults[view]
  const filters = { ...defaults, ...values }
  let cleared = false
  for (const [name, choices] of Object.entries(options)) {
    if (choices.some(([key]) => key === filters[name])) continue
    filters[name] = defaults[name]
    cleared = true
  }
  return { filters, cleared }
}

export function renderReportPanel(view, { inventory }, filters, options = reportSelectOptions(view, inventory)) {
  const select = (name, label) => selectFilter(name, label, options[name], filters[name])
  const category = select('categoryId', 'Category')
  let fields = category
  if (view === 'inventory') {
    fields = `<div>
      <label for="report-query" class="form-label">Search items</label>
      <input class="form-control" type="search" id="report-query" name="query" placeholder="Item name or full ID" value="${escape(filters.query)}">
      </div>${category}
      ${select('stockStatus', 'Stock status')}${select('sort', 'Sort by')}`
  } else if (view === 'restocking') {
    fields += select('stockScope', 'Items to include')
  } else if (view === 'expiration') {
    fields += select('status', 'Expiration status')
  } else {
    fields = select('itemId', 'Inventory item') + category + select('type', 'Movement type') +
      reportDateField('fromDate', 'From date', filters.fromDate) +
      reportDateField('toDate', 'To date', filters.toDate)
  }
  return `<section class="card cafe-card" aria-labelledby="report-content-title">
    <div class="card-body report-stack">
      <h2 class="mb-0" id="report-content-title">${reportTitles[view]}</h2>
      <form class="report-stack" data-report-filters novalidate aria-label="Filter this report">
        <div class="report-filters${view === 'movements' ? ' report-filters--movements' : ''}">${fields}</div>
        ${view === 'movements' ? `<p id="report-item-selection" class="cafe-muted cafe-supporting mb-0" hidden></p>
          <p id="report-date-help" class="cafe-muted cafe-supporting mb-0">Dates include both selected days in ${escape(inventory.businessTimezone)}. Item and category names reflect the current catalog.</p>` : ''}
        <p class="cafe-muted cafe-supporting mb-0" role="status" data-report-filter-notice hidden></p>
        <div class="report-buttons">
          <button type="submit" class="btn btn-primary">Apply filters</button>
          <button type="button" class="btn btn-outline-primary" data-report-clear>Clear filters</button>
        </div>
      </form>
    </div>
  </section>
  <div class="report-stack" data-report-results>
    <div data-report-summary hidden></div>
    <p class="cafe-muted cafe-supporting mb-0" role="status" data-report-count></p>
    <div class="report-stack" data-report-rows></div>
  </div>`
}

// Only the visible representation is exposed to the accessibility tree.
function renderRecords(title, columns, rows) {
  return `<div class="card cafe-card report-records">
    <table class="table report-table mb-0">
      <caption class="visually-hidden">${title}</caption>
      <thead><tr>${columns.map((label) => `<th scope="col">${label}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(([first, ...rest]) => `<tr data-report-row><th scope="row">${first}</th>
        ${rest.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>
    <ul class="report-cards list-unstyled mb-0" aria-label="${title}">
      ${rows.map(([first, ...rest]) => `<li class="report-record" data-report-row>
        <strong class="report-record-name">${first}</strong>
        <dl class="inventory-facts">${rest.map((cell, index) => `<div><dt>${columns[index + 1]}</dt><dd>${cell}</dd></div>`).join('')}</dl>
      </li>`).join('')}
    </ul>
  </div>`
}

function reportNote(title, message) {
  return renderMessage({ tone: 'info', icon: 'info', title, message })
}

function itemCell(item, references) {
  return `${escape(item.name)}<span class="report-reference cafe-muted cafe-supporting">Item ${escape(references.get(item.itemId))}${item.isActive === false ? ' · Archived' : ''}</span>`
}

function inventoryRows(view, rows, references) {
  const showExpiration = view === 'inventory'
  const columns = ['Item', 'Category', 'Unit', 'Recorded balance', 'Minimum', 'Stock status']
  columns.push(showExpiration ? 'Expiration alerts' : 'Shortfall to minimum')
  return renderRecords(reportTitles[view], columns, rows.map((item) => {
    const cells = [itemCell(item, references), escape(item.categoryName), escape(item.unit),
      renderInventoryQuantity(item.availableQuantity, item.unit),
      renderInventoryQuantity(item.minimumStockLevel, item.unit), renderBadge(stockStatus[item.stockStatus])]
    if (showExpiration) {
      const knownAlerts = item.expirationAlerts.map((status) => renderBadge(expirationStatus[status]))
      const warningUnavailable = item.batches.some(({ expirationStatus }) => expirationStatus === 'warning-period-unset')
      if (warningUnavailable) knownAlerts.push(renderBadge(expirationStatus['warning-period-unset']))
      cells.push(knownAlerts.join(' ') || 'None')
    } else cells.push(renderInventoryQuantity(item.shortfallToMinimum, item.unit))
    return cells
  }))
}

function renderExpiration(data, filters, references) {
  const { rows, expiredBatchCount, expiringSoonItemCount, hasDatedStock, warningPeriodUnavailable } = expirationMonitoring(data, filters)
  const batchReferences = shortRecordReferences(data.expirationRecords.map(({ batchId }) => batchId))
  const hasAlerts = expiredBatchCount > 0 || expiringSoonItemCount > 0
  const category = data.inventory.categoryById.get(filters.categoryId)
  const scope = category ? `These cards cover remaining batches in ${escape(category.name)}.` : 'These cards cover remaining batches for all active items.'
  return {
    count: filters.status === 'expiring-soon' && expiringSoonItemCount === null
      ? '' : `Showing ${counts.format(rows.length)} of ${formatCount(data.expirationRecords.length, 'remaining batch', 'remaining batches')}`,
    summary: reportSummary('Expiration summary',
      scope + ' The expiration status filter applies to the results below. An item can have more than one batch.',
      `<div class="report-metrics">
      ${reportMetric('report-expired', 'Expired batches', expiredBatchCount, 'error', 'calendar-clock', 'Batches with remaining stock')}
      ${reportMetric('report-expiring', 'Expiring-soon items', expiringSoonItemCount,
        expiringSoonItemCount === null ? 'info' : 'warning', expiringSoonItemCount === null ? 'info' : 'calendar-clock',
        'Items with at least one approaching expiration')}
    </div>`),
    html: `
    ${warningPeriodUnavailable ? reportNote('Warning period unavailable', 'Approaching expiration cannot be calculated. Known expired dates are still classified.') : ''}
    ${!hasDatedStock ? reportNote('No dated batches with remaining stock', 'An undated batch stays unclassified for expiration.') : ''}
    ${!hasAlerts && expiringSoonItemCount !== null && rows.length ? reportNote('No expiration alerts', 'The selected category has no remaining expired or expiring-soon stock.') : ''}
    <p class="cafe-muted cafe-supporting mb-0">Recorded balances can include expired stock, which is excluded from ordinary usage. Production expiration policy is pending.</p>
    ${rows.length ? renderRecords('Expiration Monitoring', ['Item', 'Category', 'Batch', 'Recorded remaining', 'Purchased', 'Expiration date', 'Classification'], rows.map((row) => [
      itemCell(row, references), escape(row.categoryName),
      `${escape(batchReferences.get(row.batchId))}<details class="report-full-id"><summary>Full batch ID</summary><code>${escape(row.batchId)}</code></details>`,
      renderInventoryQuantity(row.remainingQuantity, row.unit), calendarDate(row.purchaseDate), calendarDate(row.expirationDate),
      renderBadge(expirationStatus[row.expirationStatus]),
    ])) : filters.status === 'expiring-soon' && expiringSoonItemCount === null ? '' :
      data.expirationRecords.length ? reportNote('No matching expiration records', 'Try clearing the filters to see other batches.') :
        reportNote('No remaining batches', 'Batches appear here when active inventory has stock remaining.')}`,
  }
}

function renderMovements(data, filters, references) {
  const { groups, errors, matchingMovements } = movementReport(data, filters)
  if (Object.keys(errors).length) return {
    errors, count: '', html: '<p class="report-field-error mb-0" role="alert">Correct the date range to see movement totals.</p>',
  }
  if (!groups.length) return {
    count: `Showing 0 of ${formatCount(data.movements.length, 'movement record')}`,
    html: data.movements.length ? reportNote('No stock movements match', 'Choose another period or clear the filters to see more records.') :
      reportNote('No stock movements match', 'The local inventory has no recorded stock movements.'),
  }
  const hasOverflow = groups.some(({ quantityChange }) => quantityChange === null)
  const records = renderRecords('Stock Movements', ['Item', 'Category', 'Unit', 'Movement type', 'Movements', 'Net quantity change', 'Records'], groups.map((group) => {
    const href = routeHref('history', {
      item: group.itemId, type: group.type, ...(filters.fromDate && { from: filters.fromDate }), ...(filters.toDate && { to: filters.toDate }),
    })
    const movementLabel = movementLabels.get(group.type) ?? 'Stock movement'
    const historyLabel = `View history for ${group.name} · Item ${references.get(group.itemId)} · ${movementLabel} · ${group.unit} · Transaction History`
    return [itemCell(group, references), escape(group.categoryName), escape(group.unit),
      movementLabel, counts.format(group.movementCount),
      group.quantityChange === null ? 'Unavailable' : renderInventoryQuantity(group.quantityChange, group.unit, true),
      `<a class="btn btn-outline-primary" href="${escape(href)}" aria-label="${escape(historyLabel)}">View history</a>`]
  }))
  return {
    count: `Showing ${counts.format(matchingMovements)} of ${formatCount(data.movements.length, 'movement record')} in ${formatCount(groups.length, 'group')}`,
    html: (hasOverflow ? reportNote('Some totals are unavailable', 'Those groups exceed the safe integer range. Their movements are still available in Transaction History.') : '') + records,
  }
}

export function renderReportResults(view, data, filters) {
  const { items, summary } = data.inventory
  const references = shortRecordReferences(items.map(({ itemId }) => itemId))
  if (view === 'expiration') return renderExpiration(data, filters, references)
  if (view === 'movements') return renderMovements(data, filters, references)
  const overview = view === 'inventory'
  const population = overview ? summary.counts.totalActive : summary.counts.lowStock + summary.counts.outOfStock
  const rows = overview
    ? inventoryOverview(data, filters)
    : restockingItems(data, { categoryId: filters.categoryId, includeOutOfStock: filters.stockScope !== 'low-only' })
  const empty = summary.counts.totalActive === 0
    ? reportNote('No active inventory', 'Add an item in Inventory to begin tracking stock.')
    : population === 0 ? reportNote('No restocking items', 'All active items have sufficient stock.') :
      reportNote('No matching items', 'Try clearing the filters to see more records.')
  const unitNote = overview && filters.sort.startsWith('quantity-')
    ? '<p class="cafe-muted cafe-supporting mb-0">Quantities are sorted within each unit group.</p>' : ''
  const balanceNote = '<p class="cafe-muted cafe-supporting mb-0">Recorded balances can include expired stock. Stock Management shows which batches are eligible for ordinary usage.</p>'
  const shortfallNote = overview ? '' :
    '<p class="cafe-muted cafe-supporting mb-0">Shortfall measures the gap to the minimum. A positive balance at the minimum is still classified as low stock.</p>'
  return {
    count: `Showing ${counts.format(rows.length)} of ${formatCount(population, overview ? 'active item' : 'restocking item')}`,
    summary: overview ? inventoryMetrics(summary.counts) : '',
    html: rows.length ? balanceNote + shortfallNote + unitNote + inventoryRows(view, rows, references) : empty,
  }
}
