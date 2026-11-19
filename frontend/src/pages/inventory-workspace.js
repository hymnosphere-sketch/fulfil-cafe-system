import { renderPageHeader } from '../components/page-header.js'
import { renderMessage } from '../components/status.js'
import { routeHref } from '../router.js'
import { buildInventoryReadModel, filterAndSortInventory } from '../services/inventory-read-model.js'
import { normalizeDemoName } from '../utils/demo-catalog.js'
import { clearCorrectedFieldError, renderArchiveScreen, renderRecordForm } from './inventory-forms.js'
import {
  escapeInventoryText,
  renderCategoryList,
  renderCategoryResults,
  renderDemoContext,
  renderInventoryAction,
  renderInventoryList,
  renderInventoryResults,
  renderItemDetails,
} from './inventory-rendering.js'

const pages = {
  inventory: { title: 'Inventory', description: 'Find ingredients and supplies, review stock, and manage item records.' },
  categories: { title: 'Categories', description: 'Organize inventory items and keep historical category references.' },
}
const initialFilters = {
  inventory: { view: 'active', query: '', categoryId: '', stockStatus: '', sort: 'name-asc' },
  categories: { view: 'active', query: '' },
}
const numberFormat = new Intl.NumberFormat('en-PH')

function newModuleState(module) {
  return { filters: { ...initialFilters[module] }, detail: null, draft: null, archive: null, feedback: '' }
}

function createDraft(module, record) {
  const values = module === 'inventory'
    ? { name: record?.name ?? '', category_id: record?.categoryId ?? '', unit_of_measurement: record?.unit ?? '',
        minimum_stock_level: String(record?.minimumStockLevel ?? '') }
    : { name: record?.name ?? '', description: record?.description ?? '' }

  return {
    id: record?.itemId ?? record?.categoryId,
    values,
    initialValues: { ...values },
    error: null,
    duplicateIds: [],
    busy: false,
  }
}

function isDirty(draft) {
  return draft && Object.keys(draft.values).some((field) => draft.values[field] !== draft.initialValues[field])
}

function renderLoading() {
  return `<div role="status">${renderMessage({ tone: 'info', icon: 'info', title: 'Loading demo records', message: 'Reading local inventory.' })}</div>`
}

function renderReadError() {
  return `<div class="inventory-stack">
    <div role="alert">
      ${renderMessage({ tone: 'error', icon: 'circle-alert', title: 'Could not load demo records', message: 'Try reading the saved local inventory again.' })}
    </div>
    <div>${renderInventoryAction('retry', 'Retry')}</div>
  </div>`
}

