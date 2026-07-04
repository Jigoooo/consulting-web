import { ConsultingApiClient } from '@consulting/api-client';

/**
 * Auth token store. Phase 1-K: in-memory access token (survives route changes,
 * cleared on reload). Phase 1-L will layer refresh-token rotation via an
 * httpOnly cookie set by the API; the getter stays the same so callers don't change.
 */
let accessToken: string | null = null;
const listeners = new Set<(token: string | null) => void>();

export const authStore = {
  get: (): string | null => accessToken,
  set: (token: string | null): void => {
    accessToken = token;
    for (const l of listeners) l(token);
  },
  clear: (): void => authStore.set(null),
  subscribe: (fn: (token: string | null) => void): (() => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  isAuthed: (): boolean => accessToken !== null,
};

/**
 * Single API client instance for the app. In dev the browser talks to the
 * Vite proxy at /api → NestJS; in prod the same-origin API path is used.
 * Secrets (Hermes key, JWT secret) never reach this client.
 */
export const api = new ConsultingApiClient({
  baseUrl: import.meta.env.VITE_API_BASE_URL ?? '/api',
  getAccessToken: () => authStore.get(),
});
