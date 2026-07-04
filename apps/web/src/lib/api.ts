import { ConsultingApiClient } from '@consulting/api-client';
import type { PublicUser } from '@consulting/contracts';

const STORAGE_KEY = 'consulting.auth.v1';

interface PersistedAuth {
  accessToken: string;
  refreshToken: string;
  user: PublicUser;
}

/**
 * Auth store. Phase 1-L: access+refresh+user persisted to localStorage so a
 * reload keeps the session. Phase 2 will move refresh to an httpOnly cookie;
 * the public getters stay the same so callers won't change.
 *
 * NOTE: localStorage is XSS-readable — acceptable for this phase (no secrets
 * beyond the user's own session tokens), hardened later with cookie rotation.
 */
let state: PersistedAuth | null = load();
const listeners = new Set<() => void>();

function load(): PersistedAuth | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PersistedAuth) : null;
  } catch {
    return null;
  }
}

function persist(next: PersistedAuth | null): void {
  state = next;
  try {
    if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable — keep in-memory */
  }
  for (const l of listeners) l();
}

export const authStore = {
  get: (): PersistedAuth | null => state,
  getAccessToken: (): string | null => state?.accessToken ?? null,
  getUser: (): PublicUser | null => state?.user ?? null,
  isAuthed: (): boolean => state !== null,
  setSession: (session: PersistedAuth): void => persist(session),
  clear: (): void => persist(null),
  subscribe: (fn: () => void): (() => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export type AuthStore = typeof authStore;

/**
 * Single API client. Dev: browser → Vite proxy /api → NestJS. Prod: same-origin.
 * Secrets (Hermes key, JWT secret) never reach the browser.
 */
export const api = new ConsultingApiClient({
  baseUrl: import.meta.env.VITE_API_BASE_URL ?? '/api',
  getAccessToken: () => authStore.getAccessToken(),
});
