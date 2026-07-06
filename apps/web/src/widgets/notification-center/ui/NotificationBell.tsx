import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useAuth } from '../../../lib/useAuth';
import { useNotifications, useMarkNotificationsRead } from '../../../lib/collab';
import { usePushNotifications } from '../../../lib/push';
import { DialogRoot, DialogContent } from '../../../shared/ui/dialog/Dialog';
import { Icon } from '../../../shared/icons/Icon';
import type { IconName } from '../../../shared/icons/registry';
import s from './NotificationBell.module.css';

const typeIcon: Record<string, IconName> = {
  invite_accepted: 'handshake',
  assistant_reply: 'bot',
  artifact_version: 'file-text',
  member_joined: 'user-plus',
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

/** 알림 센터 — bell + unread badge + 중앙 modal (2026-07-06: 사이드바 popover가
 *  레일/레이아웃 경계에 가려지는 문제로 Radix Dialog modal 로 전환). */
export function NotificationBell() {
  const { user } = useAuth();
  const { data } = useNotifications(Boolean(user));
  const markRead = useMarkNotificationsRead();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const push = usePushNotifications(open);

  const unread = data?.unreadCount ?? 0;

  function onItemClick(n: { id: string; refType: string; refId: string; readAt: string | null }) {
    if (!n.readAt) markRead.mutate([n.id]);
    setOpen(false);
    if (n.refType === 'thread') void navigate({ to: '/th/$threadId', params: { threadId: n.refId } });
  }

  return (
    <div className={s.wrap}>
      <button
        type="button"
        className={s.bell}
        title="알림"
        aria-label={`알림 ${unread}개 안 읽음`}
        onClick={() => setOpen(true)}
      >
        <Icon name="bell" size="sm" decorative />
        {unread > 0 ? <span className={s.badge}>{unread > 99 ? '99+' : unread}</span> : null}
      </button>
      <DialogRoot open={open} onOpenChange={setOpen}>
        <DialogContent className={s.modal} title="알림" description="워크스페이스의 새 소식을 확인하세요.">
          {unread > 0 ? (
            <div className={s.modalTools}>
              <button type="button" className={s.readAll} onClick={() => markRead.mutate(undefined)}>
                모두 읽음
              </button>
            </div>
          ) : null}
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
                  <span className={s.icon}><Icon name={typeIcon[n.type] ?? 'info'} size="sm" decorative /></span>
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
          {push.state !== 'unsupported' && push.state !== 'unavailable' ? (
            <div className={s.pushRow}>
              <span className={s.pushLabel}>
                <Icon name="monitor" size="sm" decorative /> 브라우저 알림
              </span>
              {push.state === 'denied' ? (
                <span className={s.pushDenied}>브라우저 설정에서 차단됨</span>
              ) : (
                <button
                  type="button"
                  className={s.pushToggle}
                  role="switch"
                  aria-checked={push.state === 'on'}
                  aria-label="브라우저 알림 켜기/끄기"
                  disabled={push.state === 'busy'}
                  onClick={() => void push.toggle()}
                >
                  {push.state === 'busy' ? (
                    <Icon name="loader" size="sm" decorative />
                  ) : push.state === 'on' ? (
                    '켜짐'
                  ) : (
                    '꺼짐'
                  )}
                </button>
              )}
            </div>
          ) : null}
        </DialogContent>
      </DialogRoot>
    </div>
  );
}
