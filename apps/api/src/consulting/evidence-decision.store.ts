import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  DecisionAnalyticsRunSchema,
  JudgmentGuardIssueSchema,
  RetrievalFailureTypeSchema,
  type DecisionAnalyticsRun,
  type EvidenceDecisionSummaryResponse,
  type EvidenceDecisionSummaryV2Response,
  type EvidenceDecisionSummaryV3Response,
  type ListRetrievalHitFeedbackResponse,
  type RetrievalFailureType,
  type ReviewQueueFilter,
  type ReviewQueueResponse,
  type RunDecisionAnalyticsRequest,
} from '@consulting/contracts';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';
import { EvidenceToDecisionService, type ClaimInput, type ClaimVerdict, type DecisionRating, type EvidenceInput, type ProvenanceGraphEdge, type ReviewInput, type StrictJsonVerificationResult } from './evidence-to-decision.service.js';
import { ClaimVerifierService } from './claim-verifier.service.js';
import { ExactnessGateService, type ExactnessGateResult, type ExactnessRunStatus } from './exactness-gate.service.js';
import { VerifierGatePolicyService, type VerifierGateResult } from './verifier-gate-policy.service.js';
import { ConsultingJudgmentGuardService, type ConsultingJudgmentGuardResult } from './consulting-judgment-guard.service.js';
import type { ConsultingVerifiedContradiction } from './consulting-web-ingest.service.js';
import { buildDecisionAnalyticsAudit, type DecisionAnalyticsAuditInput } from './decision-analytics-audit.js';
import { artifactContentHash } from '../artifacts/artifact-export-preflight-audit.js';

const FACTUAL_RE = /(이다|입니다|한다|합니다|된다|됩니다|있다|있습니다|없다|없습니다|필요|확정|증가|감소|부담|영향|제시|늘려|줄어|higher|lower|increase|decrease)/iu;

type ReviewAction = {
  id: 'rewrite_with_evidence' | 'remove_sentence' | 'request_more_sources';
  label: '근거 보강 후 재작성' | '해당 문장 제거' | '추가 자료 요청';
  prompt: string;
};

export interface CompletedAnswerInput {
  workspaceId: string;
  threadId: string;
  assistantMessageId: string;
  userPrompt: string;
  answer: string;
  runId: string | null;
}

type PreparedEvidenceRow = {
  id: string;
  ref: string;
  excerpt: string;
  qualityScore: number | null;
  createdAt: Date;
};

export interface PreparedCompletedAnswer {
  fingerprint: string;
  startedAt: Date;
  durationMs: number;
  evidenceRows: PreparedEvidenceRow[];
  evidence: EvidenceInput[];
  verification: StrictJsonVerificationResult | null;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  return 0;
}

