import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, desc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';
import { ARTIFACT_RED_TEAM_REVIEW_REQUESTED_EVENT } from '../queues/outbox-routing.js';

import { artifactContentHash, type ArtifactRedTeamMode, type ArtifactRedTeamSnapshot } from './artifact-export-preflight-audit.js';
import { ARTIFACT_RED_TEAM_PERSONAS, ARTIFACT_RED_TEAM_POLICY_VERSION } from './artifact-red-team.constants.js';
import type { ArtifactVerificationTarget } from './artifact-verification.service.js';

const LEASE_SECONDS = 45;
const ACTIVE_JOB_STATUSES = ['pending', 'processing', 'completed'] as const;

type JobRow = typeof schema.artifactRedTeamJobs.$inferSelect;

export interface ArtifactRedTeamJobSnapshot {
  id: string;
  workspaceId: string;
  projectId: string;
  artifactId: string;
  artifactVersionId: string;
  contentHash: string;
  mode: 'shadow' | 'warning';
  policyVersion: string;
  requestedByUserId: string | null;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  attemptCount: number;
  recoveryCount: number;
}

export interface ArtifactRedTeamCompletion {
  reviewerRunId: string;
  verdict: 'PASS' | 'PASS_WITH_WARNINGS' | 'BLOCKED';
  attacks: ArtifactRedTeamSnapshot['attacks'];
  defenses: ArtifactRedTeamSnapshot['defenses'];
}

export type ArtifactRedTeamJobClaim =
  | { state: 'claimed'; leaseToken: string; job: ArtifactRedTeamJobSnapshot }
  | { state: 'busy' }
  | { state: 'terminal' }
  | { state: 'missing' };

@Injectable()
export class ArtifactRedTeamJobStore {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async enqueue(input: {
    target: ArtifactVerificationTarget;
    contentHash: string;
    mode: Exclude<ArtifactRedTeamMode, 'off'>;
    requestedByUserId: string | null;
    outboxNotBefore?: Date;
  }): Promise<ArtifactRedTeamJobSnapshot> {
    return this.db.transaction(async (tx) => {
      const [created] = await tx.insert(schema.artifactRedTeamJobs).values({
        workspaceId: input.target.workspaceId,
        projectId: input.target.projectId,
        artifactId: input.target.artifactId,
        artifactVersionId: input.target.artifactVersionId,
        contentHash: input.contentHash,
        mode: input.mode,
        policyVersion: ARTIFACT_RED_TEAM_POLICY_VERSION,
        requestedByUserId: input.requestedByUserId,
      }).onConflictDoNothing().returning();
      if (created) {
        await tx.insert(schema.outboxEvents).values({
          workspaceId: created.workspaceId,
          eventType: ARTIFACT_RED_TEAM_REVIEW_REQUESTED_EVENT,
          aggregateType: 'artifact-version',
          aggregateId: created.artifactVersionId,
          payload: {
            jobId: created.id,
            artifactId: created.artifactId,
            artifactVersionId: created.artifactVersionId,
            contentHash: created.contentHash,
          },
          idempotencyKey: `artifact-red-team:${created.id}:requested`,
          nextAttemptAt: input.outboxNotBefore ?? null,
        });
        return toSnapshot(created);
      }
      const [existing] = await tx.select().from(schema.artifactRedTeamJobs).where(and(
        eq(schema.artifactRedTeamJobs.workspaceId, input.target.workspaceId),
        eq(schema.artifactRedTeamJobs.artifactVersionId, input.target.artifactVersionId),
        eq(schema.artifactRedTeamJobs.contentHash, input.contentHash),
        eq(schema.artifactRedTeamJobs.policyVersion, ARTIFACT_RED_TEAM_POLICY_VERSION),
        inArray(schema.artifactRedTeamJobs.status, [...ACTIVE_JOB_STATUSES]),
      )).orderBy(desc(schema.artifactRedTeamJobs.sequenceNo)).limit(1);
      if (!existing) throw new Error('artifact red-team enqueue conflict could not be reconciled');
      return toSnapshot(existing);
    });
  }

