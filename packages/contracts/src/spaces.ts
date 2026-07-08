import { z } from 'zod';
import { VerifierGateSummarySchema } from './collab.js';

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

export const TopicMessageStatsSchema = z
  .object({
    messageCount: z.number().int().nonnegative(),
    recentMessageCount: z.number().int().nonnegative(),
    recentAvgChars: z.number().int().nonnegative(),
    lastMessageAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type TopicMessageStats = z.infer<typeof TopicMessageStatsSchema>;

export const TopicNodeSchema = z
  .object({
    id: UuidSchema,
    name: NameSchema,
    slug: z.string(),
    /** First/default chat thread for this topic. Lets the web pre-size channel transitions before /threads resolves. */
    defaultThreadId: UuidSchema.nullable().optional(),
    /** Lightweight per-topic message density used only for smooth initial channel placeholders. */
    messageStats: TopicMessageStatsSchema.optional(),
  })
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

export const ArchivedScopeKindSchema = z.enum(['project', 'channel', 'topic', 'thread']);
export type ArchivedScopeKind = z.infer<typeof ArchivedScopeKindSchema>;

export const ContextGraphScopeTypeSchema = z.enum(['project', 'channel', 'topic', 'thread']);
export type ContextGraphScopeType = z.infer<typeof ContextGraphScopeTypeSchema>;
export const ScopeProfileScopeTypeSchema = z.enum(['channel', 'topic']);
export type ScopeProfileScopeType = z.infer<typeof ScopeProfileScopeTypeSchema>;
export const ScopeProfileSourceSchema = z.enum(['template', 'manual', 'inferred']);
export type ScopeProfileSource = z.infer<typeof ScopeProfileSourceSchema>;
const ProfileTextSchema = z.string().max(2000);
export const ScopeProfileSchema = z
  .object({
    scopeType: ScopeProfileScopeTypeSchema,
    scopeId: UuidSchema,
    purpose: ProfileTextSchema,
    role: ProfileTextSchema,
    style: ProfileTextSchema,
    rules: ProfileTextSchema,
    source: ScopeProfileSourceSchema,
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ScopeProfile = z.infer<typeof ScopeProfileSchema>;
export const ScopeProfileResponseSchema = z.object({ profile: ScopeProfileSchema.nullable() }).strict();
export type ScopeProfileResponse = z.infer<typeof ScopeProfileResponseSchema>;
export const UpdateScopeProfileRequestSchema = z
  .object({
    purpose: ProfileTextSchema.optional(),
    role: ProfileTextSchema.optional(),
    style: ProfileTextSchema.optional(),
    rules: ProfileTextSchema.optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), { message: 'at least one profile field is required' });
export type UpdateScopeProfileRequest = z.infer<typeof UpdateScopeProfileRequestSchema>;
export const CreateContextEdgeTypeSchema = z.enum(['related_to', 'references', 'shares_memory_with']);
export const ContextGraphEdgeTypeSchema = z.enum(['related_to', 'references', 'shares_memory_with', 'derived_from', 'supersedes']);
export const ContextGraphOriginSchema = z.enum(['manual', 'classifier', 'system', 'bot', 'import', 'inherited']);

export const CreateContextEdgeRequestSchema = z
  .object({
    fromScopeType: ContextGraphScopeTypeSchema,
    fromScopeId: UuidSchema,
    toScopeType: ContextGraphScopeTypeSchema,
    toScopeId: UuidSchema,
    edgeType: CreateContextEdgeTypeSchema,
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();
export type CreateContextEdgeRequest = z.infer<typeof CreateContextEdgeRequestSchema>;

export const CreateContextEdgeResponseSchema = z.object({ edgeId: UuidSchema }).strict();
export type CreateContextEdgeResponse = z.infer<typeof CreateContextEdgeResponseSchema>;

export const ListContextEdgesRequestSchema = z
  .object({
    scopeType: ContextGraphScopeTypeSchema,
    scopeId: UuidSchema,
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();
export type ListContextEdgesRequest = z.infer<typeof ListContextEdgesRequestSchema>;

export const ContextEdgeScopeSchema = z
  .object({
    edgeId: UuidSchema.optional(),
    scopeType: ContextGraphScopeTypeSchema,
    scopeId: UuidSchema,
    projectId: UuidSchema,
    projectName: z.string().min(1).max(200),
    channelId: UuidSchema.nullable(),
    channelName: z.string().min(1).max(200).nullable(),
    topicId: UuidSchema.nullable(),
    topicName: z.string().min(1).max(200).nullable(),
    threadId: UuidSchema.nullable(),
    threadTitle: z.string().min(1).max(200).nullable(),
    name: z.string().min(1).max(200),
    scopePath: z.string().min(1).max(800),
    edgeType: ContextGraphEdgeTypeSchema,
    origin: ContextGraphOriginSchema,
    confidence: z.number().min(0).max(1).nullable(),
    direction: z.enum(['out', 'in']).optional(),
    relation: z.enum(['same_project', 'cross_project']),
    weight: z.number().min(0).max(1),
  })
  .strict();
export type ContextEdgeScope = z.infer<typeof ContextEdgeScopeSchema>;

export const ListContextEdgesResponseSchema = z.object({ edges: z.array(ContextEdgeScopeSchema) }).strict();
export type ListContextEdgesResponse = z.infer<typeof ListContextEdgesResponseSchema>;

export const ArchivedScopeItemSchema = z
  .object({
    kind: ArchivedScopeKindSchema,
    id: UuidSchema,
    name: z.string().min(1).max(200),
    /** Human breadcrumb excluding the archived item itself, e.g. project → channel. */
    parentPath: z.array(z.string().min(1).max(200)),
    archivedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ArchivedScopeItem = z.infer<typeof ArchivedScopeItemSchema>;

export const ListArchivedScopesResponseSchema = z
  .object({ items: z.array(ArchivedScopeItemSchema) })
  .strict();
export type ListArchivedScopesResponse = z.infer<typeof ListArchivedScopesResponseSchema>;

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
    topicName: NameSchema,
    channelId: UuidSchema,
    channelName: NameSchema,
    projectId: UuidSchema,
    projectName: NameSchema,
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ThreadDetailResponse = z.infer<typeof ThreadDetailResponseSchema>;

/** Persisted chat message (N-1). assistant rows carry runId; user rows carry authorUserId. */
export const ChatMessageAttachmentSchema = z
  .object({
    id: UuidSchema,
    fileName: z.string(),
    mimeType: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    extraction: z
      .object({
        status: z.enum(['processing', 'indexed', 'skipped', 'failed']),
        extractor: z.string().nullable(),
        textChars: z.number().int().nonnegative(),
        qualityScore: z.number().int().min(0).max(100),
        warnings: z.array(z.string()).max(20),
      })
      .strict()
      .nullable(),
    uploaderUserId: UuidSchema.nullable(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ChatMessageAttachment = z.infer<typeof ChatMessageAttachmentSchema>;

export const ChatMessageVerificationSchema = z
  .object({
    status: z.enum(['supported', 'needs_review', 'refuted', 'unsupported']),
    badgeLabel: z.enum(['지지됨', '근거부족', '반박됨']),
    counts: z
      .object({
        supports: z.number().int().nonnegative(),
        refutes: z.number().int().nonnegative(),
        mixed: z.number().int().nonnegative(),
        notEnoughInfo: z.number().int().nonnegative(),
      })
      .strict(),
    topRationale: z.string().nullable(),
    claims: z.array(z.object({
      claimId: z.string(),
      claimText: z.string(),
      verdict: z.enum(['supports', 'refutes', 'mixed', 'not_enough_info']),
      confidence: z.number().min(0).max(1),
    }).strict()).max(12),
    gate: VerifierGateSummarySchema.optional(),
  })
  .strict();
export type ChatMessageVerification = z.infer<typeof ChatMessageVerificationSchema>;

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
    attachments: z.array(ChatMessageAttachmentSchema).optional(),
    verification: ChatMessageVerificationSchema.optional(),
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

export const FileSearchHitSchema = z
  .object({
    id: UuidSchema,
    fileName: z.string(),
    mimeType: z.string(),
    snippet: z.string(),
    messageId: UuidSchema.nullable(),
    status: z.enum(['processing', 'indexed', 'skipped', 'failed']).nullable(),
    modality: z.enum(['text', 'table', 'page_visual']).optional(),
    locator: z.string().optional(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type FileSearchHit = z.infer<typeof FileSearchHitSchema>;

export const EvidenceSearchHitSchema = z
  .object({
    id: UuidSchema,
    sourceType: z.enum(['gbrain', 'web', 'file', 'tool', 'manual']),
    ref: z.string(),
    snippet: z.string(),
    url: z.string().nullable(),
    messageId: UuidSchema.nullable(),
    runId: z.string().nullable(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type EvidenceSearchHit = z.infer<typeof EvidenceSearchHitSchema>;

export const SearchMessagesResponseSchema = z
  .object({
    /** Backward-compatible alias for message hits; used by header navigator. */
    results: z.array(MessageSearchHitSchema),
    messages: z.array(MessageSearchHitSchema),
    files: z.array(FileSearchHitSchema),
    evidence: z.array(EvidenceSearchHitSchema),
  })
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
