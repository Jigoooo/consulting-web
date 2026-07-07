import { describe, expect, it, beforeEach } from 'vitest';
import type { MessageWindow } from './messageWindow';
import {
  clearMessageWindowCache,
  getCachedMessageWindow,
  setCachedMessageWindow,
} from './messageCache';

function win(label: string): MessageWindow {
  return {
    mode: 'latest',
    messagesById: new Map(),
    orderedIds: [label],
    messages: [],
    hasOlder: false,
    hasNewer: false,
    olderCursor: null,
    newerCursor: null,
    anchorMessageId: null,
  };
}

describe('message window LRU cache', () => {
  beforeEach(() => clearMessageWindowCache());

  it('returns cached windows and refreshes recency on read', () => {
    for (let i = 1; i <= 8; i += 1) setCachedMessageWindow(`thread-${i}`, win(String(i)));
    expect(getCachedMessageWindow('thread-1')?.orderedIds).toEqual(['1']);
    setCachedMessageWindow('thread-9', win('9'));
    expect(getCachedMessageWindow('thread-2')).toBeUndefined();
    expect(getCachedMessageWindow('thread-1')?.orderedIds).toEqual(['1']);
  });

  it('deletes a thread cache when undefined is written', () => {
    setCachedMessageWindow('thread-a', win('a'));
    setCachedMessageWindow('thread-a', undefined);
    expect(getCachedMessageWindow('thread-a')).toBeUndefined();
  });
});
