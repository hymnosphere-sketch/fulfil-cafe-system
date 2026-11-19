import { renderPageHeader } from '../components/page-header.js'
import { renderMessage } from '../components/status.js'
import { routeHref } from '../router.js'
import {
  buildTransactionHistory, filterTransactionHistory, validateTransactionDateRange,
} from '../services/transaction-history.js'
import { catalogItemLabels } from '../utils/catalog-display.js'
import { movementLabels } from '../utils/dashboard-format.js'
import {
  escapeInventoryText as escapeText, renderDemoContext, renderInventoryQuantity, renderOption,
} from './inventory-rendering.js'

const numberFormat = new Intl.NumberFormat('en-PH')
const filterDateNames = ['fromDate', 'toDate']

function filtersFromURL(params) {
  const type = params.get('type')
  return {
    itemId: params.get('item') ?? '',
    type: movementLabels.has(type) ? type : '',
    fromDate: params.get('from') ?? '',
    toDate: params.get('to') ?? '',
  }
}

function historyHref({ itemId, type, fromDate, toDate }, movementId) {
  const params = new URLSearchParams()
  for (const [name, value] of Object.entries({ item: itemId, type, from: fromDate, to: toDate, movement: movementId })) {
    if (value) params.set(name, value)
  }
  return routeHref('history', params)
}

function recordingTimeFormat(timeZone) {
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'medium', timeZone })
}

function renderTimestamp(timestamp, formatter) {
  return `<time datetime="${escapeText(timestamp)}">${escapeText(formatter.format(new Date(timestamp)))}</time>`
}

function renderReason(reason) {
  return reason ? escapeText(reason) : '<span class="cafe-muted">None recorded</span>'
}

function renderMovementType(type) {
  return escapeText(movementLabels.get(type) ?? 'Stock movement')
}

function viewLink(movement, filters) {
  const href = escapeText(historyHref(filters, movement.movementId))
  const description = escapeText(`View details for ${movement.name}, ${movementLabels.get(movement.type) ?? 'stock movement'}`)
  return `<a class="btn btn-outline-primary" href="${href}" aria-label="${description}" data-history-view>View details</a>`
}

function archivedItemLabel(movement) {
  return movement.isActive ? '' : ' <small class="cafe-muted">(archived)</small>'
}

