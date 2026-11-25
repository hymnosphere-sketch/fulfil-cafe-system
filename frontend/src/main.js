import 'bootstrap/dist/css/bootstrap.min.css'
import '@fontsource/inter/latin-400.css'
import '@fontsource/inter/latin-500.css'
import '@fontsource/inter/latin-600.css'
import '@fontsource/inter/latin-700.css'

import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
import './styles/layout.css'
import './styles/dashboard.css'
import './styles/inventory.css'
import './styles/stock.css'
import './styles/transaction-history.css'
import './styles/reports.css'

import {
  ArrowLeft,
  ArrowLeftRight,
  CalendarClock,
  ChartColumn,
  CircleAlert,
  CircleCheck,
  Clock,
  Coffee,
  History,
  Info,
  LayoutDashboard,
  Menu,
  Package,
  PackageMinus,
  PackagePlus,
  PanelLeft,
  RefreshCw,
  Settings,
  Tags,
  TriangleAlert,
  Wifi,
  X,
  createIcons,
} from 'lucide'

import { initializeSidebar } from './components/sidebar.js'
import { renderStorageState } from './components/local-storage-status.js'
import { renderSyncBadge, renderSyncPanel, renderSyncSummary } from './components/sync-status.js'
import { initializeConnectivity, updateStorageStatus } from './components/topbar.js'
import { renderAppLayout } from './layouts/app-layout.js'
import { loadDashboard, renderDashboard } from './pages/dashboard.js'
import { createInventoryWorkspace } from './pages/inventory-workspace.js'
import { createReportsWorkspace } from './pages/reports-workspace.js'
import { renderSettings } from './pages/settings.js'
import { createStockWorkspace } from './pages/stock-workspace.js'
import { createTransactionHistory } from './pages/transaction-history.js'
import { routeHref, routes, startRouter } from './router.js'
import { createLocalInventorySession } from './services/local-inventory-session.js'
import { deriveSyncStatus } from './services/sync-status.js'

/**
 * Register the Service Worker for offline app shell support.
 * This runs after the application loads to avoid blocking initial render.
 */
async function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js', {
        scope: '/',
      })

      // Check for updates periodically
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing
        if (newWorker) {
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              // New version available, notify user
              dispatchEvent(new CustomEvent('sw-update-available', { detail: registration }))
            }
          })
        }
      })

      // Listen for controller change (update applied)
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        // Reload to use new service worker
        window.location.reload()
      })

      console.log('[PWA] Service Worker registered:', registration.scope)
    } catch (error) {
      console.warn('[PWA] Service Worker registration failed:', error)
    }
  }
}

/**
 * Handle PWA update notifications
 */
function setupUpdateHandling() {
  window.addEventListener('sw-update-available', () => {
    // The update is ready, will be applied on next navigation/reload
    console.log('[PWA] Update available, will apply on next reload')
    // Could show a toast/notification here in the future
  })
}

function renderIcons(root) {
  createIcons({
    root,
    icons: {
      ArrowLeft, ArrowLeftRight, CalendarClock, ChartColumn, CircleAlert, CircleCheck, Clock, Coffee, History, Info,
      LayoutDashboard, Menu, Package, PackageMinus, PackagePlus, PanelLeft, RefreshCw,
      Settings, Tags, TriangleAlert, Wifi, X,
    },
  })
}

