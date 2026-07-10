import { describe, expect, it, vi } from 'vitest';
import { ArtifactExportPreflightResponseSchema } from '@consulting/contracts';
import { ArtifactVerificationService } from '../src/artifacts/artifact-verification.service.js';
import { VerifierGatePolicyService } from '../src/consulting/verifier-gate-policy.service.js';

const target = {
  artifactId: '11111111-1111-4111-8111-111111111111',
  artifactVersionId: '22222222-2222-4222-8222-222222222222',
  workspaceId: '33333333-3333-4333-8333-333333333333',
  projectId: '44444444-4444-4444-8444-444444444444',
  title: '대화 — 지구 답변',
  versionNo: 1,
  content: '조직 진단 결과는 현행 인력 배치가 업무량 근거와 일치합니다.',
  sourceThreadId: null,
  sourceMessageId: null,
};

describe('ArtifactVerificationService', () => {
  it('verifies the exact manual artifact content and records a version-bound content hash', async () => {
    const store = {
      loadEvidence: vi.fn().mockResolvedValue([
        {
          id: '55555555-5555-4555-8555-555555555555',
          text: '현행 인력 배치는 업무량 조사 결과와 일치합니다.',
          qualityScore: 95,
          observedAt: new Date('2026-07-10T00:00:00.000Z'),
          collectedAt: new Date('2026-07-10T00:00:00.000Z'),
        },
      ]),
      record: vi.fn(async (input: any) => ({
        artifactId: input.target.artifactId,
        artifactVersionId: input.target.artifactVersionId,
        workspaceId: input.target.workspaceId,
        projectId: input.target.projectId,
        contentHash: input.contentHash,
        gate: input.gate,
      })),
      latest: vi.fn(),
    };
    const verifier = {
      verify: vi.fn().mockResolvedValue({
        verifier: 'fixture_verifier',
        lattice: {
          verdicts: [
            {
              claimId: 'ART-22222222-1',
              claimText: target.content,
              evidenceId: '55555555-5555-4555-8555-555555555555',
              verdict: 'supports',
              confidence: 0.96,
              matchedTerms: ['인력', '업무량'],
              contradictedTerms: [],
              rationale: 'supported',
              decisionImpact: 0.62,
            },
          ],
          summary: { supports: 1, refutes: 0, mixed: 0, notEnoughInfo: 0, claimCount: 1 },
        },
        strictJson: { verdicts: [] },
        metrics: { totalLatencyMs: 1, providerCalls: {}, providerLatencies: {} },
      }),
    };
    const exactness = {
      evaluateAnswer: vi.fn().mockReturnValue({
        gate: 'exactness_gate_v1',
        required: false,
        status: 'skipped',
        checks: [],
        summary: 'exactness_not_required',
        answerInstruction: '정성 요청',
      }),
    };
    const service = new (ArtifactVerificationService as any)(
      store,
      verifier,
      exactness,
      new VerifierGatePolicyService(),
    ) as ArtifactVerificationService;

    const result = await (service as any).verifyVersion({ ...target, verifiedByUserId: '66666666-6666-4666-8666-666666666666' });

    expect(result).toMatchObject({ canExport: true, reason: 'OK', versionNo: 1, gate: { decision: 'PASS' } });
    expect(() => ArtifactExportPreflightResponseSchema.parse(result)).not.toThrow();
    expect(store.loadEvidence).toHaveBeenCalledWith(target);
    expect(store.record).toHaveBeenCalledWith(expect.objectContaining({
      target,
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      sourceMessageId: null,
      sourceThreadId: null,
      exactness: expect.objectContaining({ status: 'skipped' }),
      verdicts: [expect.objectContaining({ verdict: 'supports', claimText: target.content })],
      gate: expect.objectContaining({ decision: 'PASS' }),
      verifier: expect.stringMatching(/^artifact_claim_coverage_v4:[a-f0-9]{64}:/u),
      verifiedByUserId: '66666666-6666-4666-8666-666666666666',
    }));
  });

  it('blocks final export when the verifier omits a verdict for a short noun-form claim', async () => {
    const noClaimTarget = { ...target, content: '내부 메모' };
    const store = {
      loadEvidence: vi.fn().mockResolvedValue([]),
      record: vi.fn(async (input: any) => ({
        artifactId: input.target.artifactId,
        artifactVersionId: input.target.artifactVersionId,
        workspaceId: input.target.workspaceId,
        projectId: input.target.projectId,
        contentHash: input.contentHash,
        gate: input.gate,
      })),
      latest: vi.fn(),
    };
    const verifier = {
      verify: vi.fn().mockResolvedValue({
        verifier: 'fixture_verifier',
        lattice: {
          verdicts: [],
          summary: { supports: 0, refutes: 0, mixed: 0, notEnoughInfo: 0, claimCount: 0 },
        },
        strictJson: { verdicts: [] },
        metrics: { totalLatencyMs: 1, providerCalls: {}, providerLatencies: {} },
      }),
    };
    const exactness = {
      evaluateAnswer: vi.fn().mockReturnValue({
        gate: 'exactness_gate_v1',
        required: false,
        status: 'skipped',
        checks: [],
        summary: 'exactness_not_required',
        answerInstruction: '정성 요청',
      }),
    };
    const service = new (ArtifactVerificationService as any)(
      store,
      verifier,
      exactness,
      new VerifierGatePolicyService(),
    ) as ArtifactVerificationService;

    const result = await (service as any).verifyVersion({
      ...noClaimTarget,
      verifiedByUserId: '66666666-6666-4666-8666-666666666666',
    });

    expect(verifier.verify).toHaveBeenCalledWith(expect.objectContaining({
      claims: [expect.objectContaining({ text: '내부 메모' })],
    }));
    expect(result).toMatchObject({
      canExport: false,
      reason: 'VERIFIER_GATE_BLOCKED',
      gate: {
        decision: 'BLOCKED',
        blockers: [expect.objectContaining({ code: 'high_impact_unsupported' })],
      },
    });
  });

  it('includes numeric markdown tables and English bullet claims in final-export verification', async () => {
    const coverageTarget = {
      ...target,
      content: ['# 검증 보고서', '| 항목 | 값 |', '|---|---:|', '| 매출 | 999억원 |', '| A사 | 파산 |', '|A|9|', '- Revenue increased sharply.'].join('\n'),
    };
    const store = {
      loadEvidence: vi.fn().mockResolvedValue([]),
      record: vi.fn(async (input: any) => ({
        artifactId: input.target.artifactId,
        artifactVersionId: input.target.artifactVersionId,
        workspaceId: input.target.workspaceId,
        projectId: input.target.projectId,
        contentHash: input.contentHash,
        gate: input.gate,
      })),
      latest: vi.fn(),
    };
    const verifier = {
      verify: vi.fn(async ({ claims }: any) => ({
        verifier: 'fixture_verifier',
        lattice: {
          verdicts: claims.map((claim: any) => ({
            claimId: claim.id,
            claimText: claim.text,
            evidenceId: null,
            verdict: 'supports',
            confidence: 1,
            matchedTerms: [],
            contradictedTerms: [],
            rationale: 'fixture support',
            decisionImpact: claim.decisionImpact,
          })),
          summary: { supports: claims.length, refutes: 0, mixed: 0, notEnoughInfo: 0, claimCount: claims.length },
        },
        strictJson: { verdicts: [] },
        metrics: { totalLatencyMs: 1, providerCalls: {}, providerLatencies: {} },
      })),
    };
    const exactness = {
      evaluateAnswer: vi.fn().mockReturnValue({
        gate: 'exactness_gate_v1', required: false, status: 'skipped', checks: [], summary: 'exactness_not_required', answerInstruction: '정성 요청',
      }),
    };
    const service = new (ArtifactVerificationService as any)(store, verifier, exactness, new VerifierGatePolicyService()) as ArtifactVerificationService;

    await (service as any).verifyVersion({ ...coverageTarget, verifiedByUserId: '66666666-6666-4666-8666-666666666666' });

    const claims = verifier.verify.mock.calls[0]![0].claims as Array<{ text: string }>;
    expect(claims.map((claim) => claim.text)).toEqual(expect.arrayContaining([
      '매출',
      '999억원',
      'A사',
      '파산',
      'A',
      '9',
      'Revenue increased sharply.',
    ]));
  });

  it('includes a factual artifact title in claims and binds the title hash into the verifier policy tag', async () => {
    const factualTitleTarget = { ...target, title: 'A사 파산 확정' };
    const store = {
      loadEvidence: vi.fn().mockResolvedValue([]),
      record: vi.fn(async (input: any) => ({
        artifactId: input.target.artifactId,
        artifactVersionId: input.target.artifactVersionId,
        workspaceId: input.target.workspaceId,
        projectId: input.target.projectId,
        contentHash: input.contentHash,
        gate: input.gate,
      })),
      latest: vi.fn(),
    };
    const verifier = {
      verify: vi.fn(async ({ claims }: any) => ({
        verifier: 'fixture_verifier',
        lattice: {
          verdicts: claims.map((claim: any) => ({
            claimId: claim.id,
            claimText: claim.text,
            evidenceId: null,
            verdict: 'supports',
            confidence: 1,
            matchedTerms: [],
            contradictedTerms: [],
            rationale: 'fixture support',
            decisionImpact: claim.decisionImpact,
          })),
          summary: { supports: claims.length, refutes: 0, mixed: 0, notEnoughInfo: 0, claimCount: claims.length },
        },
        strictJson: { verdicts: [] },
        metrics: { totalLatencyMs: 1, providerCalls: {}, providerLatencies: {} },
      })),
    };
    const exactness = {
      evaluateAnswer: vi.fn().mockReturnValue({
        gate: 'exactness_gate_v1', required: false, status: 'skipped', checks: [], summary: 'exactness_not_required', answerInstruction: '정성 요청',
      }),
    };
    const service = new (ArtifactVerificationService as any)(store, verifier, exactness, new VerifierGatePolicyService()) as ArtifactVerificationService;

    await (service as any).verifyVersion({ ...factualTitleTarget, verifiedByUserId: '66666666-6666-4666-8666-666666666666' });

    const claims = verifier.verify.mock.calls[0]![0].claims as Array<{ text: string }>;
    expect(claims.map((claim) => claim.text)).toContain(factualTitleTarget.title);
    expect(store.record).toHaveBeenCalledWith(expect.objectContaining({
      verifier: expect.stringMatching(/^artifact_claim_coverage_v4:[a-f0-9]{64}:fixture_verifier$/u),
    }));
  });

  it('bounds claim count and length and fails closed on overflow', async () => {
    const longClaim = `${'가'.repeat(3_000)}입니다.`;
    const overflowTarget = {
      ...target,
      content: [...Array.from({ length: 30 }, (_, index) => `항목 ${index + 1} 값은 ${index + 1}억원입니다.`), longClaim].join('\n'),
    };
    const store = {
      loadEvidence: vi.fn().mockResolvedValue([]),
      record: vi.fn(async (input: any) => ({
        artifactId: input.target.artifactId,
        artifactVersionId: input.target.artifactVersionId,
        workspaceId: input.target.workspaceId,
        projectId: input.target.projectId,
        contentHash: input.contentHash,
        gate: input.gate,
      })),
      latest: vi.fn(),
    };
    const verifier = {
      verify: vi.fn(async ({ claims }: any) => ({
        verifier: 'fixture_verifier',
        lattice: {
          verdicts: claims.map((claim: any) => ({
            claimId: claim.id,
            claimText: claim.text,
            evidenceId: null,
            verdict: 'supports',
            confidence: 1,
            matchedTerms: [],
            contradictedTerms: [],
            rationale: 'fixture support',
            decisionImpact: claim.decisionImpact,
          })),
          summary: { supports: claims.length, refutes: 0, mixed: 0, notEnoughInfo: 0, claimCount: claims.length },
        },
        strictJson: { verdicts: [] },
        metrics: { totalLatencyMs: 1, providerCalls: {}, providerLatencies: {} },
      })),
    };
    const exactness = {
      evaluateAnswer: vi.fn().mockReturnValue({
        gate: 'exactness_gate_v1', required: false, status: 'skipped', checks: [], summary: 'exactness_not_required', answerInstruction: '정성 요청',
      }),
    };
    const service = new (ArtifactVerificationService as any)(store, verifier, exactness, new VerifierGatePolicyService()) as ArtifactVerificationService;

    const result = await (service as any).verifyVersion({ ...overflowTarget, verifiedByUserId: '66666666-6666-4666-8666-666666666666' });

    const claims = verifier.verify.mock.calls[0]![0].claims as Array<{ text: string }>;
    expect(claims.length).toBeLessThanOrEqual(24);
    expect(Math.max(...claims.map((claim) => claim.text.length))).toBeLessThanOrEqual(2_000);
    expect(result).toMatchObject({ canExport: false, gate: { decision: 'BLOCKED' } });
    expect(store.record).toHaveBeenCalledWith(expect.objectContaining({
      verdicts: expect.arrayContaining([
        expect.objectContaining({ verdict: 'not_enough_info', rationale: expect.stringContaining('artifact_claim_coverage') }),
      ]),
    }));
  });

  it.each([
    ['title', { ...target, title: '제'.repeat(201) }],
    ['content', { ...target, content: '가'.repeat(200_001) }],
  ])('rejects oversized %s before evidence, verifier, or exactness work', async (_field, oversizedTarget) => {
    const store = { loadEvidence: vi.fn(), record: vi.fn(), latest: vi.fn() };
    const verifier = { verify: vi.fn() };
    const exactness = { evaluateAnswer: vi.fn() };
    const service = new (ArtifactVerificationService as any)(store, verifier, exactness, new VerifierGatePolicyService()) as ArtifactVerificationService;

    await expect((service as any).verifyVersion({
      ...oversizedTarget,
      verifiedByUserId: '66666666-6666-4666-8666-666666666666',
    })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'ARTIFACT_VERIFICATION_INPUT_TOO_LARGE' }),
      status: 413,
    });
    expect(store.loadEvidence).not.toHaveBeenCalled();
    expect(verifier.verify).not.toHaveBeenCalled();
    expect(exactness.evaluateAnswer).not.toHaveBeenCalled();

    await expect((service as any).preflightVersion(oversizedTarget)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'ARTIFACT_VERIFICATION_INPUT_TOO_LARGE' }),
      status: 413,
    });
    expect(store.latest).not.toHaveBeenCalled();
  });

  it('deduplicates the same version and rejects a third distinct concurrent verification', async () => {
    const releases: Array<() => void> = [];
    const store = {
      loadEvidence: vi.fn().mockResolvedValue([]),
      record: vi.fn(async (input: any) => ({
        artifactId: input.target.artifactId,
        artifactVersionId: input.target.artifactVersionId,
        workspaceId: input.target.workspaceId,
        projectId: input.target.projectId,
        contentHash: input.contentHash,
        gate: input.gate,
      })),
      latest: vi.fn(),
    };
    const verifier = {
      verify: vi.fn(({ claims }: any) => new Promise((resolve) => {
        releases.push(() => resolve({
          verifier: 'fixture_verifier',
          lattice: {
            verdicts: claims.map((claim: any) => ({
              claimId: claim.id,
              claimText: claim.text,
              evidenceId: null,
              verdict: 'supports',
              confidence: 1,
              matchedTerms: [],
              contradictedTerms: [],
              rationale: 'fixture support',
              decisionImpact: claim.decisionImpact,
            })),
            summary: { supports: claims.length, refutes: 0, mixed: 0, notEnoughInfo: 0, claimCount: claims.length },
          },
          strictJson: { verdicts: [] },
          metrics: { totalLatencyMs: 1, providerCalls: {}, providerLatencies: {} },
        }));
      })),
    };
    const exactness = {
      evaluateAnswer: vi.fn().mockReturnValue({
        gate: 'exactness_gate_v1', required: false, status: 'skipped', checks: [], summary: 'exactness_not_required', answerInstruction: '정성 요청',
      }),
    };
    const service = new (ArtifactVerificationService as any)(store, verifier, exactness, new VerifierGatePolicyService()) as ArtifactVerificationService;
    const verifiedByUserId = '66666666-6666-4666-8666-666666666666';

    const first = (service as any).verifyVersion({ ...target, verifiedByUserId });
    const duplicate = (service as any).verifyVersion({ ...target, verifiedByUserId });
    const second = (service as any).verifyVersion({
      ...target,
      artifactVersionId: '77777777-7777-4777-8777-777777777777',
      verifiedByUserId,
    });
    await expect((service as any).verifyVersion({
      ...target,
      artifactVersionId: '88888888-8888-4888-8888-888888888888',
      verifiedByUserId,
    })).rejects.toMatchObject({ status: 503 });

    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.forEach((release) => release());
    await Promise.all([first, duplicate, second]);
    expect(verifier.verify).toHaveBeenCalledTimes(2);
    expect(store.record).toHaveBeenCalledTimes(2);
  });
});