function retrievalFailureTypeForResponse(value: string | null): RetrievalFailureType | null {
  if (value === null) return null;
  const parsed = RetrievalFailureTypeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function iso(value: Date): string {
  return value.toISOString();
}

function splitClaims(answer: string): string[] {
  return answer
    .split(/(?<=[.!?。]|다\.)\s+|\n+/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 8 && FACTUAL_RE.test(part))
    .slice(0, 12);
}

function latestMessagePrefix(messageId: string): string {
  return messageId.replaceAll('-', '').slice(0, 10).toUpperCase();
}

function completedAnswerFingerprint(input: CompletedAnswerInput): string {
  return createHash('sha256')
    .update(JSON.stringify([
      input.workspaceId,
      input.threadId,
      input.assistantMessageId,
      input.userPrompt,
      input.answer,
      input.runId,
    ]))
    .digest('hex');
}

/**
 * Durable store for Evidence-to-Decision Intelligence.
 *
 * This is deliberately deterministic in v1: the verifier emits a strict JSON-like
 * structure and persists only schema-checked fields. A future NLI/LLM verifier can
 * replace the verdict source without changing API/UI contracts.
 */
@Injectable()
export class EvidenceDecisionStore {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(EvidenceToDecisionService) private readonly engine: EvidenceToDecisionService,
    @Inject(ClaimVerifierService) private readonly verifier: ClaimVerifierService,
    @Inject(ExactnessGateService) private readonly exactness: ExactnessGateService,
    @Inject(VerifierGatePolicyService) private readonly gatePolicy: VerifierGatePolicyService,
    @Inject(ConsultingJudgmentGuardService) private readonly judgmentGuard: ConsultingJudgmentGuardService,
  ) {}

  async recordCompletedAnswer(input: CompletedAnswerInput): Promise<{ verifiedContradictions: ConsultingVerifiedContradiction[] }> {
    const prepared = await this.prepareCompletedAnswer(input);
    return this.persistCompletedAnswer(input, prepared, this.db);
  }

  /** Reads evidence and performs optional remote verification without holding a DB transaction. */
  async prepareCompletedAnswer(input: CompletedAnswerInput): Promise<PreparedCompletedAnswer> {
    const startedAt = new Date();
    const startedMs = Date.now();
    await this.assertThreadInWorkspace(input.workspaceId, input.threadId, this.db);
    const claimTexts = splitClaims(input.answer);
    if (claimTexts.length === 0) {
      return {
        fingerprint: completedAnswerFingerprint(input),
        startedAt,
        durationMs: Date.now() - startedMs,
        evidenceRows: [],
        evidence: [],
        verification: null,
      };
    }

    const evidenceRows = await this.db
      .select({
        id: schema.evidenceItems.id,
        ref: schema.evidenceItems.ref,
        excerpt: schema.evidenceItems.excerpt,
        qualityScore: schema.evidenceItems.qualityScore,
        createdAt: schema.evidenceItems.createdAt,
      })
      .from(schema.evidenceItems)
      .where(and(eq(schema.evidenceItems.threadId, input.threadId), isNull(schema.evidenceItems.deletedAt)))
      .orderBy(desc(schema.evidenceItems.createdAt))
      .limit(80);

    const prefix = latestMessagePrefix(input.assistantMessageId);
    const claims: ClaimInput[] = claimTexts.map((text, index) => ({
      id: `MSG-${prefix}-${index + 1}`,
      text,
      decisionImpact: text.includes('감소') || text.includes('증가') || text.includes('부담') ? 0.82 : 0.62,
    }));
    const evidence: EvidenceInput[] = evidenceRows.map((row) => ({
      id: row.id,
      text: `${row.ref}\n${row.excerpt}`,
      qualityScore: row.qualityScore ?? 70,
      observedAt: row.createdAt,
      collectedAt: row.createdAt,
    }));

    const highRiskClaimIds = claims.filter((claim) => (claim.decisionImpact ?? 0) >= 0.8).map((claim) => claim.id);
    const verification = await this.verifier.verify({ claims, evidence, highRiskClaimIds });
    return {
      fingerprint: completedAnswerFingerprint(input),
      startedAt,
      durationMs: Date.now() - startedMs,
      evidenceRows,
      evidence,
      verification,
    };
  }

  /** Persists a prepared verification inside the caller's short settlement transaction. */
  async persistCompletedAnswer(
    input: CompletedAnswerInput,
    prepared: PreparedCompletedAnswer,
    db: Db,
  ): Promise<{ verifiedContradictions: ConsultingVerifiedContradiction[] }> {
    if (prepared.fingerprint !== completedAnswerFingerprint(input)) {
      throw new Error('prepared completed-answer verification does not match input');
    }
    await this.assertThreadInWorkspace(input.workspaceId, input.threadId, db);
    const judgmentGuard = this.judgmentGuard.evaluate({ query: input.userPrompt, hits: [], userFeedback: input.answer, now: new Date() });
    if (judgmentGuard.required) await this.persistJudgmentGuardRun(input, judgmentGuard, db);

    const exactnessRun = this.exactness.evaluateAnswer({ query: input.userPrompt, answer: input.answer });
    if (exactnessRun.required) await this.persistExactnessRun(input, exactnessRun, db);
    if (!prepared.verification) return { verifiedContradictions: [] };

    const { evidenceRows, evidence, verification } = prepared;
    const lattice = verification.lattice;
    const evidenceById = new Map(evidenceRows.map((row) => [row.id, row]));
    const verifiedContradictions: ConsultingVerifiedContradiction[] = [];
    for (const verdict of lattice.verdicts) {
      if (verdict.verdict !== 'refutes' && verdict.verdict !== 'mixed') continue;
      const counterEvidenceId = verdict.verdict === 'refutes' ? verdict.evidenceId : verdict.counterEvidenceId;
      const counterEvidence = counterEvidenceId ? evidenceById.get(counterEvidenceId) : undefined;
      if (!counterEvidence?.ref || !counterEvidence.excerpt) continue;
      verifiedContradictions.push({
        verdictRef: `assistant:${input.assistantMessageId}:${verdict.claimId}`,
        claimId: verdict.claimId,
        claimText: verdict.claimText,
        verdict: verdict.verdict,
        confidence: verdict.confidence,
        rationale: verdict.rationale,
        evidenceItemId: counterEvidence.id,
        evidenceRef: counterEvidence.ref,
        evidenceText: counterEvidence.excerpt,
      });
    }
    if (lattice.verdicts.length > 0) {
      await db.insert(schema.claimVerificationVerdicts).values(
        lattice.verdicts.map((verdict) => {
          const verdictEvidenceId = verdict.verdict === 'mixed' ? (verdict.counterEvidenceId ?? null) : verdict.evidenceId;
          return {
            workspaceId: input.workspaceId,
            threadId: input.threadId,
            assistantMessageId: input.assistantMessageId,
            claimId: verdict.claimId,
            claimText: verdict.claimText,
            evidenceRef: verdictEvidenceId,
            evidenceItemId: verdictEvidenceId,
            verdict: verdict.verdict,
            confidence: String(verdict.confidence),
            matchedTerms: verdict.matchedTerms,
            contradictedTerms: verdict.contradictedTerms,
            rationale: verdict.rationale,
            verifier: verification.verifier,
          };
        }),
      );
    }

    const provenanceGraph = this.engine.buildProvenanceGraph({ verdicts: lattice.verdicts, evidence, asOf: new Date() });
    if (provenanceGraph.edges.length > 0) {
      try {
        await db.insert(schema.provenanceGraphEdges).values(
          provenanceGraph.edges.map((edge) => ({
            workspaceId: input.workspaceId,
            threadId: input.threadId,
            sourceRef: edge.sourceRef,
            targetRef: edge.targetRef,
            edgeType: edge.edgeType,
            confidence: String(edge.confidence),
            evidenceRefs: edge.evidenceRefs,
            validFrom: edgeDate(edge.validFrom),
            validTo: edgeDate(edge.validTo),
            observedAt: edgeDate(edge.observedAt),
            publishedAt: edgeDate(edge.publishedAt),
            collectedAt: edgeDate(edge.collectedAt),
            supersededBy: edge.supersededBy,
            rationale: edge.rationale,
            metadata: edge.metadata,
          })),
        );
      } catch (error) {
        if (!isMissingRelationError(error)) throw error;
      }
    }

    const supported = lattice.summary.supports;
    const refuted = lattice.summary.refutes + lattice.summary.mixed;
    const unsupported = lattice.summary.notEnoughInfo;
    const claimCount = Math.max(1, lattice.summary.claimCount);
    const verifierGate = this.gatePolicy.evaluate({ mode: 'report_decision', exactnessStatus: exactnessRun.status, citationIssueCount: 0, verdicts: lattice.verdicts, judgmentIssues: judgmentGuard.issues });
    const ratings: DecisionRating[] = [
      { alternativeId: 'answer_as_written', criterionId: 'support', score: supported / claimCount, uncertainty: unsupported / claimCount, evidenceIds: evidenceRows.map((row) => row.id).slice(0, 3) },
      { alternativeId: 'answer_as_written', criterionId: 'contradiction_risk', score: refuted / claimCount, uncertainty: unsupported / claimCount, evidenceIds: [] },
      { alternativeId: 'collect_more_evidence', criterionId: 'support', score: Math.min(1, (unsupported + refuted) / claimCount), uncertainty: 0.25, evidenceIds: [] },
      { alternativeId: 'collect_more_evidence', criterionId: 'contradiction_risk', score: 0.15, uncertainty: 0.2, evidenceIds: [] },
    ];
    const scorecard = this.engine.buildDecisionScorecard({
      question: 'post_answer_verification',
      alternatives: [
        { id: 'answer_as_written', label: '현재 답변 유지' },
        { id: 'collect_more_evidence', label: '근거 보강 후 재작성' },
      ],
      criteria: [
        { id: 'support', label: '근거 지지율', weight: 0.65 },
        { id: 'contradiction_risk', label: '반박 위험', weight: 0.35, direction: 'lower_is_better' },
      ],
      ratings,
    });
    const [scorecardRow] = await db
      .insert(schema.decisionScorecards)
      .values({
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        question: scorecard.question,
        recommendedAlternativeId: scorecard.recommendedAlternativeId,
        scoreSummary: { runId: input.runId, source: 'post_answer_verification_v2', verificationMetrics: verification.metrics, verifier: verification.verifier, verifierGate },
      })
      .returning({ id: schema.decisionScorecards.id });
    if (scorecardRow) {
      await db.insert(schema.decisionScorecardItems).values(
        scorecard.ranked.map((item) => ({
          workspaceId: input.workspaceId,
          scorecardId: scorecardRow.id,
          alternativeId: item.alternativeId,
          alternativeLabel: item.label,
          weightedScore: String(item.weightedScore),
          uncertainty: String(item.uncertainty),
          evidenceCoverage: String(item.evidenceCoverage),
          requiredAction: item.requiredAction,
          criteriaBreakdown: item.criteriaBreakdown,
        })),
      );
      const analytics = buildDecisionAnalyticsAudit({
        scorecardId: scorecardRow.id,
        source: 'post_answer_verification_v2',
        ranked: scorecard.ranked.map((item) => ({
          alternativeId: item.alternativeId,
          label: item.label,
          criteriaBreakdown: item.criteriaBreakdown,
        })),
        perturbationPct: 0.2,
        scenarios: 2_000,
      });
      await db.insert(schema.decisionAnalyticsRuns).values({
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        scorecardId: scorecardRow.id,
        methodVersion: analytics.methodVersion,
        inputHash: analytics.inputHash,
        inputSnapshot: analytics.inputSnapshot,
        sensitivity: analytics.sensitivity,
        impact: analytics.impact,
        actorKind: 'system',
        actorUserId: null,
      });
    }

    const reviewInputs: ReviewInput[] = [
      ...lattice.verdicts
        .filter((verdict) => verdict.verdict !== 'supports')
        .map((verdict) => ({
          id: verdict.claimId,
          kind: verdict.verdict === 'refutes' || verdict.verdict === 'mixed' ? 'refuted_claim' : 'unsupported_claim',
          title: verdict.claimText.slice(0, 120),
          decisionImpact: verdict.decisionImpact,
          uncertainty: clamp01(1 - verdict.confidence),
          evidenceGap: verdict.verdict === 'not_enough_info' ? 1 : 0.75,
        })),
      ...provenanceGraph.reviewItems,
    ];
    const reviewQueue = this.engine.prioritizeReviewQueue({ items: reviewInputs });
    if (reviewQueue.length > 0) {
      await db.insert(schema.activeReviewItems).values(
        reviewQueue.map((item) => ({
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          itemKind: item.kind,
          title: item.title,
          targetRef: item.id,
          decisionImpact: String(item.decisionImpact),
          uncertainty: String(item.uncertainty),
          evidenceGap: String(item.evidenceGap),
          deadlineWeight: String(item.deadlineWeight),
          priorityScore: String(item.priorityScore),
          status: 'open',
          reasons: item.reasons,
        })),
      );
    }

    await this.persistPostAnswerTelemetry({
      input,
      exactnessRun,
      verdictSummary: lattice.summary,
      verifierGate,
      verificationMetrics: verification.metrics,
      startedAt: prepared.startedAt,
      durationMs: prepared.durationMs,
    }, db);
    return { verifiedContradictions };
  }

  private async persistPostAnswerTelemetry(args: {
    input: {
      workspaceId: string;
      threadId: string;
      assistantMessageId: string;
      userPrompt: string;
      answer: string;
      runId: string | null;
    };
    exactnessRun: ExactnessGateResult;
    verdictSummary: { supports: number; refutes: number; mixed: number; notEnoughInfo: number; claimCount: number };
    verifierGate: VerifierGateResult;
    verificationMetrics: unknown;
    startedAt: Date;
    durationMs: number;
  }, db: Db = this.db): Promise<void> {
    const { input, exactnessRun, verdictSummary, verifierGate } = args;
    const traceId = `post-answer:${input.runId ?? input.assistantMessageId}`;
    const claimCount = Math.max(1, verdictSummary.claimCount);
    const supportRate = clamp01(verdictSummary.supports / claimCount);
    const refutedRate = clamp01((verdictSummary.refutes + verdictSummary.mixed) / claimCount);
    const unsupportedRate = clamp01(verdictSummary.notEnoughInfo / claimCount);
    const exactnessScore = exactnessRun.status === 'blocked' ? 0 : 1;
    const finalExportScore = verifierGate.decision === 'BLOCKED' ? 0 : 1;
    const status = exactnessRun.status === 'blocked' || verifierGate.decision === 'BLOCKED' ? 'blocked' : 'completed';
    const endedAt = new Date(args.startedAt.getTime() + Math.max(0, Math.round(args.durationMs)));
    const sharedMetrics = {
      source: 'post_answer_verification_v1',
      traceId,
      runId: input.runId,
      assistantMessageId: input.assistantMessageId,
      exactnessStatus: exactnessRun.status,
      verifierGateDecision: verifierGate.decision,
      verdictSummary,
      verificationMetrics: args.verificationMetrics,
    };
    try {
      await db.insert(schema.traceSpans).values({
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        traceId,
        spanKind: 'verifier',
        name: 'consulting.post_answer.verification',
        status: status === 'blocked' ? 'blocked' : 'ok',
        startedAt: args.startedAt,
        endedAt,
        durationMs: Math.max(0, Math.round(args.durationMs)),
        input: { promptHash: exactnessQueryHash(input.userPrompt, ''), answerLength: input.answer.length },
        output: {
          exactnessStatus: exactnessRun.status,
          verifierGateDecision: verifierGate.decision,
          verdictSummary,
        },
        metadata: sharedMetrics,
      });
      const [evalCase] = await db
        .insert(schema.evalCases)
        .values({
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          caseKind: 'human_feedback',
          sourceRef: `message:${input.assistantMessageId}:post_answer_verification`,
          prompt: input.userPrompt,
          expected: {
            source: 'post_answer_verification_v1',
            exactnessStatus: exactnessRun.status,
            noHighImpactRefutes: verifierGate.decision !== 'BLOCKED',
          },
          status: 'active',
          metadata: sharedMetrics,
        })
        .returning({ id: schema.evalCases.id });
      const [evalRun] = await db
        .insert(schema.evalRuns)
        .values({
          workspaceId: input.workspaceId,
          runKind: 'post_answer_verification',
          status,
          startedAt: args.startedAt,
          completedAt: endedAt,
          metrics: sharedMetrics,
        })
        .returning({ id: schema.evalRuns.id });
      if (!evalCase || !evalRun) return;
      await db.insert(schema.evalScores).values([
        {
          workspaceId: input.workspaceId,
          evalRunId: evalRun.id,
          evalCaseId: evalCase.id,
          metricName: 'claim_support_rate',
          score: String(supportRate),
          passed: supportRate >= 0.5 && refutedRate === 0,
          detail: { supports: verdictSummary.supports, claimCount: verdictSummary.claimCount },
        },
        {
          workspaceId: input.workspaceId,
          evalRunId: evalRun.id,
          evalCaseId: evalCase.id,
          metricName: 'unsupported_rate',
          score: String(unsupportedRate),
          passed: unsupportedRate === 0,
          detail: { notEnoughInfo: verdictSummary.notEnoughInfo, claimCount: verdictSummary.claimCount },
        },
        {
          workspaceId: input.workspaceId,
          evalRunId: evalRun.id,
          evalCaseId: evalCase.id,
          metricName: 'refuted_rate',
          score: String(refutedRate),
          passed: refutedRate === 0,
          detail: { refutes: verdictSummary.refutes, mixed: verdictSummary.mixed, claimCount: verdictSummary.claimCount },
        },
        {
          workspaceId: input.workspaceId,
          evalRunId: evalRun.id,
          evalCaseId: evalCase.id,
          metricName: 'exactness_status',
          score: String(exactnessScore),
          passed: exactnessRun.status !== 'blocked',
          detail: { status: exactnessRun.status, required: exactnessRun.required, summary: exactnessRun.summary },
        },
        {
          workspaceId: input.workspaceId,
          evalRunId: evalRun.id,
          evalCaseId: evalCase.id,
          metricName: 'final_export_gate',
          score: String(finalExportScore),
          passed: verifierGate.decision !== 'BLOCKED',
          detail: { decision: verifierGate.decision, blockers: verifierGate.blockers, warnings: verifierGate.warnings },
        },
      ]);
    } catch (error) {
      if (!isMissingRelationError(error)) throw error;
    }
  }

  private async persistExactnessRun(input: {
    workspaceId: string;
    threadId: string;
    assistantMessageId: string;
    userPrompt: string;
    answer: string;
  }, run: ExactnessGateResult, db: Db = this.db): Promise<void> {
    try {
      await db.insert(schema.exactnessRuns).values({
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        assistantMessageId: input.assistantMessageId,
        required: run.required,
        status: run.status,
        queryHash: exactnessQueryHash(input.userPrompt, input.answer),
        checks: JSON.parse(JSON.stringify(run.checks)) as Record<string, unknown>[],
        summary: run.summary,
        answerInstruction: run.answerInstruction,
      });
    } catch (error) {
      if (isMissingRelationError(error)) return;
      throw error;
    }
  }

  private async persistJudgmentGuardRun(input: {
    workspaceId: string;
    threadId: string;
    assistantMessageId: string;
    userPrompt: string;
    answer: string;
  }, run: ConsultingJudgmentGuardResult, db: Db = this.db): Promise<void> {
    try {
      await db.insert(schema.judgmentGuardRuns).values({
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        assistantMessageId: input.assistantMessageId,
        required: run.required,
        status: run.issues.some((issue) => issue.severity === 'blocker') ? 'blocked' : 'warnings',
        queryHash: exactnessQueryHash(input.userPrompt, input.answer),
        issueSummary: run.issueSummary,
        issues: run.issues.map((issue) => ({ ...issue })),
        promptRules: run.promptRules,
        currentTimeIso: run.currentTimeIso,
        userCorrectionDetected: run.issues.some((issue) => issue.code === 'user_correction_pattern'),
      });
    } catch (error) {
      if (isMissingRelationError(error)) return;
      throw error;
    }
  }

  private async assertThreadInWorkspace(workspaceId: string, threadId: string, db: Db = this.db): Promise<void> {
    const [thread] = await db
      .select({ id: schema.threads.id })
      .from(schema.threads)
      .where(and(
        eq(schema.threads.id, threadId),
        eq(schema.threads.workspaceId, workspaceId),
        isNull(schema.threads.deletedAt),
      ))
      .limit(1);
    if (!thread) throw new Error('evidence decision thread/workspace mismatch');
  }

  async listRetrievalHits(input: { workspaceId: string; threadId: string; limit?: number }): Promise<ListRetrievalHitFeedbackResponse> {
    await this.assertThreadInWorkspace(input.workspaceId, input.threadId);
    const rows = await this.db
      .select({
        id: schema.retrievalHits.id,
        retrievalRunId: schema.retrievalHits.retrievalRunId,
        queryText: schema.retrievalRuns.queryText,
        rank: schema.retrievalHits.rank,
        hitKind: schema.retrievalHits.hitKind,
        sourceTopicSlug: schema.retrievalHits.sourceTopicSlug,
        docTitle: schema.retrievalHits.docTitle,
        textPreview: schema.retrievalHits.textPreview,
        score: schema.retrievalHits.adjustedScore,
        judgedRelevant: schema.retrievalHits.judgedRelevant,
        failureType: schema.retrievalHits.failureType,
        createdAt: schema.retrievalHits.createdAt,
      })
      .from(schema.retrievalHits)
      .innerJoin(schema.retrievalRuns, eq(schema.retrievalHits.retrievalRunId, schema.retrievalRuns.id))
      .where(and(
        eq(schema.retrievalHits.workspaceId, input.workspaceId),
        eq(schema.retrievalHits.threadId, input.threadId),
        eq(schema.retrievalRuns.workspaceId, input.workspaceId),
        eq(schema.retrievalRuns.threadId, input.threadId),
        isNull(schema.retrievalHits.deletedAt),
        isNull(schema.retrievalRuns.deletedAt),
      ))
      .orderBy(desc(schema.retrievalHits.createdAt), schema.retrievalHits.rank)
      .limit(Math.max(1, Math.min(50, input.limit ?? 20)));
    return {
      hits: rows.map((row) => ({
        id: row.id,
        retrievalRunId: row.retrievalRunId,
        queryText: row.queryText,
        rank: row.rank,
        hitKind: row.hitKind,
        sourceTopicSlug: row.sourceTopicSlug,
        docTitle: row.docTitle,
        textPreview: row.textPreview,
        score: row.score === null ? null : toNumber(row.score),
        judgedRelevant: row.judgedRelevant,
        failureType: retrievalFailureTypeForResponse(row.failureType),
        createdAt: iso(row.createdAt),
      })),
    };
  }

  async recordRetrievalHitFeedback(input: {
    workspaceId: string;
    threadId: string;
    hitId: string;
    judgedRelevant: boolean;
    failureType: RetrievalFailureType | null;
  }): Promise<boolean> {
    await this.assertThreadInWorkspace(input.workspaceId, input.threadId);
    const [row] = await this.db
      .update(schema.retrievalHits)
      .set({
        judgedRelevant: input.judgedRelevant,
        failureType: input.judgedRelevant ? null : input.failureType,
        updatedAt: new Date(),
      })
      .where(and(
        eq(schema.retrievalHits.id, input.hitId),
        eq(schema.retrievalHits.workspaceId, input.workspaceId),
        eq(schema.retrievalHits.threadId, input.threadId),
        isNull(schema.retrievalHits.deletedAt),
      ))
      .returning({ id: schema.retrievalHits.id });
    return Boolean(row);
  }

  async summary(threadId: string): Promise<EvidenceDecisionSummaryResponse> {
    const verdictRows = await this.db
      .select({
        id: schema.claimVerificationVerdicts.id,
        claimId: schema.claimVerificationVerdicts.claimId,
        claimText: schema.claimVerificationVerdicts.claimText,
        evidenceRef: schema.claimVerificationVerdicts.evidenceRef,
        evidenceItemId: schema.claimVerificationVerdicts.evidenceItemId,
        verdict: schema.claimVerificationVerdicts.verdict,
        confidence: schema.claimVerificationVerdicts.confidence,
        rationale: schema.claimVerificationVerdicts.rationale,
        verifier: schema.claimVerificationVerdicts.verifier,
        createdAt: schema.claimVerificationVerdicts.createdAt,
      })
      .from(schema.claimVerificationVerdicts)
      .where(and(eq(schema.claimVerificationVerdicts.threadId, threadId), isNull(schema.claimVerificationVerdicts.deletedAt)))
      .orderBy(desc(schema.claimVerificationVerdicts.createdAt))
      .limit(20);

    const allVerdicts = await this.db
      .select({ verdict: schema.claimVerificationVerdicts.verdict })
      .from(schema.claimVerificationVerdicts)
      .where(and(eq(schema.claimVerificationVerdicts.threadId, threadId), isNull(schema.claimVerificationVerdicts.deletedAt)));
    const verdictSummary = {
      supports: allVerdicts.filter((row) => row.verdict === 'supports').length,
      refutes: allVerdicts.filter((row) => row.verdict === 'refutes').length,
      mixed: allVerdicts.filter((row) => row.verdict === 'mixed').length,
      notEnoughInfo: allVerdicts.filter((row) => row.verdict === 'not_enough_info').length,
      claimCount: allVerdicts.length,
    };

    const [scorecard] = await this.db
      .select({
        id: schema.decisionScorecards.id,
        question: schema.decisionScorecards.question,
        recommendedAlternativeId: schema.decisionScorecards.recommendedAlternativeId,
        scoreSummary: schema.decisionScorecards.scoreSummary,
        createdAt: schema.decisionScorecards.createdAt,
      })
      .from(schema.decisionScorecards)
      .where(and(eq(schema.decisionScorecards.threadId, threadId), isNull(schema.decisionScorecards.deletedAt)))
      .orderBy(desc(schema.decisionScorecards.createdAt))
      .limit(1);
    const ranked = scorecard
      ? await this.db
          .select({
            id: schema.decisionScorecardItems.id,
            alternativeId: schema.decisionScorecardItems.alternativeId,
            alternativeLabel: schema.decisionScorecardItems.alternativeLabel,
            weightedScore: schema.decisionScorecardItems.weightedScore,
            uncertainty: schema.decisionScorecardItems.uncertainty,
            evidenceCoverage: schema.decisionScorecardItems.evidenceCoverage,
            requiredAction: schema.decisionScorecardItems.requiredAction,
          })
          .from(schema.decisionScorecardItems)
          .where(eq(schema.decisionScorecardItems.scorecardId, scorecard.id))
          .orderBy(desc(schema.decisionScorecardItems.weightedScore))
      : [];

    const documentRows = await this.db
      .select({ modality: schema.documentRetrievalUnits.modality })
      .from(schema.documentRetrievalUnits)
      .innerJoin(schema.fileAttachments, eq(schema.documentRetrievalUnits.attachmentId, schema.fileAttachments.id))
      .where(and(eq(schema.fileAttachments.threadId, threadId), isNull(schema.documentRetrievalUnits.deletedAt)));
    const byModality: Record<string, number> = {};
    for (const row of documentRows) byModality[row.modality] = (byModality[row.modality] ?? 0) + 1;

    const review = await this.reviewQueue(threadId, 50);
    let exactnessRows: Array<{
      id: string;
      status: string;
      required: boolean;
      checks: unknown;
      summary: string;
      answerInstruction: string;
      createdAt: Date;
    }> = [];
    try {
      exactnessRows = await this.db
        .select({
          id: schema.exactnessRuns.id,
          status: schema.exactnessRuns.status,
          required: schema.exactnessRuns.required,
          checks: schema.exactnessRuns.checks,
          summary: schema.exactnessRuns.summary,
          answerInstruction: schema.exactnessRuns.answerInstruction,
          createdAt: schema.exactnessRuns.createdAt,
        })
        .from(schema.exactnessRuns)
        .where(and(eq(schema.exactnessRuns.threadId, threadId), isNull(schema.exactnessRuns.deletedAt)))
        .orderBy(desc(schema.exactnessRuns.createdAt))
        .limit(50);
    } catch (error) {
      if (!isMissingRelationError(error)) throw error;
    }
    const latestExactness = exactnessRows[0];
    const latestExactnessStatus = latestExactness?.status === 'blocked' || latestExactness?.status === 'passed' || latestExactness?.status === 'skipped' ? latestExactness.status : undefined;
    const reportGate = this.gatePolicy.evaluate({
      mode: 'report_decision',
      ...(latestExactnessStatus ? { exactnessStatus: latestExactnessStatus } : {}),
      citationIssueCount: 0,
      verdicts: verdictRows.map(verdictRowForGate),
    });
    const checkedMessageIds = new Set(verdictRows.map((row) => row.claimId.split('-').slice(0, 2).join('-')));
    return {
      verdictSummary,
      latestVerdicts: verdictRows.map((row) => ({
        id: row.id,
        claimId: row.claimId,
        claimText: row.claimText,
        evidenceRef: row.evidenceRef,
        evidenceItemId: row.evidenceItemId,
        verdict: row.verdict as 'supports' | 'refutes' | 'mixed' | 'not_enough_info',
        confidence: toNumber(row.confidence),
        rationale: row.rationale,
        verifier: row.verifier,
        createdAt: iso(row.createdAt),
      })),
      latestScorecard: scorecard
        ? {
            id: scorecard.id,
            question: scorecard.question,
            recommendedAlternativeId: scorecard.recommendedAlternativeId,
            ranked: ranked.map((row) => ({
              id: row.id,
              alternativeId: row.alternativeId,
              alternativeLabel: row.alternativeLabel,
              weightedScore: toNumber(row.weightedScore),
              uncertainty: toNumber(row.uncertainty),
              evidenceCoverage: toNumber(row.evidenceCoverage),
              requiredAction: row.requiredAction as 'recommend' | 'collect_more_evidence' | 'defer',
            })),
            createdAt: iso(scorecard.createdAt),
          }
        : null,
      documentUnits: { total: documentRows.length, byModality },
      reviewQueue: { openCount: review.items.length, top: review.items[0] ?? null },
      postAnswerVerification: {
        checkedMessageCount: checkedMessageIds.size,
        unsupportedCount: verdictSummary.notEnoughInfo,
        refutedCount: verdictSummary.refutes + verdictSummary.mixed,
        verificationMetrics: verificationMetricsForResponse(scorecard?.scoreSummary),
        gate: reportGate,
      },
      exactness: {
        latestRun: latestExactness
          ? {
              id: latestExactness.id,
              status: latestExactness.status as 'skipped' | 'passed' | 'blocked',
              required: latestExactness.required,
              summary: latestExactness.summary,
              answerInstruction: latestExactness.answerInstruction,
              checks: exactnessChecksForResponse(latestExactness.checks),
              createdAt: iso(latestExactness.createdAt),
            }
          : null,
        blockedCount: exactnessRows.filter((row) => row.status === 'blocked').length,
      },
    };
  }

  async summaryV2(threadId: string): Promise<EvidenceDecisionSummaryV2Response> {
    const base = await this.summary(threadId);
    let judgmentRows: Array<{
      id: string;
      status: string;
      required: boolean;
      issueSummary: string;
      issues: unknown;
      promptRules: unknown;
      currentTimeIso: string;
      userCorrectionDetected: boolean;
      createdAt: Date;
    }> = [];
    try {
      judgmentRows = await this.db
        .select({
          id: schema.judgmentGuardRuns.id,
          status: schema.judgmentGuardRuns.status,
          required: schema.judgmentGuardRuns.required,
          issueSummary: schema.judgmentGuardRuns.issueSummary,
          issues: schema.judgmentGuardRuns.issues,
          promptRules: schema.judgmentGuardRuns.promptRules,
          currentTimeIso: schema.judgmentGuardRuns.currentTimeIso,
          userCorrectionDetected: schema.judgmentGuardRuns.userCorrectionDetected,
          createdAt: schema.judgmentGuardRuns.createdAt,
        })
        .from(schema.judgmentGuardRuns)
        .where(and(eq(schema.judgmentGuardRuns.threadId, threadId), isNull(schema.judgmentGuardRuns.deletedAt)))
        .orderBy(desc(schema.judgmentGuardRuns.createdAt))
        .limit(50);
    } catch (error) {
      if (!isMissingRelationError(error)) throw error;
    }
    const latestJudgment = judgmentRows[0];
    const judgmentIssues = judgmentIssuesForResponse(latestJudgment?.issues);
    const gate = this.gatePolicy.evaluate({
      mode: 'report_decision',
      ...(base.exactness.latestRun ? { exactnessStatus: base.exactness.latestRun.status } : {}),
      citationIssueCount: 0,
      verdicts: base.latestVerdicts.map(verdictRowForGate),
      judgmentIssues,
    });
    return {
      ...base,
      postAnswerVerification: { ...base.postAnswerVerification, gate },
      judgment: {
        latestRun: latestJudgment
          ? {
              id: latestJudgment.id,
              status: judgmentStatusForResponse(latestJudgment.status),
              required: latestJudgment.required,
              issueSummary: latestJudgment.issueSummary,
              issues: judgmentIssues,
              promptRules: stringArray(latestJudgment.promptRules),
              currentTimeIso: latestJudgment.currentTimeIso,
              userCorrectionDetected: latestJudgment.userCorrectionDetected,
              createdAt: iso(latestJudgment.createdAt),
            }
          : null,
        blockedCount: judgmentRows.filter((row) => row.status === 'blocked').length,
      },
    };
  }

  private analyticsRunForResponse(row: {
    id: string;
    scorecardId: string;
    artifactVersionId: string | null;
    artifactContentHash: string | null;
    methodVersion: string;
    inputHash: string;
    sensitivity: unknown;
    impact: unknown;
    actorKind: string;
    createdAt: Date;
  }): DecisionAnalyticsRun {
    return DecisionAnalyticsRunSchema.parse({
      id: row.id,
      scorecardId: row.scorecardId,
      artifactVersionId: row.artifactVersionId,
      artifactContentHash: row.artifactContentHash,
      methodVersion: row.methodVersion,
      inputHash: row.inputHash,
      sensitivity: row.sensitivity,
      impact: row.impact,
      actorKind: row.actorKind,
      createdAt: iso(row.createdAt),
    });
  }

  async decisionAnalyticsArtifactScope(
    threadId: string,
    artifactVersionId: string,
  ): Promise<{
    workspaceId: string;
    projectId: string;
    scorecard: { id: string; question: string; createdAt: string } | null;
  } | null> {
    const [row] = await this.db
      .select({
        workspaceId: schema.artifactVersions.workspaceId,
        projectId: schema.artifacts.projectId,
        sourceMessageId: schema.artifactVersions.sourceMessageId,
      })
      .from(schema.artifactVersions)
      .innerJoin(schema.artifacts, and(
        eq(schema.artifactVersions.artifactId, schema.artifacts.id),
        eq(schema.artifactVersions.workspaceId, schema.artifacts.workspaceId),
      ))
      .innerJoin(schema.threads, and(
        eq(schema.artifactVersions.sourceThreadId, schema.threads.id),
        eq(schema.artifactVersions.workspaceId, schema.threads.workspaceId),
      ))
      .innerJoin(schema.topics, and(
        eq(schema.threads.topicId, schema.topics.id),
        eq(schema.threads.workspaceId, schema.topics.workspaceId),
      ))
      .innerJoin(schema.channels, and(
        eq(schema.topics.channelId, schema.channels.id),
        eq(schema.topics.workspaceId, schema.channels.workspaceId),
      ))
      .innerJoin(schema.projects, and(
        eq(schema.artifacts.projectId, schema.projects.id),
        eq(schema.artifacts.workspaceId, schema.projects.workspaceId),
        eq(schema.channels.projectId, schema.projects.id),
      ))
      .where(and(
        eq(schema.artifactVersions.id, artifactVersionId),
        eq(schema.threads.id, threadId),
        eq(schema.threads.status, 'active'),
        eq(schema.topics.status, 'active'),
        eq(schema.channels.status, 'active'),
        eq(schema.projects.status, 'active'),
        isNull(schema.artifacts.deletedAt),
        isNull(schema.threads.deletedAt),
        isNull(schema.topics.deletedAt),
        isNull(schema.channels.deletedAt),
        isNull(schema.projects.deletedAt),
      ))
      .limit(1);
    if (!row) return null;
    if (!row.sourceMessageId) return { ...row, scorecard: null };
    const [sourceMessage] = await this.db
      .select({ runId: schema.chatMessages.runId })
      .from(schema.chatMessages)
      .where(and(
        eq(schema.chatMessages.id, row.sourceMessageId),
        eq(schema.chatMessages.workspaceId, row.workspaceId),
        eq(schema.chatMessages.threadId, threadId),
        eq(schema.chatMessages.role, 'assistant'),
        eq(schema.chatMessages.finishState, 'complete'),
        isNull(schema.chatMessages.deletedAt),
      ))
      .limit(1);
    if (!sourceMessage?.runId) return { ...row, scorecard: null };
    const scorecards = await this.db
      .select({
        id: schema.decisionScorecards.id,
        question: schema.decisionScorecards.question,
        createdAt: schema.decisionScorecards.createdAt,
      })
      .from(schema.decisionScorecards)
      .where(and(
        eq(schema.decisionScorecards.workspaceId, row.workspaceId),
        eq(schema.decisionScorecards.threadId, threadId),
        isNull(schema.decisionScorecards.deletedAt),
        sql`${schema.decisionScorecards.scoreSummary} ->> 'runId' = ${sourceMessage.runId}`,
      ))
      .orderBy(desc(schema.decisionScorecards.createdAt), desc(schema.decisionScorecards.id))
      .limit(2);
    const scorecard = scorecards.length === 1 && scorecards[0]
      ? { ...scorecards[0], createdAt: iso(scorecards[0].createdAt) }
      : null;
    return { workspaceId: row.workspaceId, projectId: row.projectId, scorecard };
  }

  async latestDecisionAnalytics(threadId: string, scorecardId?: string): Promise<DecisionAnalyticsRun | null> {
    const predicates = [eq(schema.decisionAnalyticsRuns.threadId, threadId)];
    if (scorecardId) predicates.push(eq(schema.decisionAnalyticsRuns.scorecardId, scorecardId));
    const [row] = await this.db
      .select({
        id: schema.decisionAnalyticsRuns.id,
        scorecardId: schema.decisionAnalyticsRuns.scorecardId,
        artifactVersionId: schema.decisionAnalyticsRuns.artifactVersionId,
        artifactContentHash: schema.decisionAnalyticsRuns.artifactContentHash,
        methodVersion: schema.decisionAnalyticsRuns.methodVersion,
        inputHash: schema.decisionAnalyticsRuns.inputHash,
        sensitivity: schema.decisionAnalyticsRuns.sensitivity,
        impact: schema.decisionAnalyticsRuns.impact,
        actorKind: schema.decisionAnalyticsRuns.actorKind,
        createdAt: schema.decisionAnalyticsRuns.createdAt,
      })
      .from(schema.decisionAnalyticsRuns)
      .where(and(...predicates))
      .orderBy(desc(schema.decisionAnalyticsRuns.sequenceNo))
      .limit(1);
    return row ? this.analyticsRunForResponse(row) : null;
  }

  async latestDecisionAnalyticsForArtifactVersion(threadId: string, artifactVersionId: string): Promise<DecisionAnalyticsRun | null> {
    const [row] = await this.db
      .select({
        id: schema.decisionAnalyticsRuns.id,
        scorecardId: schema.decisionAnalyticsRuns.scorecardId,
        artifactVersionId: schema.decisionAnalyticsRuns.artifactVersionId,
        artifactContentHash: schema.decisionAnalyticsRuns.artifactContentHash,
        methodVersion: schema.decisionAnalyticsRuns.methodVersion,
        inputHash: schema.decisionAnalyticsRuns.inputHash,
        sensitivity: schema.decisionAnalyticsRuns.sensitivity,
        impact: schema.decisionAnalyticsRuns.impact,
        actorKind: schema.decisionAnalyticsRuns.actorKind,
        createdAt: schema.decisionAnalyticsRuns.createdAt,
      })
      .from(schema.decisionAnalyticsRuns)
      .where(and(
        eq(schema.decisionAnalyticsRuns.threadId, threadId),
        eq(schema.decisionAnalyticsRuns.artifactVersionId, artifactVersionId),
      ))
      .orderBy(desc(schema.decisionAnalyticsRuns.sequenceNo))
      .limit(1);
    return row ? this.analyticsRunForResponse(row) : null;
  }

  async summaryV3(threadId: string): Promise<EvidenceDecisionSummaryV3Response> {
    const base = await this.summaryV2(threadId);
    const latestRun = base.latestScorecard
      ? await this.latestDecisionAnalytics(threadId, base.latestScorecard.id)
      : null;
    return { ...base, analytics: { supported: true, latestRun } };
  }

  async runDecisionAnalytics(input: {
    workspaceId: string;
    threadId: string;
    actorUserId: string;
    artifactProjectId?: string;
    artifactScorecardId?: string;
    request: RunDecisionAnalyticsRequest;
  }): Promise<DecisionAnalyticsRun | null> {
    return this.db.transaction(async (tx) => {
      const scorecardPredicates = [
        eq(schema.decisionScorecards.workspaceId, input.workspaceId),
        eq(schema.decisionScorecards.threadId, input.threadId),
        isNull(schema.decisionScorecards.deletedAt),
      ];
      if (input.request.scorecardId) scorecardPredicates.push(eq(schema.decisionScorecards.id, input.request.scorecardId));
      const [selectedScorecard] = await tx
        .select({ id: schema.decisionScorecards.id })
        .from(schema.decisionScorecards)
        .where(and(...scorecardPredicates))
        .orderBy(desc(schema.decisionScorecards.createdAt), desc(schema.decisionScorecards.id))
        .limit(1);
      if (!selectedScorecard) return null;
      await tx.execute(sql`SELECT decision_analytics_source_is_locked(
        'scorecard', ${selectedScorecard.id}::uuid, ${input.workspaceId}::uuid
      )`);
      const [scorecard] = await tx
        .select({
          id: schema.decisionScorecards.id,
          scoreSummary: schema.decisionScorecards.scoreSummary,
        })
        .from(schema.decisionScorecards)
        .where(and(
          eq(schema.decisionScorecards.id, selectedScorecard.id),
          eq(schema.decisionScorecards.workspaceId, input.workspaceId),
          eq(schema.decisionScorecards.threadId, input.threadId),
          isNull(schema.decisionScorecards.deletedAt),
        ))
        .limit(1);
      if (!scorecard) return null;
      const items = await tx
      .select({
        alternativeId: schema.decisionScorecardItems.alternativeId,
        label: schema.decisionScorecardItems.alternativeLabel,
        criteriaBreakdown: schema.decisionScorecardItems.criteriaBreakdown,
      })
      .from(schema.decisionScorecardItems)
      .where(and(
        eq(schema.decisionScorecardItems.workspaceId, input.workspaceId),
        eq(schema.decisionScorecardItems.scorecardId, scorecard.id),
      ))
      .orderBy(asc(schema.decisionScorecardItems.alternativeId));
    let artifact: { versionId: string; contentHash: string } | undefined;
    if (input.request.artifactVersionId) {
      if (!input.artifactProjectId) throw new RangeError('artifact project authorization is required');
      if (!input.artifactScorecardId || input.artifactScorecardId !== scorecard.id) {
        throw new RangeError('artifact scorecard lineage authorization is required');
      }
      await tx.execute(sql`SELECT decision_analytics_source_is_locked(
        'artifact_version', ${input.request.artifactVersionId}::uuid, ${input.workspaceId}::uuid
      )`);
      const [version] = await tx
        .select({
          id: schema.artifactVersions.id,
          content: schema.artifactVersions.content,
          governingMessage: schema.artifactVersions.governingMessage,
          soWhat: schema.artifactVersions.soWhat,
        })
        .from(schema.artifactVersions)
        .innerJoin(schema.artifacts, eq(schema.artifacts.id, schema.artifactVersions.artifactId))
        .where(and(
          eq(schema.artifactVersions.id, input.request.artifactVersionId),
          eq(schema.artifactVersions.workspaceId, input.workspaceId),
          eq(schema.artifactVersions.sourceThreadId, input.threadId),
          eq(schema.artifacts.workspaceId, input.workspaceId),
          eq(schema.artifacts.projectId, input.artifactProjectId),
          isNull(schema.artifacts.deletedAt),
        ))
        .limit(1);
      if (!version) throw new RangeError('artifact version is unavailable in this thread scope');
      artifact = {
        versionId: version.id,
        contentHash: artifactContentHash(version.content, version.governingMessage, version.soWhat),
      };
    }
    const summary = scorecard.scoreSummary && typeof scorecard.scoreSummary === 'object'
      ? scorecard.scoreSummary
      : {};
    const source = typeof summary.source === 'string' ? summary.source : 'unknown';
    const analytics = buildDecisionAnalyticsAudit({
      scorecardId: scorecard.id,
      source,
      ranked: items.map((item) => ({
        alternativeId: item.alternativeId,
        label: item.label,
        criteriaBreakdown: item.criteriaBreakdown as DecisionAnalyticsAuditInput['ranked'][number]['criteriaBreakdown'],
      })),
      perturbationPct: input.request.perturbationPct,
      scenarios: input.request.scenarios,
      ...(artifact ? { artifact } : {}),
      ...(input.request.impact ? { impact: input.request.impact } : {}),
    });
    const [inserted] = await tx
      .insert(schema.decisionAnalyticsRuns)
      .values({
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        scorecardId: scorecard.id,
        artifactVersionId: analytics.artifactVersionId,
        artifactContentHash: analytics.artifactContentHash,
        methodVersion: analytics.methodVersion,
        inputHash: analytics.inputHash,
        inputSnapshot: analytics.inputSnapshot,
        sensitivity: analytics.sensitivity,
        impact: analytics.impact,
        actorKind: 'user',
        actorUserId: input.actorUserId,
      })
      .onConflictDoNothing()
      .returning({
        id: schema.decisionAnalyticsRuns.id,
        scorecardId: schema.decisionAnalyticsRuns.scorecardId,
        artifactVersionId: schema.decisionAnalyticsRuns.artifactVersionId,
        artifactContentHash: schema.decisionAnalyticsRuns.artifactContentHash,
        methodVersion: schema.decisionAnalyticsRuns.methodVersion,
        inputHash: schema.decisionAnalyticsRuns.inputHash,
        sensitivity: schema.decisionAnalyticsRuns.sensitivity,
        impact: schema.decisionAnalyticsRuns.impact,
        actorKind: schema.decisionAnalyticsRuns.actorKind,
        createdAt: schema.decisionAnalyticsRuns.createdAt,
      });
    if (inserted) return this.analyticsRunForResponse(inserted);
    const [existing] = await tx
      .select({
        id: schema.decisionAnalyticsRuns.id,
        scorecardId: schema.decisionAnalyticsRuns.scorecardId,
        artifactVersionId: schema.decisionAnalyticsRuns.artifactVersionId,
        artifactContentHash: schema.decisionAnalyticsRuns.artifactContentHash,
        methodVersion: schema.decisionAnalyticsRuns.methodVersion,
        inputHash: schema.decisionAnalyticsRuns.inputHash,
        sensitivity: schema.decisionAnalyticsRuns.sensitivity,
        impact: schema.decisionAnalyticsRuns.impact,
        actorKind: schema.decisionAnalyticsRuns.actorKind,
        createdAt: schema.decisionAnalyticsRuns.createdAt,
      })
      .from(schema.decisionAnalyticsRuns)
      .where(and(
        eq(schema.decisionAnalyticsRuns.workspaceId, input.workspaceId),
        eq(schema.decisionAnalyticsRuns.scorecardId, scorecard.id),
        eq(schema.decisionAnalyticsRuns.inputHash, analytics.inputHash),
        eq(schema.decisionAnalyticsRuns.actorKind, 'user'),
        eq(schema.decisionAnalyticsRuns.actorUserId, input.actorUserId),
      ))
      .limit(1);
    return existing ? this.analyticsRunForResponse(existing) : null;
    });
  }

  async reviewQueue(threadId: string, limit = 30, filter: ReviewQueueFilter = 'all'): Promise<ReviewQueueResponse> {
    const predicates = [
      eq(schema.activeReviewItems.threadId, threadId),
      eq(schema.activeReviewItems.status, 'open'),
      isNull(schema.activeReviewItems.deletedAt),
    ];
    if (filter !== 'all') predicates.push(eq(schema.activeReviewItems.itemKind, filter));
    const rows = await this.db
      .select({
        id: schema.activeReviewItems.id,
        itemKind: schema.activeReviewItems.itemKind,
        title: schema.activeReviewItems.title,
        targetRef: schema.activeReviewItems.targetRef,
        priorityScore: schema.activeReviewItems.priorityScore,
        decisionImpact: schema.activeReviewItems.decisionImpact,
        uncertainty: schema.activeReviewItems.uncertainty,
        evidenceGap: schema.activeReviewItems.evidenceGap,
        deadlineWeight: schema.activeReviewItems.deadlineWeight,
        status: schema.activeReviewItems.status,
        reasons: schema.activeReviewItems.reasons,
        createdAt: schema.activeReviewItems.createdAt,
      })
      .from(schema.activeReviewItems)
      .where(and(...predicates))
      .orderBy(desc(schema.activeReviewItems.priorityScore), desc(schema.activeReviewItems.createdAt))
      .limit(limit);
    return {
      items: rows.map((row) => ({
        id: row.id,
        itemKind: row.itemKind,
        title: row.title,
        targetRef: row.targetRef,
        priorityScore: toNumber(row.priorityScore),
        decisionImpact: toNumber(row.decisionImpact),
        uncertainty: toNumber(row.uncertainty),
        evidenceGap: toNumber(row.evidenceGap),
        deadlineWeight: toNumber(row.deadlineWeight),
        status: row.status,
        reasons: row.reasons,
        actions: reviewActions(row.title),
        createdAt: iso(row.createdAt),
      })),
    };
  }

  async decideReviewItem(input: {
    threadId: string;
    itemId: string;
    action: 'resolve' | 'ignore';
    note: string | null;
  }): Promise<boolean> {
    const [row] = await this.db
      .update(schema.activeReviewItems)
      .set({
        status: input.action === 'resolve' ? 'resolved' : 'ignored',
        updatedAt: new Date(),
      })
      .where(and(
        eq(schema.activeReviewItems.id, input.itemId),
        eq(schema.activeReviewItems.threadId, input.threadId),
        eq(schema.activeReviewItems.status, 'open'),
        isNull(schema.activeReviewItems.deletedAt),
      ))
      .returning({ id: schema.activeReviewItems.id });
    void input.note;
    return Boolean(row);
  }

  /**
   * Final-export gate for a single assistant message. Aggregates that message's
   * persisted claim verdicts + latest exactness run and evaluates the strictest
   * ('final_export') policy so PDF/DOCX rendering can be blocked before it runs.
   */
  async gateForAssistantMessage(input: {
    assistantMessageId: string;
    workspaceId: string;
    threadId: string | null;
  }): Promise<VerifierGateResult> {
    const verdictRows = await this.db
      .select({
        claimId: schema.claimVerificationVerdicts.claimId,
        claimText: schema.claimVerificationVerdicts.claimText,
        evidenceRef: schema.claimVerificationVerdicts.evidenceRef,
        evidenceItemId: schema.claimVerificationVerdicts.evidenceItemId,
        verdict: schema.claimVerificationVerdicts.verdict,
        confidence: schema.claimVerificationVerdicts.confidence,
        rationale: schema.claimVerificationVerdicts.rationale,
      })
      .from(schema.claimVerificationVerdicts)
      .where(and(
        eq(schema.claimVerificationVerdicts.assistantMessageId, input.assistantMessageId),
        eq(schema.claimVerificationVerdicts.workspaceId, input.workspaceId),
        ...(input.threadId ? [eq(schema.claimVerificationVerdicts.threadId, input.threadId)] : []),
        isNull(schema.claimVerificationVerdicts.deletedAt),
      ))
      .orderBy(desc(schema.claimVerificationVerdicts.createdAt))
      .limit(100);

    let exactnessStatus: ExactnessRunStatus | undefined;
    try {
      const exactnessRows = await this.db
        .select({ status: schema.exactnessRuns.status })
        .from(schema.exactnessRuns)
        .where(and(
          eq(schema.exactnessRuns.assistantMessageId, input.assistantMessageId),
          eq(schema.exactnessRuns.workspaceId, input.workspaceId),
          ...(input.threadId ? [eq(schema.exactnessRuns.threadId, input.threadId)] : []),
          isNull(schema.exactnessRuns.deletedAt),
        ))
        .orderBy(desc(schema.exactnessRuns.createdAt))
        .limit(1);
      const status = exactnessRows[0]?.status;
      if (status === 'blocked' || status === 'passed' || status === 'skipped') exactnessStatus = status;
    } catch (error) {
      if (!isMissingRelationError(error)) throw error;
    }

    return this.gatePolicy.evaluate({
      mode: 'final_export',
      ...(exactnessStatus ? { exactnessStatus } : {}),
      citationIssueCount: 0,
      verdicts: verdictRows.map(verdictRowForGate),
    });
  }
}

