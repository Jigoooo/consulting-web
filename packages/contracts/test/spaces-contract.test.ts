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
} from '../src/index.js';

const uuid = '00000000-0000-0000-0000-000000000001';

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
