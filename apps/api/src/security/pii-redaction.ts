/**
 * Korean-aware PII detection & redaction (P5). Complements
 * redact-sensitive-text.ts (which targets credentials/secrets) by catching
 * PERSONAL identifiers: 주민등록번호, phone numbers, card numbers, emails.
 *
 * Pure, dependency-free, deterministic. Used to keep PII out of tenant audit
 * logs, eval fixtures, and any surface that persists model I/O.
 */

export type PiiKind = 'rrn' | 'phone' | 'card' | 'email';

export interface PiiFinding {
  kind: PiiKind;
  /** Character count of the matched span (never the value itself). */
  length: number;
}

export interface PiiScanResult {
  redacted: string;
  findings: PiiFinding[];
  hasPii: boolean;
}

// Order matters: RRN before phone (RRN's 6-digit prefix can look phone-like),
// card before phone (16-digit runs), email last.
const PII_PATTERNS: Array<{ kind: PiiKind; re: RegExp; token: string }> = [
  // 주민등록번호 6-7 (하이픈 필수, 성별코드 1-4/5-8)
  { kind: 'rrn', re: /\b\d{6}-[1-8]\d{6}\b/gu, token: '[REDACTED_RRN]' },
  // 신용카드 16자리 (하이픈/공백 구분 허용)
  { kind: 'card', re: /\b(?:\d[ -]?){15}\d\b/gu, token: '[REDACTED_CARD]' },
  // 이메일
  { kind: 'email', re: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, token: '[REDACTED_EMAIL]' },
  // 전화번호: 010-1234-5678, 02-123-4567, +82 10 1234 5678
  { kind: 'phone', re: /\b(?:\+?82[ -]?)?0?1[0-9][ -]?\d{3,4}[ -]?\d{4}\b/gu, token: '[REDACTED_PHONE]' },
  { kind: 'phone', re: /\b0\d{1,2}[ -]\d{3,4}[ -]\d{4}\b/gu, token: '[REDACTED_PHONE]' },
];

export function scanPii(input: string): PiiScanResult {
  const findings: PiiFinding[] = [];
  let redacted = input;
  for (const { kind, re, token } of PII_PATTERNS) {
    redacted = redacted.replace(re, (match) => {
      findings.push({ kind, length: match.length });
      return token;
    });
  }
  return { redacted, findings, hasPii: findings.length > 0 };
}

export function redactPii(input: string): string {
  return scanPii(input).redacted;
}

/** Aggregate finding counts by kind for audit metrics (no raw values). */
export function summarizePii(findings: PiiFinding[]): Record<PiiKind, number> {
  const summary: Record<PiiKind, number> = { rrn: 0, phone: 0, card: 0, email: 0 };
  for (const f of findings) summary[f.kind] += 1;
  return summary;
}
