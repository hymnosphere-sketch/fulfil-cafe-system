import { renderCard } from './card.js'
import { renderBadge } from './status.js'
import { deriveSyncStatus } from '../services/sync-status.js'

const countFormat = new Intl.NumberFormat('en-PH')
const dateFormat = new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short' })
const count = (value) => value == null ? '—' : countFormat.format(value)

function detail(label, value, key) {
  return '<div class="local-data__detail"><dt>' + label + '</dt><dd data-sync-' + key + '>' + value + '</dd></div>'
}

function formatTime(value) {
  const date = new Date(value)
  return '<time datetime="' + date.toISOString() + '">' + dateFormat.format(date) + '</time>'
}

export function renderSyncBadge(model = deriveSyncStatus()) {
  return '<span class="d-inline-flex mw-100" data-sync-state="' + model.state + '">' + renderBadge(model) + '</span>'
}

export function renderSyncPanel(model = deriveSyncStatus()) {
  const lastKnown = model.counts !== null || model.state === 'not_configured'
  const last = model.lastConfirmed ? formatTime(model.lastConfirmed) : lastKnown ? 'Not yet synchronized' : '—'
  const retry = model.retryAt === null ? '—' : model.canRetry ? 'Can retry now' : formatTime(model.retryAt)
  return renderCard({
    id: 'sync-panel-title',
    title: 'Synchronization',
    content: [
      '<div class="d-flex flex-wrap align-items-center gap-2 mb-3">',
      renderSyncBadge(model),
      '<p class="cafe-muted cafe-supporting mb-0">' + model.message + '</p></div>',
      '<dl class="local-data__details sync-details mb-0" data-sync-details>',
      detail('Pending operations', count(model.counts?.pending), 'pending'),
      detail('Confirmed synchronized', count(model.counts?.synchronized), 'confirmed'),
      detail('Operations requiring review', count(model.counts?.review), 'review'),
      detail('Last successful synchronization', last, 'last-success'),
      detail('Next retry eligibility', retry, 'retry'),
      '</dl>',
    ].join(''),
  })
}

export function renderSyncSummary(model = deriveSyncStatus()) {
  return [
    '<section class="card cafe-card" aria-labelledby="sync-summary-title">',
    '<div class="card-body d-flex flex-wrap align-items-center gap-2 py-3">',
    '<h2 id="sync-summary-title" class="h6 mb-0">Synchronization</h2>',
    renderSyncBadge(model),
    '<p class="cafe-muted cafe-supporting mb-0">' + model.message + '</p>',
    '</div></section>',
  ].join('')
}
