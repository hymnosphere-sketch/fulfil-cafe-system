import { renderMessage } from '../components/status.js'
import { routeHref } from '../router.js'
import { buildInventoryReadModel } from '../services/inventory-read-model.js'
import { validateDemoStockMovement } from '../services/stock-movements.js'
import {
  renderStockConfirmation, renderStockContext, renderStockForm, renderStockLanding, renderStockSuccess,
  renderStockTotals, renderStockWorkspace, stockItemOptions, stockMovementType, stockWorkflows,
} from './stock-rendering.js'

function createDraft(workflow, itemId = '') {
  return {
    workflow, itemId, query: '', quantity: '', purchaseDate: '', expirationDate: '', reason: '', direction: '',
    allocations: new Map(), busy: false, error: null, preview: null, result: null,
  }
}

function movementCommand(draft, model) {
  return {
    itemId: draft.itemId,
    type: stockMovementType(draft),
    quantity: draft.quantity,
    unit: model.itemById.get(draft.itemId)?.unit,
    scale: 0,
    purchaseDate: draft.purchaseDate || null,
    expirationDate: draft.expirationDate || null,
    reason: draft.reason,
    allocations: [...draft.allocations].map(([batchId, quantity]) => ({ batchId, quantity })),
  }
}

function validationError(error, draft) {
  return {
    field: error?.field === 'type' && draft.workflow === 'adjustment' ? 'direction' : error?.field,
    batchId: error?.batchId,
    message: typeof error?.message === 'string' ? error.message : 'The movement could not be prepared.',
  }
}

function errorWasCorrected(view, field, batchId) {
  const { draft, model, snapshot } = view
  const { field: invalidField, batchId: invalidBatch } = draft.error ?? {}
  const updatesAllocationTotal = invalidField === 'allocations' && !invalidBatch && field === 'quantity'
  const updatesDateOrder = invalidField === 'expirationDate' && field === 'purchaseDate'
  if (!updatesAllocationTotal && !updatesDateOrder &&
    (invalidField !== field || (invalidBatch && invalidBatch !== batchId))) return false

  try {
    validateDemoStockMovement(snapshot, movementCommand(draft, model), model.businessDate)
    return true
  } catch (error) {
    const next = validationError(error, draft)
    // Keep an allocation or date-range message while its related field is still invalid.
    if (!next.field || ((updatesAllocationTotal || updatesDateOrder) && next.field === field)) return false
    return next.field !== invalidField || next.batchId !== invalidBatch
  }
}

function clearStockError(view) {
  view.draft.error = null
  view.content.querySelector('[data-stock-form-error]')?.remove()
  const field = view.content.querySelector('[aria-invalid="true"]')
  if (!field) return

  field.classList.remove('is-invalid')
  field.removeAttribute('aria-invalid')
  const errorId = field.id + '-error'
  const descriptions = (field.getAttribute('aria-describedby') ?? '').split(' ')
    .filter((id) => id && id !== errorId)
  if (descriptions.length) field.setAttribute('aria-describedby', descriptions.join(' '))
  else field.removeAttribute('aria-describedby')
  view.content.querySelector('[data-stock-field-error]')?.remove()
}

function incompleteDateControl(form) {
  return [...form.querySelectorAll('input[type="date"]')].find((input) => input.validity.badInput)
}

function refreshStockTotals(view) {
  const { content, model, draft } = view
  const form = content.querySelector('[data-stock-form]')
  const totals = form.querySelector('[data-stock-totals]')
  totals.innerHTML = renderStockTotals(draft, model.itemById.get(draft.itemId), model.businessDate, {
    hasInvalidDateInput: Boolean(incompleteDateControl(form)),
  })
}

function showIncompleteDateError(view, input) {
  clearStockError(view)
  const message = 'Finish entering the date or clear the field.'
  const errorId = input.id + '-error'
  view.draft.error = { field: input.name, message }
  input.classList.add('is-invalid')
  input.setAttribute('aria-invalid', 'true')
  input.setAttribute('aria-describedby', [input.getAttribute('aria-describedby'), errorId].filter(Boolean).join(' '))
  const error = input.ownerDocument.createElement('span')
  error.className = 'invalid-feedback'
  error.id = errorId
  error.dataset.stockFieldError = ''
  error.textContent = message
  input.after(error)
  input.focus()
  refreshStockTotals(view)
}

