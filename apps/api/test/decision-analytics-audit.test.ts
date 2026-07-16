import { describe, expect, it } from 'vitest';
import {
  buildDecisionAnalyticsAudit,
  DecisionAnalyticsSourceIntegrityError,
  type DecisionAnalyticsAuditInput,
} from '../src/consulting/decision-analytics-audit.js';

const scorecard: Pick<DecisionAnalyticsAuditInput, 'scorecardId' | 'source' | 'ranked'> = {
  scorecardId: '00000000-0000-4000-8000-000000000001',
  source: 'post_answer_verification_v2',
  ranked: [
    {
      alternativeId: 'keep',
      label: '현재 답변 유지',
      criteriaBreakdown: [
        { criterionId: 'support', label: '근거 지지율', normalizedWeight: 0.65, direction: 'higher_is_better', score: 0.9, uncertainty: 0.1 },
        { criterionId: 'risk', label: '반박 위험', normalizedWeight: 0.35, direction: 'lower_is_better', score: 0.1, uncertainty: 0.1 },
      ],
    },
    {
      alternativeId: 'rewrite',
      label: '근거 보강 후 재작성',
      criteriaBreakdown: [
        { criterionId: 'support', label: '근거 지지율', normalizedWeight: 0.65, direction: 'higher_is_better', score: 0.5, uncertainty: 0.2 },
        { criterionId: 'risk', label: '반박 위험', normalizedWeight: 0.35, direction: 'lower_is_better', score: 0.4, uncertainty: 0.2 },
      ],
    },
  ],
};

describe('buildDecisionAnalyticsAudit', () => {
  it('is deterministic and binds the full impact input to the audit hash', () => {
    const input = {
      ...scorecard,
      perturbationPct: 0.2,
      scenarios: 100,
      impact: {
        unit: 'KRW' as const,
        model: 'multiplicative' as const,
        fixedMultiplier: 12,
        iterations: 100,
        drivers: [
          { id: 'headcount', label: '대상 인원', min: 820, mode: 900, max: 1010 },
          { id: 'monthly_add', label: '월 추가액', min: 90_000, mode: 120_000, max: 160_000 },
        ],
      },
    };
    const first = buildDecisionAnalyticsAudit(input);
    const second = buildDecisionAnalyticsAudit(input);
    expect(second).toEqual(first);
    expect(first.inputHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.sensitivity.baselineWinnerId).toBe('keep');
    expect(first.impact?.interval.p10).toBeLessThanOrEqual(first.impact!.interval.p50);
    expect(first.impact?.interval.p50).toBeLessThanOrEqual(first.impact!.interval.p90);

    const changed = buildDecisionAnalyticsAudit({
      ...input,
      impact: { ...input.impact, drivers: input.impact.drivers.map((driver, index) => index === 0 ? { ...driver, max: 1020 } : driver) },
    });
    expect(changed.inputHash).not.toBe(first.inputHash);
  });

  it('supports the exact legacy post-answer direction map but rejects unknown missing direction', () => {
    const legacyRanked = scorecard.ranked.map((alternative) => ({
      ...alternative,
      criteriaBreakdown: alternative.criteriaBreakdown.map(({ direction: _direction, ...criterion }) => ({
        ...criterion,
        criterionId: criterion.criterionId === 'risk' ? 'contradiction_risk' : criterion.criterionId,
      })),
    }));
    expect(buildDecisionAnalyticsAudit({
      ...scorecard,
      source: 'post_answer_verification_v1',
      ranked: legacyRanked,
      perturbationPct: 0.2,
      scenarios: 10,
    }).sensitivity.baselineWinnerId).toBe('keep');

    expect(() => buildDecisionAnalyticsAudit({
      ...scorecard,
      source: 'custom',
      ranked: legacyRanked,
      perturbationPct: 0.2,
      scenarios: 10,
    })).toThrow('criterion direction is unavailable');
    const invalidDirection = {
      ...scorecard,
      ranked: scorecard.ranked.map((alternative) => ({
        ...alternative,
        criteriaBreakdown: alternative.criteriaBreakdown.map((criterion) => ({
          ...criterion,
          direction: 'sideways',
        })),
      })),
      perturbationPct: 0.2,
      scenarios: 10,
    } as unknown as DecisionAnalyticsAuditInput;
    expect(() => buildDecisionAnalyticsAudit(invalidDirection)).toThrow('criterion direction is unavailable');

    const nullBreakdown = {
      ...scorecard,
      ranked: scorecard.ranked.map((alternative) => ({ ...alternative, criteriaBreakdown: null })),
      perturbationPct: 0.2,
      scenarios: 10,
    } as unknown as DecisionAnalyticsAuditInput;
    expect(() => buildDecisionAnalyticsAudit(nullBreakdown)).toThrow(DecisionAnalyticsSourceIntegrityError);
  });

  it('does not report a deterministic array-order winner for an exact baseline tie', () => {
    const tied = buildDecisionAnalyticsAudit({
      scorecardId: '00000000-0000-4000-8000-000000000099',
      source: 'custom',
      ranked: ['alpha', 'beta'].map((alternativeId) => ({
        alternativeId,
        label: alternativeId,
        criteriaBreakdown: [{
          criterionId: 'value',
          label: '가치',
          normalizedWeight: 1,
          direction: 'higher_is_better' as const,
          score: 0.5,
          uncertainty: 0,
        }],
      })),
      perturbationPct: 0.2,
      scenarios: 100,
    });

    expect(tied.sensitivity.baselineWinnerId).toBeNull();
    expect(tied.sensitivity.winnerStability).toBe(0);
    expect(tied.sensitivity.criticalCriteria).toEqual([
      expect.objectContaining({ flipsWinner: false, thresholdPct: null, challengerId: null }),
    ]);
  });

  it('rejects an impact model whose maximum outcome exceeds the auditable ceiling', () => {
    expect(() => buildDecisionAnalyticsAudit({
      ...scorecard,
      perturbationPct: 0.2,
      scenarios: 10,
      impact: {
        unit: 'KRW', model: 'multiplicative', fixedMultiplier: 1_000_000, iterations: 10,
        drivers: [
          { id: 'a', label: 'A', min: 1_000_000_000, mode: 1_000_000_000, max: 1_000_000_000 },
          { id: 'b', label: 'B', min: 1_000_000_000, mode: 1_000_000_000, max: 1_000_000_000 },
        ],
      },
    })).toThrow('impact maximum exceeds the auditable KRW ceiling');
  });
});
