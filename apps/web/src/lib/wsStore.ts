import { useSyncExternalStore } from 'react';

/** Selected workspace — tiny persisted UI store (same pattern as authStore). */
const KEY = 'consulting.ws.v1';
let selected: string | null = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
const listeners = new Set<() => void>();

export const wsStore = {
  get: (): string | null => selected,
  set: (id: string): void => {
    selected = id;
    try {
      localStorage.setItem(KEY, id);
    } catch {
      /* ignore */
    }
    for (const l of listeners) l();
  },
  subscribe: (fn: () => void): (() => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export function useSelectedWorkspace(): string | null {
  return useSyncExternalStore(wsStore.subscribe, wsStore.get, wsStore.get);
}
