import { useSyncExternalStore } from 'react';
import { Icon } from '../../icons/Icon';
import s from './OfflineBadge.module.css';

/** Offline indicator (2026-07-06). The service worker keeps the app shell and
 * hashed assets available offline (read-only degradation); this badge tells
 * the user why sending/streaming won't work until the connection returns. */

function subscribe(fn: () => void): () => void {
  window.addEventListener('online', fn);
  window.addEventListener('offline', fn);
  return () => {
    window.removeEventListener('online', fn);
    window.removeEventListener('offline', fn);
  };
}

function getOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine;
}

export function OfflineBadge() {
  const online = useSyncExternalStore(subscribe, getOnline, () => true);
  if (online) return null;
  return (
    <div className={s.badge} role="status" aria-live="polite">
      <Icon name="alert" size="sm" decorative />
      오프라인 상태입니다 — 열람은 가능하지만 전송은 연결 후 가능해요
    </div>
  );
}
