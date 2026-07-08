import type { MessageWindow } from './messageWindow';
import type { ChatMessage } from '@consulting/contracts';

const MAX_CACHED_THREADS = 8;
const MAX_PERSISTED_THREADS = 12;
const MAX_PERSISTED_MESSAGES = 50;
const PERSIST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STORAGE_KEY = 'consulting.message-window-cache.v1';
const windows = new Map<string, MessageWindow>();

interface PersistedWindow {
  threadId: string;
  savedAt: number;
  messages: ChatMessage[];
  hasOlder: boolean;
  olderCursor: string | null;
  newerCursor: string | null;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readPersisted(): PersistedWindow[] {
  const store = storage();
  if (!store) return [];
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed.filter((item): item is PersistedWindow => {
      if (!item || typeof item !== 'object') return false;
      const row = item as Partial<PersistedWindow>;
      return typeof row.threadId === 'string'
        && typeof row.savedAt === 'number'
        && now - row.savedAt <= PERSIST_TTL_MS
        && Array.isArray(row.messages);
    });
  } catch {
    return [];
  }
}

function writePersisted(entries: PersistedWindow[]): void {
  const store = storage();
  if (!store) return;
  try {
    const fresh = entries
      .filter((entry) => Date.now() - entry.savedAt <= PERSIST_TTL_MS)
      .sort((a, b) => b.savedAt - a.savedAt)
      .slice(0, MAX_PERSISTED_THREADS);
    store.setItem(STORAGE_KEY, JSON.stringify(fresh));
  } catch {
    // Storage quota/private-mode failures must never break chat navigation.
  }
}

function rememberPersisted(threadId: string, value: MessageWindow | undefined): void {
  const entries = readPersisted().filter((entry) => entry.threadId !== threadId);
  if (!value) {
    writePersisted(entries);
    return;
  }
  if (value.mode !== 'latest' || value.hasNewer || value.messages.length === 0) {
    writePersisted(entries);
    return;
  }
  entries.unshift({
    threadId,
    savedAt: Date.now(),
    messages: value.messages.slice(-MAX_PERSISTED_MESSAGES),
    hasOlder: value.hasOlder,
    olderCursor: value.olderCursor,
    newerCursor: value.newerCursor,
  });
  writePersisted(entries);
}

function hydratePersisted(threadId: string): MessageWindow | undefined {
  const entry = readPersisted().find((candidate) => candidate.threadId === threadId);
  if (!entry || entry.messages.length === 0) return undefined;
  const messagesById = new Map(entry.messages.map((message) => [message.id, message]));
  const orderedIds = entry.messages.map((message) => message.id);
  return {
    mode: 'latest',
    messagesById,
    orderedIds,
    messages: entry.messages,
    hasOlder: entry.hasOlder,
    hasNewer: false,
    olderCursor: entry.olderCursor,
    newerCursor: entry.newerCursor,
    anchorMessageId: null,
  };
}

export function getCachedMessageWindow(threadId: string): MessageWindow | undefined {
  const value = windows.get(threadId);
  if (!value) {
    const persisted = hydratePersisted(threadId);
    if (!persisted) return undefined;
    windows.set(threadId, persisted);
    return persisted;
  }
  windows.delete(threadId);
  windows.set(threadId, value);
  return value;
}

export function setCachedMessageWindow(threadId: string, value: MessageWindow | undefined): void {
  if (!value) {
    windows.delete(threadId);
    rememberPersisted(threadId, undefined);
    return;
  }
  windows.delete(threadId);
  windows.set(threadId, value);
  rememberPersisted(threadId, value);
  while (windows.size > MAX_CACHED_THREADS) {
    const oldest = windows.keys().next().value;
    if (typeof oldest !== 'string') break;
    windows.delete(oldest);
  }
}

export function clearMessageWindowCache(): void {
  windows.clear();
  storage()?.removeItem(STORAGE_KEY);
}
