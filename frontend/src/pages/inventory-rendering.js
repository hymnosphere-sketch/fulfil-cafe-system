import { renderCard } from '../components/card.js'
import { renderBadge, renderMessage } from '../components/status.js'
import { routeHref } from '../router.js'
import { filterAndSortInventory } from '../services/inventory-read-model.js'
import { formatQuantity, movementLabels } from '../utils/dashboard-format.js'
import { demoStorageNotice } from './demo-data-notice.js'

const stockBadges = {
  sufficient: { label: 'Sufficient stock', tone: 'success', icon: 'package' },
  'low-stock': { label: 'Low stock', tone: 'warning', icon: 'triangle-alert' },
  'out-of-stock': { label: 'Out of stock', tone: 'error', icon: 'circle-alert' },
}
const expirationLabels = {
  undated: 'No expiration date recorded',
  depleted: 'No stock remaining',
  expired: 'Expired',
  'warning-period-unset': 'Warning period unavailable',
  'expiring-soon': 'Expiring soon',
  current: 'Outside warning window',
}
const dateFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' })
const numberFormat = new Intl.NumberFormat('en-PH')

export function escapeInventoryText(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character])
}

export function renderInventoryAction(action, label, id, { primary = false, subject, icon, disabled = false } = {}) {
  const record = id === undefined ? '' : ` data-id="${escapeInventoryText(id)}"`
  const accessibleLabel = subject === undefined ? '' : ` aria-label="${escapeInventoryText(`${label} ${subject}`)}"`
  const symbol = icon ? `<i data-lucide="${icon}" aria-hidden="true"></i>` : ''
  return `<button class="btn btn-${primary ? 'primary' : 'outline-primary'}" type="button" data-inventory-action="${action}"${record}${accessibleLabel}${disabled ? ' disabled' : ''}>${symbol}${label}</button>`
}

export function renderReceiveStockLink(item, { identifyItem = false } = {}) {
  const href = routeHref('stock', { workflow: 'receive', item: item.itemId })
  const label = identifyItem ? ` aria-label="Receive stock for ${escapeInventoryText(item.name)}"` : ''
  return `<a class="btn btn-outline-primary" href="${escapeInventoryText(href)}"${label}>Receive stock</a>`
}

function renderArchiveAction(kind, record) {
  const isItem = kind === 'item'
  const reason = isItem
    ? record.availableQuantity !== 0 && 'Stock must reach zero.'
    : record.activeItemCount !== 0 && 'Active items still use this category.'
  return renderInventoryAction('archive-' + kind, 'Archive', isItem ? record.itemId : record.categoryId, {
    subject: record.name,
    disabled: Boolean(reason),
  }) + (reason ? `<p class="inventory-archive-note cafe-muted cafe-supporting mb-0">${reason}</p>` : '')
}

export function renderOption(value, label, selectedValue) {
  return `<option value="${escapeInventoryText(value)}"${value === selectedValue ? ' selected' : ''}>${escapeInventoryText(label)}</option>`
}

export function renderInventoryQuantity(quantity, unit, signed = false) {
  const display = formatQuantity(quantity, unit, { signed })
  return `${escapeInventoryText(display.amount)} ${escapeInventoryText(display.unit)}`
}

export function renderDemoContext(model, module, storageMode) {
  const date = model ? ` Demo date ${renderDate(model.businessDate)} · ${escapeInventoryText(model.businessTimezone)}.` : ''
  return renderMessage({
    tone: 'info',
    icon: 'info',
    title: 'Fictional demonstration data',
    message: demoStorageNotice(storageMode) + (module === 'inventory' ? date : ''),
  })
}

function renderDate(value, formatter = dateFormat) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return 'Not recorded'
  return `<time datetime="${escapeInventoryText(value)}">${escapeInventoryText(formatter.format(new Date(value)))}</time>`
}

function renderOptional(value, missing = 'Not recorded') {
  return value == null || value === '' ? `<span class="cafe-muted">${missing}</span>` : escapeInventoryText(value)
}

function renderExpirationAlerts(item) {
  const alerts = item.expirationAlerts.map((alert) => renderBadge({
    label: alert === 'expired' ? 'Expired stock' : 'Expiring soon',
    tone: alert === 'expired' ? 'error' : 'warning',
    icon: 'calendar-clock',
  }))
  return alerts.length ? `<div class="inventory-expiration-alerts">${alerts.join('')}</div>` : ''
}

