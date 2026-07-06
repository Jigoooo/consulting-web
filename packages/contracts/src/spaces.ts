import { z } from 'zod';

const UuidSchema = z.string().uuid();
const NameSchema = z.string().trim().min(1).max(120);
const TitleSchema = z.string().trim().min(1).max(200);
const SlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/);

export const CreateProjectRequestSchema = z.object({
  workspaceId: UuidSchema,
  name: NameSchema,
  slug: SlugSchema,
}).strict();
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

export const CreateWorkspaceRequestSchema = z.object({
  name: NameSchema,
  slug: SlugSchema,
}).strict();
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>;

export const CreateChannelRequestSchema = z.object({
  projectId: UuidSchema,
  name: NameSchema,
  slug: SlugSchema,
}).strict();
export type CreateChannelRequest = z.infer<typeof CreateChannelRequestSchema>;

export const CreateTopicRequestSchema = z.object({
  channelId: UuidSchema,
  name: NameSchema,
  slug: SlugSchema,
}).strict();
export type CreateTopicRequest = z.infer<typeof CreateTopicRequestSchema>;

export const CreateThreadRequestSchema = z.object({
  topicId: UuidSchema,
  title: TitleSchema,
}).strict();
export type CreateThreadRequest = z.infer<typeof CreateThreadRequestSchema>;

const IdResponseSchema = z.object({ id: UuidSchema }).strict();
export const CreateProjectResponseSchema = IdResponseSchema;
export type CreateProjectResponse = z.infer<typeof CreateProjectResponseSchema>;
export const CreateWorkspaceResponseSchema = IdResponseSchema;
export type CreateWorkspaceResponse = z.infer<typeof CreateWorkspaceResponseSchema>;
export const CreateChannelResponseSchema = IdResponseSchema;
export type CreateChannelResponse = z.infer<typeof CreateChannelResponseSchema>;
export const CreateTopicResponseSchema = IdResponseSchema;
export type CreateTopicResponse = z.infer<typeof CreateTopicResponseSchema>;
export const CreateThreadResponseSchema = IdResponseSchema;
export type CreateThreadResponse = z.infer<typeof CreateThreadResponseSchema>;

// ---------------------------------------------------------------------------
// Read contracts (Phase 1-M). Strict responses; no secrets, no internal fields
// (memoryTopicId, tokenHash, version counters stay server-side).
// ---------------------------------------------------------------------------

export const WorkspaceSummarySchema = z
  .object({
    id: UuidSchema,
    name: NameSchema,
    slug: z.string(),
    isPersonal: z.boolean(),
    /** Caller's highest role in this workspace (from membership). */
    role: z.enum(['owner', 'admin', 'editor', 'commenter', 'viewer']),
  })
  .strict();
export type WorkspaceSummary = z.infer<typeof WorkspaceSummarySchema>;

export const ListWorkspacesResponseSchema = z
  .object({ workspaces: z.array(WorkspaceSummarySchema) })
  .strict();
export type ListWorkspacesResponse = z.infer<typeof ListWorkspacesResponseSchema>;

export const TopicNodeSchema = z
  .object({ id: UuidSchema, name: NameSchema, slug: z.string() })
  .strict();
export type TopicNode = z.infer<typeof TopicNodeSchema>;

export const ChannelNodeSchema = z
  .object({
    id: UuidSchema,
    name: NameSchema,
    slug: z.string(),
    topics: z.array(TopicNodeSchema),
  })
  .strict();
export type ChannelNode = z.infer<typeof ChannelNodeSchema>;

export const ProjectNodeSchema = z
  .object({
    id: UuidSchema,
    name: NameSchema,
    slug: z.string(),
    channels: z.array(ChannelNodeSchema),
  })
  .strict();
export type ProjectNode = z.infer<typeof ProjectNodeSchema>;

export const WorkspaceTreeResponseSchema = z
  .object({
    workspaceId: UuidSchema,
    projects: z.array(ProjectNodeSchema),
  })
  .strict();
export type WorkspaceTreeResponse = z.infer<typeof WorkspaceTreeResponseSchema>;

