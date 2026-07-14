import { useEffect } from 'react';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { ChatThread } from '../widgets/chat-thread/ui/ChatThread';
import { EmptyState as SharedEmptyState } from '../shared/ui/feedback/EmptyState';

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
  const router = useRouter();
  const detail = useQuery({
    queryKey: ['thread', threadId],
    queryFn: () => api.threadDetail(threadId),
  });
  useEffect(() => {
    if (detail.isError) void router.navigate({ to: '/' });
  }, [detail.isError, router]);

  if (detail.isLoading || detail.isError || !detail.data) {
    return (
      <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--text-muted)' }}>
        <SharedEmptyState
          icon="navigation"
          title={detail.isError ? '대화를 표시할 수 없어요' : '대화를 불러오는 중이에요'}
          description={detail.isError ? '보관되었거나 접근할 수 없는 대화라 채널 선택 화면으로 돌아갑니다.' : '잠시만 기다려 주세요.'}
        />
      </div>
    );
  }
  return (
    <ChatThread
      key={threadId}
      threadId={threadId}
      projectId={detail.data.projectId}
      title={detail.data.title}
      topicId={detail.data.topicId}
      {...(focusMessageId ? { focusMessageId } : {})}
      breadcrumb={{
        projectName: detail.data.projectName,
        channelName: detail.data.channelName,
        topicName: detail.data.topicName,
      }}
    />
  );
}
