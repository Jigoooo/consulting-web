import { describe, expect, it } from 'vitest';
import {
  classifyMessageWindowChange,
  computePrependAnchorScrollTop,
  shouldRevealTailDuringSettle,
  shouldAutoPageEdge,
  type EdgePagingDecisionInput,
} from './scrollPaging';

const base: EdgePagingDecisionInput = {
  edge: 'newer',
  isIntersecting: true,
  allowAutoLoad: true,
  hasPage: true,
  isLoading: false,
  userInitiated: true,
  direction: 'down',
  now: 1_000,
  suppressUntil: 0,
};

describe('scrollPaging', () => {
  it('loads newer only when the user scrolls downward into the bottom edge', () => {
    expect(shouldAutoPageEdge(base)).toBe(true);
    expect(shouldAutoPageEdge({ ...base, direction: 'up' })).toBe(false);
    expect(shouldAutoPageEdge({ ...base, userInitiated: false })).toBe(false);
  });

  it('loads older only when the user scrolls upward into the top edge', () => {
    expect(shouldAutoPageEdge({ ...base, edge: 'older', direction: 'up' })).toBe(true);
    expect(shouldAutoPageEdge({ ...base, edge: 'older', direction: 'down' })).toBe(false);
  });

  it('blocks programmatic scroll-triggered intersections during suppression', () => {
    expect(shouldAutoPageEdge({ ...base, now: 1_000, suppressUntil: 1_300 })).toBe(false);
    expect(shouldAutoPageEdge({ ...base, now: 1_301, suppressUntil: 1_300 })).toBe(true);
  });

  it('never loads when the edge has no page or is already loading', () => {
    expect(shouldAutoPageEdge({ ...base, hasPage: false })).toBe(false);
    expect(shouldAutoPageEdge({ ...base, isLoading: true })).toBe(false);
    expect(shouldAutoPageEdge({ ...base, isIntersecting: false })).toBe(false);
  });

  it('classifies older-page prepends separately from newer-page appends', () => {
    expect(classifyMessageWindowChange(['3', '4', '5'], ['1', '2', '3', '4', '5'])).toEqual({
      kind: 'prepend',
      added: 2,
    });
    expect(classifyMessageWindowChange(['3', '4', '5'], ['3', '4', '5', '6', '7'])).toEqual({
      kind: 'append',
      added: 2,
    });
  });

  it('treats search/latest window replacement as a replace, not a prepend anchor restore', () => {
    expect(classifyMessageWindowChange(['100', '101', '102'], ['1', '2', '3'])).toEqual({
      kind: 'replace',
      added: 0,
    });
  });

  it('preserves a prepend anchor by compensating scrollHeight growth before paint', () => {
    expect(computePrependAnchorScrollTop({
      snapshot: { id: '3', scrollTop: 520, scrollHeight: 1_400, offsetTop: 24 },
      nextScrollHeight: 1_880,
      nextOffsetTop: 24,
    })).toBe(1_000);
  });

  it('adds measured anchor drift on top of scrollHeight growth', () => {
    expect(computePrependAnchorScrollTop({
      snapshot: { id: '3', scrollTop: 520, scrollHeight: 1_400, offsetTop: 24 },
      nextScrollHeight: 1_880,
      nextOffsetTop: 38,
    })).toBe(1_014);
  });

  it('clamps anchor compensation to the scrollable range', () => {
    expect(computePrependAnchorScrollTop({
      snapshot: { id: '3', scrollTop: 520, scrollHeight: 1_400, offsetTop: 24 },
      nextScrollHeight: 3_000,
      nextOffsetTop: 24,
      maxScrollTop: 1_200,
    })).toBe(1_200);
  });

  it('reveals cached live-tail messages while the tail lock settles', () => {
    expect(shouldRevealTailDuringSettle({
      messageCount: 50,
      mode: 'latest',
      hasNewer: false,
      targetMessageId: null,
    })).toBe(true);
  });

  it('keeps non-tail or targeted windows hidden until their anchor is applied', () => {
    expect(shouldRevealTailDuringSettle({
      messageCount: 50,
      mode: 'around',
      hasNewer: true,
      targetMessageId: null,
    })).toBe(false);
    expect(shouldRevealTailDuringSettle({
      messageCount: 50,
      mode: 'latest',
      hasNewer: false,
      targetMessageId: 'hit-1',
    })).toBe(false);
    expect(shouldRevealTailDuringSettle({
      messageCount: 0,
      mode: 'latest',
      hasNewer: false,
      targetMessageId: null,
    })).toBe(false);
  });
});
