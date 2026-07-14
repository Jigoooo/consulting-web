export interface AuthStatusSource {
  isAuthed(): boolean;
  subscribe(listener: () => void): () => void;
}

/** Re-run route guards when login/logout state crosses its boundary.
 * Token rotation keeps `isAuthed` true and must not churn the router. */
export function bindAuthRouterInvalidation(
  auth: AuthStatusSource,
  invalidate: () => void,
): () => void {
  let previous = auth.isAuthed();
  return auth.subscribe(() => {
    const current = auth.isAuthed();
    if (current === previous) return;
    previous = current;
    invalidate();
  });
}