  async claim(jobId: string): Promise<ArtifactRedTeamJobClaim> {
    const leaseToken = randomUUID();
    const [claimed] = await this.db.update(schema.artifactRedTeamJobs).set({
      status: 'processing',
      leaseToken,
      leaseExpiresAt: sql`now() + interval '${sql.raw(String(LEASE_SECONDS))} seconds'`,
      attemptCount: sql`${schema.artifactRedTeamJobs.attemptCount} + 1`,
      lastError: null,
      nextAttemptAt: null,
      updatedAt: sql`now()`,
    }).where(and(
      eq(schema.artifactRedTeamJobs.id, jobId),
      or(
        and(
          eq(schema.artifactRedTeamJobs.status, 'pending'),
          or(isNull(schema.artifactRedTeamJobs.nextAttemptAt), lte(schema.artifactRedTeamJobs.nextAttemptAt, sql`now()`)),
        ),
        and(
          eq(schema.artifactRedTeamJobs.status, 'processing'),
          or(isNull(schema.artifactRedTeamJobs.leaseExpiresAt), lte(schema.artifactRedTeamJobs.leaseExpiresAt, sql`now()`)),
        ),
      ),
    )).returning();
    if (claimed) return { state: 'claimed', leaseToken, job: toSnapshot(claimed) };
    const [existing] = await this.db.select({ status: schema.artifactRedTeamJobs.status })
      .from(schema.artifactRedTeamJobs).where(eq(schema.artifactRedTeamJobs.id, jobId)).limit(1);
    if (!existing) return { state: 'missing' };
    return existing.status === 'completed' || existing.status === 'failed'
      ? { state: 'terminal' }
      : { state: 'busy' };
  }

  async heartbeat(jobId: string, leaseToken: string): Promise<boolean> {
    const rows = await this.db.update(schema.artifactRedTeamJobs).set({
      leaseExpiresAt: sql`now() + interval '${sql.raw(String(LEASE_SECONDS))} seconds'`,
      updatedAt: sql`now()`,
    }).where(and(
      eq(schema.artifactRedTeamJobs.id, jobId),
      eq(schema.artifactRedTeamJobs.status, 'processing'),
      eq(schema.artifactRedTeamJobs.leaseToken, leaseToken),
    )).returning({ id: schema.artifactRedTeamJobs.id });
    return rows.length === 1;
  }

