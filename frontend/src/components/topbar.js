import { renderSyncBadge } from './sync-status.js'
import { describeStorage } from './local-storage-status.js'

export function renderTopbar() {
  return `
    <header class="app-topbar">
      <div class="app-topbar__context">
        <button class="app-icon-button d-lg-none" type="button" data-menu-toggle
          aria-label="Open navigation" aria-controls="app-sidebar" aria-expanded="false">
          <i data-lucide="menu" aria-hidden="true"></i>
        </button>
        <button class="app-icon-button d-none d-lg-inline-flex" type="button" data-sidebar-toggle
          aria-label="Collapse sidebar" aria-controls="app-sidebar" aria-expanded="true" title="Collapse sidebar">
          <i data-lucide="panel-left" aria-hidden="true"></i>
        </button>
        <div class="app-topbar__location">
          <span class="app-topbar__identity d-lg-none">Fulfil Cafe</span>
          <span class="app-topbar__page" data-current-page></span>
        </div>
      </div>
      <div class="app-topbar__statuses">
        <span class="badge cafe-badge" data-browser-status role="status" title="Browser-reported network status">
          <i data-lucide="wifi" aria-hidden="true"></i>
          <span data-browser-status-label></span>
        </span>
        <span class="badge cafe-badge cafe-tone--info" data-storage-status data-storage-state="opening" role="status">
          <i data-lucide="package" aria-hidden="true"></i>
          <span data-storage-status-label>Opening local storage</span>
        </span>
        ${renderSyncBadge()}
        <span class="preview-label">Development Preview</span>
      </div>
    </header>
  `
}

export function updateStorageStatus(topbar, storage) {
  const status = topbar.querySelector('[data-storage-status]')
  const label = status.querySelector('[data-storage-status-label]')
  const { kind, tone, label: text } = describeStorage(storage)

  status.dataset.storageState = kind
  status.classList.remove('cafe-tone--info', 'cafe-tone--success', 'cafe-tone--warning', 'cafe-tone--error')
  status.classList.add('cafe-tone--' + tone)
  if (label.textContent !== text) label.textContent = text
}

export function initializeConnectivity(topbar) {
  const status = topbar.querySelector('[data-browser-status]')
  const label = status.querySelector('[data-browser-status-label]')

  function updateConnectivity() {
    const online = navigator.onLine
    status.classList.toggle('cafe-tone--success', online)
    status.classList.toggle('cafe-tone--warning', !online)
    label.textContent = online ? 'Browser online' : 'Browser offline'
  }

  window.addEventListener('online', updateConnectivity)
  window.addEventListener('offline', updateConnectivity)
  updateConnectivity()
}
