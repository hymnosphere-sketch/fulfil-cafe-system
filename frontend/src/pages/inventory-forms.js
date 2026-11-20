import { renderMessage } from '../components/status.js'
import { demoUnits } from '../data/demo-inventory-repository.js'
import { shortRecordReferences } from '../utils/catalog-display.js'
import { cleanDemoName, findDemoNameMatches, parseDemoMinimumStockLevel } from '../utils/demo-catalog.js'
import { escapeInventoryText, renderInventoryAction, renderInventoryQuantity, renderOption, renderReceiveStockLink } from './inventory-rendering.js'

export const CREATE_CATEGORY_OPTION = 'create-category'

const matchLabels = {
  normalized: 'Same normalized name',
  compact: 'Same name ignoring spaces or selected separators',
  spelling: 'Similar spelling',
}

const categoryHelp = 'Demo rules require a distinct category name across active and archived categories. Production matching rules are pending.'

function isValidCorrection(draft, model, module) {
  const { field } = draft.error
  const value = draft.values[field]
  if (field === 'name') {
    return Boolean(cleanDemoName(value)) && (module === 'inventory' ||
      findDemoNameMatches(model.categories, value, { idField: 'categoryId', excludeId: draft.id }).length === 0)
  }
  if (field === 'minimum_stock_level') return parseDemoMinimumStockLevel(value) !== null
  if (field === 'category_id') return model.categoryById.get(value)?.isActive === true
  if (field === 'unit_of_measurement') {
    const item = model.itemById.get(draft.id)
    return demoUnits.includes(value) && (!item?.hasHistory || item.unit === value)
  }
  return field === 'description' && typeof value === 'string'
}

export function clearCorrectedFieldError(draft, control, model, module) {
  if (draft.error?.field !== control.name || !isValidCorrection(draft, model, module)) return

  draft.error = null
  control.classList.remove('is-invalid')
  control.removeAttribute('aria-invalid')
  const errorId = control.id + '-error'
  const descriptions = (control.getAttribute('aria-describedby') ?? '').split(' ')
    .filter((id) => id && id !== errorId)
  if (descriptions.length) control.setAttribute('aria-describedby', descriptions.join(' '))
  else control.removeAttribute('aria-describedby')
  control.parentElement.querySelector('[data-field-error]')?.remove()
}

function renderFormField({ name, label, value, error, help, options, required, disabled, multiline, numeric, prefix = 'demo-field' }) {
  const id = `${prefix}-${name}`
  const invalid = error?.field === name
  const descriptions = [help && `${id}-help`, invalid && `${id}-error`].filter(Boolean).join(' ')
  const attributes = `id="${id}" name="${name}"${required ? ' required' : ''}${disabled ? ' disabled' : ''}${invalid ? ' aria-invalid="true"' : ''}${descriptions ? ` aria-describedby="${descriptions}"` : ''}`
  const safeValue = escapeInventoryText(value ?? '')
  const invalidClass = invalid ? ' is-invalid' : ''

  let control
  if (options) {
    control = `<select class="form-select${invalidClass}" ${attributes}>${options.map(([optionValue, optionLabel]) => renderOption(optionValue, optionLabel, value)).join('')}</select>`
  } else if (multiline) {
    control = `<textarea class="form-control${invalidClass}" rows="3" ${attributes}>\n${safeValue}</textarea>`
  } else {
    control = `<input class="form-control${invalidClass}" type="text"${numeric ? ' inputmode="numeric"' : ''} value="${safeValue}" ${attributes}>`
  }

  return `<div>
    <label class="form-label" for="${id}">${label}${required ? ' <span aria-hidden="true">*</span>' : ''}</label>
    ${control}
    ${help ? `<p id="${id}-help" class="cafe-muted cafe-supporting mt-2 mb-0">${help}</p>` : ''}
    ${invalid ? `<p id="${id}-error" class="invalid-feedback mb-0" data-field-error${prefix === 'demo-inline-category' ? ' role="alert"' : ''}>${escapeInventoryText(error.message)}</p>` : ''}
  </div>`
}

export function inlineCategoryFeedback(draft, model) {
  if (!draft.createdCategoryId || draft.inlineCategory) return ''
  const category = model.categoryById.get(draft.createdCategoryId)
  if (category?.isActive && draft.values.category_id === category.categoryId) {
    return `Category saved and selected. ${category.name}`
  }
  if (!category?.isActive && (!draft.values.category_id || draft.values.category_id === draft.createdCategoryId)) {
    return 'The category you created is no longer available. Choose an active category.'
  }
  return ''
}

