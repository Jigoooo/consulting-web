import { describe, expect, it } from 'vitest';
import {
  ListWorkspacesResponseSchema,
  WorkspaceTreeResponseSchema,
  ListThreadsResponseSchema,
  ListMessagesPageRequestSchema,
  ListMessagesPageResponseSchema,
  ListArchivedScopesResponseSchema,
  SearchMessagesRequestSchema,
  SearchMessagesResponseSchema,
} from '../src/index.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('space read contracts (Phase 1-M)', () => {
  it('parses a workspace list with caller role', () => {
    const res = {
      workspaces: [
        { id: uuid(1), name: '개인', slug: 'personal', isPersonal: true, role: 'owner' },
        { id: uuid(2), name: '창원시', slug: 'changwon', isPersonal: false, role: 'editor' },
      ],
    };
    expect(ListWorkspacesResponseSchema.parse(res)).toEqual(res);
  });

  it('rejects workspace rows with internal/extra fields (strict)', () => {
    expect(() =>
      ListWorkspacesResponseSchema.parse({
        workspaces: [
          { id: uuid(1), name: 'x', slug: 's', isPersonal: true, role: 'owner', ownerUserId: uuid(9) },
        ],
      }),
    ).toThrow();
  });

  it('parses a nested workspace tree (projects → channels → topics)', () => {
    const res = {
      workspaceId: uuid(1),
      projects: [
        {
          id: uuid(2),
          name: '창원시 적정성 검토',
          slug: 'changwon-review',
          channels: [
            {
              id: uuid(3),
              name: '진단',
              slug: 'diagnosis',
              topics: [{ id: uuid(4), name: '서비스 연속성', slug: 'continuity' }],
            },
          ],
        },
      ],
    };
    expect(WorkspaceTreeResponseSchema.parse(res)).toEqual(res);
  });

  it('rejects tree nodes leaking internal linkage fields', () => {
    expect(() =>
      WorkspaceTreeResponseSchema.parse({
        workspaceId: uuid(1),
        projects: [
          {
            id: uuid(2),
            name: 'p',
            slug: 'p',
            channels: [
              {
                id: uuid(3),
                name: 'c',
                slug: 'c',
                topics: [{ id: uuid(4), name: 't', slug: 't', memoryTopicId: 'tm_123' }],
              },
            ],
          },
        ],
      }),
    ).toThrow();
  });

  it('parses thread summaries with ISO timestamps', () => {
    const res = {
      threads: [{ id: uuid(5), title: '이관 리스크 정리', createdAt: '2026-07-05T04:00:00.000Z' }],
    };
    expect(ListThreadsResponseSchema.parse(res)).toEqual(res);
    expect(() =>
      ListThreadsResponseSchema.parse({ threads: [{ id: uuid(5), title: 't', createdAt: 'yesterday' }] }),
    ).toThrow();
  });

  it('parses cursor-paged chat message contracts', () => {
    const req = {
      limit: 50,
      before: uuid(6),
      direction: 'older' as const,
    };
    expect(ListMessagesPageRequestSchema.parse(req)).toEqual(req);

    const res = {
      messages: [
        {
          id: uuid(7),
          role: 'assistant' as const,
          content: '이전 답변',
          authorUserId: null,
          authorName: null,
          runId: 'run_abc',
          finishState: 'complete' as const,
          createdAt: '2026-07-06T00:00:00.000Z',
        },
      ],
      hasOlder: true,
      hasNewer: false,
      olderCursor: uuid(7),
      newerCursor: uuid(7),
      anchorMessageId: uuid(7),
    };
    expect(ListMessagesPageResponseSchema.parse(res)).toEqual(res);
    expect(() => ListMessagesPageRequestSchema.parse({ limit: 500 })).toThrow();
    expect(() => ListMessagesPageRequestSchema.parse({ before: uuid(1), after: uuid(2) })).toThrow();
  });

  it('parses message search contracts', () => {
    expect(SearchMessagesRequestSchema.parse({ q: '창원', limit: 10 })).toEqual({ q: '창원', limit: 10 });
    const res = {
      results: [
        {
          id: uuid(8),
          role: 'user' as const,
          snippet: '창원 컨설팅 질문',
          createdAt: '2026-07-06T01:00:00.000Z',
        },
      ],
      messages: [
        {
          id: uuid(8),
          role: 'user' as const,
          snippet: '창원 컨설팅 질문',
          createdAt: '2026-07-06T01:00:00.000Z',
        },
      ],
      files: [],
      evidence: [],
    };
    expect(SearchMessagesResponseSchema.parse(res)).toEqual(res);
    expect(() => SearchMessagesRequestSchema.parse({ q: '', limit: 10 })).toThrow();
    expect(() => SearchMessagesRequestSchema.parse({ q: 'x', limit: 1000 })).toThrow();
  });

  it('parses an empty archive as a valid non-error response', () => {
    expect(ListArchivedScopesResponseSchema.parse({ items: [] })).toEqual({ items: [] });
  });
});
