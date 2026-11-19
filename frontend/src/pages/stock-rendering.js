import { renderPageHeader } from '../components/page-header.js'
import { renderMessage } from '../components/status.js'
import { routeHref } from '../router.js'
import { filterAndSortInventory } from '../services/inventory-read-model.js'
import { getDemoBatchEligibility } from '../services/stock-movements.js'
import { calculateStockPreview } from '../services/stock-preview.js'
import { catalogItemLabels, shortRecordReferences } from '../utils/catalog-display.js'
import { movementLabels } from '../utils/dashboard-format.js'
import { escapeInventoryText, renderDemoContext, renderInventoryQuantity, renderOption } from './inventory-rendering.js'

export const stockWorkflows = {
  receive: { title: 'Receive stock', icon: 'package-plus', quantity: 'Quantity received',
    description: 'Record a delivery and create a batch for an existing item.' },
  usage: { title: 'Record usage', icon: 'package-minus', quantity: 'Quantity used',
    description: 'Deduct stock used during regular operations.' },
  wastage: { title: 'Record wastage', icon: 'triangle-alert', quantity: 'Quantity wasted',
    description: 'Deduct unusable stock and record the reason.' },
  adjustment: { title: 'Adjust stock', icon: 'arrow-left-right', quantity: 'Adjustment quantity',
    description: 'Record a traceable correction to one or more existing batches.' },
}

const expirationLabels = {
  undated: 'Unclassified (no expiration date)',
  depleted: 'Depleted',
  expired: 'Expired',
  'warning-period-unset': 'Warning period unavailable',
  'expiring-soon': 'Expiring soon',
  current: 'Outside warning window',
}

const allocationPolicy = {
  stock_out: 'Ordinary usage excludes expired batches in this demo. Undated batches remain eligible.',
  wastage: 'Expired and undated batches can be selected for wastage in this demo.',
  negative_adjustment: 'Expired and undated batches can be selected for a negative adjustment in this demo.',
  positive_adjustment: 'Positive adjustments increase explicitly selected existing, non-expired or undated batches in this demo.',
}

export function stockMovementType(draft) {
  if (draft.workflow === 'receive') return 'stock_in'
  if (draft.workflow === 'usage') return 'stock_out'
  if (draft.workflow === 'wastage') return 'wastage'
  if (draft.direction === 'positive') return 'positive_adjustment'
  if (draft.direction === 'negative') return 'negative_adjustment'
  return ''
}

const escape = escapeInventoryText

function renderLink(destination, label, { primary = false, icon, attributes = '' } = {}) {
  const prefix = icon ? `<i data-lucide="${icon}" aria-hidden="true"></i> ` : ''
  return `<a class="btn btn-${primary ? 'primary' : 'outline-primary'}" href="${escape(destination)}"${attributes}>${prefix}${label}</a>`
}

function renderFacts(rows) {
  return `<dl class="stock-facts">${rows.map(([label, html]) =>
    `<div><dt>${label}</dt><dd>${html}</dd></div>`,
  ).join('')}</dl>`
}

const civilDateFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' })

function renderDate(value) {
  if (!value) return 'Not recorded'
  const date = new Date(value + 'T00:00:00Z')
  if (!Number.isFinite(date.getTime())) return 'Not recorded'
  return `<time datetime="${escape(value)}">${civilDateFormat.format(date)}</time>`
}

export function renderStockContext(model, storageMode) {
  return renderDemoContext(model, 'inventory', storageMode)
}

export function renderStockWorkspace(storageMode) {
  return `<div class="stock-workspace" data-stock-workspace>
    ${renderPageHeader({
      title: 'Stock Management',
      description: 'Receive deliveries, record usage and wastage, and make stock adjustments.',
    })}
    <div class="stock-stack">
      <div data-stock-context>${renderStockContext(null, storageMode)}</div>
      <div data-stock-content aria-busy="true"></div>
    </div>
  </div>`
}

export function renderStockLanding() {
  return `<section aria-labelledby="stock-workflows-title" class="stock-stack">
    <h2 class="mb-0" id="stock-workflows-title" tabindex="-1" data-stock-heading>Stock workflows</h2>
    <div class="stock-flow-grid">
      ${Object.entries(stockWorkflows).map(([workflow, details]) => `
        <article class="card cafe-card stock-flow-card">
          <div class="card-body stock-stack">
            <div class="stock-flow-icon"><i data-lucide="${details.icon}" aria-hidden="true"></i></div>
            <div>
              <h3 class="mb-1">${details.title}</h3>
              <p class="mb-0 cafe-muted">${details.description}</p>
            </div>
            <div>${renderLink(routeHref('stock', { workflow }), details.title, { attributes: ` data-stock-workflow="${workflow}"` })}</div>
          </div>
        </article>`).join('')}
    </div>
    <p class="cafe-muted mb-0">Batch expiration uses the demo business date above. Transaction History shows each movement’s recording time.</p>
    <div class="stock-actions">
      ${renderLink(routeHref('history'), 'View Transaction History', { icon: 'history' })}
    </div>
  </section>`
}

