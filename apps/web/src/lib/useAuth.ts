import { useSyncExternalStore } from 'react';
import { authStore, revokeAndClearSession } from './api';

/** React binding for the auth store — re-renders on login/logout. */
export function useAuth() {
  const snapshot = useSyncExternalStore(authStore.subscribe, authStore.get, authStore.get);
  return {
    session: snapshot,
    user: snapshot?.user ?? null,
    isAuthed: snapshot !== null,
    logout: revokeAndClearSession,
  };
}
