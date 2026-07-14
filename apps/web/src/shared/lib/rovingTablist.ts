/**
 * WAI-ARIA APG roving-focus key resolver for a single-row tablist.
 *
 * Returns the index the tablist should move focus to, or null when the key is
 * not a navigation key (so the caller leaves the event untouched — Enter/Space
 * still activate, Tab still leaves the widget). Movement wraps at both ends and
 * clamps a stale current index so callers never index out of bounds.
 */
export type RovingKey = string;

export function nextRovingIndex(key: RovingKey, currentIndex: number, count: number): number | null {
  if (count <= 0) return null;
  const clamped = Math.min(Math.max(Math.trunc(currentIndex), 0), count - 1);
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (clamped + 1) % count;
    case 'ArrowLeft':
    case 'ArrowUp':
      return (clamped - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
