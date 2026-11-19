import { renderCard } from '../components/card.js'
import { describeStorage, renderStorageNotice } from '../components/local-storage-status.js'
import { renderPageHeader } from '../components/page-header.js'
import { demoBusinessDate } from '../data/demo-inventory.js'
import { DATABASE_VERSION } from '../db/schema.js'

const formatter = new Intl.NumberFormat('en-PH')

function detail(label, value, attribute = '') {
  return `
    <div class="local-data__detail">
      <dt>${label}</dt>
      <dd${attribute ? ' ' + attribute : ''}>${value}</dd>
    </div>
  `
}

export function renderSettings(storage) {
  const { kind, label } = describeStorage(storage)
  const isolated = kind === 'isolated'
  const count = kind === 'ready' && Number.isSafeInteger(storage.queueCount) && storage.queueCount >= 0
    ? formatter.format(storage.queueCount)
    : 'Unavailable'
  const schemaVersion = Number.isSafeInteger(storage.schemaVersion) && storage.schemaVersion > 0
    ? storage.schemaVersion
    : 'Unavailable'

  return `
    ${renderPageHeader({
      title: 'Settings',
      description: 'Review local data and application status.',
    })}
    ${renderStorageNotice(storage)}
    <div class="local-data__cards">
      ${renderCard({
        id: 'settings-local-data-title',
        title: 'Local data',
        content: `
          <dl class="local-data__details">
            ${detail('Data mode', isolated ? 'Fictional temporary demonstration' : 'Fictional demonstration')}
            ${detail('Local storage', label, 'data-settings-storage-status')}
            ${detail('Storage technology', isolated ? 'In-memory' : 'IndexedDB')}
            ${isolated ? '' : kind === 'ready'
              ? detail('Database schema version', schemaVersion, 'data-settings-schema-version')
              : detail('Supported schema version', DATABASE_VERSION, 'data-settings-schema-version')}
            ${detail('Demonstration business date', `<time datetime="${demoBusinessDate}">${demoBusinessDate}</time>`)}
          </dl>
        `,
      })}
      ${renderCard({
        id: 'settings-application-status-title',
        title: 'Application status',
        content: `
          <dl class="local-data__details">
            ${detail('Queued fictional operations', count, 'data-settings-queue-count')}
            ${detail('Synchronization', 'Sync not configured')}
            ${detail('Backups', 'Unavailable')}
          </dl>
          ${isolated ? '' : `
            <p class="cafe-muted mb-2">These queued operations are ineligible for upload.</p>
            <p class="cafe-muted mb-0">Changes stay in this browser after refresh. If browser data is cleared or lost, recovery requires a verified backup.</p>
          `}
        `,
      })}
    </div>
  `
}
