import { renderCard } from '../components/card.js'
import { renderPageHeader } from '../components/page-header.js'

export function renderModulePlaceholder(route) {
  const { title, icon, description } = route

  return `
    ${renderPageHeader({ title, description })}
    <div class="module-placeholder">
      ${renderCard({
        id: 'module-status-title',
        title: 'In development',
        content: `
          <span class="module-placeholder__icon">
            <i data-lucide="${icon}" aria-hidden="true"></i>
          </span>
          <p class="cafe-muted mb-3">This module is available to preview. Its inventory features are still being built.</p>
          <a class="btn btn-primary" href="#/dashboard">
            <i data-lucide="arrow-left" aria-hidden="true"></i>
            Back to dashboard
          </a>
        `,
      })}
    </div>
  `
}
