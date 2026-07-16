import { describe, expect, it } from 'vitest';
import {
  ArtifactExportPreflightResponseSchema,
  ArtifactVersionSchema,
  ArtifactVersionDecisionAnalyticsResponseSchema,
  CreateArtifactRequestSchema,
  DecisionAnalyticsRunResponseSchema,
  EvidenceDecisionSummaryResponseSchema,
  EvidenceDecisionSummaryV2ResponseSchema,
  EvidenceDecisionSummaryV3ResponseSchema,
  RunDecisionAnalyticsRequestSchema,
  ReviewQueueDecisionRequestSchema,
  ReviewQueueFilterSchema,
} from '../src/index.js';

const uuid = '00000000-0000-4000-8000-000000000001';

describe('collab evidence-decision contracts', () => {
  it('carries immutable artifact structure while still allowing unstructured drafts', () => {
    const draft = CreateArtifactRequestSchema.parse({ projectId: uuid, title: '초안 보고서', content: '초안 본문' });
    expect(draft.structure).toBeUndefined();

    const structured = CreateArtifactRequestSchema.parse({
      projectId: uuid,
      title: '구조화 보고서',
      content: '분석 본문',
      structure: {
        governingMessage: '핵심 결론은 사업 범위를 단계적으로 조정해야 한다는 것입니다.',
        soWhat: '따라서 예산 우선순위와 실행 일정을 이번 분기에 다시 확정해야 합니다.',
      },
    });
    expect(structured.structure?.governingMessage).toContain('핵심 결론');
    expect(CreateArtifactRequestSchema.safeParse({
      projectId: uuid,
      title: '빈 구조',
      content: '본문',
      structure: { governingMessage: '   ', soWhat: '의미가 없습니다' },
    }).success).toBe(false);

    expect(ArtifactVersionSchema.parse({
      id: uuid,
      versionNo: 1,
      content: '본문',
      note: '',
      authorUserId: null,
      authorName: null,
      sourceThreadId: null,
      sourceMessageId: null,
      governingMessage: null,
      soWhat: null,
      createdAt: '2026-07-11T00:00:00.000Z',
    })).toMatchObject({ governingMessage: null, soWhat: null });

    expect(ArtifactExportPreflightResponseSchema.parse({
      canExport: false,
      reason: 'ARTIFACT_STRUCTURE_REQUIRED',
      versionNo: 1,
      gate: null,
      messages: ['핵심 결론을 입력하세요.'],
    })).toMatchObject({
      reason: 'ARTIFACT_STRUCTURE_REQUIRED',
      redTeam: { mode: 'off', status: 'disabled' },
    });

    const reviewed = ArtifactExportPreflightResponseSchema.parse({
      canExport: true,
      reason: 'OK',
      versionNo: 1,
      gate: { decision: 'PASS', blockers: [], warnings: [] },
      messages: ['비용 산식의 반대 근거를 보강하세요.'],
      redTeam: {
        mode: 'warning',
        status: 'completed',
        verdict: 'PASS_WITH_WARNINGS',
        contentHash: 'a'.repeat(64),
        policyVersion: 'artifact_red_team_v1',
        attacks: [{ persona: '감사원', severity: 'warning', category: 'cost', message: '비용 산식의 반대 근거가 없습니다.' }],
        defenses: [{ attackIndex: 0, response: '추가 분석 필요', disposition: 'unresolved' }],
        reviewedAt: '2026-07-11T12:00:00.000Z',
      },
    });
    expect(reviewed.redTeam).toMatchObject({ status: 'completed', verdict: 'PASS_WITH_WARNINGS' });
    expect(ArtifactExportPreflightResponseSchema.safeParse({
      ...reviewed,
      redTeam: { ...reviewed.redTeam, defenses: [{ attackIndex: 2, response: '잘못된 참조', disposition: 'unresolved' }] },
    }).success).toBe(false);
  });

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
    const v2 = { ...response, judgment: { latestRun: null, blockedCount: 0 } };
    expect(EvidenceDecisionSummaryV2ResponseSchema.parse(v2)).toEqual(v2);
    const v3 = { ...v2, analytics: { supported: true, latestRun: null } };
    expect(EvidenceDecisionSummaryV3ResponseSchema.parse(v3)).toEqual(v3);
    expect(EvidenceDecisionSummaryV2ResponseSchema.safeParse(v3).success).toBe(false);
  });

  it('accepts only explicit review queue decision actions', () => {
    expect(ReviewQueueDecisionRequestSchema.parse({ action: 'resolve', note: '검토 완료' })).toEqual({ action: 'resolve', note: '검토 완료' });
    expect(ReviewQueueDecisionRequestSchema.parse({ action: 'ignore' })).toEqual({ action: 'ignore' });
    expect(ReviewQueueDecisionRequestSchema.safeParse({ action: 'delete' }).success).toBe(false);
    expect(ReviewQueueDecisionRequestSchema.safeParse({ action: 'resolve', itemId: uuid }).success).toBe(false);
  });

  it('accepts only bounded and auditable decision analytics inputs and outputs', () => {
    const request = RunDecisionAnalyticsRequestSchema.parse({
      scorecardId: uuid,
      artifactVersionId: uuid,
      impact: {
        unit: 'KRW',
        model: 'multiplicative',
        fixedMultiplier: 12,
        drivers: [
          { id: 'headcount', label: '대상 인원', min: 820, mode: 900, max: 1010 },
          { id: 'monthly_add', label: '월 추가액', min: 90_000, mode: 120_000, max: 160_000 },
        ],
      },
    });
    expect(request.impact?.drivers).toHaveLength(2);
    expect(RunDecisionAnalyticsRequestSchema.safeParse({
      impact: {
        unit: 'KRW', model: 'multiplicative', fixedMultiplier: 1,
        drivers: [{ id: 'bad', label: '범위 오류', min: 10, mode: 5, max: 20 }],
      },
    }).success).toBe(false);
    expect(RunDecisionAnalyticsRequestSchema.safeParse({
      impact: {
        unit: 'KRW', model: 'multiplicative', fixedMultiplier: 1,
        drivers: [
          { id: 'same', label: '중복 1', min: 1, mode: 1, max: 1 },
          { id: 'same', label: '중복 2', min: 1, mode: 1, max: 1 },
        ],
      },
    }).success).toBe(false);

    const run = DecisionAnalyticsRunResponseSchema.parse({
      run: {
        id: uuid,
        scorecardId: uuid,
        artifactVersionId: uuid,
        artifactContentHash: 'b'.repeat(64),
        methodVersion: 'decision_analytics_v2',
        inputHash: 'a'.repeat(64),
        actorKind: 'user',
        sensitivity: {
          baselineWinnerId: 'A', winnerStability: 0.82, perturbationPct: 0.2, scenarios: 2000,
          criticalCriteria: [{ criterionId: 'cost', label: '비용', flipsWinner: true, thresholdPct: -0.13, challengerId: 'B' }],
        },
        impact: {
          unit: 'KRW', model: 'multiplicative', fixedMultiplier: 12, iterations: 10000, seed: 2026,
          drivers: request.impact!.drivers,
          interval: { iterations: 10000, mean: 1, p10: 1, p50: 1, p90: 1, min: 1, max: 1 },
        },
        createdAt: '2026-07-14T00:00:00.000Z',
      },
    });
    expect(run.run.sensitivity.criticalCriteria[0]?.thresholdPct).toBe(-0.13);
    expect(ArtifactVersionDecisionAnalyticsResponseSchema.parse({ supported: true, latestRun: run.run }).latestRun?.artifactContentHash)
      .toBe('b'.repeat(64));
    const contradictoryInterval = {
      run: {
        ...run.run,
        impact: {
          ...run.run.impact!,
          interval: {
            iterations: 100_000,
            min: 100,
            p10: 90,
            p50: 80,
            p90: 70,
            max: 60,
            mean: 1_000,
          },
        },
      },
    };
    expect(DecisionAnalyticsRunResponseSchema.safeParse(contradictoryInterval).success).toBe(false);
  });

  it('accepts only explicit review queue filters', () => {
    expect(ReviewQueueFilterSchema.parse('all')).toBe('all');
    expect(ReviewQueueFilterSchema.parse('refuted_claim')).toBe('refuted_claim');
    expect(ReviewQueueFilterSchema.parse('unsupported_claim')).toBe('unsupported_claim');
    expect(ReviewQueueFilterSchema.safeParse('contradiction').success).toBe(false);
  });
});
