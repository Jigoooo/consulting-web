import { describe, expect, it, vi } from 'vitest';
import { SpacesController } from '../src/spaces/spaces.controller.js';

const USER_ID = '72000000-0000-4000-8000-000000000001';
const PROJECT_A = '72000000-0000-4000-8000-000000000002';
const PROJECT_B = '72000000-0000-4000-8000-000000000003';
const PROJECT_C = '72000000-0000-4000-8000-000000000004';
const WORKSPACE_ID = '72000000-0000-4000-8000-000000000005';

function edge(scopeId: string, edgeId: string) {
  return {
    edgeId,
    scopeType: 'project' as const,
    scopeId,
    workspaceId: WORKSPACE_ID,
    projectId: scopeId,
    projectName: `project-${scopeId.at(-1)}`,
    channelId: null,
    channelName: null,
    topicId: null,
    topicName: null,
    threadId: null,
    threadTitle: null,
    name: `project-${scopeId.at(-1)}`,
    scopePath: `project-${scopeId.at(-1)}`,
    edgeType: 'related_to' as const,
    origin: 'manual' as const,
    confidence: 1,
    direction: 'out' as const,
    relation: 'cross_project' as const,
    weight: 1,
  };
}

describe('context edge target scope RBAC', () => {
  it('filters related targets that the caller cannot read', async () => {
    const projectMember = vi.fn(async (_userId: string, projectId: string) => (
      projectId === PROJECT_B
        ? { allowed: false as const, reason: 'forbidden' as const }
        : { allowed: true as const, workspaceId: WORKSPACE_ID }
    ));
    const contextGraph = {
      traverseRelatedScopes: vi.fn().mockResolvedValue([
        edge(PROJECT_B, '72000000-0000-4000-8000-000000000006'),
        edge(PROJECT_C, '72000000-0000-4000-8000-000000000007'),
      ]),
    };
    const controller = new SpacesController(
      { projectMember } as never,
      {} as never,
      {} as never,
      contextGraph as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const result = await controller.contextEdges(
      { scopeType: 'project', scopeId: PROJECT_A },
      { authUserId: USER_ID } as never,
    );

    expect(result.edges.map((item) => item.scopeId)).toEqual([PROJECT_C]);
    expect(projectMember).toHaveBeenCalledWith(USER_ID, PROJECT_A);
    expect(projectMember).toHaveBeenCalledWith(USER_ID, PROJECT_B);
    expect(projectMember).toHaveBeenCalledWith(USER_ID, PROJECT_C);
  });
});
