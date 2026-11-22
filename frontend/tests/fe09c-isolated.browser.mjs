// Native IndexedDB regressions in a fresh Chrome profile on a disposable Vite origin.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { connectBrowser } from './browser-cdp.mjs'

const app = process.env.FE09C_APP_URL ?? 'http://127.0.0.1:5173/'
const endpoint = process.env.FE09C_CHROME_URL ?? 'http://127.0.0.1:9222'
const evidence = process.env.FE09C_RESTART_EVIDENCE
const reopening = process.argv.includes('--verify-restart')
assert.ok(!reopening || evidence, 'Restart verification requires a temporary evidence path')
const saved = reopening ? JSON.parse(await readFile(evidence, 'utf8')) : null
const databaseName = saved?.databaseName ?? 'fulfil-cafe-fe09c-v2-isolated-' + randomUUID()
const browser = await connectBrowser(endpoint)
const context = await browser.context({ persistent: Boolean(evidence) })
const page = await context.page()

function run(experiment, ...args) {
  return page.evaluate('(' + async function (databaseName, source, args) {
    const api = await import('/src/db/v2-isolated-initialization.js')
    const fixtures = await import('/tests/fixtures/api-v2-initialization.mjs')
    const response = (data) => ({ data, generation: data.server_generation_id,
      settingsVersion: data.settings.settings_version, installable: data.replay.status === 'authoritative' })
    const install = (source, options = {}) => api.initializeIsolatedV2({
      consent: api.FE09C_TEST_CONSENT, databaseName,
      client: { snapshot: typeof source === 'function' ? source : async () => response(source) },
      ...options,
    })
    const active = async (name = databaseName) => {
      const current = await api.readIsolatedV2({ databaseName: name })
      if (!current) return null
      return { slot: current.slot, generation: current.snapshot.server_generation_id,
        balance: current.snapshot.inventory_items[0]?.available_quantity ?? null,
        batches: current.snapshot.stock_batches.map(({ remaining_quantity }) => remaining_quantity),
        sequences: current.snapshot.stock_movements.map(({ commit_seq }) => commit_seq) }
    }
    const failure = async (work) => {
      try { await work(); return null } catch (error) { return error.code ?? error.name }
    }
    const countSlotRows = async (slot) => {
      const req = indexedDB.open(databaseName)
      const result = (request) => new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const db = await result(req)
      try {
        const names = Array.from(db.objectStoreNames).filter((name) => name !== 'control')
        const tx = db.transaction(names)
        const counts = await Promise.all(names.map((name) => {
          const store = tx.objectStore(name)
          return result(name === 'manifests' ? store.count(slot) : store.index('by_slot').count(slot))
        }))
        return counts.reduce((sum, count) => sum + count, 0)
      } finally { db.close() }
    }
    return await (0, eval)('(' + source + ')')({ fixtures, install, active, failure, response, countSlotRows, databaseName }, ...args)
  } + ')(' + [databaseName, experiment.toString(), args].map(JSON.stringify).join(',') + ')')
}

