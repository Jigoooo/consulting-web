import { describe, it, expect } from 'vitest';
import {
  AuthSessionResponseSchema,
  SignUpResponseSchema,
  PublicUserSchema,
  HealthResponseSchema,
} from '../src/index.js';

/**
 * ADR-0007/0014: response contracts must never carry secrets.
 * This test fails loudly if someone adds password_hash / hermes key / raw secret
 * fields to a public response schema.
 */
const FORBIDDEN_KEYS = [
  'passwordHash',
  'password_hash',
  'hermesApiKey',
  'hermes_api_key',
  'jwtSecret',
  'refreshSecret',
  'dbPassword',
];

function keysOf(schema: { shape?: Record<string, unknown> }): string[] {
  return schema.shape ? Object.keys(schema.shape) : [];
}

describe('no secret leak in response contracts', () => {
  it('PublicUser has no secret fields', () => {
    const keys = keysOf(PublicUserSchema as never);
    for (const forbidden of FORBIDDEN_KEYS) {
      expect(keys).not.toContain(forbidden);
    }
    expect(keys).toContain('email');
    expect(keys).not.toContain('password');
  });

  it('SignUpResponse parses a clean payload and rejects extra secret keys', () => {
    const clean = {
      user: {
        id: '00000000-0000-0000-0000-000000000001',
        email: 'a@b.com',
        displayName: 'A',
        status: 'active' as const,
      },
      personalWorkspaceId: '00000000-0000-0000-0000-000000000002',
      tokens: { accessToken: 'x', refreshToken: 'y', expiresInSec: 900 },
    };
    const parsed = SignUpResponseSchema.parse(clean);
    expect(parsed.user.email).toBe('a@b.com');

    const leakedUserSecret = SignUpResponseSchema.safeParse({
      ...clean,
      user: { ...clean.user, passwordHash: 'hash-that-must-not-cross-contract' },
    });
    expect(leakedUserSecret.success).toBe(false);

    const leakedTopLevelSecret = SignUpResponseSchema.safeParse({
      ...clean,
      tokenHash: 'raw-or-hashed-internal-token',
    });
    expect(leakedTopLevelSecret.success).toBe(false);
  });

  it('AuthSessionResponse exposes only public user and intended tokens', () => {
    const clean = {
      user: {
        id: '00000000-0000-0000-0000-000000000001',
        email: 'a@b.com',
        displayName: 'A',
        status: 'active' as const,
      },
      tokens: { accessToken: 'access.jwt', refreshToken: 'refresh.jwt', expiresInSec: 900 },
    };
    expect(AuthSessionResponseSchema.parse(clean)).toEqual(clean);
    expect(AuthSessionResponseSchema.safeParse({
      ...clean,
      user: { ...clean.user, passwordHash: 'hash' },
    }).success).toBe(false);
    expect(AuthSessionResponseSchema.safeParse({
      ...clean,
      jwtSecret: 'server-secret',
    }).success).toBe(false);
  });

  it('HealthResponse requires all component statuses', () => {
    const r = HealthResponseSchema.safeParse({
      status: 'ok',
      components: { api: 'ok', db: 'ok', redis: 'ok', bullmq: 'ok', hermes: 'degraded' },
      version: '0.0.0',
      time: new Date().toISOString(),
    });
    expect(r.success).toBe(true);
  });
});
