export interface RefreshSessionIdentity {
  accessToken: string;
}

export interface RefreshLockManager {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

const REFRESH_LOCK_NAME = 'consulting-auth-refresh';

/**
 * Serialize refresh rotation across browser tabs. After waiting for the lock,
 * re-read the session: if another tab already installed a new access token,
 * adopt it instead of rotating the now-consumed refresh token again.
 */
export async function coordinateRefresh(
  attemptedAccessToken: string | null,
  getCurrent: () => RefreshSessionIdentity | null,
  rotate: () => Promise<boolean>,
  locks?: RefreshLockManager,
): Promise<boolean> {
  const insideLock = async (): Promise<boolean> => {
    const current = getCurrent();
    if (!current) return false;
    if (attemptedAccessToken !== null && current.accessToken !== attemptedAccessToken) return true;
    return rotate();
  };
  return locks ? locks.request(REFRESH_LOCK_NAME, insideLock) : insideLock();
}

export interface PeerRefreshWaitOptions {
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Web Locks fallback: a CAS loser waits for the winning tab to persist its new
 * refresh token instead of immediately clearing the shared session on 401.
 */
export async function waitForPeerRefresh<T extends { refreshToken: string }>(
  attemptedRefreshToken: string,
  getCurrent: () => T | null,
  options: PeerRefreshWaitOptions = {},
): Promise<boolean> {
  const timeoutMs = Math.max(0, options.timeoutMs ?? 16_000);
  const pollMs = Math.max(1, options.pollMs ?? 25);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const attempts = Math.ceil(timeoutMs / pollMs);

  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    const current = getCurrent();
    if (!current) return false;
    if (current.refreshToken !== attemptedRefreshToken) return true;
    if (attempt < attempts) await sleep(pollMs);
  }
  return false;
}
