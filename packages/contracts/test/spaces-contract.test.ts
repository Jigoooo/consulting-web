import { describe, expect, it } from 'vitest';
import {
  CreateProjectRequestSchema,
  CreateProjectResponseSchema,
  CreateChannelRequestSchema,
  CreateChannelResponseSchema,
  CreateTopicRequestSchema,
  CreateTopicResponseSchema,
  CreateThreadRequestSchema,
  CreateThreadResponseSchema,
  CreateContextEdgeRequestSchema,
  CreateContextEdgeResponseSchema,
  ListContextEdgesResponseSchema,
} from '../src/index.js';

const uuid = '00000000-0000-4000-8000-000000000001';

describe('space creation contracts', () => {
  it('accepts strict creation requests', () => {
    expect(CreateProjectRequestSchema.parse({ workspaceId: uuid, name: '프로젝트', slug: 'project-a' })).toEqual({
      workspaceId: uuid,
      name: '프로젝트',
      slug: 'project-a',
    });
    expect(CreateChannelRequestSchema.parse({ projectId: uuid, name: '채널', slug: 'channel-a' })).toEqual({
      projectId: uuid,
      name: '채널',
      slug: 'channel-a',
    });
    expect(CreateTopicRequestSchema.parse({ channelId: uuid, name: '토픽', slug: 'topic-a' })).toEqual({
      channelId: uuid,
      name: '토픽',
      slug: 'topic-a',
    });
    expect(CreateThreadRequestSchema.parse({ topicId: uuid, title: '스레드' })).toEqual({ topicId: uuid, title: '스레드' });
    expect(() => CreateProjectRequestSchema.parse({ workspaceId: uuid, name: 'x', slug: 'bad slug' })).toThrow();
    expect(() => CreateThreadRequestSchema.parse({ topicId: uuid, title: '', extra: true })).toThrow();
  });

  it('accepts strict creation responses without secret fields', () => {
    const response = { id: uuid };
    expect(CreateProjectResponseSchema.parse(response)).toEqual(response);
    expect(CreateChannelResponseSchema.parse(response)).toEqual(response);
    expect(CreateTopicResponseSchema.parse(response)).toEqual(response);
    expect(CreateThreadResponseSchema.parse(response)).toEqual(response);
    expect(() => CreateThreadResponseSchema.parse({ ...response, jwtSecret: 'secret' })).toThrow();
  });
});

describe('context graph contracts', () => {
  it('accepts manual context edge creation and strict traversal responses', () => {
    const request = {
      fromScopeType: 'topic',
      fromScopeId: uuid,
      toScopeType: 'topic',
      toScopeId: '00000000-0000-4000-8000-000000000002',
      edgeType: 'related_to',
      confidence: 0.9,
    };
    expect(CreateContextEdgeRequestSchema.parse(request)).toEqual(request);
    expect(() => CreateContextEdgeRequestSchema.parse({ ...request, edgeType: 'parent_of' })).toThrow();
    expect(CreateContextEdgeResponseSchema.parse({ edgeId: uuid })).toEqual({ edgeId: uuid });

    const response = {
      edges: [{
        scopeType: 'topic',
        scopeId: uuid,
        projectId: '00000000-0000-4000-8000-000000000003',
        projectName: '창원 프로젝트',
        channelId: '00000000-0000-4000-8000-000000000004',
        channelName: '분석',
        topicId: uuid,
        topicName: '예산',
        threadId: null,
        threadTitle: null,
        name: '예산',
        scopePath: '창원 프로젝트 > 분석 > 예산',
        edgeType: 'related_to',
        origin: 'manual',
        confidence: 0.9,
        relation: 'cross_project',
        weight: 0.6,
      }],
    };
    expect(ListContextEdgesResponseSchema.parse(response)).toEqual(response);
    expect(() => ListContextEdgesResponseSchema.parse({ ...response, secret: 'x' })).toThrow();
  });
});
