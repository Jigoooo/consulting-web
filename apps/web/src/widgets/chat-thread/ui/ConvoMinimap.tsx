import s from './ConvoMinimap.module.css';

export interface MinimapEntry {
  key: string;
  role: 'user' | 'assistant';
  preview: string;
}

/**
 * 창조 패턴 #2 — "대화 미니맵" (U-2).
 * Long consulting threads bury earlier Q&A. This vertical dot rail (right edge
 * of the stream) maps every USER question as a clickable dot; hover shows the
 * question preview, click smooth-scrolls to that turn. Assistant turns render
 * as hairline ticks so the Q/A rhythm is visible at a glance — a scannable
 * "table of contents" that no mainstream chat UI ships.
 */
export function ConvoMinimap({ entries, onJump }: { entries: MinimapEntry[]; onJump: (key: string) => void }) {
  const userEntries = entries.filter((e) => e.role === 'user');
  if (userEntries.length < 3) return null; // only useful once the thread has depth

  return (
    <nav className={s.rail} aria-label="대화 미니맵">
      {entries.map((e) =>
        e.role === 'user' ? (
          <button
            key={e.key}
            type="button"
            className={s.dot}
            title={e.preview}
            onClick={() => onJump(e.key)}
          >
            <span className={s.tip}>{e.preview}</span>
          </button>
        ) : (
          <span key={e.key} className={s.tick} aria-hidden />
        ),
      )}
    </nav>
  );
}
