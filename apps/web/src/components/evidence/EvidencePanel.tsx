import { useState } from 'react';
import { useEvidence, useAddEvidence } from '../../lib/collab';
import { useHoveredMessage } from '../../lib/threadCtx';
import { useToast } from '../ui/Toast';
import s from './EvidencePanel.module.css';

const sourceLabel: Record<string, string> = {
  gbrain: '지식그래프',
  web: '웹',
  file: '파일',
  tool: '도구',
  manual: '직접 첨부',
};
const sourceIcon: Record<string, string> = {
  gbrain: '🧠',
  web: '🌐',
  file: '📁',
  tool: '🛠',
  manual: '📌',
};

/**
 * Phase 2-A E-4 — evidence tab in the context panel. Auto items come from
 * Hermes tool events; the glow link highlights evidence rows tied to the
 * assistant message the user is hovering in the thread (E-4 창조 패턴 실현).
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
      toast('success', '근거를 추가했어요.');
      setRef('');
      setExcerpt('');
      setUrl('');
      setFormOpen(false);
    } catch {
      toast('error', '근거 추가에 실패했어요. URL 형식을 확인해주세요.');
    }
  }

  const items = data?.evidence ?? [];

  return (
    <div>
      {isLoading ? <div className={s.empty}>불러오는 중…</div> : null}
      {!isLoading && items.length === 0 ? (
        <div className={s.empty}>
          아직 수집된 근거가 없어요.
          <br />
          지구가 도구를 사용하면 자동으로 쌓입니다.
        </div>
      ) : null}
      {items.map((e) => (
        <div key={e.id} className={`${s.card} ${hovered && e.messageId === hovered ? s.glow : ''}`}>
          <div className={s.cardHead}>
            <span className={s.srcIcon}>{sourceIcon[e.sourceType] ?? '•'}</span>
            <span className={s.srcType}>{sourceLabel[e.sourceType] ?? e.sourceType}</span>
            <span className={s.ref} title={e.ref}>
              {e.ref}
            </span>
          </div>
          <div className={s.excerpt}>{e.excerpt}</div>
          {e.url ? (
            <a className={s.link} href={e.url} target="_blank" rel="noreferrer noopener">
              출처 열기 ↗
            </a>
          ) : null}
        </div>
      ))}

      {formOpen ? (
        <div className={s.form}>
          <input
            className={s.input}
            placeholder="출처 이름 (예: 창원시 예산서)"
            value={ref}
            onChange={(e) => setRef(e.target.value)}
          />
          <textarea
            className={s.input}
            rows={3}
            placeholder="핵심 내용 발췌"
            value={excerpt}
            onChange={(e) => setExcerpt(e.target.value)}
          />
          <input
            className={s.input}
            placeholder="URL (선택)"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" className={s.btnPrimary} disabled={addEvidence.isPending} onClick={() => void submit()}>
              추가
            </button>
            <button type="button" className={s.btnGhost} onClick={() => setFormOpen(false)}>
              취소
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className={s.addBtn} onClick={() => setFormOpen(true)}>
          + 근거 직접 추가
        </button>
      )}
    </div>
  );
}
