import { useSyncExternalStore } from 'react';

/** Theme choice. System is used only as the first-load default; user toggles light/dark only. */
export type Theme = 'light' | 'dark';
const KEY = 'consulting.theme.v1';

let theme: Theme = (() => {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'dark' || v === 'light') return v;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
})();
const listeners = new Set<() => void>();

function apply(next: Theme): void {
  if (next === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
}

if (typeof window !== 'undefined') {
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
    themeStore.set(theme === 'dark' ? 'light' : 'dark');
  },
  subscribe: (fn: () => void): (() => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export function useTheme(): Theme {
  return useSyncExternalStore(themeStore.subscribe, themeStore.get, themeStore.get);
}
