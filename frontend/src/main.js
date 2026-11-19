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

import {
  ArrowLeft,
  ArrowLeftRight,
  CalendarClock,
  ChartColumn,
  CircleAlert,
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
import { initializeConnectivity } from './components/topbar.js'
import { createDemoInventoryRepository } from './data/demo-inventory-repository.js'
import { renderAppLayout } from './layouts/app-layout.js'
import { loadDashboard, renderDashboard } from './pages/dashboard.js'
import { createInventoryWorkspace } from './pages/inventory-workspace.js'
import { renderModulePlaceholder } from './pages/module-placeholder.js'
import { routes, startRouter } from './router.js'

function renderIcons(root) {
  createIcons({
    root,
    icons: {
      ArrowLeft, ArrowLeftRight, CalendarClock, ChartColumn, CircleAlert, Coffee, History, Info,
      LayoutDashboard, Menu, Package, PackageMinus, PackagePlus, PanelLeft, RefreshCw,
      Settings, Tags, TriangleAlert, Wifi, X,
    },
  })
}

function mountApplication(app) {
  app.innerHTML = renderAppLayout(routes)

  const repository = createDemoInventoryRepository()
  const inventoryWorkspace = createInventoryWorkspace({ repository, renderIcons })
  const shell = app.querySelector('.app-shell')
  const main = shell.querySelector('main')
  const topbar = shell.querySelector('.app-topbar')
  const currentPage = topbar.querySelector('[data-current-page]')
  const sidebar = initializeSidebar(shell, () => {
    main.querySelector('#page-title').focus({ preventScroll: true })
    window.scrollTo(0, 0)
  })

  shell.querySelector('.app-skip-link').addEventListener('click', (event) => {
    event.preventDefault()
    main.focus()
  })

  initializeConnectivity(topbar)
  renderIcons(shell)
  startRouter((route, isInitial) => {
    currentPage.textContent = route.title
    sidebar.setActiveRoute(route.id)

    if (route.id === 'inventory' || route.id === 'categories') {
      inventoryWorkspace.mount(main, route.id)
    } else {
      main.innerHTML = route.id === 'dashboard' ? renderDashboard() : renderModulePlaceholder(route)
      renderIcons(main)

      if (route.id === 'dashboard') {
        const scenario = import.meta.env.DEV
          ? new URLSearchParams(location.search).get('dashboard-state')
          : undefined
        const isolatedScenario = ['empty', 'error', 'loading', 'unavailable'].includes(scenario)
        void loadDashboard(main.querySelector('.inventory-dashboard'), {
          scenario,
          renderIcons,
          readSnapshot: isolatedScenario ? undefined : repository.read,
        })
      }
    }

    if (!isInitial) sidebar.focusDestination()
  })
}

const app = document.querySelector('#app')
if (import.meta.env.DEV && new URLSearchParams(location.search).has('showcase')) {
  const { showDesignShowcase } = await import('./pages/showcase-preview.js')
  showDesignShowcase(app)
} else {
  mountApplication(app)
}