type ExactnessCheckForResponse = NonNullable<EvidenceDecisionSummaryResponse['exactness']['latestRun']>['checks'][number];
type ExactnessPassForResponse = ExactnessCheckForResponse['passes'][number];
type VerificationMetricsForResponse = EvidenceDecisionSummaryResponse['postAnswerVerification']['verificationMetrics'];

type PersistedVerdictRowForGate = {
  claimId: string;
  claimText: string;
  evidenceItemId: string | null;
  evidenceRef: string | null;
  verdict: string;
  confidence: unknown;
  rationale: string;
};

function verdictRowForGate(row: PersistedVerdictRowForGate): ClaimVerdict {
  const verdict = row.verdict === 'refutes' || row.verdict === 'mixed' || row.verdict === 'not_enough_info' ? row.verdict : 'supports';
  return {
    claimId: row.claimId,
    claimText: row.claimText,
    evidenceId: row.evidenceItemId ?? row.evidenceRef,
    verdict,
    confidence: clamp01(toNumber(row.confidence)),
    matchedTerms: [],
    contradictedTerms: [],
    rationale: row.rationale,
    decisionImpact: verdict === 'refutes' || verdict === 'mixed' ? 0.82 : verdict === 'not_enough_info' ? 0.62 : 0.5,
  };
}

