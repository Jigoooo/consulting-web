import { useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { gsap } from 'gsap';
import { useAuth } from '../../lib/useAuth';
import { useNotifications, useMarkNotificationsRead } from '../../lib/collab';
import s from './NotificationBell.module.css';

const typeIcon: Record<string, string> = {
  invite_accepted: '🤝',
  assistant_reply: '🌍',
  artifact_version: '📄',
  member_joined: '👋',
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

/** Phase 2-C F-3 — bell + unread badge + dropdown feed (30s poll). */
export function NotificationBell() {
  const { user } = useAuth();
  const { data } = useNotifications(Boolean(user));
  const markRead = useMarkNotificationsRead();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const unread = data?.unreadCount ?? 0;

  useEffect(() => {
    if (!open || !popRef.current) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduce) {
      gsap.fromTo(
        popRef.current,
        { opacity: 0, y: -6, scale: 0.98 },
        { opacity: 1, y: 0, scale: 1, duration: 0.18, ease: 'power2.out' },
      );
    }
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function onItemClick(n: { id: string; refType: string; refId: string; readAt: string | null }) {
    if (!n.readAt) markRead.mutate([n.id]);
    setOpen(false);
    if (n.refType === 'thread') void navigate({ to: '/th/$threadId', params: { threadId: n.refId } });
  }

  return (
    <div className={s.wrap} ref={wrapRef}>
      <button
        type="button"
        className={s.bell}
        title="알림"
        aria-label={`알림 ${unread}개 안 읽음`}
        onClick={() => setOpen((v) => !v)}
      >
        🔔
        {unread > 0 ? <span className={s.badge}>{unread > 99 ? '99+' : unread}</span> : null}
      </button>
      {open ? (
        <div className={s.pop} ref={popRef} role="dialog" aria-label="알림 목록">
          <div className={s.popHead}>
            <span>알림</span>
            {unread > 0 ? (
              <button type="button" className={s.readAll} onClick={() => markRead.mutate(undefined)}>
                모두 읽음
              </button>
            ) : null}
          </div>
          <div className={s.list}>
            {(data?.notifications ?? []).length === 0 ? (
              <div className={s.empty}>알림이 없어요</div>
            ) : (
              data!.notifications.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  className={`${s.item} ${n.readAt ? '' : s.unreadItem}`}
                  onClick={() => onItemClick(n)}
                >
                  <span className={s.icon}>{typeIcon[n.type] ?? '•'}</span>
                  <span className={s.body}>
                    <span className={s.title}>{n.title}</span>
                    {n.body ? <span className={s.preview}>{n.body}</span> : null}
                    <span className={s.time}>{timeAgo(n.createdAt)}</span>
                  </span>
                  {!n.readAt ? <span className={s.dot} aria-hidden /> : null}
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
