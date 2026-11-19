export const routes = [
  { id: 'dashboard', title: 'Dashboard', icon: 'layout-dashboard' },
  { id: 'inventory', title: 'Inventory', icon: 'package', description: 'Find ingredients and supplies, check quantities, and review stock batches.' },
  { id: 'stock', title: 'Stock Management', shortTitle: 'Stock', icon: 'arrow-left-right', description: 'Receive stock, record usage and wastage, and review adjustments.' },
  { id: 'categories', title: 'Categories', icon: 'tags', description: 'Organize ingredients and supplies into categories.' },
  { id: 'history', title: 'Transaction History', shortTitle: 'History', icon: 'history', description: 'Review stock movements and the changes they made to inventory.' },
  { id: 'reports', title: 'Reports', icon: 'chart-column', description: 'Review inventory levels, stock alerts, expiration, and movement summaries.' },
  { id: 'settings', title: 'Settings', icon: 'settings', description: 'Review application preferences and approved synchronization and recovery options.' },
]

export function routeHref(id, parameters) {
  const query = new URLSearchParams(parameters).toString()
  return '#/' + id + (query ? '?' + query : '')
}

export function startRouter(renderRoute) {
  function renderCurrentRoute(isInitial = false) {
    const [path, query] = location.hash.split('?', 2)
    const route = routes.find(({ id }) => path === routeHref(id))
    const destination = route ?? routes[0]

    // Replace unknown or empty hashes so Back does not revisit an invalid page.
    if (!route) {
      history.replaceState(history.state, '', routeHref(destination.id))
    }

    document.title = `${destination.title} | Fulfil Cafe Inventory and Operations Management System`
    renderRoute(destination, isInitial, new URLSearchParams(route ? query : undefined))
  }

  window.addEventListener('hashchange', () => renderCurrentRoute())
  renderCurrentRoute(true)
}
