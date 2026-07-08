import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { resolveTopicThreadForNavigation } from './openTopicThread';

const topicId = '11111111-1111-4111-8111-111111111111';
const threadId = '22222222-2222-4222-8222-222222222222';

const detail = {
  id: threadId,
  title: '대화',
  topicId,
  topicName: '보고서',
  channelId: '33333333-3333-4333-8333-333333333333',
  channelName: '보고서',
  projectId: '44444444-4444-4444-8444-444444444444',
  projectName: '테스트 프로젝트',
  createdAt: '2026-07-08T00:00:00.000Z',
};

describe('resolveTopicThreadForNavigation', () => {
  it('creates a backing thread for an empty topic and preloads thread detail before route navigation', async () => {
    const qc = new QueryClient();
    const client = {
      listThreads: vi.fn().mockResolvedValue({ threads: [] }),
      createThread: vi.fn().mockResolvedValue({ id: threadId }),
      threadDetail: vi.fn().mockResolvedValue(detail),
    };

    const resolved = await resolveTopicThreadForNavigation({
      queryClient: qc,
      topicId,
      workspaceId: '55555555-5555-4555-8555-555555555555',
      client,
    });

    expect(resolved).toEqual(detail);
    expect(client.createThread).toHaveBeenCalledWith({ topicId, title: '대화' });
    expect(client.threadDetail).toHaveBeenCalledWith(threadId);
    expect(qc.getQueryData(['thread', threadId])).toEqual(detail);
  });

  it('reuses an existing topic thread but still preloads thread detail', async () => {
    const qc = new QueryClient();
    const client = {
      listThreads: vi.fn().mockResolvedValue({ threads: [{ id: threadId, title: '대화', createdAt: '2026-07-08T00:00:00.000Z' }] }),
      createThread: vi.fn(),
      threadDetail: vi.fn().mockResolvedValue(detail),
    };

    const resolved = await resolveTopicThreadForNavigation({ queryClient: qc, topicId, client });

    expect(resolved.id).toBe(threadId);
    expect(client.createThread).not.toHaveBeenCalled();
    expect(client.threadDetail).toHaveBeenCalledWith(threadId);
    expect(qc.getQueryData(['thread', threadId])).toEqual(detail);
  });
});
