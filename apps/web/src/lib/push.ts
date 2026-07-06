/** Web Push client glue (2026-07-06).
 *
 * Flow: bell dropdown shows a "브라우저 알림" toggle →
 *   enablePush(): permission → SW pushManager.subscribe(VAPID) → POST /push/subscribe
 *   disablePush(): unsubscribe locally → POST /push/unsubscribe
 * Availability requires: SW registered (prod, HTTPS), server VAPID configured.
 */
import { useEffect, useState } from 'react';
import { api } from './api';

function base64UrlToUint8Array(base64Url: string): Uint8Array {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  return (await navigator.serviceWorker.getRegistration('/')) ?? null;
}

export type PushState = 'unsupported' | 'unavailable' | 'denied' | 'off' | 'on' | 'busy';

export function usePushNotifications(enabled: boolean): {
  state: PushState;
  toggle: () => Promise<void>;
} {
  const [state, setState] = useState<PushState>('unsupported');

  useEffect(() => {
    if (!enabled) return;
    void (async () => {
      const reg = await getRegistration();
      if (!reg) {
        setState('unsupported');
        return;
      }
      let publicKey: string | null;
      try {
        publicKey = (await api.pushPublicKey()).publicKey;
      } catch {
        publicKey = null;
      }
      if (!publicKey) {
        setState('unavailable');
        return;
      }
      if (Notification.permission === 'denied') {
        setState('denied');
        return;
      }
      const sub = await reg.pushManager.getSubscription();
      setState(sub ? 'on' : 'off');
    })();
  }, [enabled]);

  const toggle = async () => {
    const reg = await getRegistration();
    if (!reg) return;
    setState('busy');
    try {
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        const endpoint = existing.endpoint;
        await existing.unsubscribe();
        try {
          await api.pushUnsubscribe(endpoint);
        } catch {
          /* server row is pruned on next failed send anyway */
        }
        setState('off');
        return;
      }

      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setState(permission === 'denied' ? 'denied' : 'off');
        return;
      }
      const { publicKey } = await api.pushPublicKey();
      if (!publicKey) {
        setState('unavailable');
        return;
      }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToUint8Array(publicKey) as BufferSource,
      });
      const json = sub.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
        await sub.unsubscribe();
        setState('off');
        return;
      }
      await api.pushSubscribe({
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      });
      setState('on');
    } catch {
      setState('off');
    }
  };

  return { state, toggle };
}