function verificationMetricsForResponse(scoreSummary: unknown): VerificationMetricsForResponse {
  const summary = isRecord(scoreSummary) ? scoreSummary : {};
  const metrics = isRecord(summary.verificationMetrics) ? summary.verificationMetrics : {};
  const calls = isRecord(metrics.providerCalls) ? metrics.providerCalls : {};
  const latencies = isRecord(metrics.providerLatencies) ? metrics.providerLatencies : {};
  const providerLatencies: Record<string, number> = {};
  for (const [key, value] of Object.entries(latencies)) providerLatencies[key] = Math.max(0, Math.round(toNumber(value)));
  return {
    totalLatencyMs: Math.max(0, Math.round(toNumber(metrics.totalLatencyMs))),
    providerCalls: {
      nli: Math.max(0, Math.round(toNumber(calls.nli))),
      llm: Math.max(0, Math.round(toNumber(calls.llm))),
      heuristic: Math.max(0, Math.round(toNumber(calls.heuristic))),
    },
    providerLatencies,
  };
}

function exactnessQueryHash(userPrompt: string, answer: string): string {
  return createHash('sha256').update(`${userPrompt}\n---answer---\n${answer}`).digest('hex').slice(0, 40);
}

function exactnessChecksForResponse(raw: unknown): ExactnessCheckForResponse[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const row = isRecord(item) ? item : {};
    return {
      id: stringValue(row.id),
      kind: exactnessKind(row.kind),
      status: exactnessCheckStatus(row.status),
      value: typeof row.value === 'string' ? row.value : null,
      expected: typeof row.expected === 'string' ? row.expected : null,
      reason: stringValue(row.reason),
      passes: Array.isArray(row.passes) ? row.passes.map(exactnessPassForResponse) : [],
    };
  });
}

