import { describe, expect, it } from 'vitest';
import { schema } from '@consulting/db-schema';
import { EvidenceDecisionStore } from '../src/consulting/evidence-decision.store.js';
import { EvidenceToDecisionService } from '../src/consulting/evidence-to-decision.service.js';
import { ClaimVerifierService } from '../src/consulting/claim-verifier.service.js';
import { ExactnessGateService } from '../src/consulting/exactness-gate.service.js';
import { VerifierGatePolicyService } from '../src/consulting/verifier-gate-policy.service.js';
import { ConsultingJudgmentGuardService } from '../src/consulting/consulting-judgment-guard.service.js';

type CapturedInsert = { table: unknown; value: unknown };

function makeDb(captured: CapturedInsert[]) {
  let selectCount = 0;
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => [{
              id: 'ev-1',
              ref: 'EV-1',
              excerpt: '정원 증가와 인건비 부담 증가는 재정소요의 핵심 요인이다. 100명에서 110명으로 10% 증가했다.',
              qualityScore: 92,
              createdAt: new Date('2026-07-10T00:00:00.000Z'),
            }],
          }),
          limit: async () => {
            selectCount += 1;
            if (selectCount === 1) return [{ id: 'thread-1' }];
            return [{ id: 'ev-1' }];
          },
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (value: unknown) => {
        captured.push({ table, value });
        return { returning: async () => [{ id: `row-${captured.length}` }] };
      },
    }),
  };
}

function valuesFor(captured: CapturedInsert[], table: unknown): unknown[] {
  return captured.filter((item) => item.table === table).map((item) => item.value);
}

describe('EvidenceDecisionStore post-answer telemetry', () => {
  it('records trace, eval case/run/score, verdict, and exactness rows from one completed answer', async () => {
    const captured: CapturedInsert[] = [];
    const store = new EvidenceDecisionStore(
      makeDb(captured) as never,
      new EvidenceToDecisionService(),
      new ClaimVerifierService(),
      new ExactnessGateService(),
      new VerifierGatePolicyService(),
      new ConsultingJudgmentGuardService(),
    );

    await store.recordCompletedAnswer({
      workspaceId: 'ws-1',
      threadId: 'thread-1',
      assistantMessageId: '00000000-0000-4000-8000-000000000001',
      userPrompt: '정원이 100명에서 110명으로 증가했으면 증가율과 인건비 영향을 검산해줘',
      answer: '정원 증가는 인건비 부담을 증가시킨다. 정원은 100명에서 110명으로 10% 증가했다.',
      runId: 'run-telemetry-1',
    });

    expect(valuesFor(captured, schema.exactnessRuns)[0]).toMatchObject({
      workspaceId: 'ws-1',
      threadId: 'thread-1',
      assistantMessageId: '00000000-0000-4000-8000-000000000001',
      status: 'passed',
    });
    expect(valuesFor(captured, schema.claimVerificationVerdicts)[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        workspaceId: 'ws-1',
        threadId: 'thread-1',
        assistantMessageId: '00000000-0000-4000-8000-000000000001',
        verdict: expect.stringMatching(/supports|refutes|mixed|not_enough_info/),
      }),
    ]));
    expect(valuesFor(captured, schema.traceSpans)[0]).toMatchObject({
      workspaceId: 'ws-1',
      threadId: 'thread-1',
      traceId: 'post-answer:run-telemetry-1',
      spanKind: 'verifier',
      name: 'consulting.post_answer.verification',
    });
    expect(valuesFor(captured, schema.evalCases)[0]).toMatchObject({
      workspaceId: 'ws-1',
      threadId: 'thread-1',
      caseKind: 'human_feedback',
      sourceRef: 'message:00000000-0000-4000-8000-000000000001:post_answer_verification',
      prompt: expect.stringContaining('정원이 100명에서 110명'),
      expected: expect.objectContaining({ exactnessStatus: 'passed' }),
      metadata: expect.objectContaining({ source: 'post_answer_verification_v1' }),
    });
    expect(valuesFor(captured, schema.evalRuns)[0]).toMatchObject({
      workspaceId: 'ws-1',
      runKind: 'post_answer_verification',
      status: 'completed',
      metrics: expect.objectContaining({ exactnessStatus: 'passed' }),
    });
    expect(valuesFor(captured, schema.evalScores)[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ metricName: 'claim_support_rate', passed: true }),
      expect.objectContaining({ metricName: 'exactness_status', score: '1', passed: true }),
      expect.objectContaining({ metricName: 'final_export_gate', score: '1', passed: true }),
    ]));
  });
});
