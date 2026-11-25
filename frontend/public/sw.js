/**
 * Fulfil Cafe PWA Service Worker
 *
 * Provides offline app shell caching while preserving IndexedDB as the
 * authoritative inventory store. Does not cache mutable API responses.
 * Implements safe update lifecycle that preserves local data.
 */

const CACHE_NAME = 'fulfil-cafe-shell-v1';
const STATIC_ASSETS = [
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
      return cache.addAll(STATIC_ASSETS.map((url) => new Request(url, { credentials: 'same-origin' })));
    }).then(() => self.skipWaiting())
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch event - serve cached shell, pass through API requests
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin requests
  if (url.origin !== location.origin) {
    return;
  }

  // API requests - always go to network, do not cache as authoritative
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() => {
        // Return a clear offline response for API calls
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

  // Static assets - serve from cache with network fallback
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(request).then((networkResponse) => {
        // Only cache successful GET responses for static assets
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
        if (request.mode === 'navigate') {
          return caches.match('/index.html');
        }
        // For other resources, return a generic offline response
        return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
      });
    })
  );
});

// Message event - handle skipWaiting for updates
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});