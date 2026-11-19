import assert from 'node:assert/strict'
import { test } from 'node:test'

import { readDemoInventory } from '../src/data/demo-data-provider.js'
import { clearCorrectedFieldError, renderArchiveScreen, renderRecordForm } from '../src/pages/inventory-forms.js'
import {
  renderCategoryResults,
  renderInventoryResults,
  renderItemDetails,
} from '../src/pages/inventory-rendering.js'
import { buildInventoryReadModel } from '../src/services/inventory-read-model.js'

const active = { view: 'active' }
const archived = { view: 'archived' }
const untrustedText = 'Milk & <img src=x onerror="alert(1)">'
const escapedText = 'Milk &amp; &lt;img src=x onerror=&quot;alert(1)&quot;&gt;'

test('inventory lists and details escape record names, identifiers, categories, units, and movement reasons', async () => {
  const model = buildInventoryReadModel(await readDemoInventory())
  const source = model.items[0]
  const item = {
    ...source,
    itemId: 'item-" data-untrusted="yes',
    name: untrustedText,
    categoryName: untrustedText,
    unit: 'bags & <paper>',
    movements: [{ ...source.movements[0], reason: untrustedText }],
  }
  const list = renderInventoryResults({ ...model, items: [item] }, active)
  const details = renderItemDetails(item, model)

  for (const markup of [list, details]) {
    assert.ok(markup.includes(escapedText))
    assert.ok(markup.includes('item-&quot; data-untrusted=&quot;yes'))
    assert.ok(markup.includes('bags &amp; &lt;paper&gt;'))
    assert.doesNotMatch(markup, /<img| data-untrusted="yes"/)
  }
  assert.match(details, /Reason/)
  assert.match(details, /Purchase cost<\/dt><dd>Not recorded/)
})

test('category descriptions, form values, and provider-supplied error text are escaped', async () => {
  const model = buildInventoryReadModel(await readDemoInventory())
  const category = { ...model.categories[0], name: untrustedText, description: untrustedText }
  const list = renderCategoryResults({ ...model, categories: [category] }, active, [category])
  const form = renderRecordForm({
    module: 'categories',
    model,
    draft: {
      values: { name: untrustedText, description: '</textarea><img src=x onerror=alert(1)>' },
      error: { field: 'name', message: untrustedText },
      duplicateReview: null,
    },
  })

  assert.ok(list.includes(escapedText))
  assert.ok(form.includes(escapedText))
  assert.ok(form.includes('&lt;/textarea&gt;&lt;img'))
  assert.doesNotMatch(list + form, /<img/)
  assert.match(form, /aria-invalid="true"/)
  assert.match(form, /aria-describedby="[^"]*demo-field-name-error/)
})

test('renders separate no-match, no-records, and no-archived states', async () => {
  const model = buildInventoryReadModel(await readDemoInventory())
  assert.match(renderInventoryResults(model, { ...active, query: 'nonexistent name' }), /No items match your search/)
  assert.match(renderInventoryResults({ ...model, items: [] }, active), /No active inventory items/)
  assert.match(renderInventoryResults({ ...model, items: [] }, archived), /No archived items/)
  assert.match(renderCategoryResults(model, archived, []), /No archived categories/)
})

test('correcting minimum stock clears only that field error and preserves its help and the draft', () => {
  const id = 'demo-field-minimum_stock_level'
  const classList = new Set(['form-control', 'is-invalid'])
  const attributes = new Map([
    ['aria-invalid', 'true'],
    ['aria-describedby', id + '-help ' + id + '-error'],
  ])
  let removed = false
  const control = {
    id,
    name: 'minimum_stock_level',
    classList: { remove: (name) => classList.delete(name) },
    getAttribute: (name) => attributes.get(name),
    removeAttribute: (name) => attributes.delete(name),
    setAttribute: (name, value) => attributes.set(name, value),
    parentElement: { querySelector: () => ({ remove: () => { removed = true } }) },
  }
  const draft = {
    values: { name: 'Demo supplies', minimum_stock_level: '1e2' },
    error: { field: control.name },
  }
  clearCorrectedFieldError(draft, { name: 'name' }, {}, 'inventory')
  clearCorrectedFieldError(draft, control, {}, 'inventory')
  assert.equal(draft.error.field, control.name)
  assert.equal(removed, false)
  assert.ok(classList.has('is-invalid'))
  assert.equal(attributes.get('aria-invalid'), 'true')

  draft.values.minimum_stock_level = '0'
  clearCorrectedFieldError(draft, control, {}, 'inventory')
  assert.equal(draft.error, null)
  assert.equal(removed, true)
  assert.deepEqual([...classList], ['form-control'])
  assert.equal(attributes.has('aria-invalid'), false)
  assert.equal(attributes.get('aria-describedby'), id + '-help')
  assert.deepEqual(draft.values, { name: 'Demo supplies', minimum_stock_level: '0' })
})

test('shows archive restrictions before confirmation and preserves the eligible confirmation action', async () => {
  const model = buildInventoryReadModel(await readDemoInventory())
  const stocked = model.items.find(({ availableQuantity, isActive }) => isActive && availableQuantity > 0)
  const depleted = model.items.find(({ availableQuantity, isActive }) => isActive && availableQuantity === 0)
  const markup = renderInventoryResults(model, active, [stocked, depleted])
  assert.match(markup, new RegExp('data-id="' + stocked.itemId + '" aria-label="Archive [^"]+" disabled'))
  assert.match(markup, /Stock must reach zero/)
  assert.doesNotMatch(markup, new RegExp('data-id="' + depleted.itemId + '" aria-label="Archive [^"]+" disabled'))
  const category = model.categories.find(({ activeItemCount }) => activeItemCount > 0)
  const categories = renderCategoryResults(model, active, [category])
  assert.match(categories, /aria-label="Archive [^"]+" disabled/)
  assert.match(categories, /Active items still use this category/)
  assert.match(categories, /Active items<\/strong> [1-9]/)
  const confirmation = renderArchiveScreen({ module: 'inventory', record: depleted, archive: {} })
  assert.match(confirmation, /preserves its batches and movement history/)
  assert.match(confirmation, /data-inventory-action="confirm-archive">Archive item/)
})
