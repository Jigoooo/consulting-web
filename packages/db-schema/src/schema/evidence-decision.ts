import { boolean, index, integer, jsonb, numeric, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { primaryId, softDelete, timestamps } from './_shared';
import { evidenceItems, fileAttachments, documentExtractions } from './collab';
import { workspaces } from './organization';
import { channels, chatMessages, projects, threads, topics } from './space';

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

export const judgmentGuardRuns = pgTable(
  'judgment_guard_runs',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    threadId: uuid('thread_id').references(() => threads.id, { onDelete: 'set null' }),
    assistantMessageId: uuid('assistant_message_id').references(() => chatMessages.id, { onDelete: 'cascade' }),
    runKind: text('run_kind').notNull().default('judgment_guard_v1'),
    required: boolean('required').notNull().default(false),
    status: text('status').notNull().default('skipped'),
    queryHash: text('query_hash').notNull(),
    issueSummary: text('issue_summary').notNull().default('none'),
    issues: jsonb('issues').$type<Record<string, unknown>[]>().notNull().default([]),
    promptRules: jsonb('prompt_rules').$type<string[]>().notNull().default([]),
    currentTimeIso: text('current_time_iso').notNull(),
    userCorrectionDetected: boolean('user_correction_detected').notNull().default(false),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('judgment_guard_runs_workspace_idx').on(t.workspaceId, t.createdAt),
    index('judgment_guard_runs_thread_idx').on(t.threadId, t.createdAt),
    index('judgment_guard_runs_message_idx').on(t.assistantMessageId, t.createdAt),
    index('judgment_guard_runs_status_idx').on(t.workspaceId, t.status, t.createdAt),
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

export const provenanceGraphEdges = pgTable(
  'provenance_graph_edges',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    threadId: uuid('thread_id').references(() => threads.id, { onDelete: 'set null' }),
    sourceRef: text('source_ref').notNull(),
    targetRef: text('target_ref').notNull(),
    edgeType: text('edge_type').notNull(),
    confidence: numeric('confidence').notNull().default('0'),
    evidenceRefs: jsonb('evidence_refs').$type<string[]>().notNull().default([]),
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validTo: timestamp('valid_to', { withTimezone: true }),
    observedAt: timestamp('observed_at', { withTimezone: true }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    collectedAt: timestamp('collected_at', { withTimezone: true }),
    supersededBy: text('superseded_by'),
    rationale: text('rationale').notNull().default(''),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('provenance_edges_workspace_idx').on(t.workspaceId, t.createdAt),
    index('provenance_edges_thread_idx').on(t.threadId, t.createdAt),
    index('provenance_edges_source_idx').on(t.workspaceId, t.sourceRef, t.edgeType),
    index('provenance_edges_target_idx').on(t.workspaceId, t.targetRef, t.edgeType),
    index('provenance_edges_temporal_idx').on(t.workspaceId, t.validFrom, t.validTo),
  ],
);

export const traceSpans = pgTable(
  'trace_spans',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    threadId: uuid('thread_id').references(() => threads.id, { onDelete: 'set null' }),
    traceId: text('trace_id').notNull(),
    parentSpanId: uuid('parent_span_id'),
    spanKind: text('span_kind').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull().default('ok'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    durationMs: integer('duration_ms').notNull().default(0),
    input: jsonb('input').$type<Record<string, unknown> | null>(),
    output: jsonb('output').$type<Record<string, unknown> | null>(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('trace_spans_workspace_idx').on(t.workspaceId, t.createdAt),
    index('trace_spans_trace_idx').on(t.workspaceId, t.traceId, t.startedAt),
    index('trace_spans_thread_idx').on(t.threadId, t.createdAt),
    index('trace_spans_kind_idx').on(t.workspaceId, t.spanKind, t.startedAt),
  ],
);

export const evalCases = pgTable(
  'eval_cases',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    threadId: uuid('thread_id').references(() => threads.id, { onDelete: 'set null' }),
    caseKind: text('case_kind').notNull(),
    sourceRef: text('source_ref').notNull(),
    prompt: text('prompt').notNull(),
    expected: jsonb('expected').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').notNull().default('active'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    uniqueIndex('eval_cases_source_uq').on(t.workspaceId, t.caseKind, t.sourceRef),
    index('eval_cases_workspace_idx').on(t.workspaceId, t.status, t.createdAt),
    index('eval_cases_thread_idx').on(t.threadId, t.createdAt),
  ],
);

export const evalRuns = pgTable(
  'eval_runs',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    runKind: text('run_kind').notNull(),
    status: text('status').notNull().default('running'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    metrics: jsonb('metrics').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('eval_runs_workspace_idx').on(t.workspaceId, t.createdAt),
    index('eval_runs_kind_idx').on(t.workspaceId, t.runKind, t.createdAt),
    index('eval_runs_status_idx').on(t.workspaceId, t.status, t.createdAt),
  ],
);

export const evalScores = pgTable(
  'eval_scores',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    evalRunId: uuid('eval_run_id')
      .notNull()
      .references(() => evalRuns.id, { onDelete: 'cascade' }),
    evalCaseId: uuid('eval_case_id')
      .notNull()
      .references(() => evalCases.id, { onDelete: 'cascade' }),
    metricName: text('metric_name').notNull(),
    score: numeric('score').notNull().default('0'),
    passed: boolean('passed').notNull().default(false),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    uniqueIndex('eval_scores_run_case_metric_uq').on(t.evalRunId, t.evalCaseId, t.metricName),
    index('eval_scores_workspace_idx').on(t.workspaceId, t.createdAt),
    index('eval_scores_run_idx').on(t.evalRunId, t.metricName),
    index('eval_scores_case_idx').on(t.evalCaseId),
  ],
);

export const memoryWriteCandidates = pgTable(
  'memory_write_candidates',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    threadId: uuid('thread_id').references(() => threads.id, { onDelete: 'set null' }),
    assistantMessageId: uuid('assistant_message_id').references(() => chatMessages.id, { onDelete: 'cascade' }),
    runId: text('run_id'),
    policyDecisionId: text('policy_decision_id').notNull(),
    traceId: text('trace_id').notNull(),
    candidateText: text('candidate_text').notNull(),
    allowedSegments: jsonb('allowed_segments').$type<Record<string, unknown>[]>().notNull().default([]),
    blockedSegments: jsonb('blocked_segments').$type<Record<string, unknown>[]>().notNull().default([]),
    status: text('status').notNull().default('quarantined'),
    reason: text('reason').notNull().default('assistant_output_requires_review'),
    reviewedByUserId: uuid('reviewed_by_user_id'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    unique('memory_write_candidates_policy_unique').on(t.policyDecisionId),
    index('memory_write_candidates_workspace_idx').on(t.workspaceId, t.status, t.createdAt),
    index('memory_write_candidates_thread_idx').on(t.threadId, t.createdAt),
    index('memory_write_candidates_message_idx').on(t.assistantMessageId, t.createdAt),
    index('memory_write_candidates_trace_idx').on(t.workspaceId, t.traceId),
  ],
);

export const retrievalRuns = pgTable(
  'retrieval_runs',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    channelId: uuid('channel_id').references(() => channels.id, { onDelete: 'set null' }),
    topicId: uuid('topic_id').references(() => topics.id, { onDelete: 'set null' }),
    threadId: uuid('thread_id').references(() => threads.id, { onDelete: 'set null' }),
    traceId: text('trace_id').notNull(),
    queryHash: text('query_hash').notNull(),
    queryText: text('query_text').notNull(),
    queryType: text('query_type').notNull().default('general'),
    retrievalMode: text('retrieval_mode').notNull().default('graphrag_fanout'),
    topK: integer('top_k').notNull().default(8),
    recallScopes: jsonb('recall_scopes').$type<Record<string, unknown>[]>().notNull().default([]),
    status: text('status').notNull(),
    evidenceSufficiencyStatus: text('evidence_sufficiency_status'),
    requiredAction: text('required_action'),
    hitCount: integer('hit_count').notNull().default(0),
    latencyMs: integer('latency_ms').notNull().default(0),
    rerank: text('rerank'),
    rerankError: text('rerank_error'),
    signals: jsonb('signals').$type<Record<string, unknown> | null>(),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('retrieval_runs_workspace_idx').on(t.workspaceId, t.createdAt),
    index('retrieval_runs_scope_idx').on(t.workspaceId, t.projectId, t.channelId, t.topicId, t.createdAt),
    index('retrieval_runs_thread_idx').on(t.threadId, t.createdAt),
    index('retrieval_runs_query_type_idx').on(t.workspaceId, t.queryType, t.createdAt),
    index('retrieval_runs_trace_idx').on(t.workspaceId, t.traceId),
    index('retrieval_runs_status_idx').on(t.workspaceId, t.status, t.createdAt),
  ],
);

