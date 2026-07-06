import { useEffect, useRef } from 'react';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useThreads, useCreateThread } from '../lib/spaces';

export const Route = createFileRoute('/_app/t/$topicId')({
  component: TopicPage,
});

/**
 * Compatibility bridge: the data model still has topic -> thread, but the UI now
 * treats a channel as one direct conversation. Opening a channel lands here briefly,
 * then forwards to the first/default thread. Users no longer see topic/thread layers.
 */
function TopicPage() {
  const { topicId } = Route.useParams();
  const router = useRouter();
  const { data, isLoading } = useThreads(topicId);
  const createThread = useCreateThread(topicId);
  const creatingRef = useRef(false);

  useEffect(() => {
    if (isLoading || !data || creatingRef.current) return;

    const first = data.threads[0];
    if (first) {
      void router.navigate({ to: '/th/$threadId', params: { threadId: first.id }, replace: true });
      return;
    }

    creatingRef.current = true;
    void createThread
      .mutateAsync('대화')
      .then((created) => router.navigate({ to: '/th/$threadId', params: { threadId: created.id }, replace: true }))
      .finally(() => {
        creatingRef.current = false;
      });
  }, [createThread, data, isLoading, router]);

  return (
    <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
      채널 대화를 여는 중…
    </div>
  );
}
