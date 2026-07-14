import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { VerifierGateSummarySchema } from '@consulting/contracts';
import { and, asc, count, desc, eq, isNull } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';
import type { EvidenceInput } from '../consulting/evidence-to-decision.service.js';
import type { VerifierGateIssue, VerifierGateResult } from '../consulting/verifier-gate-policy.service.js';
import type { ArtifactVersionVerificationSnapshot } from './artifact-export-preflight-audit.js';
import { artifactVerificationPolicyPrefix } from './artifact-verification.service.js';
import type {
  ArtifactVerificationLedger,
  ArtifactVerificationRecordInput,
  ArtifactVerificationTarget,
} from './artifact-verification.service.js';

const MAX_ARTIFACT_EVIDENCE_ITEMS = 40;
const MAX_ARTIFACT_EVIDENCE_CHARS = 2_000;

export interface ArtifactVerificationProjectTargets {
  projectId: string;
  projectName: string;
  totalCandidates: number;
  offset: number;
  targets: ArtifactVerificationTarget[];
}

@Injectable()
export class ArtifactVerificationDbLedger implements ArtifactVerificationLedger {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async latest(target: ArtifactVerificationTarget): Promise<ArtifactVersionVerificationSnapshot | null> {
    const [row] = await this.db
      .select({
        artifactId: schema.artifactVersionVerifications.artifactId,
        artifactVersionId: schema.artifactVersionVerifications.artifactVersionId,
        workspaceId: schema.artifactVersionVerifications.workspaceId,
        projectId: schema.artifactVersionVerifications.projectId,
        contentHash: schema.artifactVersionVerifications.contentHash,
        status: schema.artifactVersionVerifications.status,
        gate: schema.artifactVersionVerifications.gate,
        verifier: schema.artifactVersionVerifications.verifier,
        deletedAt: schema.artifactVersionVerifications.deletedAt,
      })
      .from(schema.artifactVersionVerifications)
      .where(eq(schema.artifactVersionVerifications.artifactVersionId, target.artifactVersionId))
      .orderBy(desc(schema.artifactVersionVerifications.sequenceNo))
      .limit(1);
    if (!row) return null;
    if (!row.verifier.startsWith(`${artifactVerificationPolicyPrefix(target)}:`)) return null;
    const gate = normalizeGate(row.gate);
    if (!gate) return null;
    return {
      artifactId: row.artifactId,
      artifactVersionId: row.artifactVersionId,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      contentHash: row.contentHash,
      gate: row.deletedAt === null && statusMatchesGate(row.status, gate) ? gate : malformedVerificationGate(),
    };
  }

  async loadCurrentPassVerdicts(
    target: ArtifactVerificationTarget,
    expectedContentHash: string,
  ): Promise<unknown> {
    const [row] = await this.db
      .select({
        artifactId: schema.artifactVersionVerifications.artifactId,
        artifactVersionId: schema.artifactVersionVerifications.artifactVersionId,
        workspaceId: schema.artifactVersionVerifications.workspaceId,
        projectId: schema.artifactVersionVerifications.projectId,
        contentHash: schema.artifactVersionVerifications.contentHash,
        status: schema.artifactVersionVerifications.status,
        gate: schema.artifactVersionVerifications.gate,
        verdicts: schema.artifactVersionVerifications.verdicts,
        verifier: schema.artifactVersionVerifications.verifier,
        deletedAt: schema.artifactVersionVerifications.deletedAt,
      })
      .from(schema.artifactVersionVerifications)
      .where(eq(schema.artifactVersionVerifications.artifactVersionId, target.artifactVersionId))
      .orderBy(desc(schema.artifactVersionVerifications.sequenceNo))
      .limit(1);
    if (
      !row
      || row.artifactId !== target.artifactId
      || row.artifactVersionId !== target.artifactVersionId
      || row.workspaceId !== target.workspaceId
      || row.projectId !== target.projectId
      || row.contentHash !== expectedContentHash
      || row.deletedAt !== null
      || row.status !== 'passed'
      || !row.verifier.startsWith(`${artifactVerificationPolicyPrefix(target)}:`)
    ) return null;
    const gate = normalizeGate(row.gate);
    if (!gate || !statusMatchesGate(row.status, gate)) return null;
    return row.verdicts;
  }

  async loadEvidence(target: ArtifactVerificationTarget): Promise<EvidenceInput[]> {
    const scope = [
      eq(schema.evidenceItems.workspaceId, target.workspaceId),
      eq(schema.channels.projectId, target.projectId),
      isNull(schema.evidenceItems.deletedAt),
      isNull(schema.threads.deletedAt),
      isNull(schema.topics.deletedAt),
      isNull(schema.channels.deletedAt),
    ];
    if (target.sourceThreadId) scope.push(eq(schema.threads.id, target.sourceThreadId));
    const rows = await this.db
      .select({
        id: schema.evidenceItems.id,
        text: schema.evidenceItems.excerpt,
        qualityScore: schema.evidenceItems.qualityScore,
        createdAt: schema.evidenceItems.createdAt,
      })
      .from(schema.evidenceItems)
      .innerJoin(schema.threads, eq(schema.evidenceItems.threadId, schema.threads.id))
      .innerJoin(schema.topics, eq(schema.threads.topicId, schema.topics.id))
      .innerJoin(schema.channels, eq(schema.topics.channelId, schema.channels.id))
      .where(and(...scope))
      .orderBy(desc(schema.evidenceItems.createdAt), desc(schema.evidenceItems.id))
      .limit(MAX_ARTIFACT_EVIDENCE_ITEMS);
    return rows.map((row) => ({
      id: row.id,
      text: row.text.slice(0, MAX_ARTIFACT_EVIDENCE_CHARS),
      ...(row.qualityScore === null ? {} : { qualityScore: row.qualityScore }),
      observedAt: row.createdAt,
      collectedAt: row.createdAt,
    }));
  }

