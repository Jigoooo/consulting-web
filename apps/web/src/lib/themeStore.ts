import { useSyncExternalStore } from 'react';

/** Theme choice (Phase 2-D G-1). 'system' follows the OS preference. */
export type Theme = 'light' | 'dark' | 'system';
const KEY = 'consulting.theme.v1';

let theme: Theme = (() => {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'dark' || v === 'light' || v === 'system' ? v : 'light';
  } catch {
    return 'light';
  }
})();
const listeners = new Set<() => void>();

function apply(next: Theme): void {
  const dark = next === 'dark' || (next === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (dark) document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
}

// React to OS theme flips while in 'system' mode.
if (typeof window !== 'undefined') {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (theme === 'system') apply(theme);
  });
  apply(theme);
}

export const themeStore = {
  get: (): Theme => theme,
  set: (next: Theme): void => {
    theme = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* ignore */
    }
    apply(next);
    for (const l of listeners) l();
  },
  cycle: (): void => {
    const order: Theme[] = ['light', 'dark', 'system'];
    themeStore.set(order[(order.indexOf(theme) + 1) % order.length]!);
  },
  subscribe: (fn: () => void): (() => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export function useTheme(): Theme {
  return useSyncExternalStore(themeStore.subscribe, themeStore.get, themeStore.get);
}
