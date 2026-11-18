import { renderCard } from '../components/card.js'
import { renderPageHeader } from '../components/page-header.js'
import { renderBadge } from '../components/status.js'

const upcomingModules = [
  { title: 'Stock overview', icon: 'package', description: 'Review available stock across inventory items.' },
  { title: 'Stock alerts', icon: 'triangle-alert', description: 'Find low-stock items and batches nearing expiration.' },
  { title: 'Recent movements', icon: 'history', description: 'See what was received, used, or adjusted.' },
  { title: 'Quick actions', icon: 'zap', description: 'Start common stock tasks from the dashboard.' },
]

export function renderDashboard() {
  return `
    ${renderPageHeader({
      title: 'Dashboard',
      description: 'An overview of the Fulfil Cafe inventory workspace.',
    })}
    <div class="dashboard-preview mb-4">
      ${renderCard({
        id: 'workspace-title',
        title: 'Inventory workspace',
        content: `
          ${renderBadge({ tone: 'info', icon: 'info', label: 'Development Preview' })}
          <p class="cafe-muted mt-3 mb-0">
            Use the navigation to explore the modules that will support day-to-day inventory work.
            Inventory records and stock actions are unavailable in this preview.
          </p>
        `,
      })}
    </div>
    <div class="dashboard-upcoming">
      ${renderCard({
        id: 'upcoming-title',
        title: 'Coming to the dashboard',
        content: `
          <ul class="row g-3 list-unstyled mb-0">
            ${upcomingModules.map(({ title, icon, description }) => `
              <li class="col-12 col-sm-6 col-xl-3">
                <div class="dashboard-module border rounded h-100 p-3">
                  <i data-lucide="${icon}" aria-hidden="true"></i>
                  <h3 class="h6 mt-2 mb-1">${title}</h3>
                  <p class="cafe-supporting cafe-muted mb-0">${description}</p>
                </div>
              </li>
            `).join('')}
          </ul>
        `,
      })}
    </div>
  `
}
