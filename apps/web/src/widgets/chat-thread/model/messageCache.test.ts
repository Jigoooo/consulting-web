import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@consulting/contracts';
import type { MessageWindow } from './messageWindow';
import {
  clearMessageWindowCache,
  getCachedMessageWindow,
  setCachedMessageWindow,
} from './messageCache';

function msg(label: string): ChatMessage {
  return {
    id: label,
    role: 'user',
    content: `cached ${label}`,
    authorUserId: null,
    authorName: '사용자',
    runId: null,
    finishState: 'complete',
    createdAt: '2026-07-08T00:00:00.000Z',
  };
}

function win(label: string): MessageWindow {
  const message = msg(label);
  return {
    mode: 'latest',
    messagesById: new Map([[message.id, message]]),
    orderedIds: [label],
    messages: [message],
    hasOlder: false,
    hasNewer: false,
    olderCursor: null,
    newerCursor: null,
    anchorMessageId: null,
  };
}

function stubStorage() {
  const data = new Map<string, string>();
  const store: Storage = {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => data.delete(key),
    setItem: (key, value) => data.set(key, value),
  };
  vi.stubGlobal('localStorage', store);
  return store;
}

describe('message window LRU cache', () => {
  beforeEach(() => {
    stubStorage();
    clearMessageWindowCache();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('returns cached windows and restores evicted latest windows from persisted storage', () => {
    for (let i = 1; i <= 8; i += 1) setCachedMessageWindow(`thread-${i}`, win(String(i)));
    expect(getCachedMessageWindow('thread-1')?.orderedIds).toEqual(['1']);
    setCachedMessageWindow('thread-9', win('9'));
    expect(getCachedMessageWindow('thread-2')?.messages.map((message) => message.content)).toEqual(['cached 2']);
    expect(getCachedMessageWindow('thread-1')?.orderedIds).toEqual(['1']);
  });

  it('deletes a thread cache when undefined is written', () => {
    setCachedMessageWindow('thread-a', win('a'));
    setCachedMessageWindow('thread-a', undefined);
    expect(getCachedMessageWindow('thread-a')).toBeUndefined();
  });

  it('hydrates a latest window from persisted browser storage before the network returns', () => {
    setCachedMessageWindow('thread-persisted', win('persisted-message'));
    for (let i = 0; i < 9; i += 1) setCachedMessageWindow(`thread-pressure-${i}`, win(`pressure-${i}`));

    const restored = getCachedMessageWindow('thread-persisted');
    expect(restored?.mode).toBe('latest');
    expect(restored?.hasNewer).toBe(false);
    expect(restored?.messages.map((message) => message.content)).toEqual(['cached persisted-message']);
  });
});
