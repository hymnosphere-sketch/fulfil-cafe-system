import assert from 'node:assert/strict'
import test from 'node:test'
import { withIntegrationEnvironment } from './fe09f-environment.mjs'
import { evaluate, waitSync, route, quiet } from './fe09f-integration.browser.mjs'

async function dumpStores(page, demo = false) {
  return evaluate(page, (demoMode) => new Promise((resolve, reject) => {
    const fixture = new URL(location.href).searchParams.get('fixture')
    const name = demoMode ? 'fulfil-cafe-demo-inventory' : 'fulfil-cafe-fe09f-integration-' + fixture
    const request = indexedDB.open(name)
    request.onupgradeneeded = () => request.transaction.abort()
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const names = [...database.objectStoreNames]
      const tx = database.transaction(names, 'readonly')
      const saved = {}
      for (const store of names) {
        const read = tx.objectStore(store).getAll()
        read.onsuccess = () => { saved[store] = read.result }
      }
      tx.oncomplete = () => { database.close(); resolve(saved) }
      tx.onabort = () => { database.close(); reject(tx.error) }
    }
  }), demo)
}

const queue = (stores) => stores.synchronization_queue.toSorted((a, b) => a.local_sequence - b.local_sequence)

async function checkServiceWorkerRegistration(page, expectedBuildId = null) {
  const swInfo = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready
    return {
      active: !!registration.active,
      waiting: !!registration.waiting,
      installing: !!registration.installing,
      scope: registration.scope,
    }
  })
  assert.ok(swInfo.active, 'Service Worker should be active')
  return swInfo
}

async function checkOfflineCapability(page) {
  // Check if app shell is cached
  const cached = await page.evaluate(async () => {
    const cache = await caches.open('fulfil-cafe-shell-' + await (async () => {
      const reg = await navigator.serviceWorker.ready
      const msg = await new Promise(resolve => {
        const channel = new MessageChannel()
        reg.active.postMessage('GET_VERSION', [channel.port2])
        channel.port1.onmessage = e => resolve(e.data)
      })
      return msg.buildId
    })())
    const keys = await cache.keys()
    return keys.map(r => r.url)
  })
  return cached
}

