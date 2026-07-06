import type { MessageWindow } from './messageWindow';

const MAX_CACHED_THREADS = 8;
const windows = new Map<string, MessageWindow>();

export function getCachedMessageWindow(threadId: string): MessageWindow | undefined {
  const value = windows.get(threadId);
  if (!value) return undefined;
  windows.delete(threadId);
  windows.set(threadId, value);
  return value;
}

export function setCachedMessageWindow(threadId: string, value: MessageWindow | undefined): void {
  if (!value) {
    windows.delete(threadId);
    return;
  }
  windows.delete(threadId);
  windows.set(threadId, value);
  while (windows.size > MAX_CACHED_THREADS) {
    const oldest = windows.keys().next().value;
    if (typeof oldest !== 'string') break;
    windows.delete(oldest);
  }
}

export function clearMessageWindowCache(): void {
  windows.clear();
}
