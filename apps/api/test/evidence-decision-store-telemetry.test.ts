import { describe, expect, it } from 'vitest';
import { schema } from '@consulting/db-schema';
import { EvidenceDecisionStore } from '../src/consulting/evidence-decision.store.js';
import { EvidenceToDecisionService } from '../src/consulting/evidence-to-decision.service.js';
import { ClaimVerifierService } from '../src/consulting/claim-verifier.service.js';
import { ExactnessGateService } from '../src/consulting/exactness-gate.service.js';
import { VerifierGatePolicyService } from '../src/consulting/verifier-gate-policy.service.js';
import { ConsultingJudgmentGuardService } from '../src/consulting/consulting-judgment-guard.service.js';

type CapturedInsert = { table: unknown; value: unknown };

const defaultEvidenceRows = [{
  id: 'ev-1',
  ref: 'EV-1',
  excerpt: '정원 증가와 인건비 부담 증가는 재정소요의 핵심 요인이다. 100명에서 110명으로 10% 증가했다.',
  qualityScore: 92,
  createdAt: new Date('2026-07-10T00:00:00.000Z'),
}];

function makeDb(captured: CapturedInsert[], evidenceRows = defaultEvidenceRows) {
  let selectCount = 0;
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => evidenceRows,
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

  it('returns refuted claims with their counter-evidence and exposes them in the review queue', async () => {
    const captured: CapturedInsert[] = [];
    const verifier = {
      verify: async () => ({
        verifier: 'fixture_verifier',
        metrics: { fixture: true },
        lattice: {
          verdicts: [{
            claimId: 'MSG-00000000-1',
            claimText: '정원 증가는 인건비 부담을 감소시킨다.',
            evidenceId: 'ev-1',
            verdict: 'refutes',
            confidence: 0.91,
            matchedTerms: ['정원', '인건비'],
            contradictedTerms: ['감소↔증가'],
            rationale: '공식 근거는 부담 증가를 명시한다.',
            decisionImpact: 0.82,
          }],
          verdictsByClaim: {},
          summary: { supports: 0, refutes: 1, mixed: 0, notEnoughInfo: 0, claimCount: 1 },
        },
      }),
    };
    const store = new EvidenceDecisionStore(
      makeDb(captured) as never,
      new EvidenceToDecisionService(),
      verifier as never,
      new ExactnessGateService(),
      new VerifierGatePolicyService(),
      new ConsultingJudgmentGuardService(),
    );

    const result = await store.recordCompletedAnswer({
      workspaceId: 'ws-1',
      threadId: 'thread-1',
      assistantMessageId: '00000000-0000-4000-8000-000000000001',
      userPrompt: '정원과 인건비 영향을 검토해줘',
      answer: '정원 증가는 인건비 부담을 감소시킨다.',
      runId: 'run-refuted-1',
    });

    expect(result).toEqual({
      verifiedContradictions: [expect.objectContaining({
        verdictRef: 'assistant:00000000-0000-4000-8000-000000000001:MSG-00000000-1',
        claimId: 'MSG-00000000-1',
        verdict: 'refutes',
        confidence: 0.91,
        evidenceItemId: 'ev-1',
        evidenceRef: 'EV-1',
        evidenceText: expect.stringContaining('인건비 부담 증가는 재정소요'),
      })],
    });
    expect(valuesFor(captured, schema.activeReviewItems)[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemKind: 'refuted_claim', targetRef: 'MSG-00000000-1', status: 'open' }),
    ]));
  });

  it('materializes a mixed verdict from its explicit counter evidence instead of its supporting evidence', async () => {
    const captured: CapturedInsert[] = [];
    const evidenceRows = [
      { id: 'ev-support', ref: 'EV-SUPPORT', excerpt: '정원 증가는 일부 운영 효율을 높인다.', qualityScore: 88, createdAt: new Date('2026-07-10T00:00:00.000Z') },
      { id: 'ev-counter', ref: 'EV-COUNTER', excerpt: '정원 증가는 총인건비 부담을 높인다.', qualityScore: 94, createdAt: new Date('2026-07-10T00:00:00.000Z') },
    ];
    const verifier = {
      verify: async () => ({
        verifier: 'fixture_mixed', metrics: {},
        lattice: {
          verdicts: [{ claimId: 'MSG-MIXED-1', claimText: '정원 증가는 비용 부담을 낮춘다.', evidenceId: 'ev-support', counterEvidenceId: 'ev-counter', verdict: 'mixed', confidence: 0.83, matchedTerms: [], contradictedTerms: ['낮춘다↔높인다'], rationale: '상반된 근거', decisionImpact: 0.8 }],
          verdictsByClaim: {}, summary: { supports: 0, refutes: 0, mixed: 1, notEnoughInfo: 0, claimCount: 1 },
        },
      }),
    };
    const store = new EvidenceDecisionStore(makeDb(captured, evidenceRows) as never, new EvidenceToDecisionService(), verifier as never, new ExactnessGateService(), new VerifierGatePolicyService(), new ConsultingJudgmentGuardService());

    const result = await store.recordCompletedAnswer({ workspaceId: 'ws-1', threadId: 'thread-1', assistantMessageId: '00000000-0000-4000-8000-000000000002', userPrompt: '정원 영향을 봐줘', answer: '정원 증가는 비용 부담을 낮춘다.', runId: 'run-mixed-1' });

    expect(result.verifiedContradictions).toEqual([expect.objectContaining({ verdict: 'mixed', evidenceItemId: 'ev-counter', evidenceRef: 'EV-COUNTER', evidenceText: expect.stringContaining('총인건비 부담을 높인다') })]);
    expect(valuesFor(captured, schema.claimVerificationVerdicts)[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ verdict: 'mixed', evidenceItemId: 'ev-counter', evidenceRef: 'ev-counter' }),
    ]));
  });

  it('does not materialize a mixed contradiction without explicit counter evidence provenance', async () => {
    const captured: CapturedInsert[] = [];
    const verifier = {
      verify: async () => ({
        verifier: 'fixture_mixed', metrics: {},
        lattice: {
          verdicts: [{ claimId: 'MSG-MIXED-2', claimText: '정원 증가는 비용 부담을 낮춘다.', evidenceId: 'ev-1', verdict: 'mixed', confidence: 0.7, matchedTerms: [], contradictedTerms: [], rationale: 'polarity 불명확', decisionImpact: 0.8 }],
          verdictsByClaim: {}, summary: { supports: 0, refutes: 0, mixed: 1, notEnoughInfo: 0, claimCount: 1 },
        },
      }),
    };
    const store = new EvidenceDecisionStore(makeDb(captured) as never, new EvidenceToDecisionService(), verifier as never, new ExactnessGateService(), new VerifierGatePolicyService(), new ConsultingJudgmentGuardService());

    const result = await store.recordCompletedAnswer({ workspaceId: 'ws-1', threadId: 'thread-1', assistantMessageId: '00000000-0000-4000-8000-000000000003', userPrompt: '정원 영향을 봐줘', answer: '정원 증가는 비용 부담을 낮춘다.', runId: 'run-mixed-2' });

    expect(result.verifiedContradictions).toEqual([]);
  });
});
