import Offcanvas from 'bootstrap/js/dist/offcanvas.js'

export function renderSidebar(routes) {
  return `
    <aside class="app-sidebar offcanvas-lg offcanvas-start" id="app-sidebar"
      tabindex="-1" aria-labelledby="sidebar-title">
      <div class="app-sidebar__header">
        <div class="app-sidebar__brand">
          <span class="app-sidebar__brand-icon"><i data-lucide="coffee" aria-hidden="true"></i></span>
          <span class="app-sidebar__brand-text" id="sidebar-title">Fulfil Cafe</span>
        </div>
        <button class="app-sidebar__close app-icon-button d-lg-none" type="button"
          aria-label="Close navigation">
          <i data-lucide="x" aria-hidden="true"></i>
        </button>
      </div>
      <nav class="app-nav" aria-label="Inventory workspace">
        <ul class="app-nav__list list-unstyled">
          ${routes.map((route) => `
            <li>
              <a class="app-nav__link" href="#/${route.id}" data-route="${route.id}" aria-label="${route.title}">
                <span class="app-nav__icon"><i data-lucide="${route.icon}" aria-hidden="true"></i></span>
                <span class="app-nav__label">${route.title}</span>
                <span class="app-nav__compact-label" aria-hidden="true">${route.shortTitle ?? route.title}</span>
              </a>
            </li>
          `).join('')}
        </ul>
      </nav>
    </aside>
  `
}

export function initializeSidebar(shell, focusPage) {
  const sidebar = shell.querySelector('#app-sidebar')
  const workspace = shell.querySelector('.app-workspace')
  const skipLink = shell.querySelector('.app-skip-link')
  const menuToggle = shell.querySelector('[data-menu-toggle]')
  const sidebarToggle = shell.querySelector('[data-sidebar-toggle]')
  const closeButton = sidebar.querySelector('.app-sidebar__close')
  const links = sidebar.querySelectorAll('[data-route]')
  const wideViewport = window.matchMedia('(min-width: 992px)')
  const offcanvas = new Offcanvas(sidebar)

  let menuOpen = false
  let closeAfterOpening = false
  let focusPageAfterClose = false

  function closeMenu() {
    // Let Bootstrap finish opening before it removes the focus trap and backdrop.
    if (sidebar.classList.contains('showing')) {
      closeAfterOpening = true
    } else {
      offcanvas.hide()
    }
  }

  function focusDestination() {
    if (menuOpen) {
      focusPageAfterClose = true
      closeMenu()
    } else {
      focusPage()
    }
  }

  sidebarToggle.addEventListener('click', () => {
    const collapsed = shell.classList.toggle('is-sidebar-collapsed')
    const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar'
    sidebarToggle.setAttribute('aria-expanded', String(!collapsed))
    sidebarToggle.setAttribute('aria-label', label)
    sidebarToggle.title = label
  })

  menuToggle.addEventListener('click', () => {
    if (!wideViewport.matches) offcanvas.show(menuToggle)
  })
  closeButton.addEventListener('click', closeMenu)

  sidebar.addEventListener('show.bs.offcanvas', () => {
    menuOpen = true
    menuToggle.setAttribute('aria-expanded', 'true')
    workspace.inert = true
    skipLink.inert = true
  })
  sidebar.addEventListener('shown.bs.offcanvas', () => {
    if (closeAfterOpening || wideViewport.matches) {
      closeMenu()
    } else {
      closeButton.focus()
    }
  })
  sidebar.addEventListener('hide.bs.offcanvas', (event) => {
    // Bootstrap can request a dismiss directly (for example, on a backdrop click).
    if (sidebar.classList.contains('showing')) {
      event.preventDefault()
      closeAfterOpening = true
      return
    }
    menuToggle.setAttribute('aria-expanded', 'false')
  })
  sidebar.addEventListener('hidden.bs.offcanvas', () => {
    menuOpen = false
    closeAfterOpening = false
    workspace.inert = false
    skipLink.inert = false

    if (focusPageAfterClose) {
      focusPageAfterClose = false
      focusPage()
      return
    }

    const toggle = wideViewport.matches ? sidebarToggle : menuToggle
    toggle.focus()
  })

  wideViewport.addEventListener('change', ({ matches }) => {
    if (matches && menuOpen) {
      closeMenu()
    } else if (matches && document.activeElement === menuToggle) {
      sidebarToggle.focus()
    } else if (!matches && !menuOpen &&
      (sidebar.contains(document.activeElement) || document.activeElement === sidebarToggle)) {
      menuToggle.focus()
    }
  })

  sidebar.addEventListener('click', (event) => {
    const link = event.target.closest('[data-route]')
    // Activating the current URL will not fire hashchange.
    if (link?.hash === location.hash && !event.ctrlKey && !event.metaKey &&
      !event.shiftKey && !event.altKey) {
      event.preventDefault()
      focusDestination()
    }
  })

  return {
    setActiveRoute(routeId) {
      for (const link of links) {
        if (link.dataset.route === routeId) {
          link.setAttribute('aria-current', 'page')
        } else {
          link.removeAttribute('aria-current')
        }
      }
    },
    focusDestination,
  }
}