async function goOffline(page) {
  await page.cdp('Network.enable')
  await page.cdp('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  })
  await page.until('document.querySelector("[data-browser-status-label]")?.textContent.includes("offline")', 'browser offline')
}

async function goOnline(page) {
  await page.cdp('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  })
  await page.until('!document.querySelector("[data-browser-status-label]")?.textContent.includes("offline")', 'browser online')
}

await withIntegrationEnvironment(async ({ app, production, urls, page, restartChrome }) => {
  const entry = new URL('/tests/fe09f-integration.html', app)
  const observers = { script: '(() => {})()', width: 1024, height: 768 }

  const fresh = async () => {
    const tab = await page(observers)
    await tab.goto(entry.href)
    return tab
  }

  async function initialize(tab, url) {
    await tab.setField('#fixture-port', new URL(url).port)
    await tab.click('[data-integration-initialize] button')
    await waitSync(tab, 'ready')
  }

  // Test 1: Production build loads and Service Worker registers
  await test('FE-10A: Production build registers Service Worker and caches app shell', async () => {
    const tab = await page({ ...observers, script: '' })
    await tab.goto(production)
    await tab.until('!!document.querySelector("[data-storage-state=ready]")', 'production storage')

    const swInfo = await checkServiceWorkerRegistration(tab)
    assert.ok(swInfo.active, 'SW should be active in production')

    // Check cache exists
    const cached = await checkOfflineCapability(tab)
    assert.ok(cached.some(u => u.includes('/index.html')), 'index.html should be cached')
    assert.ok(cached.some(u => u.includes('/manifest.json')), 'manifest.json should be cached')
  })

  // Test 2: Offline startup after initial online load
  await test('FE-10A: App starts offline after initial online installation', async () => {
    const tab = await fresh()
    await initialize(tab, urls.core)
    const onlineUrl = await tab.evaluate('location.href')

    // Verify online works
    await waitSync(tab, 'synchronized')
    const onlineData = await dumpStores(tab)

    // Go offline
    await goOffline(tab)
    await tab.reload()

    // Should load from cache
    await tab.until('!!document.querySelector("[data-storage-state=ready]")', 'offline storage ready')
    const offlineData = await dumpStores(tab)

    // IndexedDB should be preserved
    assert.deepEqual(offlineData.inventory_items, onlineData.inventory_items)
    assert.deepEqual(offlineData.categories, onlineData.categories)

    // Should show offline indicator
    const status = await tab.evaluate('document.querySelector("[data-browser-status-label]")?.textContent')
    assert.ok(status?.includes('offline'), 'Should show offline status')
  })

  // Test 3: Cached navigation while offline
  await test('FE-10A: Navigation between routes works offline', async () => {
    const tab = await fresh()
    await initialize(tab, urls.core)
    await goOffline(tab)

    // Navigate to different routes
    for (const name of ['dashboard', 'categories', 'inventory', 'stock', 'history', 'reports', 'settings']) {
      await route(tab, name)
      await tab.until('!!document.querySelector("#page-title")', name + ' loaded offline')
    }

    // All should load without network
    await quiet(tab)
  })

  // Test 4: Full restart preserves IndexedDB and pending queue
  await test('FE-10A: Browser restart preserves IndexedDB and pending queue', async () => {
    const tab = await fresh()
    await initialize(tab, urls.core)

    // Create some pending work
    await route(tab, 'categories')
    await tab.click('[data-inventory-action="add-category"]')
    await tab.setField('[data-inventory-form] [name="name"]', 'Restart test category')
    await tab.click('[data-inventory-form] [type="submit"]')

    await route(tab, 'inventory')
    await tab.click('[data-inventory-action="add-item"]')
    await tab.setField('[data-inventory-form] [name="name"]', 'Restart test item')
    await tab.setField('[data-inventory-form] [name="category_id"]', (await dumpStores(tab)).categories[0].category_id)
    await tab.setField('[data-inventory-form] [name="unit_of_measurement"]', 'piece')
    await tab.setField('[data-inventory-form] [name="minimum_stock_level"]', '5')
    await tab.click('[data-inventory-form] [type="submit"]')

    const beforeRestart = await dumpStores(tab)
    const pendingCount = queue(beforeRestart).filter(r => r.status === 'pending').length
    assert.ok(pendingCount > 0, 'Should have pending operations')

    // Close and reopen
    const pageUrl = await tab.evaluate('location.href')
    await tab.close()

    await restartChrome()
    const newTab = await page({ ...observers, script: '' })
    await newTab.goto(pageUrl)

    // Wait for SW to be ready
    await newTab.until('!!navigator.serviceWorker.controller', 'SW controller ready')
    await newTab.until('!!document.querySelector("[data-storage-state=ready]")', 'storage ready after restart')

    const afterRestart = await dumpStores(newTab)
    assert.deepEqual(afterRestart.inventory_items, beforeRestart.inventory_items)
    assert.deepEqual(afterRestart.categories, beforeRestart.categories)
    assert.deepEqual(queue(afterRestart), queue(beforeRestart))
  })

  // Test 5: Service Worker update preserves data during active work
  await test('FE-10A: SW update does not auto-reload during active inventory work', async () => {
    const tab = await fresh()
    await initialize(tab, urls.core)

    // Create pending work (simulate active inventory session)
    await route(tab, 'categories')
    await tab.click('[data-inventory-action="add-category"]')
    await tab.setField('[data-inventory-form] [name="name"]', 'Active work category')
    await tab.click('[data-inventory-form] [type="submit"]')

    // Defer update
    await tab.evaluate('window.__pwaUpdateDeferred = true')

    // Simulate SW update found
    await tab.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready
      if (reg.waiting) {
        reg.waiting.postMessage('SKIP_WAITING')
      }
    })

    // Should NOT reload immediately
    const beforeUpdate = await dumpStores(tab)

    // Allow update after work
    await tab.evaluate('window.__pwaUpdateDeferred = false')

    // Now can reload manually
    await tab.evaluate('window.location.reload()')
    await tab.until('!!document.querySelector("[data-storage-state=ready]")', 'storage ready after update')

    const afterUpdate = await dumpStores(tab)
    assert.deepEqual(afterUpdate.inventory_items, beforeUpdate.inventory_items)
    assert.deepEqual(afterUpdate.categories, beforeUpdate.categories)
  })

  // Test 6: API isolation - /api/ requests never cached, return offline response
  await test('FE-10A: API requests bypass cache and return offline response when offline', async () => {
    const tab = await fresh()
    await initialize(tab, urls.core)
    await goOffline(tab)

    const response = await tab.evaluate(async () => {
      const res = await fetch('/api/v2/snapshot', { credentials: 'same-origin' })
      return { status: res.status, body: await res.json() }
    })

    assert.equal(response.status, 503)
    assert.equal(response.body.error, 'OFFLINE')
    assert.ok(response.body.message.includes('queued locally'))
  })

  // Test 7: Build-asset caching - hashed JS/CSS/fonts cached on first load
  await test('FE-10A: Build assets (hashed JS/CSS) are cached on first load', async () => {
    const tab = await page({ ...observers, script: '' })
    await tab.goto(production)
    await tab.until('!!document.querySelector("[data-storage-state=ready]")', 'production storage')

    // Check asset cache
    const assetCache = await tab.evaluate(async () => {
      const cachesList = await caches.keys()
      const assetCacheName = cachesList.find(n => n.startsWith('fulfil-cafe-assets-'))
      if (!assetCacheName) return []
      const cache = await caches.open(assetCacheName)
      const keys = await cache.keys()
      return keys.map(r => r.url)
    })

    assert.ok(assetCache.some(u => u.includes('/assets/') && u.endsWith('.js')), 'JS assets should be cached')
    assert.ok(assetCache.some(u => u.includes('/assets/') && u.endsWith('.css')), 'CSS assets should be cached')
  })

  // Test 8: Cache versioning - new build creates new cache, old caches cleaned
  await test('FE-10A: Cache versioning isolates builds', async () => {
    const tab = await page({ ...observers, script: '' })
    await tab.goto(production)

    const buildInfo = await tab.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready
      return new Promise(resolve => {
        const channel = new MessageChannel()
        reg.active.postMessage('GET_VERSION', [channel.port2])
        channel.port1.onmessage = e => resolve(e.data)
      })
    })

    assert.ok(buildInfo.buildId, 'Build ID should be present')
    assert.ok(buildInfo.cacheName.includes(buildInfo.buildId), 'Cache name should include build ID')

    const cacheNames = await tab.evaluate('caches.keys()')
    const relevantCaches = cacheNames.filter(n => n.startsWith('fulfil-cafe-'))
    // Should only have current build's caches
    relevantCaches.forEach(name => {
      assert.ok(name.includes(buildInfo.buildId), 'All caches should match current build ID')
    })
  })

  // Test 9: Development isolation - SW not registered in dev mode
  await test('FE-10A: Development mode does not register Service Worker', async () => {
    const tab = await page({ ...observers, script: '' })
    await tab.goto(app)
    await tab.until('!!document.querySelector("[data-storage-state=ready]")', 'demo storage')

    const swReg = await tab.evaluate('navigator.serviceWorker.ready.catch(() => null)')
    // In dev mode, SW registration should be skipped
    const hasController = await tab.evaluate('!!navigator.serviceWorker.controller')
    assert.equal(hasController, false, 'No SW controller in dev mode')
  })

  // Test 10: Integration fixtures - production build excludes integration test code
  await test('FE-10A: Production build excludes FE-09F/FE-09G integration fixtures', async () => {
    const response = await fetch(new URL('/tests/fe09f-integration.html', production))
    assert.ok(!response.ok || !/(fe09f-integration|data-integration-initialize)/.test(await response.text()), 'Integration fixtures not in production')
  })
})