function renderItemFields({ values, error, inlineCategory }, model, item) {
  const availableCategories = model.categories.filter(({ isActive }) => isActive)
  const categoryOptions = [['', 'Choose an active category'], ...availableCategories.map(({ categoryId, name }) => [categoryId, name]),
    [CREATE_CATEGORY_OPTION, '+ Create new category']]
  const selectedName = model.categoryById.get(values.category_id)?.name
  const unitOptions = [['', 'Choose a unit'], ...demoUnits.map((unit) => [unit, unit])]
  return `
    ${renderFormField({ name: 'name', label: 'Item name', value: values.name, error, required: true })}
    ${renderFormField({ name: 'category_id', label: 'Category', value: inlineCategory ? CREATE_CATEGORY_OPTION : values.category_id,
      error, required: true, disabled: Boolean(inlineCategory), options: categoryOptions,
      help: !availableCategories.length ? 'Create a category before saving this item.' :
        !inlineCategory && selectedName?.length > 32 ? escapeInventoryText(selectedName) : '' })}
    ${renderFormField({ name: 'unit_of_measurement', label: 'Unit of measurement', value: values.unit_of_measurement, error, required: true, options: unitOptions,
      disabled: item?.hasHistory, help: item?.hasHistory ? 'The unit is locked because it applies to existing batch or movement history.' : 'These fictional unit profiles use whole quantities.' })}
    ${renderFormField({ name: 'minimum_stock_level', label: 'Minimum stock level', value: values.minimum_stock_level, error, required: true, numeric: true,
      help: 'Enter a whole number of 0 or more in the selected unit.' })}
  `
}

function renderCategoryFields({ values, error }, prefix) {
  return renderFormField({ name: 'name', label: 'Category name', value: values.name, error, required: true, help: categoryHelp, prefix }) +
    renderFormField({ name: 'description', label: 'Description (optional)', value: values.description, error, multiline: true, prefix })
}

function renderInlineCategory(category) {
  return `<form class="inventory-inline-category" data-inline-category-form aria-labelledby="inline-category-title" novalidate>
    <fieldset class="inventory-stack"${category.busy ? ' disabled' : ''}>
      <h3 id="inline-category-title" class="mb-0">Create new category</h3>
      <p class="cafe-muted cafe-supporting mb-0">The category stays saved even if you cancel the item.</p>
      ${category.error && !category.error.field ? `<p class="text-danger mb-0" role="alert" tabindex="-1" data-inline-category-error>${escapeInventoryText(category.error.message)}</p>` : ''}
      ${renderCategoryFields(category, 'demo-inline-category')}
      <div class="inventory-actions">
        <button class="btn btn-primary" type="submit">${category.busy ? 'Creating…' : 'Create category'}</button>
        <button class="btn btn-outline-primary" type="button" data-inventory-action="cancel-inline-category" aria-label="Cancel category creation">Cancel</button>
      </div>
    </fieldset>
  </form>`
}

function renderDuplicateWarning(draft) {
  if (!draft.duplicateReview) return ''
  const { matches, updated } = draft.duplicateReview
  const references = shortRecordReferences(matches.map(({ itemId }) => itemId))

  return `<section class="inventory-duplicate cafe-tone--warning" aria-labelledby="duplicate-item-title" data-duplicate-warning>
    <h3 id="duplicate-item-title" tabindex="-1">Possible duplicate items</h3>
    ${updated ? '<p role="status">The matching records changed. Review the updated list before confirming again.</p>' : ''}
    <p>These records have matching or similar names under demo rules. Review their category, unit, and stock before continuing. To record a delivery, choose Receive stock on the existing item.</p>
    <ul class="inventory-records list-unstyled">${matches.map((item) => `<li class="inventory-record inventory-category-record" data-match-reason="${escapeInventoryText(item.reason)}">
      <div>
        <strong>${escapeInventoryText(item.name)}</strong>
        <p class="cafe-supporting mb-0">${matchLabels[item.reason]} · Item ${escapeInventoryText(references.get(item.itemId))}</p>
        <p class="cafe-supporting mb-0">${item.isActive ? 'Active' : 'Archived'} · ${escapeInventoryText(item.categoryName)} · ${renderInventoryQuantity(item.availableQuantity, item.unit)} available</p>
      </div>
      <div class="inventory-actions">
        ${renderInventoryAction('inspect-match', 'View existing item', item.itemId, { subject: item.name })}
        ${item.isActive ? renderReceiveStockLink(item, { identifyItem: true }) : ''}
      </div>
    </li>`).join('')}</ul>
    <div class="inventory-actions">
      ${renderInventoryAction('confirm-duplicate', draft.id ? 'Save item with this name' : 'Save as separate demo item', undefined, { primary: true })}
      ${renderInventoryAction('revise-name', 'Revise name')}
    </div>
  </section>`
}

