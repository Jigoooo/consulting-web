import { describe, expect, it, vi } from 'vitest';
import { coordinateRefresh, waitForPeerRefresh } from './refreshCoordination';

class SerialLockManager {
  private tail = Promise.resolve();

  request<T>(_name: string, callback: () => Promise<T>): Promise<T> {
    const result = this.tail.then(callback);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

describe('coordinateRefresh', () => {
  it('serializes cross-tab rotations and lets the loser adopt the winner token', async () => {
    const locks = new SerialLockManager();
    let session = { accessToken: 'access-v1' };
    const rotate = vi.fn(async () => {
      await Promise.resolve();
      session = { accessToken: 'access-v2' };
      return true;
    });

    const [first, second] = await Promise.all([
      coordinateRefresh('access-v1', () => session, rotate, locks),
      coordinateRefresh('access-v1', () => session, rotate, locks),
    ]);

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(rotate).toHaveBeenCalledTimes(1);
  });

  it('returns false without rotating after logout while waiting for the lock', async () => {
    const locks = new SerialLockManager();
    let session: { accessToken: string } | null = { accessToken: 'access-v1' };
    const rotate = vi.fn(() => Promise.resolve(true));

    const blocker = locks.request('consulting-auth-refresh', () => {
      session = null;
      return Promise.resolve(true);
    });
    const result = coordinateRefresh('access-v1', () => session, rotate, locks);
    await blocker;

    expect(await result).toBe(false);
    expect(rotate).not.toHaveBeenCalled();
  });

  it('waits for and adopts a peer rotation when Web Locks are unavailable', async () => {
    let session: { refreshToken: string } | null = { refreshToken: 'refresh-v1' };
    const sleep = vi.fn(() => {
      session = { refreshToken: 'refresh-v2' };
      return Promise.resolve();
    });

    const won = await waitForPeerRefresh(
      'refresh-v1',
      () => session,
      { timeoutMs: 100, pollMs: 10, sleep },
    );

    expect(won).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});
