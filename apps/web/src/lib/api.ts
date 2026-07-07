import { ConsultingApiClient } from '@consulting/api-client';
import { ApiClientError } from '@consulting/api-client';
import type { PublicUser } from '@consulting/contracts';

const STORAGE_KEY = 'consulting.auth.v1';

interface PersistedAuth {
  accessToken: string;
  refreshToken: string;
  user: PublicUser;
  /** epoch ms when the access token expires (C2). Older persisted sessions may
   *  lack this — treated as "unknown" and refreshed proactively on load. */
  accessExpiresAt?: number;
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
  scheduleProactiveRefresh();
}

export const authStore = {
  get: (): PersistedAuth | null => state,
  getAccessToken: (): string | null => state?.accessToken ?? null,
  getUser: (): PublicUser | null => state?.user ?? null,
  isAuthed: (): boolean => state !== null,
  ensureFresh: (): Promise<boolean> => ensureFreshSession(),
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
 * 401 → one refresh-rotation attempt (single-flight) → retry; failure logs out
 * ONLY when the server explicitly rejects the session (401/403). Transient
 * network/5xx failures keep the session so a brief outage ≠ forced re-login (C1).
 */
let refreshInFlight: Promise<boolean> | null = null;

function applySession(session: { tokens: { accessToken: string; refreshToken: string; expiresInSec: number }; user: PublicUser }): void {
  authStore.setSession({
    accessToken: session.tokens.accessToken,
    refreshToken: session.tokens.refreshToken,
    user: session.user,
    accessExpiresAt: Date.now() + session.tokens.expiresInSec * 1000,
  });
}

async function tryRefresh(): Promise<boolean> {
  const current = authStore.get();
  if (!current) return false;
  try {
    const session = await api.refresh(current.refreshToken);
    applySession(session);
    return true;
  } catch (err) {
    // C1: only clear when the server says the session is invalid. A network
    // error (status 0) or a 5xx is transient — keep the session and let the
    // caller's single request fail; a later attempt (or proactive refresh)
    // recovers without kicking the user to /login.
    const status = err instanceof ApiClientError ? err.status : undefined;
    if (status === 401 || status === 403) {
      authStore.clear();
    }
    return false;
  }
}

// ── C2: proactive refresh scheduling ──────────────────────────────────────
// Refresh ~60s before the access token expires so long SSE streams never eat a
// mid-flight 401. Re-armed on every session change and on tab focus (background
// tabs throttle timers, so we recompute the remaining time on visibility).
const REFRESH_LEAD_MS = 60_000;
const ROUTE_REFRESH_GRACE_MS = 5_000;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function shouldRefreshForRoute(current: PersistedAuth): boolean {
  return current.accessExpiresAt === undefined || current.accessExpiresAt - Date.now() <= ROUTE_REFRESH_GRACE_MS;
}

function ensureFreshSession(): Promise<boolean> {
  const current = state;
  if (!current) return Promise.resolve(false);
  if (!shouldRefreshForRoute(current)) return Promise.resolve(true);
  return kickRefresh();
}

function scheduleProactiveRefresh(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  const current = state;
  if (!current) return;
  // Legacy session without accessExpiresAt → refresh once now to backfill it.
  if (current.accessExpiresAt === undefined) {
    void kickRefresh();
    return;
  }
  const delay = current.accessExpiresAt - Date.now() - REFRESH_LEAD_MS;
  if (delay <= 0) {
    void kickRefresh();
    return;
  }
  refreshTimer = setTimeout(() => void kickRefresh(), delay);
}

function kickRefresh(): Promise<boolean> {
  refreshInFlight ??= tryRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

if (typeof window !== 'undefined') {
  // Re-arm on tab focus (timers may have been throttled while backgrounded).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleProactiveRefresh();
  });
  // Cross-tab session sync: another tab logging in/out/refreshing updates us.
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return;
    state = load();
    for (const l of listeners) l();
    scheduleProactiveRefresh();
  });
}

export const api = new ConsultingApiClient({
  baseUrl: import.meta.env.VITE_API_BASE_URL ?? '/api',
  getAccessToken: () => authStore.getAccessToken(),
  onUnauthorized: () => kickRefresh(),
});

if (typeof window !== 'undefined') {
  // Initial arm (also backfills accessExpiresAt for pre-C2 sessions). Keep this
  // after api construction: expired/legacy sessions may refresh immediately.
  scheduleProactiveRefresh();
}