  async complete(jobId: string, leaseToken: string, result: ArtifactRedTeamCompletion): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [job] = await tx.update(schema.artifactRedTeamJobs).set({
        status: 'completed',
        leaseToken: null,
        leaseExpiresAt: null,
        lastError: null,
        nextAttemptAt: null,
        updatedAt: sql`now()`,
      }).where(and(
        eq(schema.artifactRedTeamJobs.id, jobId),
        eq(schema.artifactRedTeamJobs.status, 'processing'),
        eq(schema.artifactRedTeamJobs.leaseToken, leaseToken),
      )).returning();
      if (!job) throw new Error('artifact red-team completion lease is stale');
      await tx.insert(schema.artifactRedTeamRuns).values({
        jobId: job.id,
        workspaceId: job.workspaceId,
        projectId: job.projectId,
        artifactId: job.artifactId,
        artifactVersionId: job.artifactVersionId,
        contentHash: job.contentHash,
        mode: job.mode,
        status: 'completed',
        policyVersion: job.policyVersion,
        personas: [...ARTIFACT_RED_TEAM_PERSONAS],
        attacks: result.attacks.map((attack) => ({ ...attack })),
        defenses: result.defenses.map((defense) => ({ ...defense })),
        verdict: result.verdict,
        reviewerRunId: result.reviewerRunId,
        errorMessage: null,
        reviewedByUserId: job.requestedByUserId,
      });
    });
  }

  async fail(jobId: string, leaseToken: string, error: unknown, maxAttempts = 3): Promise<{ terminal: boolean }> {
    const message = safeError(error);
    return this.db.transaction(async (tx) => {
      const [terminal] = await tx.update(schema.artifactRedTeamJobs).set({
        status: 'failed',
        leaseToken: null,
        leaseExpiresAt: null,
        lastError: message,
        nextAttemptAt: null,
        updatedAt: sql`now()`,
      }).where(and(
        eq(schema.artifactRedTeamJobs.id, jobId),
        eq(schema.artifactRedTeamJobs.status, 'processing'),
        eq(schema.artifactRedTeamJobs.leaseToken, leaseToken),
        sql`${schema.artifactRedTeamJobs.attemptCount} >= ${maxAttempts}`,
      )).returning();
      if (terminal) {
        await tx.insert(schema.artifactRedTeamRuns).values({
          jobId: terminal.id,
          workspaceId: terminal.workspaceId,
          projectId: terminal.projectId,
          artifactId: terminal.artifactId,
          artifactVersionId: terminal.artifactVersionId,
          contentHash: terminal.contentHash,
          mode: terminal.mode,
          status: 'failed',
          policyVersion: terminal.policyVersion,
          personas: [...ARTIFACT_RED_TEAM_PERSONAS],
          attacks: [],
          defenses: [],
          verdict: 'BLOCKED',
          reviewerRunId: null,
          errorMessage: message,
          reviewedByUserId: terminal.requestedByUserId,
        });
        return { terminal: true };
      }
      const released = await tx.update(schema.artifactRedTeamJobs).set({
        status: 'pending',
        leaseToken: null,
        leaseExpiresAt: null,
        lastError: message,
        nextAttemptAt: sql`now() + interval '5 seconds'`,
        updatedAt: sql`now()`,
      }).where(and(
        eq(schema.artifactRedTeamJobs.id, jobId),
        eq(schema.artifactRedTeamJobs.status, 'processing'),
        eq(schema.artifactRedTeamJobs.leaseToken, leaseToken),
      )).returning({ id: schema.artifactRedTeamJobs.id });
      if (released.length === 0) throw new Error('artifact red-team failure lease is stale');
      return { terminal: false };
    });
  }

  async recoverStalled(limit = 100, outboxNotBefore?: Date): Promise<number> {
    const stalled = await this.db.select().from(schema.artifactRedTeamJobs).where(and(
      eq(schema.artifactRedTeamJobs.status, 'processing'),
      lt(schema.artifactRedTeamJobs.leaseExpiresAt, sql`now()`),
    )).orderBy(schema.artifactRedTeamJobs.updatedAt).limit(limit);
    let recovered = 0;
    for (const candidate of stalled) {
      const didRecover = await this.db.transaction(async (tx) => {
        const [row] = await tx.update(schema.artifactRedTeamJobs).set({
          status: 'pending',
          leaseToken: null,
          leaseExpiresAt: null,
          recoveryCount: sql`${schema.artifactRedTeamJobs.recoveryCount} + 1`,
          lastError: 'processing lease expired',
          nextAttemptAt: null,
          updatedAt: sql`now()`,
        }).where(and(
          eq(schema.artifactRedTeamJobs.id, candidate.id),
          eq(schema.artifactRedTeamJobs.status, 'processing'),
          eq(schema.artifactRedTeamJobs.leaseToken, candidate.leaseToken!),
          lte(schema.artifactRedTeamJobs.leaseExpiresAt, sql`now()`),
        )).returning();
        if (!row) return false;
        await tx.insert(schema.outboxEvents).values({
          workspaceId: row.workspaceId,
          eventType: ARTIFACT_RED_TEAM_REVIEW_REQUESTED_EVENT,
          aggregateType: 'artifact-version',
          aggregateId: row.artifactVersionId,
          payload: { jobId: row.id, artifactId: row.artifactId, artifactVersionId: row.artifactVersionId, contentHash: row.contentHash },
          idempotencyKey: `artifact-red-team:${row.id}:recovery:${row.recoveryCount}`,
          nextAttemptAt: outboxNotBefore ?? null,
        }).onConflictDoNothing();
        return true;
      });
      if (didRecover) recovered += 1;
    }
    return recovered;
  }

  async latest(target: ArtifactVerificationTarget): Promise<ArtifactRedTeamSnapshot | null> {
    const [job] = await this.db.select().from(schema.artifactRedTeamJobs).where(and(
      eq(schema.artifactRedTeamJobs.workspaceId, target.workspaceId),
      eq(schema.artifactRedTeamJobs.projectId, target.projectId),
      eq(schema.artifactRedTeamJobs.artifactId, target.artifactId),
      eq(schema.artifactRedTeamJobs.artifactVersionId, target.artifactVersionId),
      eq(schema.artifactRedTeamJobs.policyVersion, ARTIFACT_RED_TEAM_POLICY_VERSION),
    )).orderBy(desc(schema.artifactRedTeamJobs.sequenceNo)).limit(1);
    if (!job) return null;
    if (job.status === 'completed' || job.status === 'failed') return null;
    if (job.status !== 'pending' && job.status !== 'processing') throw new Error('invalid artifact red-team job status');
    return {
      artifactId: job.artifactId,
      artifactVersionId: job.artifactVersionId,
      workspaceId: job.workspaceId,
      projectId: job.projectId,
      contentHash: job.contentHash,
      status: job.status,
      verdict: null,
      policyVersion: job.policyVersion,
      reviewedAt: null,
      attacks: [],
      defenses: [],
    };
  }

  async findById(jobId: string): Promise<ArtifactRedTeamJobSnapshot | null> {
    const [row] = await this.db.select().from(schema.artifactRedTeamJobs)
      .where(eq(schema.artifactRedTeamJobs.id, jobId)).limit(1);
    return row ? toSnapshot(row) : null;
  }

  async loadReviewContext(job: ArtifactRedTeamJobSnapshot): Promise<{
    target: ArtifactVerificationTarget;
  }> {
    const [artifact] = await this.db.select({
      artifactId: schema.artifacts.id,
      artifactVersionId: schema.artifactVersions.id,
      workspaceId: schema.artifacts.workspaceId,
      projectId: schema.artifacts.projectId,
      title: schema.artifacts.title,
      versionNo: schema.artifactVersions.versionNo,
      content: schema.artifactVersions.content,
      governingMessage: schema.artifactVersions.governingMessage,
      soWhat: schema.artifactVersions.soWhat,
      sourceThreadId: schema.artifactVersions.sourceThreadId,
      sourceMessageId: schema.artifactVersions.sourceMessageId,
    }).from(schema.artifactVersions)
      .innerJoin(schema.artifacts, eq(schema.artifactVersions.artifactId, schema.artifacts.id))
      .where(and(
        eq(schema.artifacts.id, job.artifactId),
        eq(schema.artifacts.workspaceId, job.workspaceId),
        eq(schema.artifacts.projectId, job.projectId),
        eq(schema.artifactVersions.id, job.artifactVersionId),
        eq(schema.artifactVersions.workspaceId, job.workspaceId),
        isNull(schema.artifacts.deletedAt),
      )).limit(1);
    if (!artifact) throw new Error('artifact red-team job target no longer exists');
    if (artifactContentHash(artifact.content, artifact.governingMessage, artifact.soWhat) !== job.contentHash) {
      throw new Error('artifact red-team job content hash no longer matches the artifact version');
    }
    return { target: artifact };
  }
}

function toSnapshot(row: JobRow): ArtifactRedTeamJobSnapshot {
  if (!['shadow', 'warning'].includes(row.mode) || !['pending', 'processing', 'completed', 'failed'].includes(row.status)) {
    throw new Error('invalid artifact red-team job row');
  }
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    artifactId: row.artifactId,
    artifactVersionId: row.artifactVersionId,
    contentHash: row.contentHash,
    mode: row.mode as 'shadow' | 'warning',
    policyVersion: row.policyVersion,
    requestedByUserId: row.requestedByUserId,
    status: row.status as ArtifactRedTeamJobSnapshot['status'],
    attemptCount: row.attemptCount,
    recoveryCount: row.recoveryCount,
  };
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/gu, ' ').slice(0, 500) || 'red-team review failed';
}