function exactnessPassForResponse(item: unknown): ExactnessPassForResponse {
  const row = isRecord(item) ? item : {};
  return {
    method: row.method === 'decimal_invariant' ? 'decimal_invariant' : 'decimal_formula',
    value: stringValue(row.value),
    detail: stringValue(row.detail),
  };
}

function exactnessKind(value: unknown): ExactnessCheckForResponse['kind'] {
  if (value === 'percentage_change' || value === 'ratio_percent' || value === 'sum_equals_total') return value;
  return 'sum_equals_total';
}

function exactnessCheckStatus(value: unknown): ExactnessCheckForResponse['status'] {
  if (value === 'mismatch' || value === 'invalid_input' || value === 'passed') return value;
  return 'invalid_input';
}

function judgmentIssuesForResponse(raw: unknown): ConsultingJudgmentGuardResult['issues'] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const parsed = JudgmentGuardIssueSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function judgmentStatusForResponse(value: string): NonNullable<EvidenceDecisionSummaryV2Response['judgment']['latestRun']>['status'] {
  if (value === 'blocked' || value === 'warnings' || value === 'skipped') return value;
  return 'skipped';
}

function stringArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function edgeDate(value: ProvenanceGraphEdge['validFrom']): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function isMissingRelationError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const code = error.code;
  if (code === '42P01') return true;
  const message = typeof error.message === 'string' ? error.message : '';
  return /relation .*(exactness_runs|judgment_guard_runs|provenance_graph_edges|trace_spans|eval_cases|eval_runs|eval_scores).* does not exist|no such table: (exactness_runs|judgment_guard_runs|provenance_graph_edges|trace_spans|eval_cases|eval_runs|eval_scores)/iu.test(message);
}

function reviewActions(title: string): ReviewAction[] {
  const claim = title.trim();
  return [
    {
      id: 'rewrite_with_evidence',
      label: '근거 보강 후 재작성',
      prompt: `다음 문장을 현재 근거로 다시 검증하고, 근거가 충분한 표현으로만 재작성해줘: ${claim}`,
    },
    {
      id: 'remove_sentence',
      label: '해당 문장 제거',
      prompt: `다음 문장이 반박되거나 근거부족이면 답변에서 제거하고, 남은 답변의 흐름을 자연스럽게 정리해줘: ${claim}`,
    },
    {
      id: 'request_more_sources',
      label: '추가 자료 요청',
      prompt: `다음 판단을 확정하기 위해 어떤 추가 자료가 필요한지 3개 이내로 요청문을 작성해줘: ${claim}`,
    },
  ];
}
