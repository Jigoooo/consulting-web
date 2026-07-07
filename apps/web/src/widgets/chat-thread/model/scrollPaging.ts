export type ScrollDirection = 'up' | 'down' | 'none';
export type PageEdge = 'older' | 'newer';
export type MessageWindowChangeKind = 'same' | 'prepend' | 'append' | 'replace';

export interface MessageWindowChange {
  kind: MessageWindowChangeKind;
  added: number;
}

export interface PrependAnchorSnapshot {
  id: string;
  scrollTop: number;
  scrollHeight: number;
  offsetTop: number;
}

export interface PrependAnchorRestoreInput {
  snapshot: PrependAnchorSnapshot;
  nextScrollHeight: number;
  nextOffsetTop?: number | undefined;
  maxScrollTop?: number | undefined;
}

export interface EdgePagingDecisionInput {
  edge: PageEdge;
  isIntersecting: boolean;
  allowAutoLoad: boolean;
  hasPage: boolean;
  isLoading: boolean;
  userInitiated: boolean;
  direction: ScrollDirection;
  now: number;
  suppressUntil: number;
}

/**
 * Direction-gated bidirectional paging.
 *
 * IntersectionObserver alone is not enough for chat history: after a search or
 * deep-link jump the bottom sentinel may already be visible, which used to pull
 * every newer page until the live tail. Only page an edge when the user actually
 * scrolls toward that edge and programmatic scroll suppression has expired.
 */
export function shouldAutoPageEdge(input: EdgePagingDecisionInput): boolean {
  if (!input.isIntersecting || !input.allowAutoLoad) return false;
  if (!input.hasPage || input.isLoading) return false;
  if (!input.userInitiated) return false;
  if (input.now < input.suppressUntil) return false;
  return input.edge === 'older' ? input.direction === 'up' : input.direction === 'down';
}

function containsContiguous(haystack: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0) return 0;
  const maxStart = haystack.length - needle.length;
  for (let start = 0; start <= maxStart; start += 1) {
    let matched = true;
    for (let index = 0; index < needle.length; index += 1) {
      if (haystack[start + index] !== needle[index]) {
        matched = false;
        break;
      }
    }
    if (matched) return start;
  }
  return -1;
}

/**
 * Classify how the loaded chat window changed so the virtualizer can preserve
 * the right anchor. Older-page loads prepend before the visible rows; newer-page
 * loads append after them; search/latest jumps replace the whole window. Treating
 * every length increase as a prepend makes the view jump/flicker.
 */
export function classifyMessageWindowChange(
  previousIds: readonly string[],
  nextIds: readonly string[],
): MessageWindowChange {
  if (previousIds.length === 0) return nextIds.length === 0 ? { kind: 'same', added: 0 } : { kind: 'replace', added: 0 };
  if (nextIds.length === previousIds.length && containsContiguous(nextIds, previousIds) === 0) return { kind: 'same', added: 0 };
  if (nextIds.length <= previousIds.length) return { kind: 'replace', added: 0 };

  const start = containsContiguous(nextIds, previousIds);
  if (start < 0) return { kind: 'replace', added: 0 };
  if (start > 0 && start + previousIds.length === nextIds.length) return { kind: 'prepend', added: start };
  if (start === 0) return { kind: 'append', added: nextIds.length - previousIds.length };
  return { kind: 'replace', added: 0 };
}

function clampScrollTop(value: number, maxScrollTop?: number): number {
  const finite = Number.isFinite(value) ? value : 0;
  const lowerBounded = Math.max(0, finite);
  return typeof maxScrollTop === 'number' && Number.isFinite(maxScrollTop)
    ? Math.min(lowerBounded, Math.max(0, maxScrollTop))
    : lowerBounded;
}

/**
 * CSS Scroll Anchoring style prepend compensation.
 *
 * Older chat rows are inserted above the viewport, so preserving absolute
 * scrollTop is wrong. Preserve the user's reading anchor instead: first account
 * for total scrollHeight growth, then correct any measured drift of the same
 * anchor row inside the scroller.
 */
export function computePrependAnchorScrollTop(input: PrependAnchorRestoreInput): number {
  const heightDelta = Math.max(0, input.nextScrollHeight - input.snapshot.scrollHeight);
  const offsetDelta = typeof input.nextOffsetTop === 'number' && Number.isFinite(input.nextOffsetTop)
    ? input.nextOffsetTop - input.snapshot.offsetTop
    : 0;
  return clampScrollTop(input.snapshot.scrollTop + heightDelta + offsetDelta, input.maxScrollTop);
}
