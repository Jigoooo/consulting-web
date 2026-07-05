import { useSyncExternalStore } from 'react';

/** Active thread context (Phase 2-A) — lets the ContextPanel show evidence
 * for whichever thread is open without prop-drilling through routes. */
let active: string | null = null;
const listeners = new Set<() => void>();

export const activeThreadStore = {
  get: (): string | null => active,
  set: (id: string | null): void => {
    if (active === id) return;
    active = id;
    for (const l of listeners) l();
  },
  subscribe: (fn: () => void): (() => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export function useActiveThread(): string | null {
  return useSyncExternalStore(activeThreadStore.subscribe, activeThreadStore.get, activeThreadStore.get);
}

/** Hovered assistant message id (Phase 2-A E-4) — drives the evidence glow link. */
let hovered: string | null = null;
const hoverListeners = new Set<() => void>();

export const hoveredMessageStore = {
  get: (): string | null => hovered,
  set: (id: string | null): void => {
    if (hovered === id) return;
    hovered = id;
    for (const l of hoverListeners) l();
  },
  subscribe: (fn: () => void): (() => void) => {
    hoverListeners.add(fn);
    return () => hoverListeners.delete(fn);
  },
};

export function useHoveredMessage(): string | null {
  return useSyncExternalStore(hoveredMessageStore.subscribe, hoveredMessageStore.get, hoveredMessageStore.get);
}