export function renderRecordForm({ module, draft, model }) {
  const isItem = module === 'inventory'
  const noun = isItem ? 'item' : 'category'
  const title = `${draft.id ? 'Edit' : 'Add'} ${noun}`
  const item = draft.id && isItem ? model.itemById.get(draft.id) : null
  const itemHelp = item
    ? `Available quantity is read-only: <strong>${renderInventoryQuantity(item.availableQuantity, item.unit)}</strong>. Stock changes require a separate transaction.`
    : 'A new item starts with zero stock. After saving the item, use Receive stock to record a delivery.'
  const fields = isItem ? renderItemFields(draft, model, item) : renderCategoryFields(draft)
  const categoryFeedback = isItem ? inlineCategoryFeedback(draft, model) : ''

  return `<section class="card cafe-card inventory-form-panel" aria-labelledby="record-form-title">
    <div class="card-body inventory-stack">
      <h2 id="record-form-title" data-inventory-section-title tabindex="-1" class="mb-0">${title}</h2>
      ${isItem ? `<p class="cafe-muted mb-0">${itemHelp}</p>` : ''}
      <p class="cafe-muted cafe-supporting mb-0">Fields marked * are required. Submit the form to save this draft. You can switch modules and return to it while this tab stays open.</p>
      ${draft.error?.field == null && draft.error ? `<div role="alert" tabindex="-1" data-form-error>${renderMessage({ tone: 'error', icon: 'circle-alert', title: 'Could not save the demo record', message: escapeInventoryText(draft.error.message) })}</div>` : ''}
      <form data-inventory-form novalidate>
        <fieldset class="inventory-stack" ${draft.busy ? 'disabled' : ''}>
          ${isItem ? `<div class="inventory-item-fields">${fields}</div>` : fields}
          ${isItem ? `<p class="cafe-supporting mb-0" role="status" data-inline-category-status${categoryFeedback ? ' data-inline-category-feedback' : ' hidden'}>${escapeInventoryText(categoryFeedback)}</p>` : ''}
          ${draft.inlineCategory ? '' : `<div class="inventory-actions">
            <button class="btn btn-primary" type="submit"${draft.duplicateReview ? ' hidden' : ''}>${draft.busy ? 'Saving…' : `Save ${noun}`}</button>
            ${renderInventoryAction('cancel-form', 'Cancel')}
          </div>
          ${isItem ? renderDuplicateWarning(draft) : ''}`}
        </fieldset>
      </form>
      ${draft.inlineCategory ? renderInlineCategory(draft.inlineCategory) : ''}
    </div>
  </section>`
}

export function renderArchiveScreen({ module, record, archive }) {
  const isItem = module === 'inventory'
  const noun = isItem ? 'item' : 'category'
  const safeguard = isItem
    ? 'The demo allows archival only when the available quantity is zero.'
    : 'The demo allows archival only when the category has no active inventory items.'
  const reason = isItem
    ? record.availableQuantity !== 0 && `${renderInventoryQuantity(record.availableQuantity, record.unit)} remain. Archival is unavailable while stock remains.`
    : record.activeItemCount !== 0 && 'Reassign or archive the active items in this category before archiving it.'
  const blocked = Boolean(reason)
  const effect = isItem
    ? 'Archiving removes this item from the active inventory view and preserves its batches and movement history.'
    : 'Archiving removes this category from active lists and item selectors. Historical items keep their category reference.'

  return `<section class="card cafe-card inventory-form-panel" aria-labelledby="archive-record-title">
    <div class="card-body inventory-stack">
      <h2 id="archive-record-title" data-inventory-section-title tabindex="-1" class="mb-0">Archive ${noun}</h2>
      <p class="mb-0"><strong>${escapeInventoryText(record.name)}</strong></p>
      <p class="mb-0">${effect}</p>
      <p class="cafe-muted cafe-supporting mb-0">${safeguard} Production archival rules are pending.</p>
      ${blocked || archive.error ? `<div role="alert" data-archive-error tabindex="-1">${renderMessage({ tone: 'error', icon: 'circle-alert', title: 'Archival unavailable', message: archive.error ? escapeInventoryText(archive.error) : reason })}</div>` : ''}
      <fieldset class="inventory-actions"${archive.busy ? ' disabled' : ''}>
        <button class="btn btn-outline-danger" type="button" data-inventory-action="confirm-archive"${blocked ? ' disabled' : ''}>${archive.busy ? 'Archiving…' : `Archive ${noun}`}</button>
        ${renderInventoryAction('cancel-archive', 'Cancel')}
      </fieldset>
    </div>
  </section>`
}
