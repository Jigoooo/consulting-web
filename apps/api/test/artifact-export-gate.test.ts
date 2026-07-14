import { describe, expect, it, vi } from 'vitest';
import { ArtifactsController } from '../src/artifacts/artifacts.controller.js';

const ARTIFACT_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const VERSION_ID = '66666666-6666-4666-8666-666666666666';

function makeController() {
  const artifacts = {
    artifactWorkspace: vi.fn().mockResolvedValue({ workspaceId: WORKSPACE_ID, projectId: PROJECT_ID }),
    detail: vi.fn().mockResolvedValue({
      id: ARTIFACT_ID,
      projectId: PROJECT_ID,
      title: '무원본 미검증 보고서',
      headVersion: 1,
      versions: [
        {
          id: VERSION_ID,
          versionNo: 1,
          content: '# 검증 실패 보고서\n\n정원 증가는 인건비 부담을 줄입니다.',
          note: 'manual draft',
          authorUserId: 'user-1',
          authorName: 'User',
          sourceThreadId: null,
          sourceMessageId: null,
          createdAt: '2026-07-08T00:00:00.000Z',
        },
      ],
    }),
  };
  const access = { projectPermission: vi.fn().mockResolvedValue({ allowed: true, workspaceId: WORKSPACE_ID, projectId: PROJECT_ID }) };
  const notifications = { notifyWorkspace: vi.fn() };
  const db = makeSourceDb();
  const exporter = {
    export: vi.fn().mockResolvedValue({
      buffer: Buffer.from('%PDF-1.7\nmock pdf body'.padEnd(1200, 'x')),
      mimeType: 'application/pdf',
      fileName: 'blocked.pdf',
    }),
  };
  const artifactVerification = {
    preflightVersion: vi.fn().mockResolvedValue({
      canExport: false,
      reason: 'ARTIFACT_VERIFICATION_REQUIRED',
      versionNo: 1,
      gate: null,
      messages: ['현재 산출물 버전의 정확한 본문에 대한 검증 결과가 없습니다.'],
    }),
    verifyVersion: vi.fn().mockResolvedValue({
      canExport: true,
      reason: 'OK',
      versionNo: 1,
      gate: { decision: 'PASS', blockers: [], warnings: [] },
      messages: [],
    }),
  };
  const humanReview = {
    exportDecision: vi.fn(async (_target: unknown, preflight: { canExport: boolean; reason: string }) => ({
      canExport: preflight.canExport,
      reason: preflight.reason,
    })),
  };
  const reportWorkflow = { observe: vi.fn().mockResolvedValue({ status: 'paused' }), resume: vi.fn() };
  const controller = new (ArtifactsController as any)(
    artifacts,
    access,
    notifications,
    db,
    exporter,
    artifactVerification,
    humanReview,
    reportWorkflow,
  ) as ArtifactsController;
  return { controller, exporter, artifactVerification, reportWorkflow };
}

describe('ArtifactsController final export verifier gate', () => {
  it('blocks PDF/DOCX export before rendering when the exact artifact version has not been verified', async () => {
    const { controller, exporter } = makeController();
    const res = { setHeader: vi.fn(), end: vi.fn() };

    await expect(
      controller.export(ARTIFACT_ID, 'pdf', undefined, { authUserId: 'user-1' } as any, res as any),
    ).rejects.toMatchObject({
      response: {
        code: 'VERIFIER_GATE_BLOCKED',
        gate: null,
      },
    });
    expect(exporter.export).not.toHaveBeenCalled();
  });

  it('preflights the exact artifact version through the shared version verification service', async () => {
    const { controller, exporter, artifactVerification, reportWorkflow } = makeController();

    const response = await controller.exportPreflight(ARTIFACT_ID, 'pdf', undefined, { authUserId: 'user-1' } as any, '1');

    expect(response).toMatchObject({
      canExport: false,
      reason: 'ARTIFACT_VERIFICATION_REQUIRED',
      gate: null,
    });
    expect(artifactVerification.preflightVersion).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: ARTIFACT_ID,
      artifactVersionId: VERSION_ID,
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
    }));
    expect(reportWorkflow.observe).toHaveBeenCalledWith(
      expect.objectContaining({ artifactVersionId: VERSION_ID, contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u) }),
      expect.objectContaining({ canExport: false }),
      false,
      'ARTIFACT_VERIFICATION_REQUIRED',
    );
    expect(exporter.export).not.toHaveBeenCalled();
  });

  it('verifies the current artifact body and binds the result to that version before export', async () => {
    const { controller, artifactVerification } = makeController();
    artifactVerification.preflightVersion.mockResolvedValueOnce({
      canExport: true,
      reason: 'OK',
      versionNo: 1,
      gate: { decision: 'PASS', blockers: [], warnings: [] },
      messages: [],
      redTeam: { mode: 'off', status: 'disabled', verdict: null, contentHash: null, policyVersion: null, attacks: [], defenses: [], reviewedAt: null },
    });
    const response = await (controller as any).verifyArtifact(
      ARTIFACT_ID,
      { versionNo: 1 },
      { authUserId: 'user-1' },
      '1',
    );

    expect(response).toMatchObject({ canExport: false, reason: 'ARTIFACT_STRUCTURE_REQUIRED', versionNo: 1 });
    expect(artifactVerification.verifyVersion).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: ARTIFACT_ID,
      artifactVersionId: VERSION_ID,
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      content: '# 검증 실패 보고서\n\n정원 증가는 인건비 부담을 줄입니다.',
      verifiedByUserId: 'user-1',
    }));
  });
});

function makeSourceDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn(async () => [{
          workspaceId: WORKSPACE_ID,
          projectId: PROJECT_ID,
          threadId: null,
        }]),
      })),
    })),
  };
}