function findError(draft, field, batchId) {
  return draft.error?.field === field && draft.error.batchId === batchId ? draft.error : null
}

function renderError(error, inputId) {
  if (!error) return ''
  return `<span class="invalid-feedback" id="${inputId}-error" data-stock-field-error>${escape(error.message)}</span>`
}

function fieldAttributes(error, id, helpIds = []) {
  const descriptions = [...helpIds, ...(error ? [`${id}-error`] : [])]
  return `${error ? ' aria-invalid="true"' : ''}${descriptions.length > 0 ? ` aria-describedby="${descriptions.join(' ')}"` : ''}`
}

function renderField(draft, field, { id, label, help, options, numeric, multiline, required, type = 'text' } = {}) {
  const error = findError(draft, field)
  const value = escape(draft[field])
  const attributes = `id="${id}" name="${field}"${required ? ' required' : ''}${fieldAttributes(error, id, help ? [`${id}-help`] : [])}`
  const invalid = error ? ' is-invalid' : ''
  let control
  if (options) {
    control = `<select class="form-select${invalid}" ${attributes}>${options.map(([key, text]) => renderOption(key, text, draft[field])).join('')}</select>`
  } else if (multiline) {
    control = `<textarea class="form-control${invalid}" rows="3" ${attributes}>\n${value}</textarea>`
  } else {
    control = `<input class="form-control${invalid}" type="${type}"${numeric ? ' inputmode="numeric"' : ''} value="${value}" ${attributes}>`
  }
  return `<div class="stock-field">
    <label class="form-label" for="${id}">${label}</label>
    ${control}
    ${help ? `<span class="cafe-muted cafe-supporting stock-field-help" id="${id}-help">${help}</span>` : ''}
    ${renderError(error, id)}
  </div>`
}

function renderBatchReference(id, reference) {
  return `<span class="stock-batch-reference">${escape(reference)}</span>
    <details class="stock-id-disclosure">
      <summary>Full batch ID</summary><code class="stock-identifier">${escape(id)}</code>
    </details>`
}

export function stockItemOptions(model, query, itemId) {
  const matches = filterAndSortInventory(model.items, { query })
  const selected = model.itemById.get(itemId)
  const labels = catalogItemLabels(model.items.filter(({ isActive }) => isActive))
  const options = matches.map((item) => renderOption(item.itemId, labels.get(item.itemId), itemId))
  if (selected?.isActive && !matches.some((item) => item.itemId === itemId)) {
    options.unshift(renderOption(itemId, labels.get(itemId) + ' (current selection)', itemId))
  }
  return {
    markup: `<option value="" disabled${itemId ? '' : ' selected'}>Choose an active item</option>` + options.join(''),
    message: matches.length === 0 ? 'No active items match this search.' : `${matches.length} active ${matches.length === 1 ? 'item' : 'items'} available.`,
  }
}

function renderItemSelector(draft, model) {
  const { markup, message } = stockItemOptions(model, draft.query, draft.itemId)
  const error = findError(draft, 'itemId')
  return `<div class="stock-fields">
    <div class="stock-field">
      <label class="form-label" for="stock-item-query">Search active items</label>
      <input class="form-control" type="search" name="query" id="stock-item-query" value="${escape(draft.query)}" placeholder="Name or full item ID" aria-controls="stock-item">
    </div>
    <div class="stock-field">
      <label class="form-label" for="stock-item">Inventory item</label>
      <select class="form-select${error ? ' is-invalid' : ''}" name="itemId" id="stock-item" required${fieldAttributes(error, 'stock-item', ['stock-item-options-status'])}>${markup}</select>
      <span class="cafe-muted cafe-supporting stock-field-help" id="stock-item-options-status" role="status">${message}</span>
      ${renderError(error, 'stock-item')}
    </div>
  </div>`
}

