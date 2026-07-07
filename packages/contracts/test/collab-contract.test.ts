import { describe, expect, it } from 'vitest';
import { EvidenceDecisionSummaryResponseSchema } from '../src/index.js';

const uuid = '00000000-0000-4000-8000-000000000001';

describe('collab evidence-decision contracts', () => {
  it('accepts exactness gate summary in the right-panel response', () => {
    const response = {
      verdictSummary: { supports: 0, refutes: 0, mixed: 0, notEnoughInfo: 0, claimCount: 0 },
      latestVerdicts: [],
      latestScorecard: null,
      documentUnits: { total: 0, byModality: {} },
      reviewQueue: { openCount: 0, top: null },
      postAnswerVerification: { checkedMessageCount: 0, unsupportedCount: 0, refutedCount: 0, verificationMetrics: { totalLatencyMs: 0, providerCalls: { nli: 0, llm: 0, heuristic: 0 }, providerLatencies: {} } },
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
});