export function renderHistoryRows(movements, businessTimezone, filters = {}) {
  if (!movements.length) return '<p class="mb-0">No movements match these filters.</p>'

  const formatter = recordingTimeFormat(businessTimezone)
  return `
    <table class="table history-table mb-0">
      <caption class="visually-hidden">Stock movements, newest first</caption>
      <thead>
        <tr>
          <th scope="col">Item</th><th scope="col">Movement</th><th scope="col">Quantity</th>
          <th scope="col">Recorded</th><th scope="col">Reason</th><th scope="col">Details</th>
        </tr>
      </thead>
      <tbody>${movements.map((movement) => `
        <tr data-history-record>
          <th scope="row">${escapeText(movement.name)}${archivedItemLabel(movement)}</th>
          <td>${renderMovementType(movement.type)}</td>
          <td>${renderInventoryQuantity(movement.quantity, movement.unit, true)}</td>
          <td>${renderTimestamp(movement.timestamp, formatter)}</td>
          <td class="history-reason">${renderReason(movement.reason)}</td>
          <td>${viewLink(movement, filters)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <ol class="list-unstyled history-cards mb-0">${movements.map((movement) => `
      <li class="history-record" data-history-record>
        <h3 class="history-record-title">${escapeText(movement.name)}${archivedItemLabel(movement)}</h3>
        <dl class="inventory-facts mb-3">
          <div><dt>Movement</dt><dd>${renderMovementType(movement.type)}</dd></div>
          <div><dt>Quantity</dt><dd>${renderInventoryQuantity(movement.quantity, movement.unit, true)}</dd></div>
          <div><dt>Recorded</dt><dd>${renderTimestamp(movement.timestamp, formatter)}</dd></div>
          <div><dt>Reason</dt><dd class="history-reason">${renderReason(movement.reason)}</dd></div>
        </dl>
        ${viewLink(movement, filters)}
      </li>`).join('')}
    </ol>
  `
}

export function renderTransactionDetail(movement, businessTimezone, filters = {}) {
  const backHref = escapeText(historyHref(filters))
  const itemHref = escapeText(routeHref('inventory', { item: movement.itemId }))
  return `
    <section class="card cafe-card" aria-labelledby="history-detail-heading" data-history-detail>
      <div class="card-body inventory-stack">
        <h2 id="history-detail-heading" class="mb-0" tabindex="-1" data-history-detail-heading>Transaction details</h2>
        <dl class="inventory-facts">
          <div class="history-identifier"><dt>Transaction ID</dt><dd>${escapeText(movement.movementId)}</dd></div>
          <div><dt>Item</dt><dd>${escapeText(movement.name)}${archivedItemLabel(movement)}</dd></div>
          <div><dt>Category</dt><dd>${escapeText(movement.categoryName)}</dd></div>
          <div><dt>Movement</dt><dd>${renderMovementType(movement.type)}</dd></div>
          <div><dt>Quantity</dt><dd>${renderInventoryQuantity(movement.quantity, movement.unit, true)}</dd></div>
          <div><dt>Recorded</dt><dd>${renderTimestamp(movement.timestamp, recordingTimeFormat(businessTimezone))} · ${escapeText(businessTimezone)}</dd></div>
          <div><dt>Reason</dt><dd class="history-reason">${renderReason(movement.reason)}</dd></div>
        </dl>
        <section aria-labelledby="history-allocations-heading">
          <h3 id="history-allocations-heading" class="history-record-title">Batch allocations</h3>
          <ul class="list-unstyled history-allocation-list mb-0">
            ${movement.allocations.map(({ batchId, quantity }) => `<li class="history-record">
              <dl class="inventory-facts">
                <div><dt>Batch ID</dt><dd>${escapeText(batchId)}</dd></div>
                <div><dt>Quantity change</dt><dd>${renderInventoryQuantity(quantity, movement.unit, true)}</dd></div>
              </dl>
            </li>`).join('')}
          </ul>
        </section>
        <div class="inventory-actions">
          <a class="btn btn-outline-primary" href="${backHref}">Back to history</a>
          <a class="btn btn-outline-primary" href="${itemHref}">View item</a>
        </div>
      </div>
    </section>
  `
}

function renderDateField(name, id, label, value) {
  return `<div>
    <label class="form-label" for="${id}">${label}</label>
    <input class="form-control" type="date" id="${id}" name="${name}" value="${escapeText(value)}" aria-describedby="history-date-help">
    <p class="history-field-error cafe-supporting mb-0" id="${id}-error" hidden></p>
  </div>`
}

export function renderHistoryList(model, filters) {
  // Lead with the reference so a narrow native select keeps the distinction visible.
  const labels = catalogItemLabels(model.items, { referenceFirst: true })
  return `
    <section class="card cafe-card" aria-labelledby="history-list-heading">
      <div class="card-body inventory-stack">
        <h2 id="history-list-heading" class="mb-0" tabindex="-1">Stock movements</h2>
        <form class="inventory-stack" data-history-filters novalidate aria-label="Filter stock movements">
          <div class="history-filters">
            <div>
              <label for="history-item" class="form-label">Inventory item</label>
              <select class="form-select" id="history-item" name="itemId">
                ${renderOption('', 'All items', filters.itemId)}
                ${model.items.map(({ itemId }) =>
                  renderOption(itemId, labels.get(itemId), filters.itemId)).join('')}
              </select>
            </div>
            <div>
              <label for="history-type" class="form-label">Movement type</label>
              <select class="form-select" id="history-type" name="type">
                ${renderOption('', 'All movement types', filters.type)}
                ${Array.from(movementLabels, ([type, label]) => renderOption(type, label, filters.type)).join('')}
              </select>
            </div>
            ${renderDateField('fromDate', 'history-from', 'From date', filters.fromDate)}
            ${renderDateField('toDate', 'history-to', 'To date', filters.toDate)}
          </div>
          <p id="history-date-help" class="cafe-muted cafe-supporting mb-0">Dates use ${escapeText(model.businessTimezone)} and include both selected days.</p>
          <div class="inventory-actions">
            <button class="btn btn-primary" type="submit">Apply filters</button>
            <button class="btn btn-outline-primary" type="button" data-history-clear>Clear filters</button>
          </div>
          <p class="history-field-error mb-0" data-history-filter-note role="alert" hidden>Correct the dates and apply the filters again.</p>
        </form>
        <p data-history-count role="status" class="cafe-muted mb-0"></p>
        <div data-history-results></div>
      </div>
    </section>
  `
}

function readFilters(form) {
  const filters = Object.fromEntries(new FormData(form))
  for (const name of filterDateNames) {
    if (form.elements.namedItem(name).validity.badInput) filters[name] = 'invalid date'
  }
  return filters
}

function showDateErrors(form, errors) {
  for (const name of filterDateNames) {
    const input = form.elements.namedItem(name)
    const errorId = input.id + '-error'
    const message = form.querySelector('#' + errorId)
    message.textContent = errors[name] ?? ''
    message.hidden = !errors[name]
    if (errors[name]) input.setAttribute('aria-invalid', 'true')
    else input.removeAttribute('aria-invalid')

    input.setAttribute('aria-describedby', errors[name] ? 'history-date-help ' + errorId : 'history-date-help')
  }
  form.querySelector('[data-history-filter-note]').hidden = !Object.keys(errors).length
}

function mountList(content, model, requestedFilters) {
  content.innerHTML = renderHistoryList(model, requestedFilters)
  const form = content.querySelector('[data-history-filters]')
  const results = content.querySelector('[data-history-results]')
  const count = content.querySelector('[data-history-count]')

  function applyFilters(filters, updateURL) {
    const { errors, movements } = filterTransactionHistory(model.movements, filters)
    showDateErrors(form, errors)
    if (Object.keys(errors).length) {
      if (updateURL) form.elements.namedItem(Object.keys(errors)[0]).focus()
      return
    }

    results.innerHTML = renderHistoryRows(movements, model.businessTimezone, filters)
    count.textContent = `${numberFormat.format(movements.length)} ${movements.length === 1 ? 'movement' : 'movements'} found`
    if (updateURL) window.history.replaceState(window.history.state, '', historyHref(filters))
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    applyFilters(readFilters(form), true)
  })
  form.addEventListener('input', () => {
    if (form.querySelector('[aria-invalid="true"]')) {
      showDateErrors(form, validateTransactionDateRange(readFilters(form)))
    }
  })
  form.querySelector('[data-history-clear]').addEventListener('click', () => {
    for (const name of Object.keys(requestedFilters)) form.elements.namedItem(name).value = ''
    applyFilters(readFilters(form), true)
  })
  applyFilters(requestedFilters, false)
}

export function createTransactionHistory({ repository, renderIcons, storageMode }) {
  let refreshMounted

  function mount(main, params = new URLSearchParams()) {
    main.innerHTML = `
      <div class="history-workspace">
        ${renderPageHeader({
          title: 'Transaction History',
          description: 'Review recorded stock movements and the batches they affected.',
        })}
        <div class="inventory-stack">
          ${renderDemoContext(null, 'history', storageMode)}
          <p class="cafe-muted cafe-supporting mb-0">Item and category names reflect the current catalog.</p>
          <div data-history-content aria-busy="true" role="status">Loading stock movements…</div>
        </div>
      </div>
    `
    const root = main.firstElementChild
    const content = root.querySelector('[data-history-content]')
    const movementId = params.get('movement')
    let readSequence = 0
    renderIcons(root)

    async function load({ retry = false, refresh = false } = {}) {
      const attempt = ++readSequence
      const hash = window.location.hash
      const filters = filtersFromURL(refresh || retry ? new URLSearchParams(hash.split('?', 2)[1]) : params)
      const isCurrent = () => root.isConnected && attempt === readSequence && window.location.hash === hash
      content.setAttribute('aria-busy', 'true')
      if (retry) content.textContent = 'Loading stock movements…'
      try {
        const snapshot = await repository.read()
        if (!isCurrent()) return
        const model = buildTransactionHistory(snapshot)
        content.removeAttribute('role')
        if (!movementId) {
          mountList(content, model, filters)
          if (retry) content.querySelector('#history-list-heading').focus()
        } else {
          const movement = model.movementById.get(movementId)
          if (movement) {
            content.innerHTML = renderTransactionDetail(movement, model.businessTimezone, filters)
            if (!refresh && (root.contains(document.activeElement) || document.activeElement === document.body)) {
              content.querySelector('[data-history-detail-heading]').focus()
            }
          } else {
            content.innerHTML = `<div class="inventory-stack">
              ${renderMessage({
                tone: 'info', icon: 'info', title: 'Transaction unavailable',
                message: 'This movement is unavailable in the local demo inventory.',
              })}
              <div><a class="btn btn-outline-primary" href="${escapeText(historyHref(filters))}">Back to history</a></div>
            </div>`
          }
        }
      } catch {
        if (!isCurrent()) return
        content.removeAttribute('role')
        content.innerHTML = `<div class="inventory-stack" role="alert">
          ${renderMessage({
            tone: 'error', icon: 'circle-alert', title: 'Could not load transaction history',
            message: 'Try reading the saved local inventory again.',
          })}
          <div><button type="button" class="btn btn-outline-primary" data-history-retry>Retry</button></div>
        </div>`
      } finally {
        if (root.isConnected && readSequence === attempt) {
          content.setAttribute('aria-busy', 'false')
          if (isCurrent()) renderIcons(content)
        }
      }
    }
    root.addEventListener('click', (event) => {
      if (!event.target.closest('[data-history-retry]')) return
      root.querySelector('#page-title').focus()
      void load({ retry: true })
    })
    refreshMounted = () => {
      const focused = document.activeElement
      if (!root.isConnected || (content.contains(focused) && focused.closest('[data-history-filters]'))) return
      return load({ refresh: true })
    }
    void load()
  }

  return { mount, refresh: () => refreshMounted?.() }
}
