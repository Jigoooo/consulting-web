export interface AuthIdentitySource {
  getUserId(): string | null;
  subscribe(listener: () => void): () => void;
}

/**
 * Logout and account switching are hard identity boundaries. Clear every
 * user-scoped browser cache when the user id changes, but do nothing for a
 * same-user token rotation.
 */
export function bindAuthIdentityIsolation(
  auth: AuthIdentitySource,
  clearUserScopedState: () => void,
): () => void {
  let previousUserId = auth.getUserId();
  return auth.subscribe(() => {
    const currentUserId = auth.getUserId();
    if (currentUserId === previousUserId) return;
    previousUserId = currentUserId;
    clearUserScopedState();
  });
}
