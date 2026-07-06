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
  const root = document.documentElement;
  // B2: suppress every transition for the duration of the swap so all elements
  // recolor in the same frame — kills the partial/staggered flash (composer,
  // buttons, sidebar all flipping at slightly different times). VSCode/Linear pattern.
  root.setAttribute('data-theme-switching', '');
  if (next === 'dark') root.setAttribute('data-theme', 'dark');
  else root.removeAttribute('data-theme');
  // Release after two frames so the style recalculation has fully committed.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => root.removeAttribute('data-theme-switching')),
  );
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