export const retrievalHits = pgTable(
  'retrieval_hits',
  {
    id: primaryId,
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    retrievalRunId: uuid('retrieval_run_id')
      .notNull()
      .references(() => retrievalRuns.id, { onDelete: 'cascade' }),
    threadId: uuid('thread_id').references(() => threads.id, { onDelete: 'set null' }),
    rank: integer('rank').notNull(),
    rankBeforeRerank: integer('rank_before_rerank'),
    rankAfterRerank: integer('rank_after_rerank'),
    hitKind: text('hit_kind').notNull(),
    sourceTopicSlug: text('source_topic_slug'),
    sourceRelation: text('source_relation'),
    sourceWeight: numeric('source_weight'),
    score: numeric('score'),
    fusedScore: numeric('fused_score'),
    rerankScore: numeric('rerank_score'),
    adjustedScore: numeric('adjusted_score'),
    docTitle: text('doc_title'),
    utilityTier: text('utility_tier'),
    textPreview: text('text_preview').notNull(),
    linked: jsonb('linked').$type<string[]>().notNull().default([]),
    signalBreakdown: jsonb('signal_breakdown').$type<Record<string, unknown> | null>(),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('retrieval_hits_workspace_idx').on(t.workspaceId, t.createdAt),
    index('retrieval_hits_run_idx').on(t.retrievalRunId, t.rank),
    index('retrieval_hits_thread_idx').on(t.threadId, t.createdAt),
    index('retrieval_hits_source_idx').on(t.workspaceId, t.sourceTopicSlug),
  ],
);
