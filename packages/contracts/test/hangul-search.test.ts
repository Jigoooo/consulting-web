import { describe, expect, it } from 'vitest';
import {
  decomposeJamo,
  chosung,
  normalizeSearch,
  isChosungQuery,
  hangulMatch,
  highlightRanges,
} from '../src/hangul-search.js';

describe('normalizeSearch', () => {
  it('lowercases and strips all whitespace', () => {
    expect(normalizeSearch('  Hello   World ')).toBe('helloworld');
    expect(normalizeSearch('창원 예산')).toBe('창원예산');
  });
});

describe('chosung', () => {
  it('extracts leading consonants from syllables', () => {
    expect(chosung('창원시')).toBe('ㅊㅇㅅ');
    expect(chosung('예산서')).toBe('ㅇㅅㅅ');
  });
  it('passes non-hangul through unchanged', () => {
    expect(chosung('AB가')).toBe('ABㄱ');
  });
});

describe('decomposeJamo', () => {
  it('splits syllables into constituent jamo', () => {
    // 창 = ㅊ+ㅏ+ㅇ
    expect(decomposeJamo('창')).toBe('ㅊㅏㅇ');
    // 가 = ㄱ+ㅏ (no final)
    expect(decomposeJamo('가')).toBe('ㄱㅏ');
  });
  it('leaves standalone jamo and latin untouched', () => {
    expect(decomposeJamo('ㅊㅇ')).toBe('ㅊㅇ');
    expect(decomposeJamo('ab')).toBe('ab');
  });
});

describe('isChosungQuery', () => {
  it('true when query is all leading-consonant jamo', () => {
    expect(isChosungQuery('ㅊㅇㅅ')).toBe(true);
    expect(isChosungQuery('ㄱㄴㄷ')).toBe(true);
  });
  it('false when query contains syllables or vowels', () => {
    expect(isChosungQuery('창원')).toBe(false);
    expect(isChosungQuery('ㅏㅓ')).toBe(false);
    expect(isChosungQuery('')).toBe(false);
  });
});

describe('hangulMatch', () => {
  it('chosung query matches by leading consonants', () => {
    expect(hangulMatch('창원시 예산서', 'ㅊㅇㅅ')).toBe(true);
    expect(hangulMatch('창원시 예산서', 'ㅊㅇ')).toBe(true);
  });
  it('whitespace-insensitive substring match', () => {
    expect(hangulMatch('창원예산서', '창원 예산')).toBe(true);
    expect(hangulMatch('창원 예산서', '창원예산')).toBe(true);
  });
  it('partial jamo (composition) match', () => {
    // '차' decomposes to ㅊ+ㅏ which is a prefix of '창'(ㅊ+ㅏ+ㅇ)
    expect(hangulMatch('창원시', '차')).toBe(true);
  });
  it('latin substring still works', () => {
    expect(hangulMatch('Hello World', 'world')).toBe(true);
  });
  it('does not match unrelated text', () => {
    expect(hangulMatch('예산서', '상')).toBe(false);
    expect(hangulMatch('창원시', 'ㅂㅈ')).toBe(false);
  });
  it('empty query matches everything', () => {
    expect(hangulMatch('anything', '')).toBe(true);
  });
});

describe('highlightRanges', () => {
  it('returns char range for whitespace-insensitive substring hit', () => {
    // '창원 예산서' contains '예산' at index 3..5 (original text indices)
    const ranges = highlightRanges('창원 예산서', '예산');
    expect(ranges.length).toBeGreaterThan(0);
    const [start, end] = ranges[0]!;
    expect('창원 예산서'.slice(start, end)).toContain('예산');
  });
  it('returns empty for chosung-only match (bubble-level highlight fallback)', () => {
    expect(highlightRanges('창원시', 'ㅊㅇㅅ')).toEqual([]);
  });
});