  async record(input: ArtifactVerificationRecordInput): Promise<ArtifactVersionVerificationSnapshot> {
    await this.db.insert(schema.artifactVersionVerifications).values({
      workspaceId: input.target.workspaceId,
      projectId: input.target.projectId,
      artifactId: input.target.artifactId,
      artifactVersionId: input.target.artifactVersionId,
      contentHash: input.contentHash,
      sourceThreadId: input.sourceThreadId,
      sourceMessageId: input.sourceMessageId,
      status: input.gate.decision === 'PASS' ? 'passed' : 'blocked',
      exactness: input.exactness as unknown as Record<string, unknown>,
      verdicts: input.verdicts as unknown as Record<string, unknown>[],
      gate: input.gate as unknown as Record<string, unknown>,
      verifier: input.verifier,
      evidenceCount: input.evidenceCount,
      verifiedByUserId: input.verifiedByUserId,
    });
    return {
      artifactId: input.target.artifactId,
      artifactVersionId: input.target.artifactVersionId,
      workspaceId: input.target.workspaceId,
      projectId: input.target.projectId,
      contentHash: input.contentHash,
      gate: input.gate,
    };
  }

  async loadProjectHeadTargets(projectId: string, requestedLimit = 500, requestedOffset = 0): Promise<ArtifactVerificationProjectTargets> {
    const limit = Math.max(1, Math.min(500, requestedLimit));
    const offset = Math.max(0, requestedOffset);
    const [project] = await this.db
      .select({
        projectId: schema.projects.id,
        workspaceId: schema.projects.workspaceId,
        projectName: schema.projects.name,
      })
      .from(schema.projects)
      .where(and(
        eq(schema.projects.id, projectId),
        eq(schema.projects.status, 'active'),
        isNull(schema.projects.deletedAt),
      ))
      .limit(1);
    if (!project) throw new Error(`project not found or inactive: ${projectId}`);

    const [rows, [totalRow]] = await Promise.all([
      this.db
        .select({
          artifactId: schema.artifacts.id,
          artifactVersionId: schema.artifactVersions.id,
          title: schema.artifacts.title,
          versionNo: schema.artifactVersions.versionNo,
          content: schema.artifactVersions.content,
          governingMessage: schema.artifactVersions.governingMessage,
          soWhat: schema.artifactVersions.soWhat,
          sourceThreadId: schema.artifactVersions.sourceThreadId,
          sourceMessageId: schema.artifactVersions.sourceMessageId,
        })
        .from(schema.artifacts)
        .innerJoin(
          schema.artifactVersions,
          and(
            eq(schema.artifactVersions.artifactId, schema.artifacts.id),
            eq(schema.artifactVersions.versionNo, schema.artifacts.headVersion),
          ),
        )
        .where(and(
          eq(schema.artifacts.workspaceId, project.workspaceId),
          eq(schema.artifacts.projectId, project.projectId),
          isNull(schema.artifacts.deletedAt),
        ))
        .orderBy(asc(schema.artifacts.createdAt), asc(schema.artifacts.id))
        .limit(limit)
        .offset(offset),
      this.db.select({ value: count() }).from(schema.artifacts).where(and(
        eq(schema.artifacts.workspaceId, project.workspaceId),
        eq(schema.artifacts.projectId, project.projectId),
        isNull(schema.artifacts.deletedAt),
      )),
    ]);
    return {
      projectId: project.projectId,
      projectName: project.projectName,
      totalCandidates: Number(totalRow?.value ?? 0),
      offset,
      targets: rows.map((row) => ({
        ...row,
        workspaceId: project.workspaceId,
        projectId: project.projectId,
      })),
    };
  }
}

function normalizeGate(value: unknown): VerifierGateResult | null {
  const parsed = VerifierGateSummarySchema.safeParse(value);
  if (!parsed.success) return null;
  const normalizeIssue = (issue: (typeof parsed.data.blockers)[number]): VerifierGateIssue => ({
    code: issue.code,
    severity: issue.severity,
    message: issue.message,
    ...(issue.claimId ? { claimId: issue.claimId } : {}),
  });
  return {
    decision: parsed.data.decision,
    blockers: parsed.data.blockers.map(normalizeIssue),
    warnings: parsed.data.warnings.map(normalizeIssue),
  };
}

function statusMatchesGate(status: string, gate: VerifierGateResult): boolean {
  if (status === 'passed') {
    return gate.decision === 'PASS' && gate.blockers.length === 0 && gate.warnings.length === 0;
  }
  return status === 'blocked' && gate.decision !== 'PASS';
}

function malformedVerificationGate(): VerifierGateResult {
  return {
    decision: 'BLOCKED',
    blockers: [{
      code: 'missing_verifier_telemetry',
      severity: 'blocker',
      message: '최신 산출물 검증 원장 행의 상태가 삭제되었거나 판정과 일치하지 않습니다.',
    }],
    warnings: [],
  };
}
