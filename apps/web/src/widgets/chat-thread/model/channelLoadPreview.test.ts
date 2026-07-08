import { describe, expect, it } from 'vitest';
import type { WorkspaceTreeResponse } from '@consulting/contracts';
import {
  findThreadLoadPreview,
  planInitialChannelLoad,
  skeletonRowsForPreview,
} from './channelLoadPreview';

const threadA = '00000000-0000-4000-8000-000000000001';
const threadB = '00000000-0000-4000-8000-000000000002';

const tree: WorkspaceTreeResponse = {
  workspaceId: '00000000-0000-4000-8000-000000000999',
  projects: [
    {
      id: '00000000-0000-4000-8000-000000000100',
      name: '프로젝트',
      slug: 'project',
      channels: [
        {
          id: '00000000-0000-4000-8000-000000000200',
          name: '긴 채널',
          slug: 'long',
          topics: [
            {
              id: '00000000-0000-4000-8000-000000000300',
              name: '대화',
              slug: 'chat',
              defaultThreadId: threadA,
              messageStats: {
                messageCount: 128,
                recentMessageCount: 50,
                recentAvgChars: 720,
                lastMessageAt: '2026-07-08T02:00:00.000Z',
              },
            },
          ],
        },
        {
          id: '00000000-0000-4000-8000-000000000201',
          name: '빈 채널',
          slug: 'empty',
          topics: [
            {
              id: '00000000-0000-4000-8000-000000000301',
              name: '대화',
              slug: 'chat',
              defaultThreadId: threadB,
              messageStats: {
                messageCount: 0,
                recentMessageCount: 0,
                recentAvgChars: 0,
                lastMessageAt: null,
              },
            },
          ],
        },
      ],
    },
  ],
};

describe('channel load preview planning', () => {
  it('finds the topic preview for a thread from the workspace tree', () => {
    expect(findThreadLoadPreview(tree, threadA)).toEqual({
      threadId: threadA,
      messageCount: 128,
      recentMessageCount: 50,
      recentAvgChars: 720,
      lastMessageAt: '2026-07-08T02:00:00.000Z',
    });
  });

  it('does not skeletonize empty channels', () => {
    const preview = findThreadLoadPreview(tree, threadB);
    expect(planInitialChannelLoad({ isLoading: true, cachedMessageCount: 0, preview })).toEqual({
      kind: 'empty',
      skeletonRows: 0,
    });
  });

  it('falls back to topic stats when a newly-created empty thread is not in the tree yet', () => {
    const newlyCreatedThread = '00000000-0000-4000-8000-000000000404';
    const preview = findThreadLoadPreview(tree, newlyCreatedThread, '00000000-0000-4000-8000-000000000301');

    expect(preview).toEqual({
      threadId: newlyCreatedThread,
      messageCount: 0,
      recentMessageCount: 0,
      recentAvgChars: 0,
      lastMessageAt: null,
    });
    expect(planInitialChannelLoad({ isLoading: true, cachedMessageCount: 0, preview })).toEqual({
      kind: 'empty',
      skeletonRows: 0,
    });
  });

  it('sizes skeleton rows by known message density and viewport budget', () => {
    const compact = skeletonRowsForPreview({ messageCount: 3, recentMessageCount: 3, recentAvgChars: 42, lastMessageAt: null }, 760);
    const long = skeletonRowsForPreview({ messageCount: 128, recentMessageCount: 50, recentAvgChars: 720, lastMessageAt: null }, 760);

    expect(compact).toBe(2);
    expect(long).toBe(5);
  });

  it('keeps cached message windows instead of replacing them with skeletons', () => {
    const preview = findThreadLoadPreview(tree, threadA);
    expect(planInitialChannelLoad({ isLoading: true, cachedMessageCount: 50, preview })).toEqual({
      kind: 'cached',
      skeletonRows: 0,
    });
  });
});
