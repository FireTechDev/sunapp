const SW_VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const STATIC_CACHE = `sunapp-static-${SW_VERSION}`;
const RUNTIME_CACHE = `sunapp-runtime-${SW_VERSION}`;
const API_CACHE = `sunapp-api-${SW_VERSION}`;
const CACHE_PREFIX = 'sunapp-';

const PRECACHE_URLS = [
  './',
  './index.html',
  './offline.html',
  './manifest.webmanifest',
  './version.json',
  './places.js',
  './places.json',
  './public/icons/icon-192.svg',
  './public/icons/icon-512.svg',
  './public/icons/icon-maskable.svg',
];

const API_HOSTS = new Set([
  'api.open-meteo.com',
  'api-adresse.data.gouv.fr',
  'fr.wikipedia.org',
  'nominatim.openstreetmap.org',
]);

function isSupportedProtocol(url) {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

function isCacheableResponse(response) {
  return !!response && (response.status === 200 || response.type === 'opaque');
}

function shouldBypassCaching(url) {
  return /\.tile\.openstreetmap\.org$/i.test(url.hostname);
}

async function safeCachePut(cache, request, response) {
  try {
    const reqUrl = new URL(request.url);
    if (!isSupportedProtocol(reqUrl)) return;
    await cache.put(request, response);
  } catch (_) {
    // Ignore cache write failures (e.g., extension scheme requests, quota limits)
  }
}

async function fetchWithTimeout(request, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(request, { signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then(async (response) => {
      if (isCacheableResponse(response)) {
        await safeCachePut(cache, request, response.clone());
      }
      return response;
    })
    .catch(() => null);
  if (cached) return cached;
  const networkResponse = await networkPromise;
  if (networkResponse) return networkResponse;
  throw new Error('Network unavailable');
}

async function networkFirst(request, cacheName, timeoutMs = 9000) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetchWithTimeout(request, timeoutMs);
    if (isCacheableResponse(response)) {
      await safeCachePut(cache, request, response.clone());
    }
    return response;
  } catch (_) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw new Error('Network unavailable');
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE_URLS))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter((name) => name.startsWith(CACHE_PREFIX) && ![STATIC_CACHE, RUNTIME_CACHE, API_CACHE].includes(name))
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      clients.forEach((client) => client.postMessage({ type: 'SUNAPP_SW_OFFLINE_READY', version: SW_VERSION }));
    })()
  );
});

self.addEventListener('message', (event) => {
  const type = event?.data?.type;
  if (type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (type === 'CHECK_FOR_UPDATE') {
    self.registration.update().catch(() => {});
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (!isSupportedProtocol(url)) return;
  if (shouldBypassCaching(url)) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetchWithTimeout(request, 9000);
          if (isCacheableResponse(response)) {
            const runtimeCache = await caches.open(RUNTIME_CACHE);
            await safeCachePut(runtimeCache, request, response.clone());
          }
          return response;
        } catch (_) {
          const runtimeCache = await caches.open(RUNTIME_CACHE);
          const pageFromRuntime = await runtimeCache.match(request);
          if (pageFromRuntime) return pageFromRuntime;
          const staticCache = await caches.open(STATIC_CACHE);
          const shell = await staticCache.match('./index.html');
          if (shell) return shell;
          const offline = await staticCache.match('./offline.html');
          if (offline) return offline;
          return new Response('Offline', { status: 503, statusText: 'Offline' });
        }
      })()
    );
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(
      staleWhileRevalidate(request, RUNTIME_CACHE).catch(async () => {
        const cache = await caches.open(STATIC_CACHE);
        const fallback = await cache.match(request);
        if (fallback) return fallback;
        return new Response('', { status: 504, statusText: 'Gateway Timeout' });
      })
    );
    return;
  }

  if (API_HOSTS.has(url.hostname)) {
    const apiTimeoutMs = url.hostname === 'api.open-meteo.com' ? 22000 : 15000;
    event.respondWith(
      networkFirst(request, API_CACHE, apiTimeoutMs).catch(() => new Response('', { status: 504, statusText: 'Gateway Timeout' }))
    );
    return;
  }

  if (['script', 'style', 'image', 'font'].includes(request.destination)) {
    event.respondWith(
      staleWhileRevalidate(request, RUNTIME_CACHE).catch(() => new Response('', { status: 504, statusText: 'Gateway Timeout' }))
    );
  }
});
