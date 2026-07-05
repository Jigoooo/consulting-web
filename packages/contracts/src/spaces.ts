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
