import { Fragment } from 'react';
import { highlightRanges } from '@consulting/contracts';
import s from '../../thread-view/ui/ThreadView.module.css';

/**
 * Renders `text` with search-query hits wrapped in <mark>. Uses the shared
 * hangul-aware `highlightRanges` (F1) — whitespace-insensitive substring hits
 * produce char ranges; 초성/jamo matches produce none (bubble-level highlight
 * handles those upstream). Plain text, no markdown (used for matched bubbles).
 */
export function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const ranges = highlightRanges(text, query);
  if (ranges.length === 0) return <>{text}</>;

  const parts: Array<{ str: string; mark: boolean }> = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) parts.push({ str: text.slice(cursor, start), mark: false });
    parts.push({ str: text.slice(start, end), mark: true });
    cursor = end;
  }
  if (cursor < text.length) parts.push({ str: text.slice(cursor), mark: false });

  return (
    <>
      {parts.map((p, i) =>
        p.mark ? (
          <mark key={i} className={s.searchMark}>{p.str}</mark>
        ) : (
          <Fragment key={i}>{p.str}</Fragment>
        ),
      )}
    </>
  );
}