export function renderStockTotals(draft, item, businessDate, options) {
  const result = calculateStockPreview(draft, item, stockMovementType(draft), businessDate, options)
  const tone = {
    incomplete: 'info', valid: 'success', 'incomplete-allocation': 'warning',
  }[result.state] ?? 'error'
  const quantity = (value, signed = false) => value === null ? 'Unavailable' : renderInventoryQuantity(value, item.unit, signed)
  const rows = item ? [
    ['Current recorded balance', quantity(result.recorded)],
    ['Requested change', result.change === null ? 'Enter a quantity' : quantity(result.change, true)],
    ['Expected balance', `<span data-stock-resulting-quantity>${quantity(result.expected)}</span>`],
  ] : []
  if (item && draft.workflow === 'usage') {
    rows.push(
      ['Eligible for usage', quantity(result.available?.eligibleQuantity ?? null)],
      ['Excluded due to expiration', quantity(result.available?.expiredExcludedQuantity ?? null)],
    )
  }
  if (item && draft.workflow !== 'receive') {
    rows.push(['Total allocated', quantity(result.assigned)],
      [result.remaining < 0 ? 'Over-allocated by' : 'Remaining to allocate',
        quantity(result.remaining === null ? null : Math.abs(result.remaining))])
  }
  const shortage = result.availableForDeduction === undefined ? '' : renderFacts([
    [result.state === 'insufficient-batch' ? 'Available in batch' : 'Available for deduction', quantity(result.availableForDeduction)],
    ['Requested deduction', quantity(result.requested)],
    ['Shortage', quantity(result.requested - result.availableForDeduction)],
  ])
  const progress = item && result.progress ? `<div class="stock-allocation-progress">
    <span>Assigned ${quantity(result.progress.assigned)} of ${quantity(result.progress.requested)}</span>
    <progress aria-label="Batch allocation progress" value="${result.progress.assigned}" max="${result.progress.requested}"></progress>
  </div>` : ''
  return `<section class="stock-balance" aria-label="Balance preview" data-stock-preview-state="${result.state}" data-stock-tone="${tone}">
    ${rows.length ? renderFacts(rows) : ''}
    ${progress}
    <p class="mb-0"><strong>${escape(result.message)}</strong></p>
    ${shortage}
    ${tone === 'error' ? '<p class="mb-0 cafe-supporting">No movement recorded.</p>' : ''}
  </section>`
}

function renderBatchRow(batch, reference, index, draft, type, item, businessDate) {
  const { eligible, reason } = getDemoBatchEligibility(batch, type, businessDate)
  const error = findError(draft, 'allocations', batch.batchId)
  const id = `stock-allocation-${index}`
  const value = draft.allocations.get(batch.batchId) ?? ''
  const status = expirationLabels[batch.expirationStatus] ?? 'Unclassified'
  const reasonId = `${id}-restriction`
  return `<tr role="row">
    <th scope="row" role="rowheader"><span class="stock-batch-card-label" aria-hidden="true">Batch</span>${renderBatchReference(batch.batchId, reference)}</th>
    <td role="cell"><span class="stock-batch-card-label" aria-hidden="true">Remaining</span>${renderInventoryQuantity(batch.remainingQuantity, item.unit)}</td>
    <td role="cell"><span class="stock-batch-card-label" aria-hidden="true">Purchased</span>${renderDate(batch.purchaseDate)}</td>
    <td role="cell"><span class="stock-batch-card-label" aria-hidden="true">Expiration</span>${renderDate(batch.expirationDate)}<div class="cafe-muted cafe-supporting">${status}</div></td>
    <td role="cell">
      <label for="${id}" class="stock-batch-card-label"><span aria-hidden="true">Assigned quantity</span><span class="visually-hidden">Assign to batch ${escape(reference)}</span></label>
      <input type="text" inputmode="numeric" class="form-control${error ? ' is-invalid' : ''}" id="${id}"
        aria-label="Assigned quantity for batch ${escape(reference)}" value="${escape(value)}"
        data-stock-batch-id="${escape(batch.batchId)}"${!eligible && value === '' ? ' disabled' : ''}
        ${fieldAttributes(error, id, eligible ? [] : [reasonId])}>
      ${eligible ? '' : `<div class="cafe-muted cafe-supporting" id="${reasonId}">${escape(reason)}${value === '' ? '' : ' Clear this assignment before reviewing.'}</div>`}
      ${renderError(error, id)}
    </td>
  </tr>`
}

