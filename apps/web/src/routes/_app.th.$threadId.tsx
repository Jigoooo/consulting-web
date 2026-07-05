import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { ChatThread } from '../components/chat/ChatThread';

/**
 * Thread page (N-6): title comes from GET /spaces/threads/:id — no more
 * search-param title that vanished on refresh.
 */
export const Route = createFileRoute('/_app/th/$threadId')({
  component: ThreadPage,
});

function ThreadPage() {
  const { threadId } = Route.useParams();
  const detail = useQuery({
    queryKey: ['thread', threadId],
    queryFn: () => api.threadDetail(threadId),
  });
  return <ChatThread threadId={threadId} title={detail.data?.title ?? '…'} />;
}
