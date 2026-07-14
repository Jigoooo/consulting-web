import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import type {
  ArtifactBatchReviewPlanResponse,
  ArtifactExportPreflightResponse,
  ArtifactReviewDecision,
  ArtifactReviewWorklistItem,
} from '@consulting/contracts';
import { and, asc, desc, eq } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';
import { artifactContentHash } from './artifact-export-preflight-audit.js';
import { classifyReviewRow } from './batch-review-plan.js';
import {
  artifactHumanReviewStatus,
  evaluateArtifactHumanReviewExport,
  type ArtifactHumanReviewAction,
  type ArtifactHumanReviewDecision,
  type ArtifactHumanReviewExportDecision,
} from './artifact-human-review-policy.js';
import { ArtifactVerificationDbLedger } from './artifact-verification-db-ledger.js';
import { ArtifactVerificationService, type ArtifactVerificationTarget } from './artifact-verification.service.js';

export interface ArtifactReviewLedgerRow {
  id: string;
  sequenceNo: number;
  workspaceId: string;
  projectId: string;
  artifactId: string;
  artifactVersionId: string;
  contentHash: string;
  action: string;
  note: string;
  actorKind: string;
  decidedByUserId: string | null;
  previousHash: string | null;
  eventHash: string;
  createdAt: Date;
}

type ArtifactReviewLedgerTarget = Pick<
  ArtifactVerificationTarget,
  'workspaceId' | 'projectId' | 'artifactId' | 'artifactVersionId'
>;

export function artifactReviewDecisionHash(
  row: Omit<ArtifactReviewLedgerRow, 'eventHash'> | ArtifactReviewLedgerRow,
): string {
  return createHash('sha256').update([
    'artifact_review_decision_v2',
    String(row.sequenceNo),
    row.workspaceId,
    row.projectId,
    row.artifactId,
    row.artifactVersionId,
    row.contentHash,
    row.action,
    row.note,
    row.actorKind,
    row.decidedByUserId ?? '',
    String(row.createdAt.getTime()),
    row.previousHash ?? '',
  ].join('\x1f')).digest('hex');
}

export function evaluateArtifactReviewLedger(
  target: ArtifactReviewLedgerTarget,
  contentHash: string,
  rows: ArtifactReviewLedgerRow[],
): { valid: boolean; decision: ArtifactHumanReviewDecision | null } {
  let previousHash: string | null = null;
  let previousSequence = 0;
  let latestDecision: ArtifactHumanReviewDecision | null = null;
  let latestReject: ArtifactHumanReviewDecision | null = null;
  for (const row of rows) {
    if (!Number.isSafeInteger(row.sequenceNo) || row.sequenceNo <= previousSequence) return { valid: false, decision: null };
    if (
      row.workspaceId !== target.workspaceId
      || row.projectId !== target.projectId
      || row.artifactId !== target.artifactId
      || row.artifactVersionId !== target.artifactVersionId
      || row.contentHash !== contentHash
      || (row.action !== 'approve' && row.action !== 'reject')
      || (row.actorKind !== 'user' && row.actorKind !== 'legacy_unknown')
      || (row.actorKind === 'user' && row.decidedByUserId === null)
      || (row.actorKind === 'legacy_unknown' && row.decidedByUserId !== null)
      || row.note.length > 1_000
      || row.previousHash !== previousHash
      || row.eventHash !== artifactReviewDecisionHash(row)
    ) return { valid: false, decision: null };
    const decision: ArtifactHumanReviewDecision = {
      id: row.id,
      action: row.action,
      contentHash: row.contentHash,
      decidedAt: row.createdAt.toISOString(),
    };
    latestDecision = decision;
    if (decision.action === 'reject') latestReject = decision;
    previousHash = row.eventHash;
    previousSequence = row.sequenceNo;
  }
  return { valid: true, decision: latestReject ?? latestDecision };
}