function renderStockStatus(item) {
  return renderBadge(stockBadges[item.stockStatus])
}

function renderItemActions(item) {
  const options = { subject: item.name }
  return `<div class="inventory-actions">
    ${renderInventoryAction('view-item', 'View', item.itemId, options)}
    ${item.isActive ? `${renderInventoryAction('edit-item', 'Edit', item.itemId, options)}
    ${renderArchiveAction('item', item)}` : ''}
  </div>`
}

function renderTable(items) {
  return `<div class="inventory-table-layout">
    <table class="inventory-table table mb-0">
      <caption class="visually-hidden">Inventory results</caption>
      <thead><tr>
        <th scope="col">Item name</th>
        <th scope="col">Category</th>
        <th scope="col">Available quantity</th>
        <th scope="col">Minimum stock</th>
        <th scope="col">Stock status</th>
        <th scope="col">Actions</th>
      </tr></thead>
      <tbody>${items.map((item) => `<tr>
        <th scope="row">${escapeInventoryText(item.name)}${renderExpirationAlerts(item)}</th>
        <td>${escapeInventoryText(item.categoryName)}</td>
        <td class="inventory-quantity">${renderInventoryQuantity(item.availableQuantity, item.unit)}</td>
        <td class="inventory-quantity">${renderInventoryQuantity(item.minimumStockLevel, item.unit)}</td>
        <td>${renderStockStatus(item)}</td>
        <td>${renderItemActions(item)}</td>
      </tr>`).join('')}</tbody>
    </table>
  </div>`
}

function renderFacts(facts) {
  return `<dl class="inventory-facts">${facts.map(([label, markup]) => `
    <div><dt>${label}</dt><dd>${markup}</dd></div>`).join('')}</dl>`
}

function renderRecordList(items) {
  return `<ul class="inventory-records inventory-record-layout list-unstyled">${items.map((item) => `
    <li class="inventory-record">
      <h3>${escapeInventoryText(item.name)}</h3>
      ${renderFacts([
        ['Available quantity', renderInventoryQuantity(item.availableQuantity, item.unit)],
        ['Stock status', renderStockStatus(item)],
        ['Category', escapeInventoryText(item.categoryName)],
        ['Minimum stock', renderInventoryQuantity(item.minimumStockLevel, item.unit)],
      ])}
      ${renderExpirationAlerts(item)}
      ${renderItemActions(item)}
    </li>`).join('')}</ul>`
}

export function renderInventoryResults(model, filters, items = filterAndSortInventory(model.items, filters)) {
  if (items.length) return renderTable(items) + renderRecordList(items)

  const hasRecords = model.items.some((item) => item.isActive === (filters.view === 'active'))
  if (hasRecords) return '<p class="cafe-muted mb-0">No items match your search and filters. Clear filters to see more records.</p>'
  return filters.view === 'archived'
    ? '<p class="cafe-muted mb-0">No archived items.</p>'
    : '<p class="cafe-muted mb-0">No active inventory items. Use Add item to create a fictional record.</p>'
}

function renderRecordView(view, records) {
  return `<div class="inventory-actions" role="group" aria-label="${records} record view">
    ${['active', 'archived'].map((id) => `<button class="btn btn-${view === id ? 'primary' : 'outline-primary'}" type="button"
      data-inventory-action="record-view" data-id="${id}" aria-pressed="${view === id}">${id === 'active' ? 'Active' : 'Archived'}</button>`).join('')}
  </div>`
}

