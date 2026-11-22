import { createIntegrationInventoryRepository, integrationFixtureFetch } from '../src/data/integration-inventory-repository.js'
import { mountApplication } from '../src/main.js'
import { drainOrderedV2Queue } from '../src/services/v2-ordered-sync.js'

function startIntegration() {
  const app = document.querySelector('#integration-app')
  const form = app.querySelector('[data-integration-initialize]')
  const message = app.querySelector('[data-integration-message]')
  const button = form.querySelector('button')
  const url = new URL(location.href)
  const portInput = form.elements.port
  const savedPort = url.searchParams.get('port')
  if (savedPort !== null) portInput.value = savedPort

  async function open(fixtureId, allowInitialization) {
    const port = portInput.value.trim()
    button.disabled = true
    portInput.readOnly = true
    message.textContent = allowInitialization ? 'Checking the authoritative Flask snapshot…' : 'Opening saved integration inventory…'
    try {
      const { repository, databaseName, baseUrl } = createIntegrationInventoryRepository({ fixtureId, port, allowInitialization })
      try { await repository.read() } finally { await repository.close() }
      url.searchParams.set('port', port)
      url.searchParams.set('fixture', fixtureId)
      history.replaceState(history.state, '', url)
      mountApplication(app, {
        integration: {
          databaseName,
          createRepository: ({ onConnectionError }) =>
            createIntegrationInventoryRepository({ fixtureId, port, onConnectionError }).repository,
          synchronize: (withQueue) =>
            drainOrderedV2Queue({ withQueue, baseUrl, fetch: integrationFixtureFetch }),
        },
      })
    } catch {
      message.textContent = allowInitialization
        ? 'Initialization failed. Check the disposable Flask port and verify that its snapshot is authoritative.'
        : 'The saved integration inventory could not be opened. Its records have been left in place.'
      button.disabled = false
      portInput.readOnly = false
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (!button.disabled) void open(crypto.randomUUID(), true)
  })
  form.inert = false
  form.closest('main').hidden = false
  const fixtureId = url.searchParams.get('fixture')
  if (fixtureId) void open(fixtureId, false)
}

if (import.meta.env.DEV && ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)) startIntegration()
