import { pgTable, text, uuid, integer, bigint, index, unique, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { evidenceSource, notificationType } from './enums';
import { workspaces } from './organization';
import { users } from './identity';
import { threads, chatMessages, projects } from './space';
import { primaryId, timestamps, softDelete } from './_shared';

/**
 * Evidence items (Phase 2-A). Captured automatically from Hermes tool events
 * during a run (source auto) or attached manually. Linked to the assistant
 * message they support. Every row carries workspace_id (ADR-0001).
 */
export const evidenceItems = pgTable(
  'evidence_items',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    /** Assistant message this evidence supports. Null only while in-flight. */
    messageId: uuid('message_id').references(() => chatMessages.id, { onDelete: 'cascade' }),
    /** Hermes run that produced it (auto evidence). */
    runId: text('run_id'),
    sourceType: evidenceSource('source_type').notNull(),
    /** Tool name (web_search, gbrain_query, …) or manual label. */
    ref: text('ref').notNull(),
    /** Query/preview excerpt shown to the user. Never secrets. */
    excerpt: text('excerpt').notNull(),
    /** Optional URL for web sources. */
    url: text('url'),
    /** Evidence reliability score (0-100), nullable for legacy/tool rows. */
    qualityScore: integer('quality_score'),
    /** Short machine-readable quality reasons. */
    qualitySignals: jsonb('quality_signals').$type<string[]>().notNull().default([]),
    addedByUserId: uuid('added_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('evidence_thread_idx').on(t.threadId, t.createdAt),
    index('evidence_message_idx').on(t.messageId),
    index('evidence_workspace_idx').on(t.workspaceId),
  ],
);

/**
 * Artifacts (Phase 2-B): versioned deliverables (reports, tables) owned by a
 * project. Content lives in immutable artifact_versions rows.
 */
export const artifacts = pgTable(
  'artifacts',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    /** Denormalized head version number for cheap listing. */
    headVersion: integer('head_version').notNull().default(1),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('artifacts_workspace_idx').on(t.workspaceId),
    index('artifacts_project_idx').on(t.projectId),
  ],
);

/** Immutable version chain. (artifact_id, version_no) unique. */
export const artifactVersions = pgTable(
  'artifact_versions',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    versionNo: integer('version_no').notNull(),
    /** Markdown body. Immutable once written. */
    content: text('content').notNull(),
    /** Decision-first structure. Both fields are null for drafts or both populated for exportable versions. */
    governingMessage: text('governing_message'),
    soWhat: text('so_what'),
    /** Change note ("초안", "수치 보강" …). */
    note: text('note').notNull().default(''),
    authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Origin thread/message when saved from chat. */
    sourceThreadId: uuid('source_thread_id').references(() => threads.id, { onDelete: 'set null' }),
    sourceMessageId: uuid('source_message_id').references(() => chatMessages.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    unique('artifact_versions_no_unique').on(t.artifactId, t.versionNo),
    index('artifact_versions_artifact_idx').on(t.artifactId),
    index('artifact_versions_workspace_idx').on(t.workspaceId),
  ],
);

/**
 * Append-only final-export verification ledger. A run is reusable only when
 * tenant scope, artifact/version identity, and the exact UTF-8 content hash
 * all match the immutable artifact version being exported.
 */