function renderAllocations(draft, model, item) {
  const type = stockMovementType(draft)
  const error = findError(draft, 'allocations')
  const references = shortRecordReferences((item?.batches ?? []).map(({ batchId }) => batchId))
  let content = '<p class="cafe-muted mb-0">Select an item to view its batches.</p>'
  if (item && !type) content = '<p class="cafe-muted mb-0">Choose an adjustment direction to see eligible batches.</p>'
  if (item && type) content = item.batches.length === 0
    ? '<p class="cafe-muted mb-0">This item has no recorded batches. Receive a delivery to create a batch.</p>'
    : `<table class="stock-allocation-table" role="table" aria-label="Batch assignments">
        <thead role="rowgroup"><tr role="row">
          <th scope="col" role="columnheader">Batch reference</th>
          <th scope="col" role="columnheader">Remaining</th>
          <th scope="col" role="columnheader">Purchased</th>
          <th scope="col" role="columnheader">Expiration</th>
          <th scope="col" role="columnheader">Assigned quantity</th>
        </tr></thead>
        <tbody role="rowgroup">${item.batches.map((batch, index) => renderBatchRow(batch, references.get(batch.batchId), index, draft, type, item, model.businessDate)).join('')}</tbody>
      </table>`
  return `<section class="stock-stack stock-allocation" aria-labelledby="stock-allocation-title">
    <h3 class="mb-0" id="stock-allocation-title" tabindex="-1">Batch assignments</h3>
    ${type && allocationPolicy[type] ? `<p class="mb-0 cafe-muted">${allocationPolicy[type]}</p>` : ''}
    ${item && type && item.batches.length ? '<p class="mb-0 cafe-muted">Enter a whole quantity beside each batch you want to use. Leave the other quantities blank.</p>' : ''}
    ${error ? `<div class="stock-error" role="alert" tabindex="-1" data-stock-form-error>${escape(error.message)}</div>` : ''}
    ${content}
  </section>`
}

function renderFormFields(draft) {
  const { workflow } = draft
  const adjustment = workflow === 'adjustment'
  const receive = workflow === 'receive'
  const reasonRequired = adjustment || workflow === 'wastage'
  return `<div class="stock-fields">
    ${renderField(draft, 'quantity', { id: 'stock-quantity', label: stockWorkflows[workflow].quantity, numeric: true, required: true, help: 'Enter a positive whole number in the item’s unit.' })}
    ${adjustment ? renderField(draft, 'direction', {
      id: 'stock-direction', label: 'Adjustment direction', required: true,
      options: [['', 'Choose a direction'], ['positive', 'Increase stock'], ['negative', 'Decrease stock']],
    }) : ''}
    ${receive ? `
      ${renderField(draft, 'purchaseDate', { id: 'stock-purchase-date', label: 'Purchase date (optional)', type: 'date' })}
      ${renderField(draft, 'expirationDate', { id: 'stock-expiration-date', label: 'Expiration date (optional)', type: 'date', help: 'Expiration uses the demo business date shown above.' })}
    ` : ''}
    <div class="stock-full-width">
      ${renderField(draft, 'reason', { id: 'stock-reason', label: reasonRequired ? 'Reason (required)' : 'Reason (optional)', multiline: true, required: reasonRequired })}
    </div>
  </div>`
}

export function renderStockForm(draft, model) {
  const { workflow } = draft
  const item = model.itemById.get(draft.itemId)
  const fieldNames = ['itemId', 'quantity', 'direction', 'purchaseDate', 'expirationDate', 'reason', 'allocations']
  const batchVisible = !draft.error?.batchId || item?.batches.some((batch) => batch.batchId === draft.error.batchId)
  const generalError = draft.error && (!fieldNames.includes(draft.error.field) || !batchVisible)
  return `<article class="card cafe-card" aria-labelledby="stock-form-heading">
    <div class="card-body stock-stack">
      <h2 class="mb-0" id="stock-form-heading" tabindex="-1" data-stock-heading>${stockWorkflows[workflow].title}</h2>
      ${workflow === 'receive' ? '<p class="cafe-muted mb-0">Receive stock for an existing item. Opening-stock entry is deferred, and purchase cost is left unset in this demo.</p>' : ''}
      ${workflow === 'adjustment' ? '<p class="cafe-muted mb-0">Adjustment access is open for the demo. Production staff permissions are pending.</p>' : ''}
      ${generalError ? `<div class="stock-error" role="alert" tabindex="-1" data-stock-form-error>${escape(draft.error.message)}</div>` : ''}
      <form data-stock-form novalidate>
        <fieldset class="stock-stack"${draft.busy ? ' disabled' : ''}>
          ${renderItemSelector(draft, model)}
          ${item ? renderFacts([['Selected item', escape(item.name)], ['Category', escape(item.categoryName)], ['Unit', escape(item.unit)]]) : ''}
          ${renderFormFields(draft)}
          <div data-stock-totals aria-live="polite">${renderStockTotals(draft, item, model.businessDate)}</div>
          ${workflow === 'receive' ? '' : renderAllocations(draft, model, item)}
          <div class="stock-actions">
            <button class="btn btn-primary" type="submit" data-stock-preview>Review movement</button>
            <button class="btn btn-outline-primary" type="button" data-stock-cancel>Cancel</button>
          </div>
        </fieldset>
      </form>
    </div>
  </article>`
}

