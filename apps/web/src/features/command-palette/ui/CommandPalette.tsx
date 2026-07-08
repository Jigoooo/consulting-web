import { useDeferredValue, useEffect, useRef, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { gsap } from 'gsap';
import { hangulMatch } from '@consulting/contracts';
import { api } from '../../../lib/api';
import { resolveTopicThreadForNavigation } from '../../../lib/openTopicThread';
import { useWorkspaceTree } from '../../../lib/spaces';
import { useSelectedWorkspace } from '../../../lib/wsStore';
import { useToast } from '../../../shared/ui/toast/Toast';
import { messageWindowKeys } from '../../../widgets/chat-thread/model/useMessageWindow';
import s from './CommandPalette.module.css';

interface Item {
  id: string;
  kind: 'topic' | 'action';
  label: string;
  hint?: string;
  run: () => void;
}

/**
 * ⌘K command palette (U-3). Korean-friendly fuzzy jump across the space tree
 * plus quick actions. Raycast-style: instant open, arrow keys, Enter to run.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const selected = useSelectedWorkspace();
  const { data: tree } = useWorkspaceTree(open ? (selected ?? undefined) : undefined);
  const cardRef = useRef<HTMLDivElement | null>(null);

  function openTopic(topicId: string) {
    void (async () => {
      try {
        const thread = await resolveTopicThreadForNavigation({ queryClient: qc, topicId, workspaceId: selected ?? undefined });
        void qc.prefetchQuery({
          queryKey: messageWindowKeys.latest(thread.id),
          queryFn: () => api.listMessagesPage(thread.id, { limit: 50 }),
          staleTime: 30_000,
        });
        void router.navigate({ to: '/th/$threadId', params: { threadId: thread.id } });
      } catch {
        toast('error', '채널 대화를 여는 데 실패했어요.');
      }
    })();
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
        setQ('');
        setCursor(0);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open && cardRef.current && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      gsap.from(cardRef.current, { opacity: 0, y: -12, scale: 0.985, duration: 0.2, ease: 'power3.out' });
    }
  }, [open]);

  // React Compiler stabilizes these derived values — no useMemo needed (E).
  const items: Item[] = [];
  for (const p of tree?.projects ?? []) {
    for (const c of p.channels) {
      for (const t of c.topics) {
        items.push({
          id: t.id,
          kind: 'topic',
          label: t.name,
          hint: `${p.name} › ${c.name}`,
          run: () => openTopic(t.id),
        });
      }
    }
  }

  const needle = useDeferredValue(q.trim());
  // F4: hangul-aware match — 초성/합성/띄어쓰기무시. Deferred so typing stays
  // responsive even with a large topic tree (D1).
  const filtered = !needle
    ? items.slice(0, 8)
    : items.filter((it) => hangulMatch(it.label, needle) || (it.hint ? hangulMatch(it.hint, needle) : false)).slice(0, 8);

  useEffect(() => setCursor(0), [q]);

  if (!open) return null;

  return (
    <div className={s.overlay} onClick={() => setOpen(false)}>
      <div className={s.card} ref={cardRef} onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          className={s.input}
          placeholder="토픽 검색 또는 이동…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, filtered.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === 'Enter' && filtered[cursor]) {
              filtered[cursor].run();
              setOpen(false);
            }
          }}
        />
        <div className={s.list} role="listbox">
          {filtered.length === 0 ? <div className={s.empty}>결과가 없어요</div> : null}
          {filtered.map((it, i) => (
            <button
              key={it.id}
              type="button"
              role="option"
              aria-selected={i === cursor}
              className={`${s.item} ${i === cursor ? s.itemOn : ''}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => {
                it.run();
                setOpen(false);
              }}
            >
              <span className={s.itemHash}>#</span>
              <span className={s.itemLabel}>{it.label}</span>
              {it.hint ? <span className={s.itemHint}>{it.hint}</span> : null}
            </button>
          ))}
        </div>
        <div className={s.foot}>
          <span>↑↓ 이동</span>
          <span>↵ 열기</span>
          <span>esc 닫기</span>
        </div>
      </div>
    </div>
  );
}
