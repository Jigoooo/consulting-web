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
