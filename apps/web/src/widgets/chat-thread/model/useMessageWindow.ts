import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { mergeMessagePage, type MessageWindow } from './messageWindow';

const PAGE_SIZE = 50;

export const messageWindowKeys = {
  latest: (threadId: string) => ['messages-page', threadId, 'latest'] as const,
};

export function useMessageWindow(threadId: string) {
  const [windowState, setWindowState] = useState<MessageWindow | undefined>(undefined);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [isLoadingNewer, setIsLoadingNewer] = useState(false);
  const [isJumping, setIsJumping] = useState(false);
  // A6: surface load failures so the stream can offer an inline retry.
  const [olderError, setOlderError] = useState(false);
  const [newerError, setNewerError] = useState(false);

  const latest = useQuery({
    queryKey: messageWindowKeys.latest(threadId),
    queryFn: () => api.listMessagesPage(threadId, { limit: PAGE_SIZE }),
    // D6: don't refetch-on-focus (would reset the accumulated window).
    staleTime: 30_000,
  });

  useEffect(() => {
    setWindowState(undefined);
    setIsLoadingOlder(false);
    setIsLoadingNewer(false);
    setIsJumping(false);
    setOlderError(false);
    setNewerError(false);
  }, [threadId]);

  useEffect(() => {
    if (!latest.data) return;
    setWindowState(mergeMessagePage(undefined, latest.data, 'latest'));
  }, [latest.data]);

  // React Compiler stabilizes these — no useCallback needed.
  const loadOlder = async () => {
    const cursor = windowState?.olderCursor;
    if (!cursor || !windowState.hasOlder || isLoadingOlder) return;
    setIsLoadingOlder(true);
    setOlderError(false);
    try {
      const page = await api.listMessagesPage(threadId, { limit: PAGE_SIZE, before: cursor, direction: 'older' });
      setWindowState((prev) => mergeMessagePage(prev, page, 'older'));
    } catch {
      setOlderError(true);
    } finally {
      setIsLoadingOlder(false);
    }
  };

  const loadNewer = async () => {
    const cursor = windowState?.newerCursor;
    if (!cursor || !windowState.hasNewer || isLoadingNewer) return;
    setIsLoadingNewer(true);
    setNewerError(false);
    try {
      const page = await api.listMessagesPage(threadId, { limit: PAGE_SIZE, after: cursor, direction: 'newer' });
      setWindowState((prev) => mergeMessagePage(prev, page, 'newer'));
    } catch {
      setNewerError(true);
    } finally {
      setIsLoadingNewer(false);
    }
  };

  const jumpAround = async (messageId: string) => {
    setIsJumping(true);
    try {
      const page = await api.listMessagesPage(threadId, { limit: PAGE_SIZE, around: messageId });
      setWindowState((prev) => mergeMessagePage(prev, page, 'around'));
      return page.anchorMessageId ?? messageId;
    } finally {
      setIsJumping(false);
    }
  };

  // A2: escape a search-jump ('around') window back to the live tail in O(1)
  // instead of paging down. Replaces the window rather than accumulating.
  const resetToLatest = async () => {
    setIsJumping(true);
    try {
      const page = await api.listMessagesPage(threadId, { limit: PAGE_SIZE });
      setWindowState(mergeMessagePage(undefined, page, 'latest'));
      return page.messages.at(-1)?.id ?? null;
    } finally {
      setIsJumping(false);
    }
  };

  return {
    messages: windowState?.messages ?? [],
    mode: windowState?.mode ?? 'latest',
    hasOlder: windowState?.hasOlder ?? false,
    hasNewer: windowState?.hasNewer ?? false,
    olderCursor: windowState?.olderCursor ?? null,
    newerCursor: windowState?.newerCursor ?? null,
    isLoading: latest.isLoading && !windowState,
    isFetchingLatest: latest.isFetching,
    isLoadingOlder,
    isLoadingNewer,
    isJumping,
    olderError,
    newerError,
    loadOlder,
    loadNewer,
    jumpAround,
    resetToLatest,
    refetchLatest: latest.refetch,
  };
}
