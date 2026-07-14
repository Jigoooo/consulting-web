import { describe, expect, it, vi } from 'vitest';
import { bindAuthIdentityIsolation, type AuthIdentitySource } from './auth-identity-isolation';

function source(initial: string | null) {
  let userId = initial;
  const listeners = new Set<() => void>();
  const auth: AuthIdentitySource = {
    getUserId: () => userId,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    auth,
    change(next: string | null) {
      userId = next;
      for (const listener of listeners) listener();
    },
  };
}

describe('bindAuthIdentityIsolation', () => {
  it('clears user-scoped caches on logout and account switch', () => {
    const s = source('user-a');
    const clear = vi.fn();
    const unbind = bindAuthIdentityIsolation(s.auth, clear);

    s.change(null);
    s.change('user-b');

    expect(clear).toHaveBeenCalledTimes(2);
    unbind();
  });

  it('does not clear caches for same-user token rotation', () => {
    const s = source('user-a');
    const clear = vi.fn();
    bindAuthIdentityIsolation(s.auth, clear);

    s.change('user-a');

    expect(clear).not.toHaveBeenCalled();
  });
});