export function renderInventoryList(model, filters) {
  const sortOptions = [
    ['name-asc', 'Name A–Z'], ['name-desc', 'Name Z–A'],
    ['quantity-asc', 'Quantity low–high'], ['quantity-desc', 'Quantity high–low'],
  ]
  return `<section class="card cafe-card" aria-labelledby="inventory-list-title">
    <div class="card-body inventory-stack">
      <div class="inventory-section-heading">
        <h2 id="inventory-list-title" data-inventory-section-title tabindex="-1" class="mb-0">${filters.view === 'archived' ? 'Archived inventory' : 'Active inventory'}</h2>
        <div class="inventory-actions">${renderInventoryAction('add-item', 'Add item', undefined, { primary: true, icon: 'package-plus' })}</div>
      </div>
      ${renderRecordView(filters.view, 'Inventory')}
      ${filters.view === 'active' ? '<p class="cafe-muted cafe-supporting mb-0">The demo allows archival once an item has zero remaining stock.</p>' : ''}
      <div class="inventory-filters">
        <div class="inventory-search">
          <label class="form-label" for="inventory-query">Search items</label>
          <input class="form-control" type="search" id="inventory-query" data-filter="query" value="${escapeInventoryText(filters.query)}" placeholder="Item name or full ID">
        </div>
        <div>
          <label class="form-label" for="inventory-category">Category</label>
          <select class="form-select" id="inventory-category" data-filter="categoryId">
            ${renderOption('', 'All categories', filters.categoryId)}
            ${model.categories.map(({ categoryId, name, isActive }) => renderOption(categoryId, isActive ? name : `${name} (archived)`, filters.categoryId)).join('')}
          </select>
        </div>
        <div>
          <label class="form-label" for="inventory-stock">Stock status</label>
          <select class="form-select" id="inventory-stock" data-filter="stockStatus">
            ${renderOption('', 'Any status', filters.stockStatus)}
            ${Object.entries(stockBadges).map(([value, { label }]) => renderOption(value, label, filters.stockStatus)).join('')}
          </select>
        </div>
        <div>
          <label class="form-label" for="inventory-sort">Sort by</label>
          <select class="form-select" id="inventory-sort" data-filter="sort" aria-describedby="inventory-sort-note">
            ${sortOptions.map(([value, label]) => renderOption(value, label, filters.sort)).join('')}
          </select>
        </div>
        <div>${renderInventoryAction('clear-filters', 'Clear filters')}</div>
      </div>
      <p class="cafe-muted cafe-supporting mb-0" id="inventory-sort-note" data-quantity-sort-note hidden>Quantity sorting compares items within the same unit.</p>
      ${model.warningDays == null ? '<p class="cafe-muted cafe-supporting mb-0">The demo expiration warning period is unavailable. Stock quantities and status are still shown.</p>' : ''}
      <p class="cafe-muted cafe-supporting mb-0" data-inventory-count role="status"></p>
      <div data-inventory-results></div>
    </div>
  </section>`
}

function renderPurchaseCost(cost) {
  if (!Number.isSafeInteger(cost) || cost < 0) return 'Not recorded'
  const cents = BigInt(cost)
  const amount = `₱${numberFormat.format(cents / 100n)}.${String(cents % 100n).padStart(2, '0')}`
  return `${amount} <span class="cafe-muted cafe-supporting">(price basis pending)</span>`
}

