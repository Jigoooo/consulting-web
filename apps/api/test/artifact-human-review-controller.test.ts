import { ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ArtifactsController } from '../src/artifacts/artifacts.controller.js';

const USER_ID = '81000000-0000-4000-8000-000000000001';
const WORKSPACE_ID = '81000000-0000-4000-8000-000000000002';
const PROJECT_ID = '81000000-0000-4000-8000-000000000003';
const ARTIFACT_ID = '81000000-0000-4000-8000-000000000004';
const VERSION_ID = '81000000-0000-4000-8000-000000000005';
const preflight = {
  canExport: true,
  reason: 'OK' as const,
  versionNo: 1,
  gate: { decision: 'PASS' as const, blockers: [], warnings: [] },
  messages: ['적대 검토 보완 필요'],
  redTeam: { mode: 'warning' as const, status: 'completed' as const, verdict: 'PASS_WITH_WARNINGS' as const, contentHash: 'a'.repeat(64), policyVersion: 'p1', attacks: [], defenses: [], reviewedAt: '2026-07-13T00:00:00.000Z' },
};
const detail = {
  id: ARTIFACT_ID,
  projectId: PROJECT_ID,
  title: '검토 보고서',
  headVersion: 1,
  versions: [{
    id: VERSION_ID,
    versionNo: 1,
    content: '본문',
    governingMessage: '결론',
    soWhat: '의미',
    sourceThreadId: null,
    sourceMessageId: null,
  }],
};

function subject(
  humanReview: object,
  exporter = { export: vi.fn() },
  overrides: { access?: object; reportWorkflow?: object; verification?: object } = {},
) {
  const access = overrides.access ?? {
    projectPermission: vi.fn().mockResolvedValue({ allowed: true, workspaceId: WORKSPACE_ID, projectId: PROJECT_ID }),
  };
  return {
    controller: new ArtifactsController(
      { artifactWorkspace: vi.fn().mockResolvedValue({ workspaceId: WORKSPACE_ID, projectId: PROJECT_ID }), detail: vi.fn().mockResolvedValue(detail) } as never,
      access as never,
      {} as never,
      {} as never,
      exporter as never,
      (overrides.verification ?? { preflightVersion: vi.fn().mockResolvedValue(preflight) }) as never,
      humanReview as never,
      overrides.reportWorkflow as never,
    ),
    exporter,
    access,
  };
}

