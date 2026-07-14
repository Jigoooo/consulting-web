import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ArtifactContractController, ArtifactsController } from '../src/artifacts/artifacts.controller.js';

const USER_ID = '71000000-0000-4000-8000-000000000001';
const WORKSPACE_ID = '71000000-0000-4000-8000-000000000002';
const PROJECT_ID = '71000000-0000-4000-8000-000000000003';
const ARTIFACT_ID = '71000000-0000-4000-8000-000000000004';

function controller(
  artifacts: object,
  access: object,
  db: object = {},
  artifactVerification: object = {},
  humanReview: object = {},
) {
  return new ArtifactsController(
    artifacts as never,
    access as never,
    { notifyWorkspace: vi.fn() } as never,
    db as never,
    {} as never,
    artifactVerification as never,
    humanReview as never,
  );
}

describe('ArtifactsController scope RBAC', () => {
  it('exposes v2 capability on a top-level route that cannot collide with legacy artifact ids', () => {
    expect(new ArtifactContractController().contractCapabilities()).toEqual({ version: 2 });
  });

  it('reads an artifact through its owning project without requiring root workspace membership', async () => {
    const access = {
      workspaceMember: vi.fn().mockResolvedValue({ allowed: false, reason: 'forbidden' }),
      projectPermission: vi.fn().mockResolvedValue({ allowed: true, workspaceId: WORKSPACE_ID, projectId: PROJECT_ID }),
    };
    const subject = controller({
      artifactWorkspace: vi.fn().mockResolvedValue({ workspaceId: WORKSPACE_ID, projectId: PROJECT_ID }),
      detail: vi.fn().mockResolvedValue(null),
    }, access);

    await expect(subject.detail(ARTIFACT_ID, { authUserId: USER_ID } as never)).rejects.toBeInstanceOf(NotFoundException);
    expect(access.projectPermission).toHaveBeenCalledWith(USER_ID, PROJECT_ID, 'artifact.render');
    expect(access.workspaceMember).not.toHaveBeenCalled();
  });

  it('denies a viewer version write before source validation or transaction commit', async () => {
    const transaction = vi.fn();
    const access = {
      workspaceMember: vi.fn().mockResolvedValue({ allowed: true, workspaceId: WORKSPACE_ID }),
      projectPermission: vi.fn().mockResolvedValue({ allowed: false, reason: 'forbidden', workspaceId: WORKSPACE_ID }),
      workspaceAnyMembership: vi.fn().mockResolvedValue({ allowed: true, workspaceId: WORKSPACE_ID }),
    };
    const subject = controller({
      artifactWorkspace: vi.fn().mockResolvedValue({ workspaceId: WORKSPACE_ID, projectId: PROJECT_ID }),
    }, access, { transaction });

    await expect(subject.addVersion(
      ARTIFACT_ID,
      { content: '# denied' },
      { authUserId: USER_ID } as never,
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(access.projectPermission).toHaveBeenCalledWith(USER_ID, PROJECT_ID, 'artifact.create');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('filters a workspace artifact list through each active project permission', async () => {
    const listForWorkspace = vi.fn().mockResolvedValue({ artifacts: [] });
    const access = {
      workspaceAnyMembership: vi.fn().mockResolvedValue({ allowed: true, workspaceId: WORKSPACE_ID }),
      permittedProjectIds: vi.fn().mockResolvedValue([PROJECT_ID]),
    };
    const subject = controller({ listForWorkspace }, access);

    await expect(subject.list(WORKSPACE_ID, undefined, { authUserId: USER_ID } as never, '500')).resolves.toEqual({ artifacts: [] });
    expect(access.permittedProjectIds).toHaveBeenCalledWith(USER_ID, WORKSPACE_ID, 'artifact.render');
    expect(listForWorkspace).toHaveBeenCalledWith(WORKSPACE_ID, [PROJECT_ID], 500);
  });

  it('normalizes a known foreign artifact denial to the same public 404 as a missing artifact', async () => {
    const foreignWorkspaceId = '71000000-0000-4000-8000-000000000099';
    const access = {
      projectPermission: vi.fn().mockResolvedValue({ allowed: false, reason: 'forbidden', workspaceId: foreignWorkspaceId }),
      workspaceAnyMembership: vi.fn().mockResolvedValue({ allowed: false, reason: 'forbidden', workspaceId: foreignWorkspaceId }),
    };
    const subject = controller({
      artifactWorkspace: vi.fn().mockResolvedValue({ workspaceId: foreignWorkspaceId, projectId: PROJECT_ID }),
    }, access);

    await expect(subject.detail(ARTIFACT_ID, { authUserId: USER_ID } as never)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('keeps the default detail response strict-v1 and exposes structure only by opt-in', async () => {
    const detail = {
      id: ARTIFACT_ID,
      projectId: PROJECT_ID,
      title: 'rolling artifact',
      headVersion: 1,
      versions: [{
        id: '71000000-0000-4000-8000-000000000005',
        versionNo: 1,
        content: 'body',
        note: '',
        authorUserId: null,
        authorName: null,
        sourceThreadId: null,
        sourceMessageId: null,
        governingMessage: 'governing message',
        soWhat: 'decision consequence',
        createdAt: '2026-07-14T00:00:00.000Z',
      }],
    };
    const access = {
      projectPermission: vi.fn().mockResolvedValue({ allowed: true, workspaceId: WORKSPACE_ID }),
    };
    const subject = controller({
      artifactWorkspace: vi.fn().mockResolvedValue({ workspaceId: WORKSPACE_ID, projectId: PROJECT_ID }),
      detail: vi.fn().mockResolvedValue(detail),
    }, access);

    const v1 = await subject.detail(ARTIFACT_ID, { authUserId: USER_ID } as never);
    expect(v1.versions[0]).not.toHaveProperty('governingMessage');
    expect(v1.versions[0]).not.toHaveProperty('soWhat');
    const v2 = await subject.detail(ARTIFACT_ID, { authUserId: USER_ID } as never, '1');
    expect(v2.versions[0]).toEqual(expect.objectContaining({
      governingMessage: 'governing message',
      soWhat: 'decision consequence',
    }));
  });

  it('rejects structure on the default v1 create route and accepts it only by opt-in', async () => {
    const create = vi.fn().mockResolvedValue({ id: ARTIFACT_ID, versionNo: 1 });
    const transaction = vi.fn(async (operation: (tx: object) => Promise<unknown>) => operation({ tx: true }));
    const access = {
      projectPermission: vi.fn().mockResolvedValue({ allowed: true, workspaceId: WORKSPACE_ID }),
    };
    const subject = controller({ create }, access, { transaction });
    const body = {
      projectId: PROJECT_ID,
      title: 'rolling artifact',
      content: 'body',
      structure: { governingMessage: 'governing message', soWhat: 'decision consequence' },
    };

    await expect(subject.create(body, { authUserId: USER_ID } as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(transaction).not.toHaveBeenCalled();
    await expect(subject.create(body, { authUserId: USER_ID } as never, '1')).resolves.toEqual({ id: ARTIFACT_ID, versionNo: 1 });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      governingMessage: 'governing message',
      soWhat: 'decision consequence',
    }), expect.any(Object));
  });

  it('keeps the default preflight v1 shape while mapping final review blockers fail-closed', async () => {
    const detail = {
      id: ARTIFACT_ID,
      projectId: PROJECT_ID,
      title: 'rolling artifact',
      headVersion: 1,
      versions: [{
        id: '71000000-0000-4000-8000-000000000005',
        versionNo: 1,
        content: 'body',
        note: '',
        authorUserId: null,
        authorName: null,
        sourceThreadId: null,
        sourceMessageId: null,
        governingMessage: 'governing message',
        soWhat: 'decision consequence',
        createdAt: '2026-07-14T00:00:00.000Z',
      }],
    };
    const verifier = {
      canExport: true,
      reason: 'OK' as const,
      versionNo: 1,
      gate: { decision: 'PASS' as const, blockers: [], warnings: [] },
      messages: ['human review warning'],
      redTeam: { mode: 'warning' as const, status: 'completed' as const, verdict: 'PASS_WITH_WARNINGS' as const, contentHash: 'a'.repeat(64), policyVersion: 'v1', attacks: [], defenses: [], reviewedAt: '2026-07-14T00:00:00.000Z' },
    };
    const access = {
      projectPermission: vi.fn().mockResolvedValue({ allowed: true, workspaceId: WORKSPACE_ID }),
    };
    const subject = controller({
      artifactWorkspace: vi.fn().mockResolvedValue({ workspaceId: WORKSPACE_ID, projectId: PROJECT_ID }),
      detail: vi.fn().mockResolvedValue(detail),
    }, access, {}, {
      preflightVersion: vi.fn().mockResolvedValue(verifier),
    }, {
      exportDecision: vi.fn().mockResolvedValue({ canExport: false, reason: 'HUMAN_REVIEW_REQUIRED' }),
    });

    const v1 = await subject.exportPreflight(ARTIFACT_ID, 'pdf', '1', { authUserId: USER_ID } as never);
    expect(v1).toEqual(expect.objectContaining({ canExport: false, reason: 'VERIFIER_GATE_BLOCKED' }));
    expect(v1).not.toHaveProperty('redTeam');
    const v2 = await subject.exportPreflight(ARTIFACT_ID, 'pdf', '1', { authUserId: USER_ID } as never, '1');
    expect(v2).toEqual(expect.objectContaining({
      canExport: false,
      reason: 'HUMAN_REVIEW_REQUIRED',
      humanReview: { status: 'pending', reason: 'HUMAN_REVIEW_REQUIRED' },
    }));
  });
});
