import { describe, it, expect } from 'vitest';
import { formatDateLabel, formatFullDateTime, isSameLocalDay, dayKey } from './formatDate';

// KST 고정 검증을 위해 명시적 로컬 날짜로 Date 구성. 테스트는 시스템 TZ와
// 무관하게 "같은 달력 날짜인가"의 상대표기 로직만 본다(로컬 기준 계산).
describe('formatDate', () => {
  const now = new Date(2026, 6, 6, 14, 30); // 2026-07-06 14:30 local

  it('오늘 → "오늘"', () => {
    const d = new Date(2026, 6, 6, 9, 0);
    expect(formatDateLabel(d, now)).toBe('오늘');
  });

  it('어제 → "어제"', () => {
    const d = new Date(2026, 6, 5, 23, 0);
    expect(formatDateLabel(d, now)).toBe('어제');
  });

  it('같은 해 과거 → "M월 D일"', () => {
    const d = new Date(2026, 5, 30, 12, 0);
    expect(formatDateLabel(d, now)).toBe('6월 30일');
  });

  it('다른 해 → "YYYY년 M월 D일"', () => {
    const d = new Date(2025, 11, 31, 12, 0);
    expect(formatDateLabel(d, now)).toBe('2025년 12월 31일');
  });

  it('미래(다음날) → "M월 D일" (오늘/어제 아님)', () => {
    const d = new Date(2026, 6, 7, 1, 0);
    expect(formatDateLabel(d, now)).toBe('7월 7일');
  });

  it('isSameLocalDay: 같은 날 다른 시각 → true', () => {
    expect(isSameLocalDay(new Date(2026, 6, 6, 1, 0), new Date(2026, 6, 6, 23, 0))).toBe(true);
  });

  it('isSameLocalDay: 자정 경계 다른 날 → false', () => {
    expect(isSameLocalDay(new Date(2026, 6, 6, 23, 59), new Date(2026, 6, 7, 0, 1))).toBe(false);
  });

  it('dayKey: 같은 날은 동일 키, 다른 날은 다른 키', () => {
    expect(dayKey(new Date(2026, 6, 6, 1, 0))).toBe(dayKey(new Date(2026, 6, 6, 23, 0)));
    expect(dayKey(new Date(2026, 6, 6, 1, 0))).not.toBe(dayKey(new Date(2026, 6, 7, 1, 0)));
  });

  it('ISO 문자열 입력도 허용', () => {
    const iso = new Date(2026, 6, 6, 9, 0).toISOString();
    expect(formatDateLabel(iso, now)).toBe('오늘');
  });

  it('formatFullDateTime: 전체 날짜+시간 문자열', () => {
    const d = new Date(2026, 6, 6, 14, 5);
    const out = formatFullDateTime(d);
    expect(out).toContain('2026');
    expect(out).toContain('7');
    expect(out).toContain('6');
  });

  it('잘못된 입력은 빈 문자열', () => {
    expect(formatDateLabel('not-a-date', now)).toBe('');
    expect(dayKey('not-a-date')).toBe('');
  });
});
