import { renderSidebar } from '../components/sidebar.js'
import { renderTopbar } from '../components/topbar.js'

export function renderAppLayout(routes) {
  return `
    <div class="app-shell cafe-theme">
      <a class="visually-hidden-focusable app-skip-link" href="#main-content">Skip to content</a>
      ${renderSidebar(routes)}
      <div class="app-workspace">
        ${renderTopbar()}
        <main class="app-content" id="main-content" tabindex="-1" aria-labelledby="page-title"></main>
      </div>
    </div>
  `
}
