// Native Chrome/IndexedDB FE-09C isolation regression.
// Start an isolated Vite server and Chrome CDP profile before running.
// FE09C_APP_URL=http://127.0.0.1:5173/ FE09C_CHROME_URL=http://127.0.0.1:9222
// node tests/fe09c-isolated.browser.mjs
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { connectBrowser } from './browser-cdp.mjs'

const app = process.env.FE09C_APP_URL ?? 'http://127.0.0.1:5173/'
const endpoint = process.env.FE09C_CHROME_URL ?? 'http://127.0.0.1:9222'
const databaseName = 'fulfil-cafe-fe09c-v2-isolated-' + randomUUID()
const browser = await connectBrowser(endpoint)
const context = await browser.context()
const page = await context.page()

function run(expression) {
  return page.evaluate(`(async () => {
    const api = await import('/src/db/v2-isolated-initialization.js')
    const fixtures = await import('/tests/fixtures/api-v2-initialization.mjs')
    const databaseName = ${JSON.stringify(databaseName)}
    ${expression}
  })()`)
}

try {
  await page.goto(app)
  const initial = await run(`
    const source = fixtures.makeVerifiedV2Snapshot()
    const before = await api.readIsolatedV2({ databaseName })
    const installed = await api.initializeIsolatedV2({
      consent: api.FE09C_TEST_CONSENT, databaseName,
      client: { snapshot: async () => ({
        data: source, installable: true,
        generation: source.server_generation_id,
        settingsVersion: source.settings.settings_version,
      }) },
    })
    const after = await api.readIsolatedV2({ databaseName })
    return {
      beforeNull: before === null, installed,
      after: {
        itemBalance: after.snapshot.inventory_items[0].available_quantity,
        sequence: after.snapshot.stock_movements.map((m) => m.commit_seq),
        activeSlot: after.slot,
      },
    }
  `)
  assert.equal(initial.beforeNull, true)
  assert.equal(initial.installed.itemCount, 1)
  assert.equal(initial.installed.movementCount, 2)
  assert.equal(initial.after.itemBalance, 15)
  assert.deepEqual(initial.after.sequence, [3, 4])
  assert.equal(initial.installed.slot, initial.after.activeSlot)

  await page.reload()
  const persisted = await run(`
    const current = await api.readIsolatedV2({ databaseName })
    return { present: !!current, slot: current?.slot,
      balance: current?.snapshot.inventory_items[0].available_quantity,
      movements: current?.snapshot.stock_movements.length }
  `)
  assert.equal(persisted.present, true)
  assert.equal(persisted.slot, initial.installed.slot)
  assert.equal(persisted.balance, 15)
  assert.equal(persisted.movements, 2)

  const provisional = await run(`
    const source = fixtures.makeProvisionalV2Snapshot()
    const previous = await api.readIsolatedV2({ databaseName })
    let failure = null
    try {
      await api.initializeIsolatedV2({
        consent: api.FE09C_TEST_CONSENT, databaseName,
        client: { snapshot: async () => ({
          data: source, installable: false,
          generation: source.server_generation_id,
          settingsVersion: source.settings.settings_version,
        }) },
      })
    } catch (error) { failure = error.code ?? error.name }
    const current = await api.readIsolatedV2({ databaseName })
    return { failure, unchanged: previous.slot === current.slot }
  `)
  assert.equal(provisional.failure, 'SNAPSHOT_NOT_AUTHORITATIVE')
  assert.equal(provisional.unchanged, true)

  const aborted = await run(`
    const originalAdd = IDBObjectStore.prototype.add
    let aborted = false
    IDBObjectStore.prototype.add = function (...args) {
      const request = originalAdd.apply(this, args)
      if (this.name === 'stock_batches' && !aborted) {
        aborted = true
        const tx = this.transaction
        request.addEventListener('success', () => tx.abort(), { once: true })
      }
      return request
    }
    const prior = await api.readIsolatedV2({ databaseName })
    const source = fixtures.makeVerifiedV2Snapshot()
    let failure = null
    try {
      await api.initializeIsolatedV2({
        consent: api.FE09C_TEST_CONSENT, databaseName,
        client: { snapshot: async () => ({
          data: source, installable: true,
          generation: source.server_generation_id,
          settingsVersion: source.settings.settings_version,
        }) },
      })
    } catch (error) { failure = error.code ?? error.name }
    finally { IDBObjectStore.prototype.add = originalAdd }
    const current = await api.readIsolatedV2({ databaseName })
    return { aborted, failure, unchanged: prior.slot === current.slot,
      balance: current.snapshot.inventory_items[0].available_quantity }
  `)
  assert.equal(aborted.aborted, true)
  assert.ok(aborted.failure, 'aborted staging must reject initialization')
  assert.equal(aborted.unchanged, true)
  assert.equal(aborted.balance, 15)

  const empty = await run(`
    const source = fixtures.makeEmptyVerifiedV2Snapshot()
    const installed = await api.initializeIsolatedV2({
      consent: api.FE09C_TEST_CONSENT, databaseName,
      client: { snapshot: async () => ({
        data: source, installable: true,
        generation: source.server_generation_id,
        settingsVersion: source.settings.settings_version,
      }) },
    })
    const current = await api.readIsolatedV2({ databaseName })
    return { slot: current.slot, installed: installed.slot,
      empty: current.snapshot.inventory_items.length === 0 &&
        current.snapshot.stock_movements.length === 0 }
  `)
  assert.equal(empty.slot, empty.installed)
  assert.equal(empty.empty, true)

  assert.deepEqual(page.exceptions, [])
  assert.deepEqual(page.consoleErrors, [])
  console.log('FE-09C isolated native IndexedDB: initial install, reload, provisional guard, abort rollback and empty snapshot PASSED')
} finally {
  await page.close()
  await context.dispose()
  browser.close()
}
