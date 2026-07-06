import { describe, expect, it } from 'vitest';
import type { ChatMessage, ListMessagesPageResponse } from '@consulting/contracts';
import { mergeMessagePage, type MessageWindow } from './messageWindow';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function msg(n: number): ChatMessage {
  return {
    id: uuid(n),
    role: n % 2 === 0 ? 'assistant' : 'user',
    content: `m${n}`,
    authorUserId: n % 2 === 0 ? null : uuid(900 + n),
    authorName: n % 2 === 0 ? null : '사용자',
    runId: n % 2 === 0 ? `run_${n}` : null,
    finishState: 'complete',
    createdAt: `2026-07-06T00:00:0${n}.000Z`,
  };
}

function page(nums: number[], flags: Partial<ListMessagesPageResponse> = {}): ListMessagesPageResponse {
  const messages = nums.map(msg);
  return {
    messages,
    hasOlder: flags.hasOlder ?? false,
    hasNewer: flags.hasNewer ?? false,
    olderCursor: flags.olderCursor ?? messages[0]?.id ?? null,
    newerCursor: flags.newerCursor ?? messages.at(-1)?.id ?? null,
    ...(flags.anchorMessageId ? { anchorMessageId: flags.anchorMessageId } : {}),
  };
}

describe('message window merge', () => {
  it('dedupes pages and keeps chronological id order', () => {
    let state: MessageWindow = mergeMessagePage(undefined, page([3, 4, 5], { hasOlder: true }), 'latest');
    state = mergeMessagePage(state, page([1, 2, 3], { hasOlder: false, hasNewer: true }), 'older');
    expect(state.orderedIds).toEqual([uuid(1), uuid(2), uuid(3), uuid(4), uuid(5)]);
    expect(state.messages.map((m) => m.content)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    expect(state.hasOlder).toBe(false);
    expect(state.hasNewer).toBe(false);
  });

  it('replaces the window when jumping around a search anchor', () => {
    const latest = mergeMessagePage(undefined, page([8, 9, 10], { hasOlder: true }), 'latest');
    const around = mergeMessagePage(latest, page([4, 5, 6], { hasOlder: true, hasNewer: true, anchorMessageId: uuid(5) }), 'around');
    expect(around.mode).toBe('around');
    expect(around.anchorMessageId).toBe(uuid(5));
    expect(around.orderedIds).toEqual([uuid(4), uuid(5), uuid(6)]);
  });
});

describe('message window trimming (D4 — memory ceiling)', () => {
  // Build a window past MAX_WINDOW by loading many older pages.
  function loadManyOlder(total: number): MessageWindow {
    // newest page first (latest), then page older repeatedly
    let state = mergeMessagePage(undefined, page([total - 1, total], { hasOlder: true }), 'latest');
    for (let hi = total - 2; hi >= 1; hi -= 2) {
      const lo = Math.max(1, hi - 1);
      const nums = lo === hi ? [hi] : [lo, hi];
      state = mergeMessagePage(state, page(nums, { hasOlder: lo > 1, hasNewer: false }), 'older');
    }
    return state;
  }

  it('caps the in-memory window at MAX_WINDOW when paging older', () => {
    const state = loadManyOlder(500);
    expect(state.orderedIds.length).toBeLessThanOrEqual(400);
    // Trimming the newest side must re-open the newer edge so the user can page back down.
    expect(state.hasNewer).toBe(true);
    expect(state.newerCursor).not.toBeNull();
    // Oldest retained messages are the earliest loaded (older direction keeps the old side).
    expect(state.messages[0]?.content).toBe('m1');
  });

  it('caps the window when paging newer, trimming the oldest side', () => {
    // Start in an 'around' window near the middle, then page newer many times.
    // Anchor is uuid(200) (mid-history) so trimming the oldest side is allowed.
    let state = mergeMessagePage(undefined, page([199, 200], { hasOlder: true, hasNewer: true, anchorMessageId: uuid(200) }), 'around');
    for (let lo = 201; lo <= 700; lo += 2) {
      state = mergeMessagePage(state, page([lo, lo + 1], { hasOlder: false, hasNewer: lo + 1 < 700 }), 'newer');
    }
    expect(state.orderedIds.length).toBeLessThanOrEqual(400);
    // Trimming the oldest side must re-open the older edge.
    expect(state.hasOlder).toBe(true);
    expect(state.olderCursor).not.toBeNull();
  });

  it('never evicts the anchor in the around seed merge itself', () => {
    // A huge 'around' page (seed) must keep its anchor even if it overflows MAX.
    const nums = Array.from({ length: 500 }, (_, i) => i + 1);
    const seed = mergeMessagePage(undefined, page(nums, { hasOlder: true, hasNewer: true, anchorMessageId: uuid(250) }), 'around');
    expect(seed.messagesById.has(uuid(250))).toBe(true);
  });
});
