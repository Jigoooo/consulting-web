import { describe, expect, it, vi } from 'vitest';
import { ArtifactsController } from '../src/artifacts/artifacts.controller.js';

const USER_ID = '50000000-0000-4000-8000-000000000001';
const WORKSPACE_ID = '50000000-0000-4000-8000-000000000002';
const PROJECT_ID = '50000000-0000-4000-8000-000000000003';
const ARTIFACT_ID = '50000000-0000-4000-8000-000000000004';

describe('ArtifactsController notification atomicity', () => {
  it('creates the artifact and its notification intent in the same transaction', async () => {
    const tx = { marker: 'artifact-transaction' };
    const db = {
      transaction: vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) => callback(tx)),
    };
    const artifacts = {
      create: vi.fn(async () => ({ id: ARTIFACT_ID, versionNo: 1 })),
    };
    const notifications = {
      notifyWorkspace: vi.fn(async () => {
        throw new Error('notification outbox unavailable');
      }),
    };
    const controller = new ArtifactsController(
      artifacts as never,
      { projectPermission: vi.fn(async () => ({ allowed: true, workspaceId: WORKSPACE_ID, projectId: PROJECT_ID })) } as never,
      notifications as never,
      db as never,
      {} as never,
      {} as never,
      {} as never,
    );
    Object.assign(controller as unknown as Record<string, unknown>, {
      validateArtifactSource: vi.fn(async () => ({ sourceThreadId: null, sourceMessageId: null })),
    });

    await expect(controller.create(
      { projectId: PROJECT_ID, title: '원자성 보고서', content: '# 내용', note: '초판' },
      { authUserId: USER_ID } as never,
    )).rejects.toThrow('notification outbox unavailable');

    expect(db.transaction).toHaveBeenCalledOnce();
    expect(artifacts.create).toHaveBeenCalledWith(expect.objectContaining({ projectId: PROJECT_ID }), tx);
    expect(notifications.notifyWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ refId: ARTIFACT_ID }),
      tx,
    );
  });

  it('appends the artifact version and its notification intent in the same transaction', async () => {
    const tx = { marker: 'artifact-version-transaction' };
    const db = {
      transaction: vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) => callback(tx)),
    };
    const artifacts = {
      artifactWorkspace: vi.fn(async () => ({ workspaceId: WORKSPACE_ID, projectId: PROJECT_ID })),
      addVersion: vi.fn(async () => ({ versionNo: 2 })),
    };
    const notifications = {
      notifyWorkspace: vi.fn(async () => {
        throw new Error('version notification outbox unavailable');
      }),
    };
    const controller = new ArtifactsController(
      artifacts as never,
      { projectPermission: vi.fn(async () => ({ allowed: true, workspaceId: WORKSPACE_ID, projectId: PROJECT_ID })) } as never,
      notifications as never,
      db as never,
      {} as never,
      {} as never,
      {} as never,
    );
    Object.assign(controller as unknown as Record<string, unknown>, {
      validateArtifactSource: vi.fn(async () => ({ sourceThreadId: null, sourceMessageId: null })),
    });

    await expect(controller.addVersion(
      ARTIFACT_ID,
      { content: '# 개정', note: 'v2' },
      { authUserId: USER_ID } as never,
    )).rejects.toThrow('version notification outbox unavailable');

    expect(db.transaction).toHaveBeenCalledOnce();
    expect(artifacts.addVersion).toHaveBeenCalledWith(expect.objectContaining({ artifactId: ARTIFACT_ID }), tx);
    expect(notifications.notifyWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ refId: ARTIFACT_ID, dedupKey: `artifact:${ARTIFACT_ID}:version:2` }),
      tx,
    );
  });
});
