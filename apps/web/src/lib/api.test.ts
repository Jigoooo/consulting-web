import { describe, expect, it } from 'vitest';
import {
  resolveRejectedRefresh,
  resolveRejectedRefreshAfterPeer,
  resolveSuccessfulRefresh,
  shouldClearRejectedRefresh,
} from './api';

describe('refresh-token rotation ownership', () => {
  it('preserves a newer persisted session when an older refresh attempt is rejected', () => {
    expect(shouldClearRejectedRefresh('refresh-v1', { refreshToken: 'refresh-v2' }, { refreshToken: 'refresh-v1' })).toBe(false);
  });

  it('clears the session when the rejected refresh still owns the newest token', () => {
    expect(shouldClearRejectedRefresh('refresh-v1', { refreshToken: 'refresh-v1' }, { refreshToken: 'refresh-v1' })).toBe(true);
  });

  it('adopts a newer persisted session so the rejected caller can retry immediately', () => {
    const newer = { refreshToken: 'refresh-v2', accessToken: 'access-v2' };
    expect(resolveRejectedRefresh('refresh-v1', newer, { refreshToken: 'refresh-v1', accessToken: 'access-v1' }))
      .toEqual({ action: 'adopt', session: newer });
  });

  it('rechecks ownership after a no-Web-Locks loser waits for the peer winner', async () => {
    const old = { refreshToken: 'refresh-v1', accessToken: 'access-v1' };
    const newer = { refreshToken: 'refresh-v2', accessToken: 'access-v2' };
    let persisted = old;

    const result = await resolveRejectedRefreshAfterPeer(
      'refresh-v1',
      () => persisted,
      () => old,
      () => {
        persisted = newer;
        return Promise.resolve();
      },
    );

    expect(result).toEqual({ action: 'adopt', session: newer });
  });

  it('defers instead of clearing shared storage when no peer wins before fallback timeout', async () => {
    const old = { refreshToken: 'refresh-v1', accessToken: 'access-v1' };

    const result = await resolveRejectedRefreshAfterPeer(
      'refresh-v1',
      () => old,
      () => old,
      () => Promise.resolve(),
    );

    expect(result).toEqual({ action: 'defer' });
  });

  it('does not let a late successful refresh overwrite a newer login', () => {
    const response = { refreshToken: 'refresh-from-old-request' };
    const newer = { refreshToken: 'refresh-v2', accessToken: 'access-v2' };
    expect(resolveSuccessfulRefresh(
      'refresh-v1',
      response,
      newer,
      { refreshToken: 'refresh-v1', accessToken: 'access-v1' },
    ))
      .toEqual({ action: 'adopt', session: newer });
  });

  it('discards a late successful refresh after logout', () => {
    expect(resolveSuccessfulRefresh('refresh-v1', { refreshToken: 'refresh-v2' }, null, null))
      .toEqual({ action: 'discard' });
  });

  it('applies a successful refresh only while the attempt still owns both session copies', () => {
    const response = { refreshToken: 'refresh-v2' };
    expect(resolveSuccessfulRefresh(
      'refresh-v1',
      response,
      { refreshToken: 'refresh-v1' },
      { refreshToken: 'refresh-v1' },
    )).toEqual({ action: 'apply', session: response });
  });
});
