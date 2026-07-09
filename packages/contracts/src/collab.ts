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
// Evidence-to-Decision Intelligence — verification / scorecard / review queue
// ---------------------------------------------------------------------------

export const ClaimVerdictKindSchema = z.enum(['supports', 'refutes', 'mixed', 'not_enough_info']);
export type ClaimVerdictKind = z.infer<typeof ClaimVerdictKindSchema>;

export const ClaimVerdictSummarySchema = z
  .object({
    supports: z.number().int().nonnegative(),
    refutes: z.number().int().nonnegative(),
    mixed: z.number().int().nonnegative(),
    notEnoughInfo: z.number().int().nonnegative(),
    claimCount: z.number().int().nonnegative(),
  })
  .strict();
export type ClaimVerdictSummary = z.infer<typeof ClaimVerdictSummarySchema>;

export const ClaimVerdictRowSchema = z
  .object({
    id: UuidSchema,
    claimId: z.string(),
    claimText: z.string(),
    evidenceRef: z.string().nullable(),
    evidenceItemId: UuidSchema.nullable(),
    verdict: ClaimVerdictKindSchema,
    confidence: z.number().min(0).max(1),
    rationale: z.string(),
    verifier: z.string(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ClaimVerdictRow = z.infer<typeof ClaimVerdictRowSchema>;

export const DecisionScorecardItemSchema = z
  .object({
    id: UuidSchema,
    alternativeId: z.string(),
    alternativeLabel: z.string(),
    weightedScore: z.number().min(0).max(1),
    uncertainty: z.number().min(0).max(1),
    evidenceCoverage: z.number().min(0).max(1),
    requiredAction: z.enum(['recommend', 'collect_more_evidence', 'defer']),
  })
  .strict();
export type DecisionScorecardItem = z.infer<typeof DecisionScorecardItemSchema>;

export const DecisionScorecardSummarySchema = z
  .object({
    id: UuidSchema,
    question: z.string(),
    recommendedAlternativeId: z.string().nullable(),
    ranked: z.array(DecisionScorecardItemSchema),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type DecisionScorecardSummary = z.infer<typeof DecisionScorecardSummarySchema>;

export const DocumentUnitsSummarySchema = z
  .object({
    total: z.number().int().nonnegative(),
    byModality: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict();
export type DocumentUnitsSummary = z.infer<typeof DocumentUnitsSummarySchema>;

export const ReviewQueueItemSchema = z
  .object({
    id: UuidSchema,
    itemKind: z.string(),
    title: z.string(),
    targetRef: z.string(),
    priorityScore: z.number().min(0),
    decisionImpact: z.number().min(0).max(1),
    uncertainty: z.number().min(0).max(1),
    evidenceGap: z.number().min(0).max(1),
    deadlineWeight: z.number().min(0),
    status: z.string(),
    reasons: z.array(z.string()).max(20),
    actions: z.array(z.object({
      id: z.enum(['rewrite_with_evidence', 'remove_sentence', 'request_more_sources']),
      label: z.enum(['근거 보강 후 재작성', '해당 문장 제거', '추가 자료 요청']),
      prompt: z.string().min(1).max(1000),
    }).strict()).length(3),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ReviewQueueItem = z.infer<typeof ReviewQueueItemSchema>;

export const ReviewQueueResponseSchema = z
  .object({ items: z.array(ReviewQueueItemSchema) })
  .strict();
export type ReviewQueueResponse = z.infer<typeof ReviewQueueResponseSchema>;

export const ReviewQueueDecisionRequestSchema = z
  .object({
    action: z.enum(['resolve', 'ignore']),
    note: z.string().trim().max(500).optional(),
  })
  .strict();
export type ReviewQueueDecisionRequest = z.infer<typeof ReviewQueueDecisionRequestSchema>;

export const VerificationMetricsSchema = z
  .object({
    totalLatencyMs: z.number().int().nonnegative(),
    providerCalls: z.object({ nli: z.number().int().nonnegative(), llm: z.number().int().nonnegative(), heuristic: z.number().int().nonnegative() }).strict(),
    providerLatencies: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict();
export type VerificationMetrics = z.infer<typeof VerificationMetricsSchema>;

export const VerifierGateIssueSchema = z
  .object({
    code: z.enum([
      'missing_verifier_telemetry',
      'exactness_blocked',
      'citation_issue',
      'high_impact_refute',
      'high_impact_unsupported',
      'semantic_refute',
      'semantic_unsupported',
      'judgment_guard_blocker',
      'source_intake_parse_failure',
      'applicability_map_required',
      'decision_gate_order_required',
      'latest_authority_required',
      'comparator_consistency_required',
      'counterargument_required',
      'user_correction_pattern',
      'overclaim_strength_risk',
    ]),
    severity: z.enum(['warning', 'blocker']),
    message: z.string().min(1),
    claimId: z.string().optional(),
  })
  .strict();
export type VerifierGateIssue = z.infer<typeof VerifierGateIssueSchema>;

export const VerifierGateSummarySchema = z
  .object({
    decision: z.enum(['PASS', 'PASS_WITH_WARNINGS', 'BLOCKED']),
    blockers: z.array(VerifierGateIssueSchema),
    warnings: z.array(VerifierGateIssueSchema),
  })
  .strict();
export type VerifierGateSummary = z.infer<typeof VerifierGateSummarySchema>;

export const ExactnessPassSchema = z
  .object({
    method: z.enum(['decimal_formula', 'decimal_invariant']),
    value: z.string(),
    detail: z.string(),
  })
  .strict();
export type ExactnessPass = z.infer<typeof ExactnessPassSchema>;

export const ExactnessCheckSchema = z
  .object({
    id: z.string(),
    kind: z.enum(['sum_equals_total', 'percentage_change', 'ratio_percent']),
    status: z.enum(['passed', 'mismatch', 'invalid_input']),
    value: z.string().nullable(),
    expected: z.string().nullable(),
    reason: z.string(),
    passes: z.array(ExactnessPassSchema),
  })
  .strict();
export type ExactnessCheck = z.infer<typeof ExactnessCheckSchema>;

export const ExactnessRunSummarySchema = z
  .object({
    id: UuidSchema,
    status: z.enum(['skipped', 'passed', 'blocked']),
    required: z.boolean(),
    summary: z.string(),
    answerInstruction: z.string(),
    checks: z.array(ExactnessCheckSchema),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ExactnessRunSummary = z.infer<typeof ExactnessRunSummarySchema>;

export const ExactnessSummarySchema = z
  .object({
    latestRun: ExactnessRunSummarySchema.nullable(),
    blockedCount: z.number().int().nonnegative(),
  })
  .strict();
export type ExactnessSummary = z.infer<typeof ExactnessSummarySchema>;

export const EvidenceDecisionSummaryResponseSchema = z
  .object({
    verdictSummary: ClaimVerdictSummarySchema,
    latestVerdicts: z.array(ClaimVerdictRowSchema),
    latestScorecard: DecisionScorecardSummarySchema.nullable(),
    documentUnits: DocumentUnitsSummarySchema,
    reviewQueue: z.object({ openCount: z.number().int().nonnegative(), top: ReviewQueueItemSchema.nullable() }).strict(),
    postAnswerVerification: z
      .object({
        checkedMessageCount: z.number().int().nonnegative(),
        unsupportedCount: z.number().int().nonnegative(),
        refutedCount: z.number().int().nonnegative(),
        verificationMetrics: VerificationMetricsSchema,
        gate: VerifierGateSummarySchema,
      })
      .strict(),
    exactness: ExactnessSummarySchema,
  })
  .strict();
export type EvidenceDecisionSummaryResponse = z.infer<typeof EvidenceDecisionSummaryResponseSchema>;

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

export const ArtifactExportPreflightResponseSchema = z
  .object({
    canExport: z.boolean(),
    reason: z.enum(['OK', 'NO_SOURCE_MESSAGE', 'VERIFIER_GATE_BLOCKED']),
    versionNo: z.number().int().positive(),
    gate: VerifierGateSummarySchema.nullable(),
    messages: z.array(z.string().min(1)).max(20),
  })
  .strict();
export type ArtifactExportPreflightResponse = z.infer<typeof ArtifactExportPreflightResponseSchema>;

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
// Web Push (2026-07-06)
// ---------------------------------------------------------------------------

export const PushPublicKeyResponseSchema = z
  .object({
    /** VAPID public key (base64url) or null when push is not configured. */
    publicKey: z.string().nullable(),
  })
  .strict();
export type PushPublicKeyResponse = z.infer<typeof PushPublicKeyResponseSchema>;

export const PushSubscribeRequestSchema = z
  .object({
    endpoint: z.string().url().max(2000),
    keys: z
      .object({
        p256dh: z.string().min(1).max(500),
        auth: z.string().min(1).max(500),
      })
      .strict(),
  })
  .strict();
export type PushSubscribeRequest = z.infer<typeof PushSubscribeRequestSchema>;

export const PushUnsubscribeRequestSchema = z
  .object({
    endpoint: z.string().url().max(2000),
  })
  .strict();
export type PushUnsubscribeRequest = z.infer<typeof PushUnsubscribeRequestSchema>;

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
export type AttachmentSummary = z.infer<typeof AttachmentSummarySchema>;

export const ListAttachmentsResponseSchema = z
  .object({ attachments: z.array(AttachmentSummarySchema) })
  .strict();
export type ListAttachmentsResponse = z.infer<typeof ListAttachmentsResponseSchema>;

export const UploadAttachmentResponseSchema = z
  .object({ id: UuidSchema })
  .strict();
export type UploadAttachmentResponse = z.infer<typeof UploadAttachmentResponseSchema>;

/** 축3: 파일 뷰어용 추출 텍스트 응답. document_extractions.textContent 노출. */
export const AttachmentExtractionResponseSchema = z
  .object({
    attachmentId: UuidSchema,
    fileName: z.string(),
    mimeType: z.string(),
    status: z.enum(['processing', 'indexed', 'skipped', 'failed']).nullable(),
    extractor: z.string().nullable(),
    textContent: z.string(),
    textChars: z.number().int().nonnegative(),
    qualityScore: z.number().int().min(0).max(100),
    warnings: z.array(z.string()).max(20),
  })
  .strict();
export type AttachmentExtractionResponse = z.infer<typeof AttachmentExtractionResponseSchema>;
