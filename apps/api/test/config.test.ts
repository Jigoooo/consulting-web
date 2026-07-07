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
    expect(r.env?.VOYAGE_MULTIMODAL_ENABLED).toBe(false);
    expect(r.env?.VOYAGE_MULTIMODAL_MODEL).toBe('voyage-multimodal-3.5');
    expect(r.env?.VERIFIER_LLM_ENABLED).toBe(false);
    expect(r.env?.VERIFIER_LLM_TIMEOUT_MS).toBe(30_000);
  });

  it('accepts Voyage multimodal settings without exposing the key to browser contracts', () => {
    const r = parseEnv({ ...VALID, VOYAGE_MULTIMODAL_ENABLED: 'true', VOYAGE_API_KEY: 'voyage-test-key', VOYAGE_MULTIMODAL_MODEL: 'voyage-multimodal-3' } as NodeJS.ProcessEnv);
    expect(r.ok).toBe(true);
    expect(r.env?.VOYAGE_MULTIMODAL_ENABLED).toBe(true);
    expect(r.env?.VOYAGE_MULTIMODAL_MODEL).toBe('voyage-multimodal-3');
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

  it('rejects invalid boolean flag strings instead of coercing them to false', () => {
    const r = parseEnv({ ...VALID, CONSULTING_DEFAULT_TEMPLATE_ENABLED: 'foo' } as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
    expect(r.errors?.some((e) => e.includes('CONSULTING_DEFAULT_TEMPLATE_ENABLED'))).toBe(true);
  });

  it('accepts env-gated verifier LLM settings', () => {
    const r = parseEnv({ ...VALID, VERIFIER_LLM_ENABLED: 'true', VERIFIER_LLM_MODEL: 'gpt-5.5', VERIFIER_LLM_TIMEOUT_MS: '12000' } as NodeJS.ProcessEnv);
    expect(r.ok).toBe(true);
    expect(r.env?.VERIFIER_LLM_ENABLED).toBe(true);
    expect(r.env?.VERIFIER_LLM_MODEL).toBe('gpt-5.5');
    expect(r.env?.VERIFIER_LLM_TIMEOUT_MS).toBe(12_000);
  });
});
