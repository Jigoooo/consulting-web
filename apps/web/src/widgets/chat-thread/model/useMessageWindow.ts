import { useCallback, useEffect, useState } from 'react';
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

  const latest = useQuery({
    queryKey: messageWindowKeys.latest(threadId),
    queryFn: () => api.listMessagesPage(threadId, { limit: PAGE_SIZE }),
  });

  useEffect(() => {
    setWindowState(undefined);
    setIsLoadingOlder(false);
    setIsLoadingNewer(false);
    setIsJumping(false);
  }, [threadId]);

  useEffect(() => {
    if (!latest.data) return;
    setWindowState(mergeMessagePage(undefined, latest.data, 'latest'));
  }, [latest.data]);

  const loadOlder = useCallback(async () => {
    const cursor = windowState?.olderCursor;
    if (!cursor || !windowState.hasOlder || isLoadingOlder) return;
    setIsLoadingOlder(true);
    try {
      const page = await api.listMessagesPage(threadId, { limit: PAGE_SIZE, before: cursor, direction: 'older' });
      setWindowState((prev) => mergeMessagePage(prev, page, 'older'));
    } finally {
      setIsLoadingOlder(false);
    }
  }, [isLoadingOlder, threadId, windowState]);

  const loadNewer = useCallback(async () => {
    const cursor = windowState?.newerCursor;
    if (!cursor || !windowState.hasNewer || isLoadingNewer) return;
    setIsLoadingNewer(true);
    try {
      const page = await api.listMessagesPage(threadId, { limit: PAGE_SIZE, after: cursor, direction: 'newer' });
      setWindowState((prev) => mergeMessagePage(prev, page, 'newer'));
    } finally {
      setIsLoadingNewer(false);
    }
  }, [isLoadingNewer, threadId, windowState]);

  const jumpAround = useCallback(async (messageId: string) => {
    setIsJumping(true);
    try {
      const page = await api.listMessagesPage(threadId, { limit: PAGE_SIZE, around: messageId });
      setWindowState((prev) => mergeMessagePage(prev, page, 'around'));
      return page.anchorMessageId ?? messageId;
    } finally {
      setIsJumping(false);
    }
  }, [threadId]);

  return {
    messages: windowState?.messages ?? [],
    hasOlder: windowState?.hasOlder ?? false,
    hasNewer: windowState?.hasNewer ?? false,
    olderCursor: windowState?.olderCursor ?? null,
    newerCursor: windowState?.newerCursor ?? null,
    isLoading: latest.isLoading && !windowState,
    isFetchingLatest: latest.isFetching,
    isLoadingOlder,
    isLoadingNewer,
    isJumping,
    loadOlder,
    loadNewer,
    jumpAround,
    refetchLatest: latest.refetch,
  };
}
