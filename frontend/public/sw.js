/**
 * Fulfil Cafe PWA Service Worker
 *
 * Provides offline app shell caching while preserving IndexedDB as the
 * authoritative inventory store. Does not cache mutable API responses.
 * Implements safe update lifecycle that preserves local data.
 * Caches are versioned by build via BUILD_ID injected at build time.
 */

const BUILD_ID = '__BUILD_ID__';
const CACHE_NAME = `fulfil-cafe-shell-${BUILD_ID}`;
const ASSET_CACHE_NAME = `fulfil-cafe-assets-${BUILD_ID}`;

// Static app shell - precached on install
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.svg',
  '/icons/manifest-icon-192.svg',
  '/icons/manifest-icon-512.svg',
];

// Install event - cache the application shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL.map((url) => new Request(url, { credentials: 'same-origin' })));
    }).then(() => self.skipWaiting())
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME && name !== ASSET_CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// Helper: check if request is for a build asset (hashed filename)
function isBuildAsset(url) {
  const pathname = url.pathname;
  return (
    pathname.startsWith('/assets/') &&
    (pathname.endsWith('.js') || pathname.endsWith('.css') || pathname.endsWith('.woff2') || pathname.endsWith('.png') || pathname.endsWith('.svg'))
  );
}

// Helper: check if request is an API call
function isApiRequest(url) {
  return url.pathname.startsWith('/api/');
}

// Helper: check if request is a navigation
function isNavigation(request) {
  return request.mode === 'navigate';
}

// Fetch event - serve cached shell, pass through API requests
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin requests
  if (url.origin !== location.origin) {
    return;
  }

  // API requests - always go to network, do not cache as authoritative
  if (isApiRequest(url)) {
    event.respondWith(
      fetch(request).catch(() => {
        return new Response(
          JSON.stringify({
            error: 'OFFLINE',
            message: 'Network unavailable. This operation will be queued locally.',
          }),
          {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      })
    );
    return;
  }

  // Build assets (hashed) - cache-first, long-lived
  if (isBuildAsset(url)) {
    event.respondWith(
      caches.match(request, { cacheName: ASSET_CACHE_NAME }).then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(request).then((networkResponse) => {
          if (request.method === 'GET' && networkResponse.ok) {
            const responseClone = networkResponse.clone();
            caches.open(ASSET_CACHE_NAME).then((cache) => {
              cache.put(request, responseClone);
            });
          }
          return networkResponse;
        });
      })
    );
    return;
  }

  // App shell and other static assets - stale-while-revalidate
  event.respondWith(
    caches.match(request, { cacheName: CACHE_NAME }).then((cachedResponse) => {
      const networkFetch = fetch(request).then((networkResponse) => {
        if (
          request.method === 'GET' &&
          networkResponse.ok &&
          (url.pathname.endsWith('.js') ||
            url.pathname.endsWith('.css') ||
            url.pathname.endsWith('.html') ||
            url.pathname.endsWith('.svg') ||
            url.pathname.endsWith('.png') ||
            url.pathname.endsWith('.ico') ||
            url.pathname.endsWith('.json') ||
            url.pathname.endsWith('.woff2') ||
            url.pathname === '/' ||
            url.pathname === '/index.html')
        ) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseClone);
          });
        }
        return networkResponse;
      }).catch(() => {
        // Offline fallback for navigation requests
        if (isNavigation(request)) {
          return caches.match('/index.html', { cacheName: CACHE_NAME });
        }
        return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
      });

      // Return cached immediately if available, otherwise wait for network
      return cachedResponse || networkFetch;
    })
  );
});

// Message event - handle skipWaiting for updates, and status queries
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (event.data === 'GET_VERSION') {
    event.ports[0].postMessage({ buildId: BUILD_ID, cacheName: CACHE_NAME });
  }
});