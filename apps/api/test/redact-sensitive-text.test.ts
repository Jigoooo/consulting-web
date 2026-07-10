import { describe, expect, it } from 'vitest';
import { redactLogText } from '../src/security/redact-sensitive-text.js';

describe('redactLogText', () => {
  it('removes credentials and control characters before persistence logs', () => {
    const input = 'redis://worker:***@127.0.0.1:6379\nforged-log-entry';
    expect(redactLogText(input)).toBe('[REDACTED_DATABASE_URL] forged-log-entry');
  });

  it('bounds untrusted error text', () => {
    expect(redactLogText('x'.repeat(100), 12)).toBe('x'.repeat(12));
  });
});
