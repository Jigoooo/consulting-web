import { describe, expect, it } from 'vitest';
import { EvidenceDecisionSummaryResponseSchema, ReviewQueueDecisionRequestSchema, ReviewQueueFilterSchema } from '../src/index.js';

const uuid = '00000000-0000-4000-8000-000000000001';

describe('collab evidence-decision contracts', () => {
  it('accepts exactness gate summary in the right-panel response', () => {
    const response = {
      verdictSummary: { supports: 0, refutes: 0, mixed: 0, notEnoughInfo: 0, claimCount: 0 },
      latestVerdicts: [],
      latestScorecard: null,
      documentUnits: { total: 0, byModality: {} },
      reviewQueue: { openCount: 0, top: null },
      postAnswerVerification: {
        checkedMessageCount: 0,
        unsupportedCount: 0,
        refutedCount: 0,
        verificationMetrics: { totalLatencyMs: 0, providerCalls: { nli: 0, llm: 0, heuristic: 0 }, providerLatencies: {} },
        gate: {
          decision: 'BLOCKED',
          blockers: [{ code: 'exactness_blocked', severity: 'blocker', message: '수치·계산·원문 확인 게이트가 blocked 상태입니다.' }],
          warnings: [{ code: 'semantic_unsupported', severity: 'warning', message: '근거가 부족한 claim이 있습니다.', claimId: 'MSG-1' }],
        },
      },
      exactness: {
        latestRun: {
          id: uuid,
          status: 'blocked',
          required: true,
          summary: 'exactness_required_but_no_checks_supplied',
          answerInstruction: '자료 부족',
          checks: [],
          createdAt: '2026-07-07T00:00:00.000Z',
        },
        blockedCount: 1,
      },
    };

    expect(EvidenceDecisionSummaryResponseSchema.parse(response)).toEqual(response);
  });

  it('accepts only explicit review queue decision actions', () => {
    expect(ReviewQueueDecisionRequestSchema.parse({ action: 'resolve', note: '검토 완료' })).toEqual({ action: 'resolve', note: '검토 완료' });
    expect(ReviewQueueDecisionRequestSchema.parse({ action: 'ignore' })).toEqual({ action: 'ignore' });
    expect(ReviewQueueDecisionRequestSchema.safeParse({ action: 'delete' }).success).toBe(false);
    expect(ReviewQueueDecisionRequestSchema.safeParse({ action: 'resolve', itemId: uuid }).success).toBe(false);
  });

  it('accepts only explicit review queue filters', () => {
    expect(ReviewQueueFilterSchema.parse('all')).toBe('all');
    expect(ReviewQueueFilterSchema.parse('refuted_claim')).toBe('refuted_claim');
    expect(ReviewQueueFilterSchema.parse('unsupported_claim')).toBe('unsupported_claim');
    expect(ReviewQueueFilterSchema.safeParse('contradiction').success).toBe(false);
  });
});
