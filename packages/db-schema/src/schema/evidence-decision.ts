import { boolean, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { primaryId, softDelete, timestamps } from './_shared';
import { evidenceItems, fileAttachments, documentExtractions } from './collab';
import { workspaces } from './organization';
import { chatMessages, threads } from './space';

/**
 * Evidence-to-Decision Intelligence v1.
 *
 * These tables persist the first vertical slice beyond GraphRAG: claim verdicts,
 * stale-dependency queues, decision scorecards, document retrieval units, and
 * review priorities. Most identifiers are text refs on purpose because the
 * shared consulting brain still carries claim IDs like CL-D5-01 outside this PG
 * schema; PG UUID FKs are used only where the web app owns the entity.
 */
export const claimVerificationVerdicts = pgTable(
  'claim_verification_verdicts',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    threadId: uuid('thread_id').references(() => threads.id, { onDelete: 'set null' }),
    assistantMessageId: uuid('assistant_message_id').references(() => chatMessages.id, { onDelete: 'cascade' }),
    claimId: text('claim_id').notNull(),
    claimText: text('claim_text').notNull(),
    evidenceRef: text('evidence_ref'),
    evidenceItemId: uuid('evidence_item_id').references(() => evidenceItems.id, { onDelete: 'set null' }),
    verdict: text('verdict').notNull(),
    confidence: numeric('confidence').notNull().default('0'),
    matchedTerms: jsonb('matched_terms').$type<string[]>().notNull().default([]),
    contradictedTerms: jsonb('contradicted_terms').$type<string[]>().notNull().default([]),
    rationale: text('rationale').notNull().default(''),
    verifier: text('verifier').notNull().default('heuristic_v1'),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('claim_verdicts_workspace_idx').on(t.workspaceId, t.createdAt),
    index('claim_verdicts_thread_idx').on(t.threadId, t.createdAt),
    index('claim_verdicts_message_idx').on(t.assistantMessageId, t.createdAt),
    index('claim_verdicts_claim_idx').on(t.claimId),
  ],
);

export const truthMaintenanceQueue = pgTable(
  'truth_maintenance_queue',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    threadId: uuid('thread_id').references(() => threads.id, { onDelete: 'set null' }),
    reason: text('reason').notNull(),
    affectedClaimIds: jsonb('affected_claim_ids').$type<string[]>().notNull().default([]),
    affectedArtifactIds: jsonb('affected_artifact_ids').$type<string[]>().notNull().default([]),
    priorityScore: numeric('priority_score').notNull().default('0'),
    status: text('status').notNull().default('pending'),
    ...timestamps,
  },
  (t) => [
    index('truth_maintenance_workspace_idx').on(t.workspaceId, t.status, t.createdAt),
    index('truth_maintenance_thread_idx').on(t.threadId, t.createdAt),
  ],
);

export const decisionScorecards = pgTable(
  'decision_scorecards',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    threadId: uuid('thread_id').references(() => threads.id, { onDelete: 'set null' }),
    question: text('question').notNull(),
    recommendedAlternativeId: text('recommended_alternative_id'),
    scoreSummary: jsonb('score_summary').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('decision_scorecards_workspace_idx').on(t.workspaceId, t.createdAt),
    index('decision_scorecards_thread_idx').on(t.threadId, t.createdAt),
  ],
);

export const decisionScorecardItems = pgTable(
  'decision_scorecard_items',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    scorecardId: uuid('scorecard_id')
      .notNull()
      .references(() => decisionScorecards.id, { onDelete: 'cascade' }),
    alternativeId: text('alternative_id').notNull(),
    alternativeLabel: text('alternative_label').notNull(),
    weightedScore: numeric('weighted_score').notNull().default('0'),
    uncertainty: numeric('uncertainty').notNull().default('0'),
    evidenceCoverage: numeric('evidence_coverage').notNull().default('0'),
    requiredAction: text('required_action').notNull(),
    criteriaBreakdown: jsonb('criteria_breakdown').$type<Record<string, unknown>[]>().notNull().default([]),
    ...timestamps,
  },
  (t) => [
    index('decision_items_scorecard_idx').on(t.scorecardId),
    index('decision_items_workspace_idx').on(t.workspaceId, t.weightedScore),
  ],
);

