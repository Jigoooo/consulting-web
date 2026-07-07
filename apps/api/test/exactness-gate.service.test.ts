import { describe, expect, it } from 'vitest';
import { ExactnessGateService } from '../src/consulting/exactness-gate.service.js';

const service = new ExactnessGateService();

describe('ExactnessGateService', () => {
  it('routes arithmetic and consulting decision numbers through two-pass Decimal verification', () => {
    const result = service.evaluate({
      query: '정원 12명에서 15명으로 늘면 증감률을 계산해줘',
      checks: [{ id: 'growth', kind: 'percentage_change', oldValue: '12', newValue: '15' }],
    });

    expect(result.required).toBe(true);
    expect(result.status).toBe('passed');
    expect(result.checks[0]).toMatchObject({ id: 'growth', kind: 'percentage_change', status: 'passed', value: '25' });
    expect(result.checks[0]?.passes).toHaveLength(2);
    expect(result.checks[0]?.passes.map((pass) => pass.method)).toEqual(['decimal_formula', 'decimal_invariant']);
    expect(result.summary).toContain('growth=25%');
  });

  it('blocks exact numeric claims when an invariant does not match the supplied total', () => {
    const result = service.evaluate({
      query: '표 합계가 맞는지 검산해줘',
      checks: [{ id: 'sum', kind: 'sum_equals_total', parts: ['10', '20', '30'], expectedTotal: '59' }],
    });

    expect(result.required).toBe(true);
    expect(result.status).toBe('blocked');
    expect(result.checks[0]).toMatchObject({ status: 'mismatch', value: '60' });
    expect(result.checks[0]?.passes).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'decimal_formula', value: '60' }),
      expect.objectContaining({ method: 'decimal_invariant', value: '60' }),
    ]));
    expect(result.answerInstruction).toContain('검산 불일치');
  });

  it('blocks exactness-triggered requests when no tool-backed checks were supplied', () => {
    const result = service.evaluate({ query: '정원 12명에서 15명으로 늘면 증감률이 얼마야?', checks: [] });

    expect(result.required).toBe(true);
    expect(result.status).toBe('blocked');
    expect(result.summary).toBe('exactness_required_but_no_checks_supplied');
    expect(result.answerInstruction).toContain('자료 부족');
  });

  it('extracts a simple percentage-change check from the user query before publishing', () => {
    const result = service.evaluateAnswer({
      query: '정원 12명에서 15명으로 늘면 증감률을 계산해줘',
      answer: '증감률은 25%입니다.',
    });

    expect(result.required).toBe(true);
    expect(result.status).toBe('passed');
    expect(result.checks[0]).toMatchObject({ kind: 'percentage_change', oldValue: '12', newValue: '15', value: '25' });
  });

  it('does not require a gate for purely qualitative requests', () => {
    const result = service.evaluate({ query: '보고서 문장을 더 간결하게 다듬어줘', checks: [] });
    expect(result.required).toBe(false);
    expect(result.status).toBe('skipped');
  });
});
