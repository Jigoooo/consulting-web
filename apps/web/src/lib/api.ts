import { ConsultingApiClient } from '@consulting/api-client';
import { ApiClientError } from '@consulting/api-client';
import type { PublicUser } from '@consulting/contracts';
import { coordinateRefresh, waitForPeerRefresh, type RefreshLockManager } from './refreshCoordination';

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

async function tryRefresh(waitForPeerOnReject = false): Promise<boolean> {
  const current = authStore.get();
  if (!current) return false;
  const attemptedRefreshToken = current.refreshToken;
  try {
    const session = await api.refresh(attemptedRefreshToken);
    const resolution = resolveSuccessfulRefresh(attemptedRefreshToken, session, load(), authStore.get());
    if (resolution.action === 'apply') {
      applySession(resolution.session);
      return true;
    }
    if (resolution.action === 'adopt') {
      persist(resolution.session);
      return true;
    }
    if (resolution.action === 'preserve') return true;
    return false;
  } catch (err) {
    // C1: only clear when the server says the session is invalid. A network
    // error (status 0) or a 5xx is transient — keep the session and let the
    // caller's single request fail; a later attempt (or proactive refresh)
    // recovers without kicking the user to /login. A stale HMR/tab refresh
    // must also not clear a newer token rotation written to localStorage.
    const status = err instanceof ApiClientError ? err.status : undefined;
    if (status === 401 || status === 403) {
      const resolution = waitForPeerOnReject
        ? await resolveRejectedRefreshAfterPeer(
          attemptedRefreshToken,
          load,
          () => authStore.get(),
          () => waitForPeerRefresh(attemptedRefreshToken, load),
        )
        : resolveRejectedRefresh(attemptedRefreshToken, load(), authStore.get());
      if (resolution.action === 'adopt') {
        persist(resolution.session);
        return true;
      }
      if (resolution.action === 'preserve') return true;
      if (resolution.action === 'defer') return false;
      authStore.clear();
    }
    return false;
  }
}

type RejectedRefreshResolution<T> =
  | { action: 'adopt'; session: T }
  | { action: 'preserve' }
  | { action: 'defer' }
  | { action: 'clear' };

type SuccessfulRefreshResolution<TResponse, TCurrent> =
  | { action: 'apply'; session: TResponse }
  | { action: 'adopt'; session: TCurrent }
  | { action: 'preserve' }
  | { action: 'discard' };

export function resolveSuccessfulRefresh<TResponse, TCurrent extends { refreshToken: string }>(
  attemptedRefreshToken: string,
  response: TResponse,
  persisted: TCurrent | null,
  inMemory: TCurrent | null,
): SuccessfulRefreshResolution<TResponse, TCurrent> {
  if (persisted && persisted.refreshToken !== attemptedRefreshToken) {
    return { action: 'adopt', session: persisted };
  }
  if (inMemory && inMemory.refreshToken !== attemptedRefreshToken) {
    return { action: 'preserve' };
  }
  if (
    persisted?.refreshToken === attemptedRefreshToken
    && inMemory?.refreshToken === attemptedRefreshToken
  ) {
    return { action: 'apply', session: response };
  }
  return { action: 'discard' };
}

export function resolveRejectedRefresh<T extends { refreshToken: string }>(
  attemptedRefreshToken: string,
  persisted: T | null,
  inMemory: T | null,
): RejectedRefreshResolution<T> {
  if (persisted && persisted.refreshToken !== attemptedRefreshToken) {
    return { action: 'adopt', session: persisted };
  }
  if (inMemory && inMemory.refreshToken !== attemptedRefreshToken) {
    return { action: 'preserve' };
  }
  return { action: 'clear' };
}

export async function resolveRejectedRefreshAfterPeer<T extends { refreshToken: string }>(
  attemptedRefreshToken: string,
  getPersisted: () => T | null,
  getInMemory: () => T | null,
  waitForPeer: () => Promise<unknown>,
): Promise<RejectedRefreshResolution<T>> {
  const immediate = resolveRejectedRefresh(attemptedRefreshToken, getPersisted(), getInMemory());
  if (immediate.action !== 'clear') return immediate;
  await waitForPeer();
  const afterPeer = resolveRejectedRefresh(attemptedRefreshToken, getPersisted(), getInMemory());
  return afterPeer.action === 'clear' ? { action: 'defer' } : afterPeer;
}

export function shouldClearRejectedRefresh(
  attemptedRefreshToken: string,
  persisted: Pick<PersistedAuth, 'refreshToken'> | null,
  inMemory: Pick<PersistedAuth, 'refreshToken'> | null,
): boolean {
  return resolveRejectedRefresh(attemptedRefreshToken, persisted, inMemory).action === 'clear';
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
  const attemptedAccessToken = authStore.getAccessToken();
  const browserLocks: RefreshLockManager | undefined =
    typeof navigator !== 'undefined' && navigator.locks
      ? { request: (name, callback) => navigator.locks.request(name, () => callback()) }
      : undefined;
  refreshInFlight ??= coordinateRefresh(
    attemptedAccessToken,
    () => authStore.get(),
    () => tryRefresh(browserLocks === undefined),
    browserLocks,
  ).finally(() => {
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

/** Explicit logout: revoke the server refresh session, then cross-tab clear. */
export async function revokeAndClearSession(): Promise<void> {
  const current = authStore.get();
  if (!current) return;
  try {
    await api.logout(current.refreshToken);
  } finally {
    // A concurrent login/rotation owns a different token and must survive this
    // late logout completion.
    if (authStore.get()?.refreshToken === current.refreshToken) authStore.clear();
  }
}

if (typeof window !== 'undefined') {
  // Initial arm (also backfills accessExpiresAt for pre-C2 sessions). Keep this
  // after api construction: expired/legacy sessions may refresh immediately.
  scheduleProactiveRefresh();
}
