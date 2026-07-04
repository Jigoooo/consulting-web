import { describe, expect, it } from 'vitest';
import { ApiErrorSchema, ApiErrorCodeSchema } from '../src/index.js';

describe('api error contract', () => {
  it('accepts a strict {code, message} envelope', () => {
    const clean = { code: 'FORBIDDEN', message: 'Thread access denied' };
    expect(ApiErrorSchema.parse(clean)).toEqual(clean);
  });

  it('rejects unknown fields (no secret smuggling)', () => {
    expect(() => ApiErrorSchema.parse({ code: 'FORBIDDEN', message: 'x', stack: 'secret' })).toThrow();
  });

  it('requires a non-empty message', () => {
    expect(() => ApiErrorSchema.parse({ code: 'INTERNAL', message: '' })).toThrow();
  });

  it('enumerates the known domain error codes', () => {
    for (const code of ['VALIDATION', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'IDEMPOTENCY', 'PRECONDITION', 'INTERNAL']) {
      expect(ApiErrorCodeSchema.parse(code)).toBe(code);
    }
    expect(() => ApiErrorCodeSchema.parse('TEAPOT')).toThrow();
  });
});
