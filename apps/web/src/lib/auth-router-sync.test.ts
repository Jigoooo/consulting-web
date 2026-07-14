import { describe, expect, it, vi } from 'vitest';
import { bindAuthRouterInvalidation } from './auth-router-sync';

describe('auth router synchronization', () => {
  it('invalidates protected routes only when authenticated state changes', () => {
    let authed = true;
    let listener: (() => void) | null = null;
    const invalidate = vi.fn();
    const unsubscribe = bindAuthRouterInvalidation(
      {
        isAuthed: () => authed,
        subscribe: (next) => {
          listener = next;
          return () => { listener = null; };
        },
      },
      invalidate,
    );

    listener!();
    expect(invalidate).not.toHaveBeenCalled();
    authed = false;
    listener!();
    expect(invalidate).toHaveBeenCalledTimes(1);
    listener!();
    expect(invalidate).toHaveBeenCalledTimes(1);
    authed = true;
    listener!();
    expect(invalidate).toHaveBeenCalledTimes(2);

    unsubscribe();
    expect(listener).toBeNull();
  });
});
