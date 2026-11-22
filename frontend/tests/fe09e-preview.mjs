import 'bootstrap/dist/css/bootstrap.min.css'
import '@fontsource/inter/latin-400.css'
import '@fontsource/inter/latin-500.css'
import '@fontsource/inter/latin-600.css'
import '@fontsource/inter/latin-700.css'
import '../src/styles/tokens.css'
import '../src/styles/base.css'
import '../src/styles/components.css'
import '../src/styles/layout.css'

import { CalendarClock, CircleAlert, CircleCheck, Clock, Info, RefreshCw, TriangleAlert, createIcons } from 'lucide'
import { renderSyncBadge, renderSyncPanel, renderSyncSummary } from '../src/components/sync-status.js'
import { FE09D_TEST_CONSENT, prepareIsolatedV2Queue, readIsolatedV2Queue } from '../src/db/v2-sync-queue.js'
import { createSyncStatusRefresh, deriveSyncStatus } from '../src/services/sync-status.js'
import { drainIsolatedV2Queue } from '../src/services/v2-ordered-sync.js'
import { makeEmptyVerifiedV2Snapshot } from './fixtures/api-v2-initialization.mjs'
import { at, id, queueCommands } from './fixtures/api-v2-queue.mjs'

const prefix = 'fulfil-cafe-fe09d-queue-status-'
const generation = id(99)
const settingsVersion = 1
const { category, item } = queueCommands()

function readPreviewQueue(databaseName) {
  return readIsolatedV2Queue({
    consent: FE09D_TEST_CONSENT, databaseName,
    indexedDB: {
      open(name, version) {
        const request = globalThis.indexedDB.open(name, version)
        // A status read must not create an IndexedDB database or change its schema.
        request.addEventListener('upgradeneeded', (event) => {
          event.stopImmediatePropagation()
          request.transaction.abort()
        }, { once: true })
        return request
      },
    },
  })
}

const replies = {
  retry: [503, 'SYNC_FAILED', '30'],
  temporary: [503, 'SYNC_FAILED', '0'],
  rejected: [409, 'DUPLICATE_ITEM'],
  recovery: [409, 'RECOVERY_REQUIRED'],
}

// Only this disposable browser fixture supplies a transport. It never calls Fetch.
function fixtureTransport(outcome) {
  return async (url, request) => {
    const headers = new Headers({ 'Content-Type': 'application/json', 'X-Inventory-Generation': generation,
      'X-Inventory-Settings-Version': String(settingsVersion) })
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers })
    if (url.pathname === '/api/v2/snapshot' && request.method === 'GET') {
      const data = makeEmptyVerifiedV2Snapshot()
      data.server_generation_id = generation
      return json({ success: true, data })
    }
    if (url.pathname !== '/api/v2/sync' || request.method !== 'POST') throw new Error('Unexpected fixture request.')
    const command = JSON.parse(request.body)
    const isItem = command.operation_id === item.operation_id
    if (!isItem && command.operation_id !== category.operation_id) throw new Error('Unexpected fixture operation.')
    if (isItem && outcome !== 'accepted') {
      const [status, code, retry] = replies[outcome]
      if (retry) headers.set('Retry-After', retry)
      const details = code === 'DUPLICATE_ITEM' ? { operation_id: command.operation_id, outcome: 'rejected' } : {}
      return json({ success: false, error: { code, message: 'Fictional response', details } }, status)
    }
    const fields = isItem ? { available_quantity: 0, stock_status: 'out_of_stock' } : { description: null }
    return json({ success: true, data: {
      operation_id: command.operation_id, outcome: 'accepted', processed_at: at,
      commit_seq: isItem ? 2 : 1, replay_status: 'verified',
      result: { ...command.payload, ...fields, normalized_name: command.payload.name.toLowerCase(),
        created_at: command.created_at, updated_at: command.created_at, is_active: true },
    } })
  }
}

function startPreview() {
  const root = document.querySelector('#sync-preview')
  const form = root.querySelector('[data-preview-form]')
  const input = form.elements.queue
  const create = form.querySelector('[data-create-fixture]')
  const run = form.querySelector('[data-run-fixture]')
  const outcome = form.querySelector('#fixture-outcome')
  const badge = root.querySelector('[data-preview-badge]')
  const connectivity = root.querySelector('[data-preview-connectivity]')
  const summary = root.querySelector('[data-preview-summary]')
  const panel = root.querySelector('[data-preview-panel]')
  const announcement = root.querySelector('[data-preview-announcement]')
  let queueName = new URL(location.href).searchParams.get('queue') ?? ''
  let state = {}
  let result
  let active = false
  let preparing = false
  let lastMarkup

  function render() {
    const model = deriveSyncStatus({ configured: Boolean(queueName), ...state, active, result })
    const nextMarkup = JSON.stringify(model)
    if (nextMarkup !== lastMarkup) {
      badge.innerHTML = renderSyncBadge(model)
      summary.innerHTML = renderSyncSummary(model)
      panel.innerHTML = renderSyncPanel(model)
      createIcons({ root, icons: { CalendarClock, CircleAlert, CircleCheck, Clock, Info, RefreshCw, TriangleAlert } })
      lastMarkup = nextMarkup
    }
    const online = navigator.onLine
    connectivity.textContent = online ? 'Browser online' : 'Browser offline'
    connectivity.classList.toggle('cafe-tone--success', online)
    connectivity.classList.toggle('cafe-tone--warning', !online)
    if (model.state !== 'loading' && announcement.textContent !== model.label) announcement.textContent = model.label
    input.readOnly = active || preparing
    create.disabled = active || preparing
    run.disabled = active || preparing || state.loading || !queueName.startsWith(prefix) ||
      state.queue?.generation !== generation || !model.counts?.pending ||
      ['needs_review', 'recovery_required', 'retry_delayed'].includes(model.state)
  }

  const refresh = createSyncStatusRefresh((name) => name ? readPreviewQueue(name) : null, (value) => {
    state = value
    render()
  })

  function showQueue(name) {
    queueName = name.trim()
    input.value = queueName
    const url = new URL(location.href)
    if (queueName) url.searchParams.set('queue', queueName)
    else url.searchParams.delete('queue')
    history.replaceState(null, '', url)
    result = undefined
    return refresh(queueName)
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (!active && !preparing) void showQueue(input.value)
  })
  create.addEventListener('click', async () => {
    const name = prefix + crypto.randomUUID()
    preparing = true
    render()
    try {
      await prepareIsolatedV2Queue({ consent: FE09D_TEST_CONSENT, databaseName: name,
        generation, settingsVersion, commands: [category, item] })
      await showQueue(name)
    } catch {
      await showQueue(name)
    } finally {
      preparing = false
      render()
    }
  })
  run.addEventListener('click', async () => {
    const name = queueName
    active = true
    result = undefined
    render()
    try {
      result = await drainIsolatedV2Queue({ consent: FE09D_TEST_CONSENT, databaseName: name,
        baseUrl: 'http://127.0.0.1:1', fetch: fixtureTransport(outcome.value) })
    } catch {
      result = { status: 'storage_failure' }
    } finally {
      active = false
      await refresh(name)
    }
  })
  for (const event of ['online', 'offline']) window.addEventListener(event, render)
  root.hidden = false
  root.classList.add('d-grid')
  void showQueue(queueName)
}

if (import.meta.env.DEV) startPreview()