export const ThreadSummarySchema = z
  .object({
    id: UuidSchema,
    title: TitleSchema,
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;

export const ListThreadsResponseSchema = z
  .object({ threads: z.array(ThreadSummarySchema) })
  .strict();
export type ListThreadsResponse = z.infer<typeof ListThreadsResponseSchema>;

/** Single thread detail (N-6) — includes its topic for breadcrumb rendering. */
export const ThreadDetailResponseSchema = z
  .object({
    id: UuidSchema,
    title: TitleSchema,
    topicId: UuidSchema,
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ThreadDetailResponse = z.infer<typeof ThreadDetailResponseSchema>;

/** Persisted chat message (N-1). assistant rows carry runId; user rows carry authorUserId. */
export const ChatMessageSchema = z
  .object({
    id: UuidSchema,
    role: z.enum(['user', 'assistant']),
    content: z.string(),
    authorUserId: UuidSchema.nullable(),
    authorName: z.string().nullable(),
    runId: z.string().nullable(),
    finishState: z.enum(['complete', 'cancelled', 'error']),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ListMessagesResponseSchema = z
  .object({ messages: z.array(ChatMessageSchema) })
  .strict();
export type ListMessagesResponse = z.infer<typeof ListMessagesResponseSchema>;

export const ListMessagesPageRequestSchema = z
  .object({
    limit: z.number().int().min(1).max(100).optional(),
    before: UuidSchema.optional(),
    after: UuidSchema.optional(),
    around: UuidSchema.optional(),
    direction: z.enum(['older', 'newer']).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const cursorCount = [value.before, value.after, value.around].filter(Boolean).length;
    if (cursorCount > 1) {
      ctx.addIssue({
        code: 'custom',
        message: 'Use only one of before, after, or around.',
        path: ['before'],
      });
    }
  });
export type ListMessagesPageRequest = z.infer<typeof ListMessagesPageRequestSchema>;

export const ListMessagesPageResponseSchema = z
  .object({
    messages: z.array(ChatMessageSchema),
    hasOlder: z.boolean(),
    hasNewer: z.boolean(),
    olderCursor: UuidSchema.nullable(),
    newerCursor: UuidSchema.nullable(),
    anchorMessageId: UuidSchema.optional(),
  })
  .strict();
export type ListMessagesPageResponse = z.infer<typeof ListMessagesPageResponseSchema>;

export const SearchMessagesRequestSchema = z
  .object({
    q: z.string().trim().min(1).max(120),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export type SearchMessagesRequest = z.infer<typeof SearchMessagesRequestSchema>;

export const MessageSearchHitSchema = z
  .object({
    id: UuidSchema,
    role: z.enum(['user', 'assistant']),
    snippet: z.string(),
    createdAt: z.string().datetime({ offset: true }),
    /** how the hangul-aware matcher matched (F1/F2) — used for highlight fallback */
    matchKind: z.enum(['text', 'chosung', 'jamo']).optional(),
  })
  .strict();
export type MessageSearchHit = z.infer<typeof MessageSearchHitSchema>;

export const SearchMessagesResponseSchema = z
  .object({ results: z.array(MessageSearchHitSchema) })
  .strict();
export type SearchMessagesResponse = z.infer<typeof SearchMessagesResponseSchema>;

/** Rename any space node (N-4). */
export const RenameRequestSchema = z.object({ name: NameSchema }).strict();
export type RenameRequest = z.infer<typeof RenameRequestSchema>;
export const RenameThreadRequestSchema = z.object({ title: TitleSchema }).strict();
export type RenameThreadRequest = z.infer<typeof RenameThreadRequestSchema>;
export const OkResponseSchema = z.object({ ok: z.literal(true) }).strict();
export type OkResponse = z.infer<typeof OkResponseSchema>;

/** Workspace members (N-7). */
export const WorkspaceMemberSchema = z
  .object({
    userId: UuidSchema,
    displayName: z.string(),
    email: z.string(),
    role: z.enum(['owner', 'admin', 'editor', 'commenter', 'viewer']),
  })
  .strict();
export type WorkspaceMember = z.infer<typeof WorkspaceMemberSchema>;
export const ListMembersResponseSchema = z
  .object({ members: z.array(WorkspaceMemberSchema) })
  .strict();
export type ListMembersResponse = z.infer<typeof ListMembersResponseSchema>;
