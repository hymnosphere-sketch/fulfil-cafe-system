import { routeHref } from '../router.js'
import { buildInventoryReports } from '../services/inventory-reports.js'
import { renderDemoContext } from './inventory-rendering.js'
import {
  normalizeReportFilters, reportSelectOptions,
  renderReportLoading, renderReportPanel, renderReportReadError, renderReportResults, renderReportsPage,
  reportDefaults, reportTitles,
} from './report-rendering.js'

function readReportFilters(form) {
  const filters = Object.fromEntries(new FormData(form))
  for (const field of form.querySelectorAll('input[type="date"]')) {
    if (field.validity.badInput) filters[field.name] = 'invalid date'
  }
  return filters
}

function reportURL(view, filters) {
  const parameters = new URLSearchParams({ view })
  for (const [key, value] of Object.entries(filters)) {
    if (value !== reportDefaults[view][key]) parameters.set(key, value)
  }
  return routeHref('reports', parameters)
}

function showDateErrors(form, errors) {
  for (const input of form.querySelectorAll('input[type="date"]')) {
    const error = errors[input.name]
    const hint = form.querySelector('#' + input.id + '-error')
    hint.textContent = error ?? ''
    hint.hidden = !error
    input.classList.toggle('is-invalid', Boolean(error))
    if (error) input.setAttribute('aria-invalid', 'true')
    else input.removeAttribute('aria-invalid')
    input.setAttribute('aria-describedby', error ? 'report-date-help ' + hint.id : 'report-date-help')
  }
}

function mountReportPanel(content, view, data, parameters, renderIcons) {
  const saved = Object.fromEntries(Object.entries(reportDefaults[view]).map(([key, value]) => [
    key, parameters.get(key) ?? value,
  ]))
  const options = reportSelectOptions(view, data.inventory)
  const initial = normalizeReportFilters(view, saved, options)
  content.innerHTML = renderReportPanel(view, data, initial.filters, options)
  const form = content.querySelector('[data-report-filters]')
  const notice = form.querySelector('[data-report-filter-notice]')
  const count = content.querySelector('[data-report-count]')
  const results = content.querySelector('[data-report-results]')
  const summary = results.querySelector('[data-report-summary]')
  const rows = results.querySelector('[data-report-rows]')
  const itemSelect = form.elements.namedItem('itemId')
  const selectedItemDetails = form.querySelector('#report-item-selection')

  function showSelectedItem() {
    if (!itemSelect) return
    const itemId = itemSelect.value
    selectedItemDetails.hidden = !itemId
    selectedItemDetails.textContent = itemId
      ? 'Selected item ' + itemSelect.selectedOptions[0].textContent.trim() + ' · Full ID ' + itemId
      : ''
    if (itemId) itemSelect.setAttribute('aria-describedby', selectedItemDetails.id)
    else itemSelect.removeAttribute('aria-describedby')
  }

  function displayResults({ filters, cleared }, applied = false) {
    if (applied && cleared) {
      for (const name of Object.keys(options)) form.elements.namedItem(name).value = filters[name]
    }
    const report = renderReportResults(view, data, filters)
    const errors = report.errors ?? {}
    const firstError = Object.keys(errors)[0]
    showDateErrors(form, errors)
    summary.innerHTML = report.summary ?? ''
    summary.hidden = !report.summary
    rows.innerHTML = report.html
    count.textContent = report.count
    notice.hidden = !cleared
    notice.textContent = cleared ? 'Unavailable saved filters were cleared.' : ''
    showSelectedItem()
    renderIcons(results)

    if (applied && firstError) form.elements.namedItem(firstError).focus()
    else if (applied || cleared) {
      const url = reportURL(view, filters)
      if (window.location.hash !== url) window.history.replaceState(window.history.state, '', url)
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    displayResults(normalizeReportFilters(view, readReportFilters(form), options), true)
  })
  itemSelect?.addEventListener('change', showSelectedItem)
  form.querySelector('[data-report-clear]').addEventListener('click', () => {
    for (const [key, value] of Object.entries(reportDefaults[view])) form.elements.namedItem(key).value = value
    displayResults({ filters: reportDefaults[view], cleared: false }, true)
  })
  displayResults(initial)
}

export function createReportsWorkspace({ repository, renderIcons, storageMode }) {
  let refreshMounted

  function mount(main, parameters = new URLSearchParams()) {
    const requested = parameters.get('view')
    const view = Object.hasOwn(reportTitles, requested) ? requested : 'inventory'
    main.innerHTML = renderReportsPage(view, storageMode)
    const root = main.firstElementChild
    const content = root.querySelector('[data-report-content]')
    let readSequence = 0
    renderIcons(root)

    async function load({ refresh = false } = {}) {
      const attempt = ++readSequence
      const hash = window.location.hash
      const filters = refresh ? new URLSearchParams(hash.split('?', 2)[1]) : parameters
      const isCurrent = () => root.isConnected && readSequence === attempt && window.location.hash === hash
      content.setAttribute('aria-busy', 'true')
      if (!refresh) content.innerHTML = renderReportLoading()
      try {
        const snapshot = await repository.read()
        if (!isCurrent()) return
        const data = buildInventoryReports(snapshot)
        const context = root.querySelector('[data-report-context]')
        context.innerHTML = renderDemoContext(data.inventory, 'inventory', storageMode)
        renderIcons(context)
        mountReportPanel(content, view, data, filters, renderIcons)
      } catch {
        if (!isCurrent()) return
        content.innerHTML = renderReportReadError()
        renderIcons(content)
        content.querySelector('[data-report-retry]').addEventListener('click', () => {
          root.querySelector('#page-title').focus()
          void load({ refresh })
        })
      } finally {
        if (root.isConnected && readSequence === attempt) content.setAttribute('aria-busy', 'false')
      }
    }

    refreshMounted = () => {
      const focused = document.activeElement
      if (!root.isConnected || (content.contains(focused) && focused.closest('[data-report-filters]'))) return
      return load({ refresh: true })
    }
    void load()
  }

  return { mount, refresh: () => refreshMounted?.() }
}
