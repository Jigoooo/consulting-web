/** Service worker client glue (2026-07-06).
 *
 * - Registers /sw.js (secure contexts only; dev server is excluded — Vite dev
 *   serves unhashed modules and a SW would only confuse HMR).
 * - Polls for new deploys via CHECK_VERSION messages (SW-side setInterval is
 *   unreliable: idle workers get killed), plus visibilitychange (the "back
 *   from lunch on Monday" case).
 * - When a new version is ready (precached by the SW), flips `updateReady`;
 *   the router reloads at the next route navigation — a moment the user
 *   already expects a screen change, so no form state is lost.
 * - vite:preloadError one-shot reload remains as the LAST-RESORT safety net
 *   for clients that raced the very first SW install.
 */

const POLL_MS = 5 * 60_000; // version.json is ~300 bytes; negligible.

let updateReady = false;

export function isUpdateReady(): boolean {
  return updateReady;
}

/** Called by the router on navigation. Reloads only when a new deploy has
 * been fully precached by the service worker. */
export function reloadIfUpdateReady(): void {
  if (!updateReady) return;
  updateReady = false;
  window.location.reload();
}

function askCheck(): void {
  navigator.serviceWorker?.controller?.postMessage({ type: 'CHECK_VERSION' });
}

export function setupServiceWorker(): void {
  // Last-resort net: a deploy raced us before the SW cached the old chunk.
  // One reload per session max — prevents the infinite-reload loop.
  window.addEventListener('vite:preloadError', (event) => {
    if (sessionStorage.getItem('consulting.chunk-reloaded.v1')) return;
    sessionStorage.setItem('consulting.chunk-reloaded.v1', '1');
    (event as Event & { preventDefault(): void }).preventDefault?.();
    window.location.reload();
  });

  if (!('serviceWorker' in navigator)) return;
  if (import.meta.env.DEV) return;

  window.addEventListener('load', () => {
    void (async () => {
      try {
        await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      } catch {
        return; // http / unsupported — app works normally without the SW
      }

      navigator.serviceWorker.addEventListener('message', (event) => {
        const data: unknown = event.data;
        if (typeof data === 'object' && data !== null && (data as { type?: string }).type === 'NEW_VERSION') {
          updateReady = true;
        }
      });

      askCheck();
      setInterval(askCheck, POLL_MS);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') askCheck();
      });
    })();
  });
}