describe('artifact human-review controller integration', () => {
  it('returns the final human gate from public export preflight', async () => {
    const humanReview = { exportDecision: vi.fn().mockResolvedValue({ canExport: false, reason: 'HUMAN_REVIEW_REQUIRED' }) };
    const { controller } = subject(humanReview);
    await expect(controller.exportPreflight(
      ARTIFACT_ID,
      'pdf',
      '1',
      { authUserId: USER_ID } as never,
      '1',
    )).resolves.toEqual(expect.objectContaining({
      canExport: false,
      reason: 'HUMAN_REVIEW_REQUIRED',
      humanReview: { status: 'pending', reason: 'HUMAN_REVIEW_REQUIRED' },
    }));
  });

  it('returns the final human gate after verification instead of the raw verifier result', async () => {
    const verification = {
      verifyVersion: vi.fn().mockResolvedValue(preflight),
      preflightVersion: vi.fn().mockResolvedValue(preflight),
    };
    const humanReview = { exportDecision: vi.fn().mockResolvedValue({ canExport: false, reason: 'HUMAN_REVIEW_REQUIRED' }) };
    const { controller } = subject(humanReview, undefined, { verification });
    await expect(controller.verifyArtifact(
      ARTIFACT_ID,
      { versionNo: 1 },
      { authUserId: USER_ID } as never,
      '1',
    )).resolves.toEqual(expect.objectContaining({
      canExport: false,
      reason: 'HUMAN_REVIEW_REQUIRED',
      humanReview: { status: 'pending', reason: 'HUMAN_REVIEW_REQUIRED' },
    }));
  });

  it('returns preflight within the shadow deadline when observe never settles', async () => {
    vi.useFakeTimers();
    try {
      const humanReview = { exportDecision: vi.fn().mockResolvedValue({ canExport: false, reason: 'HUMAN_REVIEW_REQUIRED' }) };
      const reportWorkflow = { observe: vi.fn(() => new Promise(() => {})) };
      const { controller } = subject(humanReview, undefined, { reportWorkflow });
      let settled = false;
      void controller.exportPreflight(
        ARTIFACT_ID,
        'pdf',
        '1',
        { authUserId: USER_ID } as never,
      ).then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(300);
      expect(settled).toBe(true);
      expect(reportWorkflow.observe).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hides a cross-workspace artifact tuple even when project permission is allowed', async () => {
    const humanReview = { recordDecision: vi.fn() };
    const { controller } = subject(humanReview, undefined, {
      access: { projectPermission: vi.fn().mockResolvedValue({ allowed: true, workspaceId: '82000000-0000-4000-8000-000000000002' }) },
    });
    await expect(controller.reviewDecision(
      ARTIFACT_ID,
      '1',
      { action: 'reject', note: 'tenant mismatch' },
      { authUserId: USER_ID } as never,
    )).rejects.toBeInstanceOf(NotFoundException);
    expect(humanReview.recordDecision).not.toHaveBeenCalled();
  });

  it('records against raw verifier output then resumes with the latest final gate', async () => {
    const verification = { preflightVersion: vi.fn().mockResolvedValue(preflight) };
    const decision = {
      id: '83000000-0000-4000-8000-000000000001',
      sequenceNo: 1,
      action: 'approve' as const,
      note: '',
      actorKind: 'user' as const,
      decidedByUserId: USER_ID,
      contentHash: 'a'.repeat(64),
      previousHash: null,
      eventHash: 'b'.repeat(64),
      decidedAt: '2026-07-14T00:00:00.000Z',
    };
    const humanReview = {
      exportDecision: vi.fn()
        .mockResolvedValueOnce({ canExport: false, reason: 'HUMAN_REVIEW_REQUIRED' })
        .mockResolvedValueOnce({ canExport: false, reason: 'RED_TEAM_BLOCKED' }),
      recordDecision: vi.fn().mockResolvedValue({ ok: true, decision }),
    };
    const reportWorkflow = { observe: vi.fn().mockResolvedValue({}), resume: vi.fn().mockResolvedValue({}) };
    const { controller } = subject(humanReview, undefined, { verification, reportWorkflow });
    await controller.reviewDecision(
      ARTIFACT_ID,
      '1',
      { action: 'approve' },
      { authUserId: USER_ID } as never,
    );
    expect(humanReview.recordDecision).toHaveBeenCalledWith(expect.objectContaining({
      preflight: expect.objectContaining({ canExport: true, reason: 'OK' }),
    }));
    expect(verification.preflightVersion).toHaveBeenCalledTimes(2);
    expect(reportWorkflow.resume).toHaveBeenCalledWith(expect.anything(), preflight, false, false, 'RED_TEAM_BLOCKED');
  });

  it('blocks renderer execution while current warning review is pending', async () => {
    const humanReview = { exportDecision: vi.fn().mockResolvedValue({ canExport: false, reason: 'HUMAN_REVIEW_REQUIRED' }) };
    const { controller, exporter } = subject(humanReview);
    await expect(controller.export(
      ARTIFACT_ID,
      'pdf',
      '1',
      { authUserId: USER_ID } as never,
      { setHeader: vi.fn(), end: vi.fn() } as never,
    )).rejects.toBeInstanceOf(ConflictException);
    expect(exporter.export).not.toHaveBeenCalled();
  });

  it('rejects an approval that attempts to override a hard blocker', async () => {
    const humanReview = {
      exportDecision: vi.fn().mockResolvedValue({ canExport: false, reason: 'RED_TEAM_BLOCKED' }),
      recordDecision: vi.fn().mockResolvedValue({ ok: false, reason: 'RED_TEAM_BLOCKED' }),
    };
    const { controller } = subject(humanReview);
    await expect(controller.reviewDecision(
      ARTIFACT_ID,
      '1',
      { action: 'approve' },
      { authUserId: USER_ID } as never,
    )).rejects.toBeInstanceOf(ConflictException);
  });
});
