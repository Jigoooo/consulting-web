import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { ChatThread } from '../widgets/chat-thread/ui/ChatThread';

/**
 * Thread page (N-6): title comes from GET /spaces/threads/:id — no more
 * search-param title that vanished on refresh.
 */
export const Route = createFileRoute('/_app/th/$threadId')({
  validateSearch: (search: Record<string, unknown>): { m?: string } =>
    typeof search.m === 'string' && search.m ? { m: search.m } : {},
  component: ThreadPage,
});

function ThreadPage() {
  const { threadId } = Route.useParams();
  const { m: focusMessageId } = Route.useSearch();
  const detail = useQuery({
    queryKey: ['thread', threadId],
    queryFn: () => api.threadDetail(threadId),
  });
  return (
    <ChatThread
      key={threadId}
      threadId={threadId}
      title={detail.data?.title ?? '…'}
      {...(focusMessageId ? { focusMessageId } : {})}
      {...(detail.data ? {
        breadcrumb: {
          projectName: detail.data.projectName,
          channelName: detail.data.channelName,
          topicName: detail.data.topicName,
        },
      } : {})}
    />
  );
}
