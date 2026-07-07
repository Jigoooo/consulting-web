import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthService } from '../src/health/health.service.js';
import type { Env } from '../src/config/env.schema.js';

const env: Env = {
  APP_ENV: 'test',
  APP_PUBLIC_URL: 'http://localhost:3000',
  PORT: 3000,
  DATABASE_URL: 'postgres://u:***@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'x'.repeat(16),
  JWT_REFRESH_SECRET: 'y'.repeat(16),
  HERMES_API_BASE_URL: 'http://hermes.local',
  HERMES_API_KEY: 'test-key',
  VAPID_SUBJECT: 'mailto:admin@localhost',
};

describe('HealthService Hermes readiness', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports hermes ok when Hermes API health endpoint is reachable', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ ok: 1 }] }) };
    const redis = { ping: vi.fn().mockResolvedValue('PONG') };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'ok' }), { status: 200 })));

    const service = new (HealthService as any)(pool, redis, env) as HealthService;
    const ready = await service.ready();

    expect(ready.status).toBe('ok');
    expect(ready.components).toMatchObject({ db: 'ok', redis: 'ok', hermes: 'ok' });
    expect(fetch).toHaveBeenCalledWith('http://hermes.local/v1/health', expect.objectContaining({ method: 'GET' }));
  });
});
