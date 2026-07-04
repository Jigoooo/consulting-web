import { describe, it, expect } from 'vitest';
import { parseEnv } from '../src/config/env.schema.js';

const VALID = {
  APP_ENV: 'test',
  APP_PUBLIC_URL: 'http://localhost:5173',
  DATABASE_URL: 'postgres://u:p@127.0.0.1:5434/consulting',
  REDIS_URL: 'redis://127.0.0.1:6380',
  JWT_ACCESS_SECRET: 'x'.repeat(16),
  JWT_REFRESH_SECRET: 'y'.repeat(16),
  HERMES_API_BASE_URL: 'http://127.0.0.1:8000',
  HERMES_API_KEY: 'k',
};

describe('env validation (ADR-0014, acceptance #3)', () => {
  it('accepts a complete valid env', () => {
    const r = parseEnv(VALID as NodeJS.ProcessEnv);
    expect(r.ok).toBe(true);
    expect(r.env?.PORT).toBe(3000); // default applied
  });

  it('rejects when a required secret is missing', () => {
    const { JWT_ACCESS_SECRET, ...missing } = VALID;
    void JWT_ACCESS_SECRET;
    const r = parseEnv(missing as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
    expect(r.errors?.some((e) => e.includes('JWT_ACCESS_SECRET'))).toBe(true);
  });

  it('rejects a too-short jwt secret', () => {
    const r = parseEnv({ ...VALID, JWT_ACCESS_SECRET: 'short' } as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
  });

  it('rejects an invalid APP_ENV', () => {
    const r = parseEnv({ ...VALID, APP_ENV: 'prod' } as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
  });
});
