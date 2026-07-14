import { describe, expect, it } from 'vitest';
import { redactPii, scanPii, summarizePii } from '../src/security/pii-redaction.js';

describe('scanPii', () => {
  it('redacts a Korean resident registration number', () => {
    const r = scanPii('주민번호는 900101-1234567 입니다.');
    expect(r.hasPii).toBe(true);
    expect(r.redacted).toContain('[REDACTED_RRN]');
    expect(r.redacted).not.toContain('900101-1234567');
    expect(r.findings.some((f) => f.kind === 'rrn')).toBe(true);
  });

  it('redacts foreign resident registration numbers with discriminator 5 through 8', () => {
    for (const discriminator of ['5', '6', '7', '8']) {
      const raw = `900101-${discriminator}123456`;
      const r = scanPii(raw);
      expect(r.redacted).toBe('[REDACTED_RRN]');
      expect(r.findings).toEqual([{ kind: 'rrn', length: raw.length }]);
    }
  });

  it('redacts Korean mobile and landline phone numbers', () => {
    const r = scanPii('연락처 010-1234-5678 또는 02-123-4567 로 주세요.');
    expect(r.redacted).not.toContain('010-1234-5678');
    expect(r.redacted).not.toContain('02-123-4567');
    expect(r.findings.filter((f) => f.kind === 'phone').length).toBeGreaterThanOrEqual(2);
  });

  it('redacts a 16-digit card number with separators', () => {
    const r = scanPii('카드 1234-5678-9012-3456 결제');
    expect(r.redacted).toContain('[REDACTED_CARD]');
    expect(r.redacted).not.toContain('3456');
  });

  it('redacts email addresses', () => {
    const r = scanPii('메일 hong@example.co.kr 로 회신');
    expect(r.redacted).toContain('[REDACTED_EMAIL]');
    expect(r.redacted).not.toContain('hong@example.co.kr');
  });

  it('reports no PII for clean text', () => {
    const r = scanPii('정원 12명에서 15명으로 증가했습니다.');
    expect(r.hasPii).toBe(false);
    expect(r.findings).toEqual([]);
    expect(r.redacted).toBe('정원 12명에서 15명으로 증가했습니다.');
  });

  it('never leaks the raw PII value into findings (length only)', () => {
    const r = scanPii('900101-1234567');
    expect(JSON.stringify(r.findings)).not.toContain('1234567');
    expect(r.findings[0]!.length).toBe('900101-1234567'.length);
  });

  it('redacts multiple PII kinds in one pass', () => {
    const r = scanPii('900101-1234567, 010-1234-5678, a@b.com');
    const summary = summarizePii(r.findings);
    expect(summary.rrn).toBe(1);
    expect(summary.phone).toBe(1);
    expect(summary.email).toBe(1);
  });

  it('redactPii is a pure convenience wrapper', () => {
    expect(redactPii('a@b.com')).toBe(scanPii('a@b.com').redacted);
  });
});

describe('summarizePii', () => {
  it('returns a zeroed summary for no findings', () => {
    expect(summarizePii([])).toEqual({ rrn: 0, phone: 0, card: 0, email: 0 });
  });
});
