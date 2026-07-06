/* Consulting-web service worker (2026-07-06).
 *
 * Scope of responsibility — INTENTIONALLY narrow:
 *  1. Deploy safety: keep hashed /assets/ chunks alive across deploys
 *     (cache-first over ALL version buckets) so an open tab never hits a 404
 *     on a lazy route after the CDN/nginx dropped old files.
 *  2. Version watch: poll /version.json (no-store) when the page asks;
 *     precache the new bundle, then notify clients (NEW_VERSION) so the app
 *     can reload at a natural navigation boundary.
 *  3. Web Push: show notifications + focus/open the app on click.
 *  4. Offline fallback: navigations fall back to cached index.html + a tiny
 *     offline badge signal (client-side) — read-only degradation only.
 *
 * HARD RULES:
 *  - NEVER intercept /api/ (especially /api/chat/stream SSE). We do not call
 *    respondWith for those, so the browser handles them natively.
 *  - Auth/token responses are never cached (guaranteed by the scope rule).
 *  - Version comparison is INEQUALITY, not ordering → rollbacks just work.
 *  - sw.js itself is served Cache-Control: no-cache (nginx) so a bad worker
 *    can be replaced on the next visit — no killswitch horror story.
 */

const CACHE_PREFIX = 'consulting-app-';
const VERSION_KEY_CACHE = 'consulting-meta';
const CORE = ['/', '/index.html'];

/** Keep only the newest N version buckets on activate (plus meta). */
const MAX_BUCKETS = 3;

// ---------------------------------------------------------------- lifecycle

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const res = await fetch('/version.json', { cache: 'no-store' });
        if (res.ok) {
          const { version, assets } = await res.json();
          const cache = await caches.open(CACHE_PREFIX + version);
          // addAll is atomic; tolerate individual failures via manual puts.
          await Promise.allSettled(
            [...CORE, ...assets].map(async (u) => {
              const r = await fetch(u, { cache: 'no-store' });
              if (r.ok) await cache.put(u, r);
            }),
          );
          await putMeta('currentVersion', version);
        }
      } catch {
        /* offline install — worker still activates, fetch falls through */
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Prune old version buckets, newest-first by cache key (timestamp names sort).
      const keys = (await caches.keys()).filter((k) => k.startsWith(CACHE_PREFIX));
      const sorted = keys.sort().reverse();
      await Promise.all(sorted.slice(MAX_BUCKETS).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

// ------------------------------------------------------------------- meta

async function putMeta(key, value) {
  const cache = await caches.open(VERSION_KEY_CACHE);
  await cache.put(new Request(`/__meta__/${key}`), new Response(JSON.stringify(value)));
}

async function getMeta(key) {
  const cache = await caches.open(VERSION_KEY_CACHE);
  const res = await cache.match(new Request(`/__meta__/${key}`));
  if (!res) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ version watch

async function checkVersion() {
  let payload;
  try {
    const res = await fetch('/version.json', { cache: 'no-store' });
    if (!res.ok) return;
    payload = await res.json();
  } catch {
    return; // offline — try again next tick
  }
  const { version, assets } = payload;
  const current = await getMeta('currentVersion');
  if (!version || version === current) return;

  // Precache the NEW bundle fully before announcing it, so the post-reload
  // boot is served almost entirely from local disk.
  const cache = await caches.open(CACHE_PREFIX + version);
  await Promise.allSettled(
    [...CORE, ...(assets ?? [])].map(async (u) => {
      const r = await fetch(u, { cache: 'no-store' });
      if (r.ok) await cache.put(u, r);
    }),
  );
  await putMeta('currentVersion', version);

  const clients = await self.clients.matchAll({ type: 'window' });
  for (const client of clients) {
    client.postMessage({ type: 'NEW_VERSION', version });
  }
}

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'CHECK_VERSION') event.waitUntil(checkVersion());
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
});

// ------------------------------------------------------------------ fetch

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // HARD RULE: never touch the API (SSE, auth, uploads). No respondWith → native.
  if (url.pathname.startsWith('/api/')) return;
  // The worker and its manifest must always hit the network path.
  if (url.pathname === '/sw.js' || url.pathname === '/version.json') return;

  // Hashed assets: cache-first across ALL buckets (old sessions keep working
  // even after the deploy deleted their chunks from nginx).
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ??
          fetch(req).then((res) => {
            if (res.ok) {
              // Stash into the current bucket so an asset missed at install
              // time is still deploy-safe afterwards.
              event.waitUntil(
                (async () => {
                  const version = await getMeta('currentVersion');
                  if (version) {
                    const cache = await caches.open(CACHE_PREFIX + version);
                    await cache.put(req, res.clone());
                  }
                })(),
              );
            }
            return res;
          }),
      ),
    );
    return;
  }

  // Navigations: network-first (fresh index.html), cached shell as offline
  // fallback so the app still boots read-only without a connection.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(async () => {
        const shell = (await caches.match('/index.html')) ?? (await caches.match('/'));
        return (
          shell ??
          new Response('오프라인 상태입니다. 연결이 복구되면 다시 시도해 주세요.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          })
        );
      }),
    );
  }
});

// ------------------------------------------------------------------- push

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: '알림', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || '지구 워크스페이스';
  const options = {
    body: data.body || '',
    icon: '/favicon.svg',
    badge: '/favicon.svg',
    tag: data.tag || 'consulting-notification',
    data: { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/';
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        if ('focus' in client) {
          await client.focus();
          if ('navigate' in client && target !== '/') await client.navigate(target);
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