export function mountApplication(app, { demoRepository, scenario, integration } = {}) {
  app.innerHTML = renderAppLayout(routes, { integration })

  const shell = app.querySelector('.app-shell')
  const main = shell.querySelector('main')
  const topbar = shell.querySelector('.app-topbar')
  const currentPage = topbar.querySelector('[data-current-page]')
  const sidebar = initializeSidebar(shell, () => {
    main.querySelector('#page-title').focus({ preventScroll: true })
    window.scrollTo(0, 0)
  })

  const storageMode = integration ? 'integration' : demoRepository ? 'isolated' : 'persistent'
  let storageStatus = { state: demoRepository ? 'isolated' : 'opening' }
  let activeRoute
  let changeChannel
  let syncActive = false
  let syncResult
  let retryDisplay
  const session = demoRepository ? null : createLocalInventorySession({
    onUpdate: showStorageStatus,
    createRepository: integration?.createRepository,
    onCommit: notifyInventoryCommitted,
  })
  const repository = demoRepository ?? session.repository
  const workspaceOptions = { repository, renderIcons, storageMode }
  const inventoryWorkspace = createInventoryWorkspace(workspaceOptions)
  const stockWorkspace = createStockWorkspace(workspaceOptions)
  const transactionHistory = createTransactionHistory(workspaceOptions)
  const reportsWorkspace = createReportsWorkspace(workspaceOptions)

  function notifyInventoryCommitted() {
    changeChannel?.postMessage('inventory-committed')
  }

  function renderSyncStatus() {
    if (!integration) return
    const queue = storageStatus.queue
    const hasPending = queue?.operations.some(({ status }) => status === 'pending')
    const model = deriveSyncStatus({
      configured: true, queue, loading: storageStatus.state === 'opening',
      unavailable: storageStatus.state === 'error', active: syncActive, result: hasPending ? syncResult : undefined,
    })
    const sections = [
      [topbar.querySelector('[data-app-sync-badge]'), renderSyncBadge],
      [main.querySelector('[data-app-sync-panel]'), renderSyncPanel],
      [main.querySelector('[data-app-sync-summary]'), renderSyncSummary],
    ]
    for (const [section, render] of sections) {
      if (section) {
        section.innerHTML = render(model)
        renderIcons(section)
      }
    }
    const announcement = shell.querySelector('[data-app-sync-announcement]')
    if (announcement.textContent !== model.label) announcement.textContent = model.label
    const button = main.querySelector('[data-integration-sync]')
    if (button) {
      button.disabled = syncActive || !model.counts?.pending ||
        ['retry_delayed', 'needs_review', 'recovery_required'].includes(model.state)
    }
    clearTimeout(retryDisplay)
    if (model.state === 'retry_delayed') {
      // Refresh the label and the button only. Delivery still needs a manual action.
      retryDisplay = setTimeout(renderSyncStatus, Math.min(60_000, Math.max(1, model.retryAt - Date.now())))
    }
  }

  async function synchronize(button) {
    if (!integration || syncActive || button.disabled) return
    syncActive = true
    syncResult = undefined
    renderSyncStatus()
    try {
      syncResult = await integration.synchronize(session.withDeliveryQueue)
      notifyInventoryCommitted()
    } catch {
      syncResult = { status: 'storage_failure' }
    } finally {
      await session.refresh()
      syncActive = false
      renderSyncStatus()
    }
  }

  function refreshDashboard() {
    const dashboard = main.querySelector('.inventory-dashboard')
    if (dashboard) void loadDashboard(dashboard, {
      scenario,
      renderIcons,
      storageMode,
      readSnapshot: scenario ? undefined : repository.read,
    })
  }

  function refreshActiveView() {
    if (activeRoute.route.id === 'inventory' || activeRoute.route.id === 'categories') inventoryWorkspace.refresh()
    else if (activeRoute.route.id === 'stock') stockWorkspace.refresh()
    else if (activeRoute.route.id === 'history') transactionHistory.refresh()
    else if (activeRoute.route.id === 'reports') reportsWorkspace.refresh()
    else if (activeRoute.route.id === 'dashboard') refreshDashboard()
  }

  function renderActiveView() {
    const { route, parameters: originalParameters } = activeRoute
    // Report and History filters can replace the URL without a route change.
    const [path, query] = window.location.hash.split('?', 2)
    const parameters = path === routeHref(route.id) ? new URLSearchParams(query) : originalParameters
    if (route.id === 'settings') {
      main.innerHTML = renderSettings(storageStatus, { integration })
      renderIcons(main)
    } else if (storageStatus.state !== 'ready' && storageStatus.state !== 'isolated') {
      main.innerHTML = renderStorageState(route.title, storageStatus)
      renderIcons(main)
    } else if (route.id === 'inventory' || route.id === 'categories') {
      inventoryWorkspace.mount(main, route.id, { itemId: parameters.get('item') })
    } else if (route.id === 'stock') {
      stockWorkspace.mount(main, { workflow: parameters.get('workflow'), itemId: parameters.get('item') })
    } else if (route.id === 'history') {
      transactionHistory.mount(main, parameters)
    } else if (route.id === 'reports') {
      reportsWorkspace.mount(main, parameters)
    } else {
      main.innerHTML = renderDashboard({ integration })
      renderIcons(main)
      refreshDashboard()
    }
    renderSyncStatus()
  }

  function showStorageStatus(status, refreshView) {
    const stateChanged = status.state !== storageStatus.state || status.error?.code !== storageStatus.error?.code
    storageStatus = status
    updateStorageStatus(topbar, storageStatus)
    if (!activeRoute) return
    if (stateChanged || activeRoute.route.id === 'settings') {
      const focusedInView = main.contains(document.activeElement)
      renderActiveView()
      if (focusedInView) main.querySelector('#page-title')?.focus({ preventScroll: true })
    } else {
      renderSyncStatus()
      if (refreshView) refreshActiveView()
    }
  }

  shell.querySelector('.app-skip-link').addEventListener('click', (event) => {
    event.preventDefault()
    main.focus()
  })
  main.addEventListener('click', (event) => {
    const sync = event.target.closest('[data-integration-sync]')
    if (sync) void synchronize(sync)
    else if (event.target.closest('[data-storage-retry]')) void session?.initialize({ reopen: true })
    else if (event.target.closest('[data-storage-reload]')) window.location.reload()
  })

  initializeConnectivity(topbar)
  updateStorageStatus(topbar, storageStatus)
  renderIcons(shell)
  startRouter((route, isInitial, parameters) => {
    activeRoute = { route, parameters }
    currentPage.textContent = route.title
    sidebar.setActiveRoute(route.id)
    renderActiveView()
    if (!isInitial) sidebar.focusDestination()
    if (route.id === 'settings') void session?.refresh()
  })

  if (session) {
    try {
      changeChannel = new BroadcastChannel(integration?.databaseName ?? 'fulfil-cafe-demo-inventory')
      changeChannel.addEventListener('message', (event) => {
        if (event.data === 'inventory-committed') void session.refresh(true)
      })
    } catch {
      // Browser lifecycle refresh still works if cross-tab signals are unavailable.
    }
    const refreshOnReturn = () => {
      if (!document.hidden) void session.refresh(true)
    }
    window.addEventListener('focus', refreshOnReturn)
    document.addEventListener('visibilitychange', refreshOnReturn)
    window.addEventListener('pageshow', (event) => {
      if (event.persisted) refreshOnReturn()
    })
    void session.initialize()
  }
}

// Initialize PWA features after DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    registerServiceWorker()
    setupUpdateHandling()
  })
} else {
  registerServiceWorker()
  setupUpdateHandling()
}

const app = document.querySelector('#app')
const developmentScenario = import.meta.env.DEV ? new URLSearchParams(location.search).get('dashboard-state') : null
if (app) {
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('showcase')) {
    const { showDesignShowcase } = await import('./pages/showcase-preview.js')
    showDesignShowcase(app)
  } else if (import.meta.env.DEV && ['empty', 'error', 'loading', 'unavailable'].includes(developmentScenario)) {
    const { createDemoInventoryRepository } = await import('./data/demo-inventory-repository.js')
    mountApplication(app, { demoRepository: createDemoInventoryRepository(), scenario: developmentScenario })
  } else {
    mountApplication(app)
  }
}