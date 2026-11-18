import { renderBadge } from './status.js'

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
        ${renderBadge({ tone: 'disabled', icon: 'refresh-cw', label: 'Sync not configured' })}
        <span class="preview-label">Development Preview</span>
      </div>
    </header>
  `
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