try {
  await page.goto(app)
  if (reopening) {
    await test('the newer balance survives a full Chrome process restart', async () => {
      assert.equal(app, saved.app)
      assert.deepEqual(await run(({ active }) => active()), saved.active)
    })
    await test('the previously active snapshot survives rejected staging and a full Chrome restart', async () => {
      assert.ok(saved.rejected, 'Staged corruption regression must record restart evidence')
      assert.deepEqual(await run(({ active }, name) => active(name), saved.rejected.name), saved.rejected.active)
    })
  } else {
    let original
    let rejected
    await test('authoritative empty and stocked snapshots install in separate disposable namespaces', async () => {
      const result = await run(async ({ fixtures, install, active, databaseName }) => {
        const emptyName = databaseName + '-empty'
        const empty = await install(fixtures.makeEmptyVerifiedV2Snapshot(), { databaseName: emptyName })
        const before = await active()
        const installed = await install(fixtures.makeVerifiedV2Snapshot())
        return { empty, before, installed, after: await active() }
      })
      assert.equal(result.empty.itemCount, 0)
      assert.equal(result.empty.movementCount, 0)
      assert.equal(result.before, null)
      assert.equal(result.installed.itemCount, 1)
      assert.equal(result.installed.movementCount, 2)
      assert.equal(result.after.slot, result.installed.slot)
      assert.equal(result.after.balance, 15)
      assert.deepEqual(result.after.sequences, [3, 4])
      original = result.after
      await page.reload()
      assert.deepEqual(await run(({ active }) => active()), original)
    })

    await test('duplicate initialization is a no-op and equal-commit differences are refused', async () => {
      const result = await run(async ({ fixtures, install, active, failure }) => {
        const value = fixtures.makeVerifiedV2Snapshot()
        value.snapshot_at = '2026-11-18T06:00:00Z'
        const sameSlot = await install(value, { createSlot: () => { throw new Error('Must not stage') } })
        value.inventory_items[0].name = 'Changed content'
        value.inventory_items[0].normalized_name = 'changed content'
        return { sameSlot: sameSlot.slot, failure: await failure(() => install(value)), active: await active() }
      })
      assert.deepEqual(result, { sameSlot: original.slot, failure: 'SNAPSHOT_CONFLICT', active: original })
    })

    await test('provisional and cross-generation snapshots preserve the active slot', async () => {
      const result = await run(async ({ fixtures, install, active, failure }) => {
        const provisional = await failure(() => install(fixtures.makeProvisionalV2Snapshot()))
        const empty = fixtures.makeEmptyVerifiedV2Snapshot()
        empty.server_generation_id = fixtures.fixtureId(88)
        return { provisional, generation: await failure(() => install(empty)), active: await active() }
      })
      assert.deepEqual(result, { provisional: 'SNAPSHOT_NOT_AUTHORITATIVE', generation: 'GENERATION_MISMATCH', active: original })
    })

    await test('impossible authoritative commits and contradictory head receipts fail in Chrome', async () => {
      const result = await run(async ({ fixtures, install, active, failure }) => {
        const { validateV2Snapshot } = await import('/src/api/v2-snapshot.js')
        const impossible = fixtures.makeVerifiedV2Snapshot()
        impossible.stock_movements[0].commit_seq = 1
        impossible.stock_movements[1].commit_seq = 2
        impossible.sync.last_commit_seq = impossible.migration.verified_receipt_count = 2
        const other = fixtures.fixtureId(42)
        const contradictory = fixtures.checkedReceipt(fixtures.makeVerifiedV2Snapshot(), other)
        return { impossible: await failure(() => install(impossible)),
          receipt: await failure(() => validateV2Snapshot(contradictory, [other])), active: await active() }
      })
      assert.deepEqual(result, { impossible: 'INVALID_PROTOCOL_RESPONSE',
        receipt: 'INVALID_PROTOCOL_RESPONSE', active: original })
    })

    await test('synchronous staging failure and native abort roll back every row and allow a retry', async () => {
      const result = await run(async ({ fixtures, install, active, failure, countSlotRows }) => {
        const add = IDBObjectStore.prototype.add
        const snapshot = fixtures.makeExtendedVerifiedV2Snapshot(6)
        const slot = 'verification-rollback-slot'
        const createSlot = () => slot
        async function simulate(mock) {
          IDBObjectStore.prototype.add = mock
          let code
          try { code = await failure(() => install(snapshot, { createSlot })) }
          finally { IDBObjectStore.prototype.add = add }
          return { code, rows: await countSlotRows(slot), active: await active() }
        }
        const synchronous = await simulate(function (...args) {
          if (this.name === 'stock_batches') throw new DOMException('Fixture', 'DataCloneError')
          return add.apply(this, args)
        })
        const aborted = await simulate(function (...args) {
          const request = add.apply(this, args)
          if (this.name === 'stock_batches' && args[0].position === 0) {
            request.addEventListener('success', () => this.transaction.abort(), { once: true })
          }
          return request
        })
        const retry = await install(snapshot, { createSlot })
        return { synchronous, aborted, retry: retry.slot, repaired: await active() }
      })
      assert.deepEqual(result.synchronous, { code: 'DB_INVALID_RECORD', rows: 0, active: original })
      assert.deepEqual(result.aborted, { code: 'DB_TRANSACTION_ABORTED', rows: 0, active: original })
      assert.equal(result.retry, 'verification-rollback-slot')
      assert.equal(result.repaired.balance, 23)
      assert.deepEqual(result.repaired.batches, [15, 8])
      original = result.repaired
    })

    await test('content and generation corruption during staging fail closed', async () => {
      const result = await run(async ({ fixtures, install, active, failure }) => {
        const add = IDBObjectStore.prototype.add
        const snapshot = fixtures.makeExtendedVerifiedV2Snapshot()
        async function simulate(mutator) {
          IDBObjectStore.prototype.add = function (row, ...args) {
            return add.call(this, mutator(this.name, row), ...args)
          }
          try { return await failure(() => install(snapshot)) }
          finally { IDBObjectStore.prototype.add = add }
        }
        const generation = await simulate((name, row) => name === 'application_settings' && row.key === 'server_generation_id'
          ? { ...row, value: fixtures.fixtureId(89) } : row)
        const content = await simulate((name, row) => name === 'inventory_items' ? { ...row, available_quantity: 999 } : row)
        return { generation, content, active: await active() }
      })
      assert.deepEqual(result, { generation: 'STAGING_MISMATCH', content: 'STAGING_MISMATCH', active: original })
    })

    await test('staged data must preserve types, nested settings and complete collection records', async () => {
      const result = await run(async ({ fixtures, install, active, failure, databaseName }) => {
        const name = databaseName + '-staging-integrity'
        await install(fixtures.makeVerifiedV2Snapshot(), { databaseName: name })
        const before = await active(name)
        const add = IDBObjectStore.prototype.add
        const snapshot = fixtures.makeExtendedVerifiedV2Snapshot()
        const inject = async (mutate) => {
          IDBObjectStore.prototype.add = function (row, ...args) {
            const changed = mutate(this.name, row)
            if (changed) return add.call(this, changed, ...args)
          }
          try {
            const code = await failure(() => install(snapshot, { databaseName: name }))
            return { code, active: await active(name) }
          } finally { IDBObjectStore.prototype.add = add }
        }
        const settings = (store, row) => store === 'application_settings' && row.key === 'settings'
        const nan = await inject((store, row) => settings(store, row)
          ? { ...row, value: { ...row.value, expiration_warning_days: NaN } } : row)
        const infinity = await inject((store, row) => settings(store, row)
          ? { ...row, value: { ...row.value, settings_version: Infinity } } : row)
        const invalidSetting = await inject((store, row) => {
          if (settings(store, row)) row.value.business_timezone = { invalid: true }
          return row
        })
        const changedRecord = await inject((store, row) => store === 'stock_movements' && row.position === 0
          ? { ...row, reason: 'Changed fictional reason' } : row)
        const missingRecord = await inject((store, row) => store === 'inventory_items' ? null : row)
        return { name, before, nan, infinity, invalidSetting, changedRecord, missingRecord }
      })
      assert.equal(result.before.balance, 15)
      for (const key of ['nan', 'infinity', 'invalidSetting', 'changedRecord', 'missingRecord']) {
        assert.deepEqual(result[key], { code: 'STAGING_MISMATCH', active: result.before }, key)
      }
      rejected = { name: result.name, active: result.before }
    })

    await test('aborted active and staged reads each surface one failure and preserve active data', async () => {
      const result = await run(async ({ fixtures, install, active, failure }) => {
        const getAll = IDBIndex.prototype.getAll
        async function abortRead(mode, work) {
          IDBIndex.prototype.getAll = function (...args) {
            const request = getAll.apply(this, args)
            if (this.objectStore.name === 'categories' && this.objectStore.transaction.mode === mode) {
              request.addEventListener('success', () => this.objectStore.transaction.abort(), { once: true })
            }
            return request
          }
          try { return await failure(work) } finally { IDBIndex.prototype.getAll = getAll }
        }
        const activeError = await abortRead('readonly', active)
        const stagedError = await abortRead('readwrite', () => install(fixtures.makeExtendedVerifiedV2Snapshot()))
        return { activeError, stagedError, active: await active() }
      })
      assert.deepEqual(result, { activeError: 'DB_TRANSACTION_ABORTED', stagedError: 'DB_TRANSACTION_ABORTED', active: original })
      await page.evaluate('new Promise(resolve => setTimeout(resolve, 50))')
      assert.deepEqual(page.exceptions, [])
    })

    await test('cancellation just before activation preserves the active slot', async () => {
      const result = await run(async ({ fixtures, install, active, failure }) => {
        const controller = new AbortController()
        const get = IDBObjectStore.prototype.get
        IDBObjectStore.prototype.get = function (...args) {
          const request = get.apply(this, args)
          if (this.name === 'manifests' && this.transaction.mode === 'readwrite') {
            request.addEventListener('success', () => controller.abort(), { once: true })
          }
          return request
        }
        let code
        try { code = await failure(() => install(fixtures.makeExtendedVerifiedV2Snapshot(), { signal: controller.signal })) }
        finally { IDBObjectStore.prototype.get = get }
        return { code, active: await active() }
      })
      assert.deepEqual(result, { code: 'CANCELLED', active: original })
    })

    await test('pre-aborted initialization and cancellation while the snapshot is fetching preserve inventory', async () => {
      const result = await run(async ({ fixtures, install, active, failure }) => {
        const { createIsolatedV2Client } = await import('/src/api/v2-client.js')
        const cancelled = new AbortController()
        cancelled.abort()
        let fetched = false
        const before = await failure(() => install(() => { fetched = true }, { signal: cancelled.signal }))
        const fetching = new AbortController()
        const started = Promise.withResolvers()
        const client = createIsolatedV2Client({
          baseUrl: 'http://127.0.0.1:5000',
          fetch: async (_url, { signal }) => {
            started.resolve()
            await new Promise((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(signal.reason), { once: true })
            })
          },
        })
        const pending = install(fixtures.makeExtendedVerifiedV2Snapshot(), { client, signal: fetching.signal })
          .then(() => null, (error) => error.kind)
        await started.promise
        fetching.abort()
        return { before, fetched, during: await pending, active: await active() }
      })
      assert.deepEqual(result, { before: 'CANCELLED', fetched: false, during: 'cancelled', active: original })
    })

    await test('cancellation after the pointer write rolls back until commit, and preserves an already committed result', async () => {
      const result = await run(async ({ fixtures, install, active, failure, databaseName }) => {
        const name = databaseName + '-activation-cancel'
        const first = await install(fixtures.makeVerifiedV2Snapshot(), { databaseName: name })
        const put = IDBObjectStore.prototype.put
        async function cancelAt(committed) {
          const controller = new AbortController()
          const { signal } = controller
          let removed = 0
          signal.removeEventListener = function (...args) {
            if (args[0] === 'abort') removed++
            return AbortSignal.prototype.removeEventListener.apply(this, args)
          }
          const events = []
          IDBObjectStore.prototype.put = function (...args) {
            const request = put.apply(this, args)
            if (this.name === 'control') {
              const tx = this.transaction
              tx.addEventListener('abort', () => events.push('abort'), { once: true })
              tx.addEventListener('complete', () => {
                events.push('complete')
                if (committed) controller.abort()
              }, { once: true })
              request.addEventListener('success', () => {
                events.push('write')
                if (!committed) controller.abort()
              }, { once: true })
            }
            return request
          }
          let code
          try {
            code = await failure(() => install(fixtures.makeExtendedVerifiedV2Snapshot(), { databaseName: name, signal }))
          } finally { IDBObjectStore.prototype.put = put }
          return { code, events, removed, active: await active(name) }
        }
        return { original: first.slot, aborted: await cancelAt(false), committed: await cancelAt(true) }
      })
      assert.equal(result.aborted.code, 'CANCELLED')
      assert.deepEqual(result.aborted.events, ['write', 'abort'])
      assert.equal(result.aborted.active.slot, result.original)
      assert.equal(result.aborted.active.balance, 15)
      assert.equal(result.aborted.removed, 1)
      assert.equal(result.committed.code, null)
      assert.deepEqual(result.committed.events, ['write', 'complete'])
      assert.notEqual(result.committed.active.slot, result.original)
      assert.equal(result.committed.active.balance, 13)
      assert.equal(result.committed.removed, 1)
    })

    await test('overlapping requests and a later stale retry cannot roll back stock', async () => {
      const result = await run(async ({ fixtures, install, active, failure, response }) => {
        const older = fixtures.makeExtendedVerifiedV2Snapshot(6)
        const started = Promise.withResolvers()
        const delayed = Promise.withResolvers()
        const pending = failure(() => install(() => { started.resolve(); return delayed.promise }))
        await started.promise
        const latest = await install(fixtures.makeExtendedVerifiedV2Snapshot())
        delayed.resolve(response(older))
        const concurrent = await pending
        const stale = await failure(() => install(older))
        return { concurrent, stale, latest: latest.slot, active: await active() }
      })
      assert.equal(result.concurrent, 'CONCURRENT_INITIALIZATION')
      assert.equal(result.stale, 'STALE_SNAPSHOT')
      assert.equal(result.active.slot, result.latest)
      assert.equal(result.active.balance, 13)
      assert.deepEqual(result.active.batches, [9, 4])
      assert.deepEqual(result.active.sequences, [3, 4, 6, 7])
      await page.reload()
      assert.deepEqual(await run(({ active }) => active()), result.active)
      if (evidence) await writeFile(evidence, JSON.stringify({ app, databaseName, active: result.active, rejected }))
    })
  }
  assert.deepEqual(page.exceptions, [])
  assert.deepEqual(page.consoleErrors, [])
} finally {
  await page.close()
  await context.dispose()
  browser.close()
}
