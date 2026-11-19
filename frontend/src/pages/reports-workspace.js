import { routeHref } from '../router.js'
import { buildInventoryReports } from '../services/inventory-reports.js'
import { renderDemoContext } from './inventory-rendering.js'
import {
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
  const filters = Object.fromEntries(Object.entries(reportDefaults[view]).map(([key, value]) => [
    key, parameters.get(key) ?? value,
  ]))
  content.innerHTML = renderReportPanel(view, data, filters)
  const form = content.querySelector('[data-report-filters]')
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

  function displayResults(selected, applied = false) {
    const report = renderReportResults(view, data, selected)
    const errors = report.errors ?? {}
    const firstError = Object.keys(errors)[0]
    showDateErrors(form, errors)
    summary.innerHTML = report.summary ?? ''
    summary.hidden = !report.summary
    rows.innerHTML = report.html
    count.textContent = report.count
    showSelectedItem()
    renderIcons(results)

    if (applied && firstError) form.elements.namedItem(firstError).focus()
    if (applied && !firstError) window.history.replaceState(window.history.state, '', reportURL(view, selected))
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    displayResults(readReportFilters(form), true)
  })
  itemSelect?.addEventListener('change', showSelectedItem)
  form.querySelector('[data-report-clear]').addEventListener('click', () => {
    for (const [key, value] of Object.entries(reportDefaults[view])) form.elements.namedItem(key).value = value
    displayResults(reportDefaults[view], true)
  })
  displayResults(filters)
}

export function createReportsWorkspace({ repository, renderIcons }) {
  function mount(main, parameters = new URLSearchParams()) {
    const requested = parameters.get('view')
    const view = Object.hasOwn(reportTitles, requested) ? requested : 'inventory'
    main.innerHTML = renderReportsPage(view)
    const root = main.firstElementChild
    const content = root.querySelector('[data-report-content]')
    renderIcons(root)

    async function load() {
      content.setAttribute('aria-busy', 'true')
      content.innerHTML = renderReportLoading()
      try {
        const snapshot = await repository.read()
        if (!root.isConnected) return
        const data = buildInventoryReports(snapshot)
        const context = root.querySelector('[data-report-context]')
        context.innerHTML = renderDemoContext(data.inventory, 'inventory')
        renderIcons(context)
        mountReportPanel(content, view, data, parameters, renderIcons)
      } catch {
        if (!root.isConnected) return
        content.innerHTML = renderReportReadError()
        renderIcons(content)
        content.querySelector('[data-report-retry]').addEventListener('click', () => {
          root.querySelector('#page-title').focus()
          void load()
        })
      } finally {
        if (root.isConnected) content.setAttribute('aria-busy', 'false')
      }
    }

    void load()
  }

  return { mount }
}