export function renderItemDetails(item, model, fromDuplicate = false) {
  const formatter = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: model.businessTimezone })
  const batches = item.batches.map((batch) => `<li class="inventory-record">${renderFacts([
    ['Batch ID', escapeInventoryText(batch.batchId)],
    ['Received quantity', renderInventoryQuantity(batch.receivedQuantity, item.unit)],
    ['Remaining quantity', renderInventoryQuantity(batch.remainingQuantity, item.unit)],
    ['Purchase date', renderDate(batch.purchaseDate)],
    ['Expiration date', renderDate(batch.expirationDate)],
    ['Expiration status', expirationLabels[batch.expirationStatus] ?? 'Unavailable'],
    ['Purchase cost', renderPurchaseCost(batch.purchaseCost)],
  ])}</li>`)
  const movements = item.movements.map((movement) => `<li class="inventory-record">${renderFacts([
    ['Type', movementLabels.get(movement.type) ?? 'Stock movement'],
    ['Quantity', renderInventoryQuantity(movement.quantity, movement.unit, true)],
    ['Recorded', renderDate(movement.timestamp, formatter)],
    ['Reason', renderOptional(movement.reason)],
  ])}</li>`)

  return `<div class="inventory-stack">
    <div class="inventory-actions">${renderInventoryAction('back-item', fromDuplicate ? 'Back to form' : 'Back to inventory', undefined, { icon: 'arrow-left' })}</div>
    <section class="card cafe-card" aria-labelledby="item-details-title">
      <div class="card-body inventory-stack">
        <div class="inventory-section-heading">
          <h2 id="item-details-title" data-inventory-section-title tabindex="-1" class="mb-0">${escapeInventoryText(item.name)}</h2>
          ${item.isActive && !fromDuplicate ? `<div class="inventory-actions">
            ${renderInventoryAction('edit-item', 'Edit', item.itemId, { subject: item.name })}
            ${renderArchiveAction('item', item)}
          </div>` : ''}
        </div>
        ${renderFacts([
          ['Item ID', escapeInventoryText(item.itemId)],
          ['Record state', item.isActive ? 'Active' : 'Archived'],
          ['Category', escapeInventoryText(item.categoryName)],
          ['Unit of measurement', escapeInventoryText(item.unit)],
          ['Available quantity', renderInventoryQuantity(item.availableQuantity, item.unit)],
          ['Minimum stock', renderInventoryQuantity(item.minimumStockLevel, item.unit)],
          ['Stock status', renderStockStatus(item)],
          ['Created', renderDate(item.createdAt, formatter)],
          ['Last modified', renderDate(item.updatedAt, formatter)],
        ])}
        ${renderExpirationAlerts(item)}
        <div class="inventory-actions">
          ${item.isActive ? renderReceiveStockLink(item) : ''}
          ${item.isActive && !fromDuplicate ? `<a class="btn btn-outline-primary" href="${escapeInventoryText(routeHref('stock', { workflow: 'usage', item: item.itemId }))}">Record usage</a>` : ''}
          <a class="btn btn-outline-primary" href="${escapeInventoryText(routeHref('history', { item: item.itemId }))}">View transaction history</a>
        </div>
      </div>
    </section>
    <div class="inventory-detail-grid">
      ${renderCard({ id: 'item-batches-title', title: 'Stock batches', content: batches.length
        ? `<ul class="inventory-records list-unstyled">${batches.join('')}</ul>`
        : '<p class="cafe-muted mb-0">No batches have been recorded for this item.</p>' })}
      ${renderCard({ id: 'item-movements-title', title: 'Movement history', content: movements.length
        ? `<ol class="inventory-records list-unstyled">${movements.join('')}</ol>`
        : '<p class="cafe-muted mb-0">No stock movements have been recorded for this item.</p>' })}
    </div>
  </div>`
}

export function renderCategoryResults(model, { view, query }, categories) {
  if (!categories.length) {
    const hasRecords = model.categories.some(({ isActive }) => isActive === (view === 'active'))
    return `<p class="cafe-muted mb-0">${hasRecords && query
      ? 'No categories match your search. Clear filters to see more records.'
      : view === 'archived' ? 'No archived categories.' : 'No active categories. Add a category to organize inventory.'}</p>`
  }
  return `<ul class="inventory-records list-unstyled">${categories.map((category) => `<li class="inventory-record inventory-category-record">
    <div>
      <h3>${escapeInventoryText(category.name)}</h3>
      <p class="cafe-muted mb-0">${renderOptional(category.description, 'No description')}</p>
      <p class="cafe-supporting mb-0 mt-2"><strong>Active items</strong> ${numberFormat.format(category.activeItemCount)}</p>
    </div>
    ${category.isActive ? `<div class="inventory-actions">
      ${renderInventoryAction('edit-category', 'Edit', category.categoryId, { subject: category.name })}
      ${renderArchiveAction('category', category)}
    </div>` : ''}
  </li>`).join('')}</ul>`
}

export function renderCategoryList(filters) {
  return `<section class="card cafe-card" aria-labelledby="category-list-title">
    <div class="card-body inventory-stack">
      <div class="inventory-section-heading">
        <h2 id="category-list-title" data-inventory-section-title tabindex="-1" class="mb-0">${filters.view === 'archived' ? 'Archived categories' : 'Active categories'}</h2>
        <div class="inventory-actions">${renderInventoryAction('add-category', 'Add category', undefined, { primary: true, icon: 'tags' })}</div>
      </div>
      ${renderRecordView(filters.view, 'Category')}
      ${filters.view === 'active' ? '<p class="cafe-muted cafe-supporting mb-0">The demo allows archival once a category has no active inventory items.</p>' : ''}
      <div class="inventory-filters inventory-filters--categories">
        <div>
          <label class="form-label" for="category-query">Search categories</label>
          <input class="form-control" type="search" id="category-query" data-filter="query" value="${escapeInventoryText(filters.query)}" placeholder="Category name">
        </div>
        <div>${renderInventoryAction('clear-filters', 'Clear filters')}</div>
      </div>
      <p class="cafe-muted cafe-supporting mb-0" data-inventory-count role="status"></p>
      <div data-inventory-results></div>
    </div>
  </section>`
}
