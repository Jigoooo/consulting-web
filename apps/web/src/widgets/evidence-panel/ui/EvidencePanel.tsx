import { useEffect, useRef, useState } from 'react';
import { useEvidence, useAddEvidence } from '../../../lib/collab';
import { useHoveredMessage } from '../../../lib/threadCtx';
import { useToast } from '../../../shared/ui/toast/Toast';
import { Icon } from '../../../shared/icons/Icon';
import type { IconName } from '../../../shared/icons/registry';
import { Button } from '../../../shared/ui/button/Button';
import { Input, Textarea } from '../../../shared/ui/input/Input';
import { EmptyState, Spinner } from '../../../shared/ui/feedback/EmptyState';
import { useDelayedFlag } from '../../../shared/lib/useDelayedFlag';
import s from './EvidencePanel.module.css';

const sourceLabel: Record<string, string> = {
  gbrain: '지식그래프',
  web: '웹',
  file: '파일',
  tool: '도구',
  manual: '직접 첨부',
};
const sourceIcon: Record<string, IconName> = {
  gbrain: 'brain',
  web: 'globe',
  file: 'files',
  tool: 'wrench',
  manual: 'pin',
};

/**
 * Phase 2-A E-4 — evidence tab in the context panel. Auto items come from
 * Hermes tool events; the accent rail highlights evidence rows tied to the
 * assistant message the user is hovering in the thread (E-4 창조 패턴 실현).
 * B4/B5: flat rows (no card chrome), EmptyState/Spinner reuse, and the add
 * form is a grid accordion (0fr→1fr) that expands/collapses smoothly.
 */
export function EvidencePanel({ threadId }: { threadId: string }) {
  const { data, isLoading } = useEvidence(threadId);
  const hovered = useHoveredMessage();
  const addEvidence = useAddEvidence(threadId);
  const toast = useToast();
  const [formOpen, setFormOpen] = useState(false);
  const [ref, setRef] = useState('');
  const [excerpt, setExcerpt] = useState('');
  const [url, setUrl] = useState('');
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  const showLoading = useDelayedFlag(isLoading, 300);

  // Focus the first field once the expand transition settles (avoids scroll jump).
  useEffect(() => {
    if (!formOpen) return;
    const t = window.setTimeout(() => firstFieldRef.current?.focus(), 210);
    return () => window.clearTimeout(t);
  }, [formOpen]);

  async function submit() {
    if (!ref.trim() || !excerpt.trim()) return;
    try {
      await addEvidence.mutateAsync({
        threadId,
        sourceType: 'manual',
        ref: ref.trim(),
        excerpt: excerpt.trim(),
        ...(url.trim() ? { url: url.trim() } : {}),
      });
      toast('success', '근거 추가 완료');
      setRef('');
      setExcerpt('');
      setUrl('');
      setFormOpen(false);
    } catch {
      toast('error', '근거 추가 실패. URL을 확인해주세요.');
    }
  }

  const items = data?.evidence ?? [];

  return (
    <div className={s.wrap}>
      {showLoading ? (
        <div className={s.loadingRow}>
          <Spinner label="근거 불러오는 중" /> 근거 불러오는 중…
        </div>
      ) : null}
      {!isLoading && items.length === 0 && !formOpen ? (
        <EmptyState
          icon="pin"
          title="아직 수집된 근거가 없어요"
          description="지구가 도구를 사용하면 자동으로 쌓이고, 직접 추가할 수도 있어요."
        />
      ) : null}

      {items.length > 0 ? (
        <div className={s.rows}>
          {items.map((e) => (
            <div key={e.id} className={`${s.row} ${hovered && e.messageId === hovered ? s.rowGlow : ''}`}>
              <span className={s.rowIcon}>
                <Icon name={sourceIcon[e.sourceType] ?? 'info'} size="sm" decorative />
              </span>
              <div className={s.rowBody}>
                <div className={s.rowHead}>
                  <span className={s.srcType}>{sourceLabel[e.sourceType] ?? e.sourceType}</span>
                  <span className={s.ref} title={e.ref}>{e.ref}</span>
                </div>
                <div className={s.excerpt}>{e.excerpt}</div>
                {e.url ? (
                  <a className={s.link} href={e.url} target="_blank" rel="noreferrer noopener">
                    출처 열기 <Icon name="globe" size="xs" decorative />
                  </a>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {/* B5: grid-accordion add form — always mounted, animates on open */}
      <div className={`${s.formShell} ${formOpen ? s.formShellOpen : ''}`} aria-hidden={!formOpen} inert={!formOpen ? true : undefined}>
        <div className={s.formInner}>
          <Input
            ref={firstFieldRef}
            className={s.input}
            placeholder="출처 이름 (예: 창원시 예산서)"
            value={ref}
            onChange={(e) => setRef(e.target.value)}
          />
          <Textarea
            className={s.input}
            rows={3}
            placeholder="핵심 내용 발췌"
            value={excerpt}
            onChange={(e) => setExcerpt(e.target.value)}
          />
          <Input
            className={s.input}
            placeholder="URL (선택)"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <div className={s.formActions}>
            <Button type="button" variant="primary" size="sm" className={s.btnPrimary} disabled={addEvidence.isPending} onClick={() => void submit()}>
              추가
            </Button>
            <Button type="button" variant="ghost" size="sm" className={s.btnGhost} onClick={() => setFormOpen(false)}>
              취소
            </Button>
          </div>
        </div>
      </div>

      {!formOpen ? (
        <button type="button" className={`${s.addBtn} cwTap`} onClick={() => setFormOpen(true)}>
          <Icon name="plus" size="xs" decorative /> 근거 추가
        </button>
      ) : null}
    </div>
  );
}
