import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { EvidenceDecisionSummaryResponse, ReviewQueueResponse } from '@consulting/contracts';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';
import { EvidenceToDecisionService, type ClaimInput, type DecisionRating, type EvidenceInput, type ReviewInput } from './evidence-to-decision.service.js';

const FACTUAL_RE = /(이다|입니다|한다|합니다|된다|됩니다|있다|있습니다|없다|없습니다|필요|확정|증가|감소|부담|영향|제시|늘려|줄어|higher|lower|increase|decrease)/iu;

type ReviewAction = {
  id: 'rewrite_with_evidence' | 'remove_sentence' | 'request_more_sources';
  label: '근거 보강 후 재작성' | '해당 문장 제거' | '추가 자료 요청';
  prompt: string;
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  return 0;
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
  ) {}

  async recordCompletedAnswer(input: {
    workspaceId: string;
    threadId: string;
    assistantMessageId: string;
    answer: string;
    runId: string | null;
  }): Promise<void> {
    const claimTexts = splitClaims(input.answer);
    if (claimTexts.length === 0) return;

    const evidenceRows = await this.db
      .select({
        id: schema.evidenceItems.id,
        ref: schema.evidenceItems.ref,
        excerpt: schema.evidenceItems.excerpt,
        qualityScore: schema.evidenceItems.qualityScore,
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
    }));

    const verification = this.engine.buildStrictJsonVerification({ claims, evidence });
    const lattice = verification.lattice;
    if (lattice.verdicts.length > 0) {
      await this.db.insert(schema.claimVerificationVerdicts).values(
        lattice.verdicts.map((verdict) => ({
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          assistantMessageId: input.assistantMessageId,
          claimId: verdict.claimId,
          claimText: verdict.claimText,
          evidenceRef: verdict.evidenceId,
          evidenceItemId: verdict.evidenceId,
          verdict: verdict.verdict,
          confidence: String(verdict.confidence),
          matchedTerms: verdict.matchedTerms,
          contradictedTerms: verdict.contradictedTerms,
          rationale: verdict.rationale,
          verifier: verification.verifier,
        })),
      );
    }

    const supported = lattice.summary.supports;
    const refuted = lattice.summary.refutes + lattice.summary.mixed;
    const unsupported = lattice.summary.notEnoughInfo;
    const claimCount = Math.max(1, lattice.summary.claimCount);
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
    const [scorecardRow] = await this.db
      .insert(schema.decisionScorecards)
      .values({
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        question: scorecard.question,
        recommendedAlternativeId: scorecard.recommendedAlternativeId,
        scoreSummary: { runId: input.runId, source: 'post_answer_verification_v1' },
      })
      .returning({ id: schema.decisionScorecards.id });
    if (scorecardRow) {
      await this.db.insert(schema.decisionScorecardItems).values(
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
    }

    const reviewInputs: ReviewInput[] = lattice.verdicts
      .filter((verdict) => verdict.verdict !== 'supports')
      .map((verdict) => ({
        id: verdict.claimId,
        kind: verdict.verdict === 'refutes' || verdict.verdict === 'mixed' ? 'refuted_claim' : 'unsupported_claim',
        title: verdict.claimText.slice(0, 120),
        decisionImpact: verdict.decisionImpact,
        uncertainty: clamp01(1 - verdict.confidence),
        evidenceGap: verdict.verdict === 'not_enough_info' ? 1 : 0.75,
      }));
    const reviewQueue = this.engine.prioritizeReviewQueue({ items: reviewInputs });
    if (reviewQueue.length > 0) {
      await this.db.insert(schema.activeReviewItems).values(
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
      },
    };
  }

  async reviewQueue(threadId: string, limit = 30): Promise<ReviewQueueResponse> {
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
      .where(and(eq(schema.activeReviewItems.threadId, threadId), eq(schema.activeReviewItems.status, 'open'), isNull(schema.activeReviewItems.deletedAt)))
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
