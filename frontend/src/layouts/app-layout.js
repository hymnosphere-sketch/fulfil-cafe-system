import { renderSidebar } from '../components/sidebar.js'
import { renderTopbar } from '../components/topbar.js'

export function renderAppLayout(routes, options) {
  return `
    <div class="app-shell cafe-theme">
      <a class="visually-hidden-focusable app-skip-link" href="#main-content">Skip to content</a>
      ${renderSidebar(routes)}
      <div class="app-workspace">
        ${renderTopbar(options)}
        ${options?.integration ? '<p class="visually-hidden" role="status" data-app-sync-announcement></p>' : ''}
        <main class="app-content" id="main-content" tabindex="-1" aria-labelledby="page-title"></main>
      </div>
    </div>
  `
}
