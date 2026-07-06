import { useSyncExternalStore } from 'react';
import type { MessageSearchHit } from '@consulting/contracts';

/**
 * Thread-scoped search state shared between the chat header (input + navigator)
 * and the right context panel (full result list) without prop-drilling through
 * the app shell. Mirrors the threadCtx external-store pattern.
 */
export interface SearchState {
  threadId: string | null;
  query: string;
  results: MessageSearchHit[];
  /** index into results of the currently focused hit, or -1 */
  focusedIndex: number;
  open: boolean;
}

const empty: SearchState = { threadId: null, query: '', results: [], focusedIndex: -1, open: false };
let state: SearchState = empty;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export const searchStore = {
  get: (): SearchState => state,
  set: (next: Partial<SearchState>): void => {
    state = { ...state, ...next };
    emit();
  },
  reset: (threadId: string | null): void => {
    state = { ...empty, threadId };
    emit();
  },
  focusIndex: (index: number): void => {
    if (state.results.length === 0) return;
    const clamped = ((index % state.results.length) + state.results.length) % state.results.length;
    state = { ...state, focusedIndex: clamped };
    emit();
  },
  subscribe: (fn: () => void): (() => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export function useSearchState(): SearchState {
  return useSyncExternalStore(searchStore.subscribe, searchStore.get, searchStore.get);
}