export function renderStockConfirmation(preview, busy = false, itemBatches = [], error = null, storageMode) {
  const unit = preview.item.unit
  const references = shortRecordReferences([
    ...itemBatches.map(({ batchId }) => batchId),
    ...preview.assignments.map(({ batchId }) => batchId),
  ])
  const rows = [
    ['Item', escape(preview.item.name)],
    ['Item ID', escape(preview.item.itemId)],
    ['Category', escape(preview.item.categoryName)],
    ['Movement', movementLabels.get(preview.type) ?? 'Stock movement'],
    ['Current balance', renderInventoryQuantity(preview.currentQuantity, unit)],
    ['Quantity change', renderInventoryQuantity(preview.quantityChange, unit, true)],
    ['Expected balance', `<span data-stock-resulting-quantity>${renderInventoryQuantity(preview.resultingQuantity, unit)}</span>`],
  ]
  if (preview.type === 'stock_in') rows.push(['Purchase date', renderDate(preview.purchaseDate)], ['Expiration date', renderDate(preview.expirationDate)])
  if (preview.reason) rows.push(['Reason', escape(preview.reason)])
  return `<article class="card cafe-card" aria-labelledby="stock-confirm-heading" data-stock-confirmation>
    <div class="card-body stock-stack">
      <h2 class="mb-0" id="stock-confirm-heading" tabindex="-1" data-stock-heading>Review movement</h2>
      ${renderFacts(rows)}
      <h3 class="mb-0">Batch assignments</h3>
      <ul class="stock-batch-confirm-list mb-0">
        ${preview.assignments.map((assignment) => `<li>
          ${renderFacts([
            [assignment.isNew ? 'New batch' : 'Batch reference', renderBatchReference(assignment.batchId, references.get(assignment.batchId))],
            ['Current batch balance', renderInventoryQuantity(assignment.remainingQuantity, unit)],
            ['Change', renderInventoryQuantity(assignment.quantityChange, unit, true)],
            ['Expected batch balance', renderInventoryQuantity(assignment.resultingQuantity, unit)],
          ])}
        </li>`).join('')}
      </ul>
      <p class="cafe-muted mb-0">${storageMode === 'isolated'
        ? 'Confirming adds this movement to the temporary demo inventory.'
        : 'Confirming saves this movement in this browser.'}</p>
      ${error ? `<div role="alert" tabindex="-1" data-stock-confirm-error>${renderMessage({
        tone: 'error', icon: 'circle-alert', title: 'Could not confirm the movement',
        message: escape(error.message) + ' Retry this confirmation to use the same movement review.',
      })}</div>` : ''}
      <div class="stock-actions">
        <button class="btn btn-primary" type="button" data-stock-confirm${busy ? ' disabled' : ''}>${error ? 'Retry confirmation' : 'Confirm and record'}</button>
        <button class="btn btn-outline-primary" type="button" data-stock-back${busy ? ' disabled' : ''}>Back to form</button>
        <button class="btn btn-outline-primary" type="button" data-stock-cancel${busy ? ' disabled' : ''}>Cancel</button>
      </div>
    </div>
  </article>`
}

export function renderStockSuccess(result, storageMode) {
  const { item_id: item, movement_id: movement } = result.movement
  const isolated = storageMode === 'isolated'
  return `<section class="stock-stack" aria-labelledby="stock-result-heading">
    <h2 id="stock-result-heading" class="mb-0" data-stock-heading tabindex="-1">Movement recorded</h2>
    <div role="status">${renderMessage({
      tone: 'success', icon: 'info', title: isolated ? 'Temporary demo inventory updated' : 'Local demo inventory updated',
      message: isolated ? 'Stock movement saved in this temporary session.' : 'Stock movement saved in this browser.',
    })}</div>
    <div class="stock-actions">
      ${renderLink(routeHref('history', { item, movement }), 'View transaction', { primary: true, icon: 'history' })}
      ${renderLink(routeHref('inventory', { item }), 'View inventory item')}
      <button class="btn btn-outline-primary" type="button" data-stock-new>Record another movement</button>
    </div>
  </section>`
}
