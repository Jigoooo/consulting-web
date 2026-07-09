import { describe, expect, it, vi } from 'vitest';
import { ArtifactsController } from '../src/artifacts/artifacts.controller.js';

const ARTIFACT_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const THREAD_ID = '44444444-4444-4444-8444-444444444444';
const MESSAGE_ID = '55555555-5555-4555-8555-555555555555';

function makeController() {
  const artifacts = {
    artifactWorkspace: vi.fn().mockResolvedValue({ workspaceId: WORKSPACE_ID, projectId: PROJECT_ID }),
    detail: vi.fn().mockResolvedValue({
      id: ARTIFACT_ID,
      projectId: PROJECT_ID,
      title: '검증 실패 보고서',
      headVersion: 1,
      versions: [
        {
          id: '66666666-6666-4666-8666-666666666666',
          versionNo: 1,
          content: '# 검증 실패 보고서\n\n정원 증가는 인건비 부담을 줄입니다.',
          note: 'from assistant',
          authorUserId: 'user-1',
          authorName: 'User',
          sourceThreadId: THREAD_ID,
          sourceMessageId: MESSAGE_ID,
          createdAt: '2026-07-08T00:00:00.000Z',
        },
      ],
    }),
  };
  const access = { workspaceMember: vi.fn().mockResolvedValue({ allowed: true, workspaceId: WORKSPACE_ID }) };
  const notifications = { notifyWorkspace: vi.fn() };
  const db = makeSourceDb();
  const exporter = {
    export: vi.fn().mockResolvedValue({
      buffer: Buffer.from('%PDF-1.7\nmock pdf body'.padEnd(1200, 'x')),
      mimeType: 'application/pdf',
      fileName: 'blocked.pdf',
    }),
  };
  const gateStore = {
    gateForAssistantMessage: vi.fn().mockResolvedValue({
      decision: 'BLOCKED',
      blockers: [
        { code: 'high_impact_refute', severity: 'blocker', message: '핵심 claim이 근거와 모순됩니다.', claimId: 'CL-EXPORT-1' },
      ],
      warnings: [],
    }),
  };
  const controller = new (ArtifactsController as any)(
    artifacts,
    access,
    notifications,
    db,
    exporter,
    gateStore,
  ) as ArtifactsController;
  return { controller, exporter, gateStore };
}

describe('ArtifactsController final export verifier gate', () => {
  it('blocks PDF/DOCX export before rendering when source message gate is BLOCKED', async () => {
    const { controller, exporter } = makeController();
    const res = { setHeader: vi.fn(), end: vi.fn() };

    await expect(
      controller.export(ARTIFACT_ID, 'pdf', undefined, { authUserId: 'user-1' } as any, res as any),
    ).rejects.toMatchObject({
      response: {
        code: 'VERIFIER_GATE_BLOCKED',
        gate: {
          decision: 'BLOCKED',
          blockers: [expect.objectContaining({ code: 'high_impact_refute', claimId: 'CL-EXPORT-1' })],
        },
      },
    });
    expect(exporter.export).not.toHaveBeenCalled();
  });

  it('preflights blocked export without rendering the artifact', async () => {
    const { controller, exporter } = makeController();

    const response = await controller.exportPreflight(ARTIFACT_ID, 'pdf', undefined, { authUserId: 'user-1' } as any);

    expect(response).toMatchObject({
      canExport: false,
      reason: 'VERIFIER_GATE_BLOCKED',
      gate: {
        decision: 'BLOCKED',
        blockers: [expect.objectContaining({ code: 'high_impact_refute', claimId: 'CL-EXPORT-1' })],
      },
    });
    expect(exporter.export).not.toHaveBeenCalled();
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
          threadId: THREAD_ID,
        }]),
      })),
    })),
  };
}
