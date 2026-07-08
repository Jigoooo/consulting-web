import type { TopicMessageStats, WorkspaceTreeResponse } from '@consulting/contracts';

export interface ThreadLoadPreview extends TopicMessageStats {
  threadId: string;
}

export type InitialChannelLoadPlan =
  | { kind: 'cached'; skeletonRows: 0 }
  | { kind: 'empty'; skeletonRows: 0 }
  | { kind: 'skeleton'; skeletonRows: number };

const MIN_SKELETON_ROWS = 2;
const MAX_SKELETON_ROWS = 5;
const ESTIMATED_ROW_GAP = 22;
const SHORT_MESSAGE_HEIGHT = 96;

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

export function skeletonRowsForPreview(preview: TopicMessageStats | null | undefined, viewportHeight = 720): number {
  if (!preview || preview.messageCount <= 0) return 0;
  if (preview.messageCount <= 2) return preview.messageCount;
  if (preview.messageCount <= 4) return 2;

  const avgChars = preview.recentAvgChars;
  const densityRows = avgChars >= 520 ? MAX_SKELETON_ROWS : avgChars >= 180 ? 4 : 3;
  const usableHeight = Math.max(SHORT_MESSAGE_HEIGHT, viewportHeight - 148);
  const rowsByViewport = Math.floor(usableHeight / (SHORT_MESSAGE_HEIGHT + ESTIMATED_ROW_GAP));
  const rowsByKnownMessages = Math.min(preview.messageCount, preview.recentMessageCount || preview.messageCount);

  return clamp(Math.min(rowsByKnownMessages, rowsByViewport, densityRows), MIN_SKELETON_ROWS, MAX_SKELETON_ROWS);
}

export function planInitialChannelLoad({
  isLoading,
  cachedMessageCount,
  preview,
  viewportHeight,
}: {
  isLoading: boolean;
  cachedMessageCount: number;
  preview: TopicMessageStats | null | undefined;
  viewportHeight?: number;
}): InitialChannelLoadPlan {
  if (cachedMessageCount > 0) return { kind: 'cached', skeletonRows: 0 };
  if (!isLoading) return { kind: 'empty', skeletonRows: 0 };
  if (preview?.messageCount === 0) return { kind: 'empty', skeletonRows: 0 };

  const skeletonRows = skeletonRowsForPreview(preview, viewportHeight);
  return skeletonRows > 0 ? { kind: 'skeleton', skeletonRows } : { kind: 'skeleton', skeletonRows: 3 };
}

export function findThreadLoadPreview(tree: WorkspaceTreeResponse | undefined, threadId: string, topicId?: string | null): ThreadLoadPreview | null {
  if (!tree) return null;
  for (const project of tree.projects) {
    for (const channel of project.channels) {
      for (const topic of channel.topics) {
        // Prefer the exact default-thread match. Fall back to the route's topic id
        // so newly-created empty channels (tree still has defaultThreadId:null)
        // still inherit messageStats=0 and avoid a fake loading state.
        if (topic.defaultThreadId !== threadId && topic.id !== topicId) continue;
        return {
          threadId,
          messageCount: topic.messageStats?.messageCount ?? 0,
          recentMessageCount: topic.messageStats?.recentMessageCount ?? 0,
          recentAvgChars: topic.messageStats?.recentAvgChars ?? 0,
          lastMessageAt: topic.messageStats?.lastMessageAt ?? null,
        };
      }
    }
  }
  return null;
}
