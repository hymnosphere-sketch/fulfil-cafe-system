import { renderPageHeader } from './page-header.js'
import { renderMessage } from './status.js'

const opening = {
  kind: 'opening', tone: 'info', icon: 'refresh-cw', label: 'Opening local storage',
  message: 'The app is preparing your browser’s inventory database.',
}
const ready = {
  kind: 'ready', tone: 'success', label: 'Local storage ready',
}
const isolated = {
  kind: 'isolated', tone: 'info', icon: 'info', label: 'Temporary demo storage',
  message: 'This isolated demonstration keeps its changes in memory for this session.',
}

const failures = {
  blocked: {
    kind: 'blocked', tone: 'warning', icon: 'triangle-alert', label: 'Database upgrade blocked',
    message: 'Close other Fulfil Cafe tabs or app windows, then retry.',
    action: 'retry',
  },
  versionChanged: {
    kind: 'version-changed', tone: 'warning', icon: 'triangle-alert', label: 'Database version changed',
    message: 'Reload this page to reopen local storage.',
    action: 'reload',
  },
  updateRequired: {
    kind: 'update-required', tone: 'warning', icon: 'triangle-alert', label: 'Database update required',
    message: 'Open this database with a newer compatible version of the app.',
  },
  unavailable: {
    kind: 'unavailable', tone: 'error', icon: 'circle-alert', label: 'Local storage unavailable',
    message: 'Check that this browser allows local storage for Fulfil Cafe, then retry.',
    action: 'retry',
  },
  quota: {
    kind: 'quota', tone: 'warning', icon: 'triangle-alert', label: 'Local storage is full',
    message: 'Free device space while keeping Fulfil Cafe browser data, then retry.',
    action: 'retry',
  },
  transaction: {
    kind: 'transaction-failed', tone: 'error', icon: 'circle-alert', label: 'Local storage transaction failed',
    message: 'The storage operation could not finish. Retry opening local storage.',
    action: 'retry',
  },
  invalid: {
    kind: 'invalid', tone: 'error', icon: 'circle-alert', label: 'Local data needs review',
    message: 'The app could not verify the stored records. Keep the existing browser data for review.',
  },
  integrity: {
    kind: 'invalid', tone: 'error', icon: 'circle-alert', label: 'Local data needs review',
    message: 'The saved inventory could not be validated. Further recording has stopped. Existing records have been kept for review.',
    action: 'retry',
  },
}

const failuresByCode = new Map([
  ['DB_BLOCKED', failures.blocked],
  ['DB_VERSION_CHANGED', failures.versionChanged],
  ['DB_VERSION_UNSUPPORTED', failures.updateRequired],
  ['DB_UNAVAILABLE', failures.unavailable],
  ['DB_CONNECTION_CLOSED', failures.unavailable],
  ['DB_OPEN_FAILED', failures.unavailable],
  ['DB_QUOTA', failures.quota],
  ['DB_TRANSACTION_FAILED', failures.transaction],
  ['DB_TRANSACTION_ABORTED', failures.transaction],
  ['DB_REQUEST_FAILED', failures.transaction],
  ['DB_UPGRADE_FAILED', failures.transaction],
  ['DB_INVALID_METADATA', failures.invalid],
  ['DB_INTEGRITY', failures.integrity],
  ['DB_UNMARKED_DATA', failures.invalid],
  ['DB_INVALID_RECORD', failures.invalid],
  ['DB_CONSTRAINT', failures.invalid],
  ['DB_INVALID_NAME', failures.invalid],
  ['DB_SEQUENCE_EXHAUSTED', failures.invalid],
])

export function describeStorage({ state, error }) {
  if (state === 'opening') return opening
  if (state === 'ready') return ready
  if (state === 'isolated') return isolated
  return failuresByCode.get(error?.code) ?? failures.invalid
}

export function renderStorageNotice(storage) {
  const { kind, tone, icon, label, message, action } = describeStorage(storage)
  if (kind === 'ready') return ''
  const buttonLabel = action === 'retry' ? 'Retry' : 'Reload app'
  return `
    <div class="local-storage-panel" data-storage-panel="${kind}">
      <div role="${tone === 'info' ? 'status' : 'alert'}">
        ${renderMessage({ tone, icon, title: label, message })}
      </div>
      ${action ? `<button class="btn btn-primary" type="button" data-storage-${action}>${buttonLabel}</button>` : ''}
    </div>
  `
}

export function renderStorageState(routeTitle, storage) {
  return `
    ${renderPageHeader({ title: routeTitle, description: 'The app uses this browser for inventory storage.' })}
    ${renderStorageNotice(storage)}
  `
}
