import type { QueryClient } from '@tanstack/react-query';
import type { CreateThreadResponse, ListThreadsResponse, ThreadDetailResponse } from '@consulting/contracts';
import { api } from './api';
import { spaceKeys } from './spaces';

interface TopicThreadNavigationClient {
  listThreads(topicId: string): Promise<ListThreadsResponse>;
  createThread(input: { topicId: string; title: string }): Promise<CreateThreadResponse>;
  threadDetail(threadId: string): Promise<ThreadDetailResponse>;
}

interface ResolveTopicThreadForNavigationInput {
  queryClient: QueryClient;
  topicId: string;
  workspaceId?: string | undefined;
  client?: TopicThreadNavigationClient;
}

/**
 * Resolve the conversation backing a channel before navigation.
 *
 * Empty channels need a thread to exist, but routing to /t/:topicId exposes a
 * bridge loader and routing straight to /th/:threadId without detail cache
 * exposes the thread-detail loader. This helper performs both network steps up
 * front and leaves ['thread', threadId] hot so the destination renders ChatThread
 * immediately.
 */
export async function resolveTopicThreadForNavigation({
  queryClient,
  topicId,
  workspaceId,
  client = api,
}: ResolveTopicThreadForNavigationInput): Promise<ThreadDetailResponse> {
  const threads = await queryClient.ensureQueryData({
    queryKey: spaceKeys.threads(topicId),
    queryFn: () => client.listThreads(topicId),
  });

  let threadId = threads.threads[0]?.id;
  if (!threadId) {
    const created = await client.createThread({ topicId, title: '대화' });
    threadId = created.id;
    void queryClient.invalidateQueries({ queryKey: spaceKeys.threads(topicId) });
    if (workspaceId) void queryClient.invalidateQueries({ queryKey: spaceKeys.tree(workspaceId) });
  }

  return queryClient.ensureQueryData({
    queryKey: ['thread', threadId],
    queryFn: () => client.threadDetail(threadId),
  });
}