export const artifactVersionVerifications = pgTable(
  'artifact_version_verifications',
  {
    id: primaryId,
    sequenceNo: bigint('sequence_no', { mode: 'number' }).generatedAlwaysAsIdentity().notNull(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    artifactVersionId: uuid('artifact_version_id')
      .notNull()
      .references(() => artifactVersions.id, { onDelete: 'cascade' }),
    contentHash: text('content_hash').notNull(),
    sourceThreadId: uuid('source_thread_id').references(() => threads.id, { onDelete: 'set null' }),
    sourceMessageId: uuid('source_message_id').references(() => chatMessages.id, { onDelete: 'set null' }),
    status: text('status').notNull(),
    exactness: jsonb('exactness').$type<Record<string, unknown>>().notNull(),
    verdicts: jsonb('verdicts').$type<Record<string, unknown>[]>().notNull().default([]),
    gate: jsonb('gate').$type<Record<string, unknown>>().notNull(),
    verifier: text('verifier').notNull(),
    evidenceCount: integer('evidence_count').notNull().default(0),
    verifiedByUserId: uuid('verified_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    unique('artifact_verifications_sequence_unique').on(t.sequenceNo),
    index('artifact_verifications_scope_idx').on(t.workspaceId, t.projectId, t.createdAt),
    index('artifact_verifications_artifact_idx').on(t.artifactId, t.artifactVersionId, t.sequenceNo),
    index('artifact_verifications_version_hash_idx').on(t.artifactVersionId, t.contentHash, t.sequenceNo),
  ],
);

/** Mutable delivery/lease state for one exact artifact red-team request. */
export const artifactRedTeamJobs = pgTable(
  'artifact_red_team_jobs',
  {
    id: primaryId,
    sequenceNo: bigint('sequence_no', { mode: 'number' }).generatedAlwaysAsIdentity().notNull(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    artifactId: uuid('artifact_id').notNull().references(() => artifacts.id, { onDelete: 'cascade' }),
    artifactVersionId: uuid('artifact_version_id').notNull().references(() => artifactVersions.id, { onDelete: 'cascade' }),
    contentHash: text('content_hash').notNull(),
    mode: text('mode').notNull(),
    policyVersion: text('policy_version').notNull(),
    requestedByUserId: uuid('requested_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('pending'),
    leaseToken: text('lease_token'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    attemptCount: integer('attempt_count').notNull().default(0),
    recoveryCount: integer('recovery_count').notNull().default(0),
    lastError: text('last_error'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('artifact_red_team_jobs_scope_idx').on(t.workspaceId, t.projectId, t.createdAt),
    index('artifact_red_team_jobs_status_lease_idx').on(t.status, t.leaseExpiresAt, t.nextAttemptAt),
    index('artifact_red_team_jobs_version_hash_idx').on(t.artifactVersionId, t.contentHash, t.sequenceNo),
  ],
);

/**
 * Append-only adversarial review result ledger. A review is current only when
 * tenant, artifact/version identity, and the structured content hash match.
 */
export const artifactRedTeamRuns = pgTable(
  'artifact_red_team_runs',
  {
    id: primaryId,
    jobId: uuid('job_id').notNull().references(() => artifactRedTeamJobs.id, { onDelete: 'restrict' }),
    sequenceNo: bigint('sequence_no', { mode: 'number' }).generatedAlwaysAsIdentity().notNull(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'restrict' }),
    artifactVersionId: uuid('artifact_version_id')
      .notNull()
      .references(() => artifactVersions.id, { onDelete: 'restrict' }),
    contentHash: text('content_hash').notNull(),
    mode: text('mode').notNull(),
    status: text('status').notNull(),
    policyVersion: text('policy_version').notNull(),
    personas: jsonb('personas').$type<Array<'감사원' | '의회' | '노조'>>().notNull().default([]),
    attacks: jsonb('attacks').$type<Array<Record<string, unknown>>>().notNull().default([]),
    defenses: jsonb('defenses').$type<Array<Record<string, unknown>>>().notNull().default([]),
    verdict: text('verdict').notNull(),
    reviewerRunId: text('reviewer_run_id'),
    errorMessage: text('error_message'),
    reviewedByUserId: uuid('reviewed_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('artifact_red_team_runs_job_unique').on(t.jobId),
    unique('artifact_red_team_runs_sequence_unique').on(t.sequenceNo),
    index('artifact_red_team_runs_scope_idx').on(t.workspaceId, t.projectId, t.createdAt),
    index('artifact_red_team_runs_version_hash_idx').on(t.artifactVersionId, t.contentHash, t.sequenceNo),
  ],
);

/**
 * Per-user notification feed (Phase 2-C). Written by domain services
 * (invitation accepted / assistant reply settled / artifact version added).
 * Read via polling; read_at marks acknowledgement.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Recipient. */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: notificationType('type').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    /** Deep-link target: 'thread' | 'artifact' | 'workspace'. */
    refType: text('ref_type').notNull(),
    refId: uuid('ref_id').notNull(),
    dedupKey: text('dedup_key'),
    readAt: timestamp('read_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('notifications_user_idx').on(t.userId, t.createdAt),
    index('notifications_workspace_idx').on(t.workspaceId),
    unique('notifications_workspace_user_dedup_unique').on(t.workspaceId, t.userId, t.dedupKey),
  ],
);

/**
 * Web Push subscriptions (2026-07-06). One row per browser endpoint; a user
 * can hold several (desktop + mobile). Endpoint is globally unique per the
 * Push API spec. Dead endpoints (404/410 on send) are pruned by the sender.
 */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: primaryId,
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    /** Client public key (base64url) — encrypts payloads end-to-end. */
    p256dh: text('p256dh').notNull(),
    /** Client auth secret (base64url). */
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    ...timestamps,
  },
  (t) => [
    unique('push_subscriptions_endpoint_unique').on(t.endpoint),
    index('push_subscriptions_user_idx').on(t.userId),
  ],
);

/**
 * Chat file attachments (Phase 2-D G-3). Content stored inline as base64 —
 * survives container rebuilds via the pg volume, no extra object store.
 * Size capped at the contract layer (10MB binary ≈ 13.7MB base64).
 */
export const fileAttachments = pgTable(
  'file_attachments',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    /** Null while the composer attachment is a draft; set when a user message is sent. */
    messageId: uuid('message_id').references(() => chatMessages.id, { onDelete: 'set null' }),
    uploaderUserId: uuid('uploader_user_id').references(() => users.id, { onDelete: 'set null' }),
    fileName: text('file_name').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    dataBase64: text('data_base64').notNull(),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('file_attachments_thread_idx').on(t.threadId, t.createdAt),
    index('file_attachments_message_idx').on(t.messageId, t.createdAt),
    index('file_attachments_workspace_idx').on(t.workspaceId),
  ],
);
/**
 * Extracted text index for uploaded documents (Phase 2-E). One row per
 * attachment. Failed/skipped attempts are recorded so low-quality documents are
 * visible instead of silently disappearing.
 */
export const documentExtractions = pgTable(
  'document_extractions',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    attachmentId: uuid('attachment_id')
      .notNull()
      .references(() => fileAttachments.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    extractor: text('extractor'),
    textContent: text('text_content').notNull().default(''),
    textChars: integer('text_chars').notNull().default(0),
    qualityScore: integer('quality_score').notNull().default(0),
    warnings: jsonb('warnings').$type<string[]>().notNull().default([]),
    ...timestamps,
  },
  (t) => [
    unique('document_extractions_attachment_unique').on(t.attachmentId),
    index('document_extractions_thread_idx').on(t.threadId, t.createdAt),
    index('document_extractions_workspace_idx').on(t.workspaceId),
  ],
);
