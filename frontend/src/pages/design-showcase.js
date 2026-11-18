import { renderCard } from '../components/card.js'
import { renderPreviewForm } from '../components/preview-form.js'
import { renderBadge, renderMessage } from '../components/status.js'

const palette = [
  { name: 'Forest green', swatch: 'primary', hex: '#254A3B' },
  { name: 'Warm ivory', swatch: 'background', hex: '#F7F5F0' },
  { name: 'White', swatch: 'surface', hex: '#FFFFFF' },
  { name: 'Charcoal', swatch: 'text', hex: '#252B28' },
  { name: 'Muted text', swatch: 'text-muted', hex: '#525B55' },
  { name: 'Coffee beige', swatch: 'accent', hex: '#B99A76' },
  { name: 'Border', swatch: 'border', hex: '#DCE1DB' },
  { name: 'Selected navigation', swatch: 'nav-selected', hex: '#E5EEE8' },
]

const icons = [
  ['coffee', 'Coffee'],
  ['package', 'Package'],
  ['plus', 'Plus'],
  ['search', 'Search'],
  ['circle-check', 'Check circle'],
  ['triangle-alert', 'Alert triangle'],
  ['info', 'Information'],
  ['settings', 'Settings'],
]

function renderPalette() {
  return `
    <ul class="palette-grid list-unstyled mb-0">
      ${palette.map(({ name, swatch, hex }) => `
        <li>
          <div class="palette-swatch" style="--swatch: var(--color-${swatch})" aria-hidden="true"></div>
          <span class="palette-name">${name}</span>
          <span class="palette-hex cafe-supporting cafe-muted">${hex}</span>
        </li>
      `).join('')}
    </ul>
  `
}

function renderTypography() {
  return `
    <table class="table type-table align-middle mb-0" aria-labelledby="type-heading">
      <thead class="visually-hidden">
        <tr><th scope="col">Type role</th><th scope="col">Example</th></tr>
      </thead>
      <tbody>
        <tr><th scope="row">Page heading</th><td class="type-page">Inventory</td></tr>
        <tr><th scope="row">Section heading</th><td class="type-section">Stock history</td></tr>
        <tr><th scope="row">Body text</th><td class="type-body">Review available stock.</td></tr>
        <tr>
          <th scope="row">Fictional quantity</th>
          <td><span class="type-stat">15</span> <span class="cafe-supporting cafe-muted">units</span></td>
        </tr>
      </tbody>
    </table>
  `
}

function renderStates() {
  const badges = [
    { tone: 'success', icon: 'circle-check', label: 'Sufficient stock' },
    { tone: 'warning', icon: 'triangle-alert', label: 'Low stock' },
    { tone: 'error', icon: 'circle-alert', label: 'Out of stock' },
    { tone: 'info', icon: 'info', label: 'Pending sync' },
  ]

  return `
    <div class="d-flex flex-wrap gap-2 mb-4" role="group" aria-label="Fictional inventory statuses">
      ${badges.map(renderBadge).join('')}
    </div>
    <div class="d-grid gap-2">
      ${renderMessage({
        tone: 'info',
        icon: 'info',
        title: 'Sample data',
        message: 'The stock labels and quantities are fictional.',
      })}
      ${renderMessage({
        tone: 'error',
        icon: 'circle-alert',
        title: 'Example validation error',
        message: 'Enter a quantity greater than zero.',
      })}
    </div>
    <button class="btn btn-outline-primary mt-3" type="button" data-bs-toggle="collapse"
      data-bs-target="#preview-availability" aria-controls="preview-availability" aria-expanded="false">
      Preview availability
      <i class="disclosure-icon" data-lucide="chevron-down" aria-hidden="true"></i>
    </button>
    <div class="collapse" id="preview-availability">
      <div class="pt-3">
        ${renderMessage({
          tone: 'disabled',
          icon: 'package',
          title: 'Inventory unavailable',
          message: 'Inventory records will be available after the application is implemented.',
        })}
      </div>
    </div>
  `
}

function renderIcons() {
  return `
    <ul class="icon-grid list-unstyled mb-0">
      ${icons.map(([id, label]) => `
        <li class="icon-sample">
          <span class="icon-tile"><i data-lucide="${id}" aria-hidden="true"></i></span>
          <span>${label}</span>
        </li>
      `).join('')}
    </ul>
  `
}

export function renderDesignShowcase() {
  return `
    <section class="preview-intro" aria-labelledby="preview-title">
      <h1 id="preview-title">Modern Café design foundation</h1>
      <p>A tablet-first workspace designed to help Fulfil Cafe track ingredients, supplies, and stock movements.</p>
    </section>

    <div class="row preview-grid">
      <div class="col-12 col-lg-7">
        ${renderCard({ id: 'palette-heading', title: 'Core palette', content: renderPalette() })}
      </div>
      <div class="col-12 col-lg-5">
        ${renderCard({ id: 'type-heading', title: 'Typography', content: renderTypography() })}
      </div>
      <div class="col-12 col-lg-6">
        ${renderCard({ id: 'controls-heading', title: 'Buttons and fields', content: renderPreviewForm() })}
      </div>
      <div class="col-12 col-lg-6">
        ${renderCard({ id: 'states-heading', title: 'Status and feedback', content: renderStates() })}
      </div>
      <div class="col-12">
        ${renderCard({ id: 'icons-heading', title: 'Lucide icons', content: renderIcons() })}
      </div>
    </div>
  `
}
