import { describe, expect, it } from 'vitest';
import { buildImpactRequest, formatKrw } from './decisionAnalyticsForm';

const validDriver = { id: 'driver_1', label: '대상 인원', min: '820', mode: '900', max: '1010' };

describe('decision analytics impact form policy', () => {
  it('builds a bounded multiplicative KRW request from valid drafts', () => {
    expect(buildImpactRequest('12', [validDriver])).toEqual({
      ok: true,
      impact: {
        unit: 'KRW',
        model: 'multiplicative',
        fixedMultiplier: 12,
        drivers: [{ id: 'driver_1', label: '대상 인원', min: 820, mode: 900, max: 1010 }],
      },
    });
  });

  it.each([
    ['', [validDriver], '고정 배수'],
    ['0', [validDriver], '고정 배수'],
    ['12', [{ ...validDriver, label: '' }], '축 이름'],
    ['12', [{ ...validDriver, min: '1000', mode: '900' }], '최솟값 ≤ 기준값 ≤ 최댓값'],
    ['12', [{ ...validDriver, max: 'not-number' }], '숫자'],
    ['12', [], '1개 이상'],
    ['12', Array.from({ length: 7 }, (_, index) => ({ ...validDriver, id: `driver_${index + 1}` })) , '6개'],
  ])('rejects an invalid impact draft %#', (fixedMultiplier, drivers, message) => {
    const result = buildImpactRequest(fixedMultiplier, drivers);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(message);
  });

  it('formats intervals as Korean won without invented precision', () => {
    expect(formatKrw(1_234_567.8)).toBe('1,234,568원');
  });
});