export const documentRetrievalUnits = pgTable(
  'document_retrieval_units',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    attachmentId: uuid('attachment_id').references(() => fileAttachments.id, { onDelete: 'set null' }),
    extractionId: uuid('extraction_id').references(() => documentExtractions.id, { onDelete: 'set null' }),
    documentRef: text('document_ref').notNull(),
    modality: text('modality').notNull(),
    locator: text('locator').notNull(),
    textContent: text('text_content').notNull(),
    scorePrior: numeric('score_prior').notNull().default('0'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('document_units_workspace_idx').on(t.workspaceId, t.modality),
    index('document_units_attachment_idx').on(t.attachmentId),
    index('document_units_extraction_idx').on(t.extractionId),
  ],
);

export const documentUnitEmbeddings = pgTable(
  'document_unit_embeddings',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    documentUnitId: uuid('document_unit_id')
      .notNull()
      .references(() => documentRetrievalUnits.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    embeddingDim: integer('embedding_dim').notNull().default(0),
    inputSha256: text('input_sha256').notNull(),
    status: text('status').notNull().default('fallback'),
    fallbackReason: text('fallback_reason'),
    embedding: jsonb('embedding').$type<number[]>().notNull().default([]),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    uniqueIndex('document_unit_embeddings_unit_provider_input_uq').on(t.documentUnitId, t.provider, t.inputSha256),
    index('document_unit_embeddings_workspace_idx').on(t.workspaceId, t.provider, t.createdAt),
    index('document_unit_embeddings_unit_idx').on(t.documentUnitId, t.createdAt),
    index('document_unit_embeddings_status_idx').on(t.workspaceId, t.status, t.createdAt),
  ],
);

export const exactnessRuns = pgTable(
  'exactness_runs',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    threadId: uuid('thread_id').references(() => threads.id, { onDelete: 'set null' }),
    assistantMessageId: uuid('assistant_message_id').references(() => chatMessages.id, { onDelete: 'cascade' }),
    runKind: text('run_kind').notNull().default('exactness_gate_v1'),
    required: boolean('required').notNull().default(false),
    status: text('status').notNull(),
    queryHash: text('query_hash').notNull(),
    checks: jsonb('checks').$type<Record<string, unknown>[]>().notNull().default([]),
    summary: text('summary').notNull().default(''),
    answerInstruction: text('answer_instruction').notNull().default(''),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('exactness_runs_workspace_idx').on(t.workspaceId, t.createdAt),
    index('exactness_runs_thread_idx').on(t.threadId, t.createdAt),
    index('exactness_runs_message_idx').on(t.assistantMessageId, t.createdAt),
    index('exactness_runs_status_idx').on(t.workspaceId, t.status, t.createdAt),
  ],
);

export const activeReviewItems = pgTable(
  'active_review_items',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    threadId: uuid('thread_id').references(() => threads.id, { onDelete: 'set null' }),
    itemKind: text('item_kind').notNull(),
    title: text('title').notNull(),
    targetRef: text('target_ref').notNull(),
    decisionImpact: numeric('decision_impact').notNull().default('0'),
    uncertainty: numeric('uncertainty').notNull().default('0'),
    evidenceGap: numeric('evidence_gap').notNull().default('0'),
    deadlineWeight: numeric('deadline_weight').notNull().default('1'),
    priorityScore: numeric('priority_score').notNull().default('0'),
    dueAt: timestamp('due_at', { withTimezone: true }),
    status: text('status').notNull().default('open'),
    reasons: jsonb('reasons').$type<string[]>().notNull().default([]),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('active_review_workspace_idx').on(t.workspaceId, t.status, t.priorityScore),
    index('active_review_thread_idx').on(t.threadId, t.createdAt),
  ],
);
