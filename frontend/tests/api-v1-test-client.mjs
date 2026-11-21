import { randomUUID } from 'node:crypto'
import { createInventoryApiClient } from '../src/api/client.js'
import { validateWireCommand } from '../src/api/commands.js'
import { apiEndpoint } from '../src/api/http.js'

// This harness can send only commands with operation IDs minted during this
// test run. It cannot replay operations from a persisted demonstration queue.
export function createLoopbackTestApiClient(options) {
  const endpoint = apiEndpoint(options.baseUrl)
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(endpoint.hostname)) {
    throw new TypeError('Integration fixtures require an HTTP loopback test server.')
  }
  const client = createInventoryApiClient(options)
  const fixtureIds = new Set()
  return {
    health: client.health,
    snapshot: client.snapshot,
    fixtureOperationId() {
      const id = randomUUID()
      fixtureIds.add(id)
      return id
    },
    async syncFixture(command, requestOptions) {
      const body = validateWireCommand(command)
      if (!fixtureIds.has(body.operation_id.toLowerCase())) throw new TypeError('Use a newly generated test operation ID.')
      return client.sync({ ...body, wire_version: 1, fictional: false, upload_eligible: true }, requestOptions)
    },
  }
}