export function createStockWorkspace({ repository, renderIcons }) {
  const drafts = new Map()
  let currentView

  function isActive(view) {
    return currentView === view && view.root.isConnected
  }

  function viewFor(draft) {
    return currentView?.draft === draft && isActive(currentView) ? currentView : null
  }

  function draftFor(workflow, itemId) {
    const key = JSON.stringify([workflow, itemId])
    const saved = drafts.get(key)
    if (!saved || saved.result) drafts.set(key, createDraft(workflow, itemId))
    return { key, draft: drafts.get(key) }
  }

  function render(view, { focus, preserveFocus } = {}) {
    if (!isActive(view)) return
    const { draft, content, model } = view
    if (!draft) content.innerHTML = renderStockLanding()
    else if (draft.result) content.innerHTML = renderStockSuccess(draft.result)
    else if (draft.preview) {
      const batches = model?.itemById.get(draft.preview.item.itemId)?.batches
      content.innerHTML = renderStockConfirmation(draft.preview, draft.busy, batches)
    }
    else if (model) content.innerHTML = renderStockForm(draft, model)
    renderIcons(content)
    const target = preserveFocus
      ? content.querySelector(preserveFocus) ?? content.querySelector('[data-stock-heading]')
      : focus === 'error'
        ? content.querySelector('[aria-invalid="true"], [data-stock-form-error]')
        : focus && content.querySelector('[data-stock-heading]')
    target?.focus({ preventScroll: Boolean(preserveFocus) })
  }

  async function load(view, options) {
    const read = ++view.read
    view.content.setAttribute('aria-busy', 'true')
    if (!view.draft) render(view)
    else if (!view.model) view.content.innerHTML = '<p class="cafe-muted" role="status">Loading fictional inventory records…</p>'
    try {
      const snapshot = await repository.read()
      if (!isActive(view) || read !== view.read) return
      const model = buildInventoryReadModel(snapshot)
      view.snapshot = snapshot
      view.model = model
      const draft = view.draft
      if (draft?.itemId && !draft.preview && !model.itemById.get(draft.itemId)?.isActive) {
        draft.itemId = ''
        draft.allocations.clear()
      }
      view.context.innerHTML = renderStockContext(model)
      renderIcons(view.context)
      render(view, options)
    } catch {
      if (!isActive(view) || read !== view.read) return
      view.content.innerHTML = `<div role="alert">${renderMessage({
        tone: 'error', icon: 'circle-alert', title: 'Stock records are unavailable',
        message: 'Try loading the fictional inventory again.',
      })}</div><button class="btn btn-outline-primary mt-3" type="button" data-stock-retry>Retry</button>`
      renderIcons(view.content)
    } finally {
      if (isActive(view) && read === view.read) view.content.setAttribute('aria-busy', 'false')
    }
  }

  function selectSuggestedItem(view, itemId) {
    // Each item-specific shortcut retains that item's draft and always reopens its own record.
    const { workflow } = view.draft
    Object.assign(view, draftFor(workflow, itemId), { requestedItemId: itemId })
    window.history.replaceState(window.history.state, '', routeHref('stock', { workflow, item: itemId }))
    render(view, { preserveFocus: '#stock-item' })
  }

  function updateField(view, control) {
    const { draft, model, content } = view
    if (!draft || !model || draft.busy) return
    const { value, name: field, dataset: { stockBatchId: batchId } } = control
    if (batchId) {
      if (value === '') draft.allocations.delete(batchId)
      else draft.allocations.set(batchId, value)
      if (errorWasCorrected(view, 'allocations', batchId)) clearStockError(view)
    } else {
      if (!Object.hasOwn(draft, field)) return
      const isDate = control.type === 'date'
      if (draft[field] === value && !isDate) return
      if (field === 'itemId' && view.requestedItemId && model.itemById.get(value)?.isActive) {
        selectSuggestedItem(view, value)
        return
      }
      draft[field] = value
      if ((!isDate || !control.validity.badInput) && errorWasCorrected(view, field)) clearStockError(view)
      if (field === 'query') {
        const options = stockItemOptions(model, value, draft.itemId)
        content.querySelector('#stock-item').innerHTML = options.markup
        content.querySelector('#stock-item-options-status').textContent = options.message
        return
      }
      if (field === 'itemId' || field === 'direction') {
        draft.allocations.clear()
        if (field === 'itemId') draft.quantity = ''
        if (draft.error?.field === 'allocations' || (field === 'itemId' && draft.error?.field === 'quantity')) {
          clearStockError(view)
        }
        render(view, { preserveFocus: field === 'itemId' ? '#stock-item' : '#stock-direction' })
        return
      }
    }
    refreshStockTotals(view)
  }

  async function prepare(view) {
    const { draft, model, content } = view
    if (!draft || !model || draft.busy || draft.preview) return
    const form = content.querySelector('[data-stock-form]')
    const values = Object.fromEntries(new FormData(form))
    if (view.requestedItemId && values.itemId !== draft.itemId && model.itemById.get(values.itemId)?.isActive) {
      selectSuggestedItem(view, values.itemId)
      return
    }
    const selectionChanged = values.itemId !== draft.itemId || (values.direction && values.direction !== draft.direction)
    Object.assign(draft, values)
    // Re-read controls at review so browser autofill does not leave old values in the signed preview.
    draft.allocations.clear()
    if (!selectionChanged) {
      for (const input of form.querySelectorAll('[data-stock-batch-id]')) {
        if (input.value !== '') draft.allocations.set(input.dataset.stockBatchId, input.value)
      }
    }
    // An incomplete native date can have an empty value without being an optional blank.
    const incompleteDate = incompleteDateControl(form)
    if (incompleteDate) {
      showIncompleteDateError(view, incompleteDate)
      return
    }
    draft.busy = true
    content.querySelector('fieldset').disabled = true
    try {
      draft.preview = await repository.previewStockMovement(movementCommand(draft, model))
      draft.error = null
    } catch (error) {
      draft.error = validationError(error, draft)
    } finally {
      draft.busy = false
      const current = viewFor(draft)
      if (current) render(current, { focus: draft.error ? 'error' : 'heading' })
    }
  }

  function discardPreview(draft) {
    if (!draft.preview) return
    repository.discardStockPreview?.(draft.preview.attemptId)
    draft.preview = null
  }

  async function record(view) {
    const { draft } = view
    if (!draft?.preview || draft.busy) return
    draft.busy = true
    view.content.querySelectorAll('button').forEach((button) => { button.disabled = true })
    try {
      draft.result = await repository.recordStockMovement(draft.preview.attemptId)
      draft.error = null
    } catch (error) {
      draft.error = validationError(error, draft)
    } finally {
      discardPreview(draft)
      draft.busy = false
      const current = viewFor(draft)
      if (current && draft.error) await load(current, { focus: 'error' })
      else if (current) render(current, { focus: 'heading' })
    }
  }

  function mount(main, { workflow, itemId } = {}) {
    const validWorkflow = Object.hasOwn(stockWorkflows, workflow)
    main.innerHTML = renderStockWorkspace()
    const root = main.firstElementChild
    const view = {
      root, ...(validWorkflow ? draftFor(workflow, itemId || '') : {}), requestedItemId: itemId, model: null, read: 0,
      content: root.querySelector('[data-stock-content]'),
      context: root.querySelector('[data-stock-context]'),
    }
    currentView = view
    root.addEventListener('input', ({ target }) => {
      if (target.closest('[data-stock-form]') && !target.matches('select')) updateField(view, target)
    })
    root.addEventListener('change', ({ target }) => {
      if (target.closest('[data-stock-form]') && target.matches('select')) updateField(view, target)
    })
    root.addEventListener('submit', (event) => {
      if (!event.target.matches('[data-stock-form]')) return
      event.preventDefault()
      void prepare(view)
    })
    root.addEventListener('click', (event) => {
      const button = event.target.closest('button')
      if (!button || button.disabled) return
      const { draft } = view
      if (button.matches('[data-stock-retry]')) void load(view)
      if (button.matches('[data-stock-confirm]')) void record(view)
      if (button.matches('[data-stock-back]')) {
        discardPreview(draft)
        render(view, { focus: 'heading' })
      }
      if (button.matches('[data-stock-cancel]')) {
        discardPreview(draft)
        drafts.delete(view.key)
        window.location.hash = routeHref('stock')
      }
      if (button.matches('[data-stock-new]')) {
        const next = createDraft(draft.workflow, draft.result.movement.item_id)
        drafts.set(view.key, next)
        view.draft = next
        void load(view, { focus: 'heading' })
      }
    })
    renderIcons(root)
    void load(view)
  }

  return { mount }
}