export function createInventoryWorkspace({ repository, renderIcons, storageMode }) {
  const states = { inventory: newModuleState('inventory'), categories: newModuleState('categories') }
  let activeMount
  let beforeUnloadRegistered = false

  function warnBeforeRefresh(event) {
    event.preventDefault()
    event.returnValue = ''
  }

  function updateRefreshWarning() {
    const hasDraftEdits = Object.values(states).some(({ draft }) => isDirty(draft))
    if (hasDraftEdits && !beforeUnloadRegistered) {
      window.addEventListener('beforeunload', warnBeforeRefresh)
    } else if (!hasDraftEdits && beforeUnloadRegistered) {
      window.removeEventListener('beforeunload', warnBeforeRefresh)
    }
    beforeUnloadRegistered = hasDraftEdits
  }

  function refreshActiveWorkspace(source) {
    if (activeMount?.root.isConnected) {
      return activeMount.load({ showLoading: false, focusHeading: activeMount.root === source })
    }
  }

  function mount(main, module, { itemId } = {}) {
    main.innerHTML = `<div class="inventory-workspace">
      ${renderPageHeader(pages[module])}
      <div class="inventory-stack">
        <div data-inventory-context>${renderDemoContext(null, module, storageMode)}</div>
        <div data-inventory-feedback role="status"></div>
        <div data-inventory-content aria-busy="true">${renderLoading()}</div>
      </div>
    </div>`

    const root = main.firstElementChild
    const context = root.querySelector('[data-inventory-context]')
    const feedback = root.querySelector('[data-inventory-feedback]')
    const content = root.querySelector('[data-inventory-content]')
    const state = states[module]
    const isInventory = module === 'inventory'
    const isolated = storageMode === 'isolated'
    const saveLocation = isolated ? 'in this temporary session.' : 'in this browser.'
    let model
    let loadSequence = 0
    let openLinkedItem = isInventory && Boolean(itemId)
    let linkedItemUnavailable = false

    function focusSection() {
      content.querySelector('[data-inventory-section-title]')?.focus()
    }

    function focusAction(action, id, { preventScroll = false } = {}) {
      const candidates = content.querySelectorAll(`[data-inventory-action="${action}"]`)
      const button = [...candidates].find((candidate) =>
        !candidate.disabled && (id === undefined || candidate.dataset.id === id) && candidate.getClientRects().length > 0)
      button?.focus({ preventScroll })
      return Boolean(button)
    }

    function renderResults() {
      const results = content.querySelector('[data-inventory-results]')
      if (!results) return
      const { filters } = state
      let count
      if (isInventory) {
        const items = filterAndSortInventory(model.items, filters)
        count = items.length
        results.innerHTML = renderInventoryResults(model, filters, items)
        content.querySelector('[data-quantity-sort-note]').hidden = !filters.sort.startsWith('quantity-')
      } else {
        const term = normalizeDemoName(filters.query)
        const categories = model.categories.filter(({ isActive, name }) =>
          isActive === (filters.view === 'active') && normalizeDemoName(name).includes(term))
        count = categories.length
        results.innerHTML = renderCategoryResults(model, filters, categories)
      }
      const noun = isInventory ? (count === 1 ? 'item' : 'items') : (count === 1 ? 'category' : 'categories')
      content.querySelector('[data-inventory-count]').textContent = `${numberFormat.format(count)} ${noun} found`
      renderIcons(results)
    }

    function renderFeedback() {
      feedback.innerHTML = state.feedback
        ? renderMessage({ tone: 'success', icon: 'info', title: isolated ? 'Temporary demo inventory updated' : 'Local demo inventory updated', message: state.feedback })
        : ''
      renderIcons(feedback)
    }

    function renderScreen() {
      if (!root.isConnected || !model) return
      renderFeedback()
      const recordById = isInventory ? model.itemById : model.categoryById
      const archiveRecord = recordById.get(state.archive?.id)
      const detailRecord = model.itemById.get(state.detail?.id)
      if (archiveRecord) {
        content.innerHTML = renderArchiveScreen({ module, record: archiveRecord, archive: state.archive })
      } else if (detailRecord && (state.detail.fromDuplicate || !state.draft)) {
        content.innerHTML = renderItemDetails(detailRecord, model, state.detail.fromDuplicate)
      } else if (state.draft) {
        content.innerHTML = renderRecordForm({ module, draft: state.draft, model })
      } else {
        content.innerHTML = isInventory ? renderInventoryList(model, state.filters) : renderCategoryList(state.filters)
      }
      renderIcons(content)
      renderResults()
    }

    function focusIssue() {
      content.querySelector('[aria-invalid="true"], [data-form-error], #duplicate-item-title, [data-archive-error]')?.focus()
    }

    async function load({ showLoading = true, focusHeading = false, afterRead, focusError = false } = {}) {
      const attempt = ++loadSequence
      content.setAttribute('aria-busy', 'true')
      if (showLoading) content.innerHTML = renderLoading()
      else if (state.feedback) renderFeedback()
      renderIcons(root)
      try {
        const snapshot = await repository.read()
        if (!root.isConnected || loadSequence !== attempt) return
        model = buildInventoryReadModel(snapshot)
        if (openLinkedItem) {
          openLinkedItem = false
          state.archive = null
          if (model.itemById.has(itemId)) {
            const fromDraft = Boolean(state.draft)
            const sameDetail = state.detail?.id === itemId
            if (!sameDetail || (fromDraft && !state.detail.fromDuplicate)) {
              const returnTo = sameDetail ? state.detail : null
              state.detail = { id: itemId, fromDuplicate: fromDraft, scrollY: 0, returnTo }
            }
          } else {
            state.detail = null
            linkedItemUnavailable = true
          }
        }
        context.innerHTML = renderDemoContext(model, module, storageMode)
        if (linkedItemUnavailable) {
          context.insertAdjacentHTML('beforeend', renderMessage({
            tone: 'info', icon: 'info', title: 'Item unavailable',
            message: 'The linked item is unavailable in the local demo inventory.',
          }))
        }
        afterRead?.()
        renderIcons(context)
        renderScreen()
        if (focusHeading) focusSection()
        if (focusError) focusIssue()
      } catch {
        if (!root.isConnected || loadSequence !== attempt) return
        model = undefined
        content.innerHTML = renderReadError()
        renderIcons(content)
        if (focusHeading) focusAction('retry')
      } finally {
        if (root.isConnected && loadSequence === attempt) content.setAttribute('aria-busy', 'false')
      }
    }

    function openScreen() {
      state.feedback = ''
      renderScreen()
      focusSection()
    }

    function openForm(id) {
      const record = (isInventory ? model.itemById : model.categoryById).get(id)
      state.draft = createDraft(module, record)
      openScreen()
    }

    function closeForm() {
      const draft = state.draft
      if (isDirty(draft) && !window.confirm('Discard unsaved changes to this demo draft?')) return
      state.draft = null
      updateRefreshWarning()
      renderScreen()
      const action = `${draft.id ? 'edit' : 'add'}-${isInventory ? 'item' : 'category'}`
      if (!focusAction(action, draft.id)) focusSection()
    }

    function updateDraftValue(control, value) {
      const draft = state.draft
      const field = control.name
      if (!draft || !Object.hasOwn(draft.values, field) || draft.values[field] === value) return
      draft.values[field] = value
      clearCorrectedFieldError(draft, control, model, module)
      if (draft.duplicateIds.length) {
        draft.duplicateIds = []
        content.querySelector('[data-duplicate-warning]')?.remove()
        content.querySelector('[type="submit"]').hidden = false
      }
      updateRefreshWarning()
    }

    async function saveForm(allowDuplicate = false) {
      const draft = state.draft
      if (!draft || draft.busy) return
      const form = content.querySelector('[data-inventory-form]')
      for (const [field, value] of new FormData(form)) updateDraftValue(form.elements.namedItem(field), value)
      const fieldset = form.querySelector('fieldset')
      const submit = fieldset.querySelector('[type="submit"]')
      if (allowDuplicate !== Boolean(draft.duplicateIds.length)) {
        if (allowDuplicate) submit.focus()
        return
      }
      draft.busy = true
      fieldset.disabled = true
      submit.textContent = 'Saving…'

      try {
        if (isInventory) {
          if (draft.id) await repository.updateItem(draft.id, draft.values, { allowDuplicate, expected: draft.initialValues })
          else await repository.createItem(draft.values, { allowDuplicate })
        } else if (draft.id) {
          await repository.updateCategory(draft.id, draft.values, { expected: draft.initialValues })
        } else {
          await repository.createCategory(draft.values)
        }
      } catch (error) {
        draft.busy = false
        draft.duplicateIds = error?.code === 'POTENTIAL_DUPLICATE_ITEM'
          ? error.matches.map(({ item_id }) => item_id)
          : []
        draft.error = draft.duplicateIds.length ? null : {
          field: error?.field, message: error?.message || 'The local record could not be saved. Review your draft and try again.',
        }
        if (error?.code === 'RECORD_CHANGED') {
          await load({ showLoading: false, focusError: true, afterRead: () => {
            const latest = (isInventory ? model.itemById : model.categoryById).get(draft.id)
            if (!latest?.isActive) return
            const { initialValues } = createDraft(module, latest)
            for (const field of Object.keys(draft.values)) {
              if (draft.values[field] === draft.initialValues[field] || (field === 'unit_of_measurement' && latest.hasHistory)) {
                draft.values[field] = initialValues[field]
              }
            }
            draft.initialValues = initialValues
            draft.error = { message: 'This record changed in another tab. Unedited fields now show the latest values. Review your draft before saving again.' }
          } })
          updateRefreshWarning()
        } else if (draft.duplicateIds.some((id) => !model?.itemById.has(id))) {
          await load({ showLoading: false, focusError: true })
        } else {
          renderScreen()
          if (root.isConnected) focusIssue()
        }
        return
      }

      state.draft = null
      updateRefreshWarning()
      if (!draft.id) state.filters.view = 'active'
      state.feedback = `Demo ${isInventory ? 'item' : 'category'} saved ${saveLocation}`
      await refreshActiveWorkspace(root)
    }

    function closeDetail() {
      const detail = state.detail
      state.detail = detail.returnTo
      if (detail.id === itemId) history.replaceState(history.state, '', routeHref('inventory'))
      renderScreen()
      const targetAction = detail.fromDuplicate ? 'inspect-match' : 'view-item'
      if (!focusAction(targetAction, detail.id, { preventScroll: true })) focusSection()
      window.scrollTo(0, detail.scrollY)
    }

    function closeArchive() {
      const { id } = state.archive
      state.archive = null
      renderScreen()
      if (!focusAction(isInventory ? 'archive-item' : 'archive-category', id)) focusSection()
    }

    async function confirmArchive() {
      const archive = state.archive
      if (!archive || archive.busy) return
      archive.busy = true
      content.querySelector('fieldset').disabled = true
      try {
        if (isInventory) await repository.archiveItem(archive.id, { expected: archive.expected })
        else await repository.archiveCategory(archive.id, { expected: archive.expected })
      } catch (error) {
        archive.busy = false
        archive.error = error?.message || 'The local record could not be archived. Try again.'
        if (error?.code === 'RECORD_CHANGED') {
          await load({ showLoading: false, focusError: true, afterRead: () => {
            const record = (isInventory ? model.itemById : model.categoryById).get(archive.id)
            if (record) archive.expected = createDraft(module, record).initialValues
          } })
        } else {
          renderScreen()
          if (root.isConnected) focusIssue()
        }
        return
      }

      state.archive = null
      state.feedback = `Demo ${isInventory ? 'item' : 'category'} archived ${saveLocation}`
      await refreshActiveWorkspace(root)
    }

    root.addEventListener('click', (event) => {
      const button = event.target.closest('[data-inventory-action]')
      if (!button || button.disabled) return
      const { inventoryAction: action, id } = button.dataset
      if (action === 'retry') {
        root.querySelector('#page-title').focus()
        void load()
        return
      }
      if (!model) return

      switch (action) {
        case 'add-item':
        case 'add-category':
        case 'edit-item':
        case 'edit-category':
          openForm(id)
          break
        case 'cancel-form':
          closeForm()
          break
        case 'record-view':
          state.filters.view = id
          renderScreen()
          focusAction('record-view', id)
          break
        case 'clear-filters':
          state.filters = { ...initialFilters[module], view: state.filters.view }
          renderScreen()
          focusAction('clear-filters')
          break
        case 'view-item':
        case 'inspect-match':
          state.detail = { id, fromDuplicate: action === 'inspect-match', scrollY: window.scrollY, returnTo: state.detail }
          openScreen()
          break
        case 'back-item':
          closeDetail()
          break
        case 'revise-name':
          content.querySelector('[name="name"]').focus()
          break
        case 'confirm-duplicate':
          void saveForm(true)
          break
        case 'archive-item':
        case 'archive-category': {
          const record = (isInventory ? model.itemById : model.categoryById).get(id)
          state.archive = { id, expected: createDraft(module, record).initialValues, busy: false, error: null }
          openScreen()
          break
        }
        case 'cancel-archive':
          closeArchive()
          break
        case 'confirm-archive':
          void confirmArchive()
          break
      }
    })

    function updateInput({ target }) {
      const { filter } = target.dataset
      if (filter && state.filters[filter] !== target.value) {
        state.filters[filter] = target.value
        renderResults()
      } else if (target.name && target.closest('[data-inventory-form]')) {
        updateDraftValue(target, target.value)
      }
    }

    root.addEventListener('input', updateInput)
    root.addEventListener('change', updateInput)
    root.addEventListener('submit', (event) => {
      if (!event.target.matches('[data-inventory-form]')) return
      event.preventDefault()
      void saveForm()
    })

    activeMount = { root, content, state, load }
    void load()
  }

  function refresh() {
    const view = activeMount
    if (!view?.root.isConnected || view.state.draft?.busy || view.state.archive?.busy) return
    const focused = document.activeElement
    if (view.content.contains(focused) && focused.matches('input, textarea, select')) return
    return view.load({ showLoading: false })
  }

  return { mount, refresh }
}
