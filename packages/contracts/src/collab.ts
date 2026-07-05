import { z } from 'zod';

const UuidSchema = z.string().uuid();
const TitleSchema = z.string().trim().min(1).max(200);

// ---------------------------------------------------------------------------
// Phase 2-A — Evidence
// ---------------------------------------------------------------------------

export const EvidenceSourceSchema = z.enum(['gbrain', 'web', 'file', 'tool', 'manual']);
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;

export const EvidenceItemSchema = z
  .object({
    id: UuidSchema,
    messageId: UuidSchema.nullable(),
    runId: z.string().nullable(),
    sourceType: EvidenceSourceSchema,
    ref: z.string(),
    excerpt: z.string(),
    url: z.string().nullable(),
    qualityScore: z.number().int().min(0).max(100).nullable(),
    qualitySignals: z.array(z.string()).max(20),
    addedByUserId: UuidSchema.nullable(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

export const ListEvidenceResponseSchema = z
  .object({ evidence: z.array(EvidenceItemSchema) })
  .strict();
export type ListEvidenceResponse = z.infer<typeof ListEvidenceResponseSchema>;

export const AddEvidenceRequestSchema = z
  .object({
    threadId: UuidSchema,
    messageId: UuidSchema.optional(),
    sourceType: EvidenceSourceSchema,
    ref: z.string().trim().min(1).max(200),
    excerpt: z.string().trim().min(1).max(4000),
    url: z.string().url().max(2000).optional(),
  })
  .strict();
export type AddEvidenceRequest = z.infer<typeof AddEvidenceRequestSchema>;

// ---------------------------------------------------------------------------
// Phase 2-B — Artifacts
// ---------------------------------------------------------------------------

export const ArtifactSummarySchema = z
  .object({
    id: UuidSchema,
    projectId: UuidSchema,
    title: TitleSchema,
    headVersion: z.number().int().positive(),
    createdByUserId: UuidSchema.nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ArtifactSummary = z.infer<typeof ArtifactSummarySchema>;

export const ListArtifactsResponseSchema = z
  .object({ artifacts: z.array(ArtifactSummarySchema) })
  .strict();
export type ListArtifactsResponse = z.infer<typeof ListArtifactsResponseSchema>;

export const ArtifactVersionSchema = z
  .object({
    id: UuidSchema,
    versionNo: z.number().int().positive(),
    content: z.string(),
    note: z.string(),
    authorUserId: UuidSchema.nullable(),
    authorName: z.string().nullable(),
    sourceThreadId: UuidSchema.nullable(),
    sourceMessageId: UuidSchema.nullable(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ArtifactVersion = z.infer<typeof ArtifactVersionSchema>;

export const ArtifactDetailResponseSchema = z
  .object({
    id: UuidSchema,
    projectId: UuidSchema,
    title: TitleSchema,
    headVersion: z.number().int().positive(),
    versions: z.array(ArtifactVersionSchema),
  })
  .strict();
export type ArtifactDetailResponse = z.infer<typeof ArtifactDetailResponseSchema>;

export const CreateArtifactRequestSchema = z
  .object({
    projectId: UuidSchema,
    title: TitleSchema,
    content: z.string().min(1).max(200_000),
    note: z.string().trim().max(300).default(''),
    sourceThreadId: UuidSchema.optional(),
    sourceMessageId: UuidSchema.optional(),
  })
  .strict();
export type CreateArtifactRequest = z.infer<typeof CreateArtifactRequestSchema>;

export const AddArtifactVersionRequestSchema = z
  .object({
    content: z.string().min(1).max(200_000),
    note: z.string().trim().max(300).default(''),
    sourceThreadId: UuidSchema.optional(),
    sourceMessageId: UuidSchema.optional(),
  })
  .strict();
export type AddArtifactVersionRequest = z.infer<typeof AddArtifactVersionRequestSchema>;

export const CreateArtifactResponseSchema = z
  .object({ id: UuidSchema, versionNo: z.number().int().positive() })
  .strict();
export type CreateArtifactResponse = z.infer<typeof CreateArtifactResponseSchema>;

// ---------------------------------------------------------------------------
// Phase 2-C — Notifications
// ---------------------------------------------------------------------------

export const NotificationTypeSchema = z.enum([
  'invite_accepted',
  'assistant_reply',
  'artifact_version',
  'member_joined',
]);
export type NotificationType = z.infer<typeof NotificationTypeSchema>;

export const NotificationSchema = z
  .object({
    id: UuidSchema,
    type: NotificationTypeSchema,
    title: z.string(),
    body: z.string(),
    refType: z.enum(['thread', 'artifact', 'workspace']),
    refId: UuidSchema,
    readAt: z.string().datetime({ offset: true }).nullable(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type Notification = z.infer<typeof NotificationSchema>;

export const ListNotificationsResponseSchema = z
  .object({
    notifications: z.array(NotificationSchema),
    unreadCount: z.number().int().nonnegative(),
  })
  .strict();
export type ListNotificationsResponse = z.infer<typeof ListNotificationsResponseSchema>;

export const MarkReadRequestSchema = z
  .object({
    /** Omit to mark ALL unread notifications as read. */
    ids: z.array(UuidSchema).max(200).optional(),
  })
  .strict();
export type MarkReadRequest = z.infer<typeof MarkReadRequestSchema>;

// ---------------------------------------------------------------------------
// Phase 2-D G-3 — File attachments
// ---------------------------------------------------------------------------

/** 10MB binary cap (base64 payload ≈ 13.7MB). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const UploadAttachmentRequestSchema = z
  .object({
    threadId: UuidSchema,
    fileName: z.string().trim().min(1).max(255),
    mimeType: z.string().trim().min(1).max(120),
    /** base64 (no data: prefix). */
    dataBase64: z.string().min(1).max(Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 16),
  })
  .strict();
export type UploadAttachmentRequest = z.infer<typeof UploadAttachmentRequestSchema>;

export const AttachmentSummarySchema = z
  .object({
    id: UuidSchema,
    fileName: z.string(),
    mimeType: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    extraction: z
      .object({
        status: z.enum(['indexed', 'skipped', 'failed']),
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
export type AttachmentSummary = z.infer<typeof AttachmentSummarySchema>;

export const ListAttachmentsResponseSchema = z
  .object({ attachments: z.array(AttachmentSummarySchema) })
  .strict();
export type ListAttachmentsResponse = z.infer<typeof ListAttachmentsResponseSchema>;

export const UploadAttachmentResponseSchema = z
  .object({ id: UuidSchema })
  .strict();
export type UploadAttachmentResponse = z.infer<typeof UploadAttachmentResponseSchema>;