@Injectable()
export class ArtifactHumanReviewService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly targets: ArtifactVerificationDbLedger,
    private readonly verification: ArtifactVerificationService,
  ) {}

  async latestDecisionState(
    target: ArtifactVerificationTarget,
    contentHash: string,
  ): Promise<{ valid: boolean; decision: ArtifactHumanReviewDecision | null }> {
    const rows = await this.db.select({
      id: schema.artifactReviewDecisions.id,
      sequenceNo: schema.artifactReviewDecisions.sequenceNo,
      workspaceId: schema.artifactReviewDecisions.workspaceId,
      projectId: schema.artifactReviewDecisions.projectId,
      artifactId: schema.artifactReviewDecisions.artifactId,
      artifactVersionId: schema.artifactReviewDecisions.artifactVersionId,
      action: schema.artifactReviewDecisions.action,
      contentHash: schema.artifactReviewDecisions.contentHash,
      note: schema.artifactReviewDecisions.note,
      actorKind: schema.artifactReviewDecisions.actorKind,
      decidedByUserId: schema.artifactReviewDecisions.decidedByUserId,
      previousHash: schema.artifactReviewDecisions.previousHash,
      eventHash: schema.artifactReviewDecisions.eventHash,
      createdAt: schema.artifactReviewDecisions.createdAt,
    }).from(schema.artifactReviewDecisions)
      .where(eq(schema.artifactReviewDecisions.artifactVersionId, target.artifactVersionId))
      .orderBy(asc(schema.artifactReviewDecisions.sequenceNo));
    return evaluateArtifactReviewLedger(target, contentHash, rows);
  }

  async latestDecision(target: ArtifactVerificationTarget, contentHash: string): Promise<ArtifactHumanReviewDecision | null> {
    const state = await this.latestDecisionState(target, contentHash);
    return state.valid ? state.decision : null;
  }

  async exportDecision(
    target: ArtifactVerificationTarget,
    preflight: ArtifactExportPreflightResponse,
  ): Promise<ArtifactHumanReviewExportDecision> {
    const contentHash = targetContentHash(target);
    const state = await this.latestDecisionState(target, contentHash);
    if (!state.valid) return { canExport: false, reason: 'HUMAN_REVIEW_LEDGER_INVALID' };
    return evaluateArtifactHumanReviewExport(preflight, contentHash, state.decision);
  }

  async recordDecision(input: {
    target: ArtifactVerificationTarget;
    preflight: ArtifactExportPreflightResponse;
    action: ArtifactHumanReviewAction;
    note: string;
    decidedByUserId: string;
  }): Promise<{ ok: true; decision: ArtifactReviewDecision } | { ok: false; reason: string }> {
    const contentHash = targetContentHash(input.target);
    const state = await this.latestDecisionState(input.target, contentHash);
    if (!state.valid) return { ok: false, reason: 'HUMAN_REVIEW_LEDGER_INVALID' };
    const currentGate = evaluateArtifactHumanReviewExport(input.preflight, contentHash, state.decision);
    const currentStatus = artifactHumanReviewStatus(input.preflight, currentGate);
    if (currentStatus === 'blocked') return { ok: false, reason: currentGate.reason };
    if (currentStatus === 'rejected') return { ok: false, reason: 'HUMAN_REVIEW_REJECTED' };
    if (input.action === 'approve') {
      const simulated: ArtifactHumanReviewDecision = {
        id: 'pending', action: 'approve', contentHash, decidedAt: new Date().toISOString(),
      };
      const gate = evaluateArtifactHumanReviewExport(input.preflight, contentHash, simulated);
      if (!gate.canExport) return { ok: false, reason: gate.reason };
    }
    try {
      const [row] = await this.db.insert(schema.artifactReviewDecisions).values({
        workspaceId: input.target.workspaceId,
        projectId: input.target.projectId,
        artifactId: input.target.artifactId,
        artifactVersionId: input.target.artifactVersionId,
        contentHash,
        action: input.action,
        note: input.note,
        actorKind: 'user',
        decidedByUserId: input.decidedByUserId,
      }).returning({
        id: schema.artifactReviewDecisions.id,
        sequenceNo: schema.artifactReviewDecisions.sequenceNo,
        action: schema.artifactReviewDecisions.action,
        note: schema.artifactReviewDecisions.note,
        actorKind: schema.artifactReviewDecisions.actorKind,
        decidedByUserId: schema.artifactReviewDecisions.decidedByUserId,
        contentHash: schema.artifactReviewDecisions.contentHash,
        previousHash: schema.artifactReviewDecisions.previousHash,
        eventHash: schema.artifactReviewDecisions.eventHash,
        createdAt: schema.artifactReviewDecisions.createdAt,
      });
      if (!row || (row.action !== 'approve' && row.action !== 'reject')) return { ok: false, reason: 'DECISION_NOT_RECORDED' };
      return { ok: true, decision: publicDecision(row) };
    } catch (error) {
      if (isTerminalRejectDatabaseError(error)) return { ok: false, reason: 'HUMAN_REVIEW_REJECTED' };
      throw error;
    }
  }

  async projectPlan(projectId: string, offset = 0): Promise<ArtifactBatchReviewPlanResponse> {
    const bundle = await this.targets.loadProjectHeadTargets(projectId, 500, offset);
    const targets = bundle.targets.slice(0, 500);
    const worklist = await mapWithConcurrency(targets, 10, async (target): Promise<ArtifactReviewWorklistItem> => {
      const preflight = await this.verification.preflightVersion(target);
      const hash = targetContentHash(target);
      const state = await this.latestDecisionState(target, hash);
      const human: ArtifactHumanReviewExportDecision = state.valid
        ? evaluateArtifactHumanReviewExport(preflight, hash, state.decision)
        : { canExport: false, reason: 'HUMAN_REVIEW_LEDGER_INVALID' };
      const reviewStatus = artifactHumanReviewStatus(preflight, human);
      const classified = classifyReviewRow({
        artifactId: target.artifactId,
        artifactVersionId: target.artifactVersionId,
        title: target.title,
        versionNo: target.versionNo,
        canExport: human.canExport,
        reason: human.reason,
        gateBlockerCount: preflight.gate?.blockers.length ?? 0,
        gateWarningCount: (preflight.gate?.warnings.length ?? 0) + (preflight.reason === 'OK' ? preflight.messages.length : 0),
        redTeamVerdict: preflight.redTeam.verdict,
      });
      const latest = state.valid && state.decision
        ? await this.latestPublicDecision(target, hash, state.decision.id)
        : null;
      const needsHumanReview = reviewStatus === 'pending' || reviewStatus === 'approved';
      return { ...classified, needsHumanReview, reviewStatus, latestDecision: latest };
    });
    const summary = {
      total: worklist.length,
      critical: worklist.filter((item) => item.priority === 'critical').length,
      high: worklist.filter((item) => item.priority === 'high').length,
      medium: worklist.filter((item) => item.priority === 'medium').length,
      clear: worklist.filter((item) => item.priority === 'clear').length,
      needsHumanReview: worklist.filter((item) => item.needsHumanReview).length,
      pending: worklist.filter((item) => item.reviewStatus === 'pending').length,
      approved: worklist.filter((item) => item.reviewStatus === 'approved').length,
      rejected: worklist.filter((item) => item.reviewStatus === 'rejected').length,
      blocked: worklist.filter((item) => item.reviewStatus === 'blocked').length,
      invalid: worklist.filter((item) => item.reviewStatus === 'invalid').length,
    };
    const totalCandidates = bundle.totalCandidates ?? targets.length;
    const pageOffset = bundle.offset ?? offset;
    return {
      projectId: bundle.projectId,
      projectName: bundle.projectName,
      cohort: {
        totalCandidates,
        offset: pageOffset,
        returned: worklist.length,
        nextOffset: pageOffset + worklist.length < totalCandidates ? pageOffset + worklist.length : null,
        summaryScope: 'returned_page',
      },
      summary,
      worklist,
    };
  }

  private async latestPublicDecision(target: ArtifactVerificationTarget, contentHash: string, decisionId: string): Promise<ArtifactReviewDecision | null> {
    const [row] = await this.db.select({
      id: schema.artifactReviewDecisions.id,
      sequenceNo: schema.artifactReviewDecisions.sequenceNo,
      action: schema.artifactReviewDecisions.action,
      note: schema.artifactReviewDecisions.note,
      actorKind: schema.artifactReviewDecisions.actorKind,
      decidedByUserId: schema.artifactReviewDecisions.decidedByUserId,
      contentHash: schema.artifactReviewDecisions.contentHash,
      previousHash: schema.artifactReviewDecisions.previousHash,
      eventHash: schema.artifactReviewDecisions.eventHash,
      createdAt: schema.artifactReviewDecisions.createdAt,
    }).from(schema.artifactReviewDecisions).where(and(
      eq(schema.artifactReviewDecisions.workspaceId, target.workspaceId),
      eq(schema.artifactReviewDecisions.projectId, target.projectId),
      eq(schema.artifactReviewDecisions.artifactId, target.artifactId),
      eq(schema.artifactReviewDecisions.artifactVersionId, target.artifactVersionId),
      eq(schema.artifactReviewDecisions.contentHash, contentHash),
      eq(schema.artifactReviewDecisions.id, decisionId),
    )).orderBy(desc(schema.artifactReviewDecisions.createdAt), desc(schema.artifactReviewDecisions.id)).limit(1);
    return row && (row.action === 'approve' || row.action === 'reject') ? publicDecision(row) : null;
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]!);
    }
  }));
  return results;
}

