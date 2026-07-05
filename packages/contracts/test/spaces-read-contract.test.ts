import { describe, expect, it } from 'vitest';
import {
  ListWorkspacesResponseSchema,
  WorkspaceTreeResponseSchema,
  ListThreadsResponseSchema,
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
});
