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

  it('blocks when the published percentage disagrees with the recomputed change', () => {
    const result = service.evaluateAnswer({
      query: '정원 변화 보고서',
      answer: '정원은 100명에서 110명으로 늘어 5% 증가했습니다.',
    });

    expect(result.required).toBe(true);
    expect(result.status).toBe('blocked');
    expect(result.checks[0]).toMatchObject({
      kind: 'percentage_change',
      status: 'mismatch',
      value: '10',
      expected: '5',
    });
  });

  it('blocks a leading percentage claim that disagrees with the following value pair', () => {
    const result = service.evaluateAnswer({
      query: '정원 변화 보고서',
      answer: '증감률은 5%입니다. 정원은 100명에서 110명으로 늘었습니다.',
    });

    expect(result.status).toBe('blocked');
    expect(result.checks).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'invalid_input' })]));
  });

  it('verifies every percentage-change claim instead of returning after the first pair', () => {
    const result = service.evaluateAnswer({
      query: '두 부서 정원 변화 보고서',
      answer: 'A부서는 100명에서 110명으로 늘어 10% 증가했고, B부서는 200명에서 220명으로 늘어 5% 증가했습니다.',
    });

    expect(result.checks).toHaveLength(2);
    expect(result.status).toBe('blocked');
    expect(result.checks).toEqual([
      expect.objectContaining({ value: '10', expected: '10', status: 'passed' }),
      expect.objectContaining({ value: '10', expected: '5', status: 'mismatch' }),
    ]);
  });

  it('deduplicates a value pair repeated in both the query and answer', () => {
    const result = service.evaluateAnswer({
      query: '정원이 100명에서 110명으로 늘면 증가율은?',
      answer: '정원은 100명에서 110명으로 늘어 10% 증가했습니다.',
    });

    expect(result.checks).toHaveLength(1);
    expect(result.status).toBe('passed');
    expect(result.checks[0]).toMatchObject({ value: '10', expected: '10', status: 'passed' });
  });

  it('uses the answer percentage instead of a correct percentage embedded in the query', () => {
    const result = service.evaluateAnswer({
      query: '정원 100명에서 110명으로 바뀌면 증감률은 10%인가?',
      answer: '증감률은 5%입니다.',
    });

    expect(result.status).toBe('blocked');
    expect(result.checks[0]).toMatchObject({ value: '10', expected: '5', status: 'mismatch' });
  });

  it('fails closed when percentage-only clauses cannot be uniquely bound to value-pair clauses', () => {
    const result = service.evaluateAnswer({
      query: '두 부서 증감률 검산',
      answer: 'B부서 증가율은 10%입니다. A부서는 100명에서 110명으로, B부서는 100명에서 120명으로 변경됐습니다. A부서 증가율은 20%입니다.',
    });

    expect(result.status).toBe('blocked');
    expect(result.checks).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'invalid_input' })]));
  });

  it('parses the Korean 퍼센트 suffix as a claimed percentage', () => {
    const result = service.evaluateAnswer({
      query: '정원 변화 보고서',
      answer: '정원은 100명에서 110명으로 늘어 5퍼센트 증가했습니다.',
    });

    expect(result.status).toBe('blocked');
    expect(result.checks[0]).toMatchObject({ value: '10', expected: '5', status: 'mismatch' });
  });

  it('parses full-width percent, 프로, and zero-width percent variants', () => {
    for (const answer of [
      '증가율은 5％입니다.',
      '증가율은 5프로입니다.',
      '증가율은 5프\u200b로입니다.',
    ]) {
      const result = service.evaluateAnswer({
        query: '정원 100명에서 110명으로 바뀌면 증가율은?',
        answer,
      });
      expect(result.status).toBe('blocked');
      expect(result.checks[0]).toMatchObject({ value: '10', expected: '5', status: 'mismatch' });
    }
  });

  it('fails closed instead of order-matching multiple query entities to answer-only percentages', () => {
    const result = service.evaluateAnswer({
      query: 'A는 100명에서 110명으로, B는 100명에서 120명으로 바뀔 때 증가율 계산',
      answer: 'B는 10%, A는 20%입니다.',
    });

    expect(result.status).toBe('blocked');
    expect(result.checks).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'invalid_input' })]));
  });

  it('fails closed when a new subject appears between a value pair and percentage claim', () => {
    const result = service.evaluateAnswer({
      query: '부서별 증가율 검산',
      answer: 'A는 100명에서 110명으로 변경됐고 B의 증가율은 10%입니다.',
    });

    expect(result.status).toBe('blocked');
    expect(result.checks).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'invalid_input' })]));
  });

  it('fails closed when a calculation answer states no numeric percentage claim', () => {
    const result = service.evaluateAnswer({
      query: '정원 100명에서 110명으로 바뀌면 증가율은?',
      answer: '증가율은 높아집니다.',
    });

    expect(result.status).toBe('blocked');
    expect(result.checks).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'invalid_input' })]));
  });

  it('blocks a percentage-only answer when no value pair exists', () => {
    const result = service.evaluateAnswer({
      query: '정원 변화 보고서',
      answer: '증가율은 5%입니다.',
    });

    expect(result.status).toBe('blocked');
    expect(result.checks).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'invalid_input' })]));
  });

  it('blocks subject switches expressed with 이 or 가', () => {
    const result = service.evaluateAnswer({
      query: '부서별 증가율 검산',
      answer: 'A는 100명에서 110명으로 변경됐고 B가 10% 증가했습니다.',
    });

    expect(result.status).toBe('blocked');
    expect(result.checks).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'invalid_input' })]));
  });

  it('removes Unicode default-ignorable characters before parsing every clause', () => {
    const result = service.evaluateAnswer({
      query: '부서별 증가율 검산',
      answer: 'A는 100명에서 110명으로 10% 증가했습니다. B는 200명에\u2060서 220명으로 5퍼\u2060센트 증가했습니다.',
    });

    expect(result.status).toBe('blocked');
    expect(result.checks).toHaveLength(2);
    expect(result.checks[1]).toMatchObject({ value: '10', expected: '5', status: 'mismatch' });
  });

  it('fails closed on nested transitions with unconsumed from-markers', () => {
    const result = service.evaluateAnswer({
      query: '정원 변화 보고서',
      answer: '정원은 100명에서 110명에서 121명으로 늘어 10%입니다.',
    });

    expect(result.status).toBe('blocked');
    expect(result.checks).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'invalid_input' })]));
  });

  it('does not reinterpret a suffix of scientific notation as the old value', () => {
    const result = service.evaluateAnswer({
      query: '정원 변화 보고서',
      answer: '정원은 1e2명에서 110명으로 늘어 5400%입니다.',
    });

    expect(result.status).toBe('blocked');
    expect(result.checks).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'invalid_input' })]));
  });

  it('does not parse percent as a prefix inside percentile', () => {
    const result = service.evaluateAnswer({
      query: '정원 100명에서 110명으로 바뀌면 증가율은?',
      answer: '증가율은 10percentile입니다.',
    });

    expect(result.status).toBe('blocked');
    expect(result.checks).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'invalid_input' })]));
  });

  it('does not reinterpret a signed exponent suffix as the old value', () => {
    const result = service.evaluateAnswer({
      query: '정원 변화 보고서',
      answer: '정원은 1e-2명에서 110명으로 늘어 5400%입니다.',
    });

    expect(result.status).toBe('blocked');
    expect(result.checks).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'invalid_input' })]));
  });

  it('fails closed when another clause contains unconsumed transition markers', () => {
    const result = service.evaluateAnswer({
      query: '정원 변화 보고서',
      answer: 'A는 100명에서 110명으로 늘어 10%입니다. B는 200명에서 260명.',
    });

    expect(result.status).toBe('blocked');
    expect(result.checks).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'invalid_input' })]));
  });

  it('normalizes Unicode minus before rejecting a signed exponent suffix', () => {
    const result = service.evaluateAnswer({
      query: '정원 100명에서 102명으로 바뀌면 증가율은?',
      answer: '증가율은 1e−2%입니다.',
    });

    expect(result.status).toBe('blocked');
    expect(result.checks).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'invalid_input' })]));
  });

  it('keeps an independent Unicode-minus percentage as a signed claim', () => {
    const result = service.evaluateAnswer({
      query: '정원 100명에서 98명으로 바뀌면 증감률은?',
      answer: '증감률은 −2%입니다.',
    });

    expect(result.status).toBe('passed');
    expect(result.checks[0]).toMatchObject({ value: '-2', expected: '-2', status: 'passed' });
  });

  it('does not require a gate for purely qualitative requests', () => {
    const result = service.evaluate({ query: '보고서 문장을 더 간결하게 다듬어줘', checks: [] });
    expect(result.required).toBe(false);
    expect(result.status).toBe('skipped');
  });

  it('leaves qualitative pay-progression judgments to the claim verifier instead of requiring a fake Decimal check', () => {
    const result = service.evaluateAnswer({
      query: '근속승진 평균 이식이 보수수준 비교에 적절한지 판단해줘',
      answer: '근속승진 평균을 다른 기관에 이식하면 각 기관의 실제 규정 차이를 지우므로 비교를 왜곡할 수 있습니다.',
    });

    expect(result.required).toBe(false);
    expect(result.status).toBe('skipped');
    expect(result.summary).toBe('exactness_not_required');
  });
});