function targetContentHash(target: ArtifactVerificationTarget): string {
  return artifactContentHash(target.content, target.governingMessage, target.soWhat);
}

function isTerminalRejectDatabaseError(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === 'object' && current !== null && !visited.has(current)) {
    visited.add(current);
    if (Reflect.get(current, 'code') === '23514'
      && String(Reflect.get(current, 'message')).includes('artifact review reject is terminal')) return true;
    current = Reflect.get(current, 'cause');
  }
  return false;
}

function publicDecision(row: {
  id: string;
  sequenceNo: number;
  action: string;
  note: string;
  actorKind: string;
  decidedByUserId: string | null;
  contentHash: string;
  previousHash: string | null;
  eventHash: string;
  createdAt: Date;
}): ArtifactReviewDecision {
  if (row.action !== 'approve' && row.action !== 'reject') throw new Error('invalid artifact review action');
  if (row.actorKind !== 'user' && row.actorKind !== 'legacy_unknown') throw new Error('invalid artifact review actor kind');
  return {
    id: row.id,
    sequenceNo: row.sequenceNo,
    action: row.action,
    note: row.note,
    actorKind: row.actorKind,
    decidedByUserId: row.decidedByUserId,
    contentHash: row.contentHash,
    previousHash: row.previousHash,
    eventHash: row.eventHash,
    decidedAt: row.createdAt.toISOString(),
  };
}
