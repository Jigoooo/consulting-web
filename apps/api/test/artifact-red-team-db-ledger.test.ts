import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { schema } from '@consulting/db-schema';
import { ArtifactRedTeamDbLedger } from '../src/artifacts/artifact-red-team-db-ledger.js';
import { ArtifactRedTeamJobStore } from '../src/artifacts/artifact-red-team-job.store.js';
import { ARTIFACT_RED_TEAM_PERSONAS } from '../src/artifacts/artifact-red-team.service.js';
import { artifactContentHash } from '../src/artifacts/artifact-export-preflight-audit.js';

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

let pool: Pool;
let db: NodePgDatabase<typeof schema>;
const userId = randomUUID();
const reviewerUserId = randomUUID();
const workspaceId = randomUUID();
const otherWorkspaceId = randomUUID();
const projectId = randomUUID();
const artifactId = randomUUID();
const artifactVersionId = randomUUID();

const target = {
  artifactId,
  artifactVersionId,
  workspaceId,
  projectId,
  title: '적대 검토 DB 원장',
  versionNo: 1,
  content: '전환 비용은 20% 절감됩니다.',
  governingMessage: '핵심 결론은 단계적 전환이 안전하다는 것입니다.',
  soWhat: '따라서 반론과 비용 계산을 먼저 검토해야 합니다.',
  sourceThreadId: null,
  sourceMessageId: null,
};

d('ArtifactRedTeamDbLedger', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    db = drizzle(pool, { schema });
    await db.insert(schema.users).values({ id: userId, email: `${userId}@example.com`, displayName: 'red-team-ledger' });
    await db.insert(schema.users).values({ id: reviewerUserId, email: `${reviewerUserId}@example.com`, displayName: 'red-team-reviewer' });
    await db.insert(schema.workspaces).values({ id: workspaceId, name: 'red-team-ledger', slug: `rt-${workspaceId}`, ownerUserId: userId });
    await db.insert(schema.workspaces).values({ id: otherWorkspaceId, name: 'other-red-team-ledger', slug: `rt-${otherWorkspaceId}`, ownerUserId: userId });
    await db.insert(schema.projects).values({ id: projectId, workspaceId, name: 'red-team-project', slug: `rtp-${projectId}` });
    await db.insert(schema.artifacts).values({ id: artifactId, workspaceId, projectId, title: target.title, createdByUserId: userId });
    await db.insert(schema.artifactVersions).values({
      id: artifactVersionId,
      workspaceId,
      artifactId,
      versionNo: 1,
      content: target.content,
      governingMessage: target.governingMessage,
      soWhat: target.soWhat,
      authorUserId: userId,
    });
  });

  afterAll(async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`ALTER TABLE artifact_red_team_runs DISABLE TRIGGER artifact_red_team_runs_append_only_guard`);
      await tx.delete(schema.artifactRedTeamRuns).where(eq(schema.artifactRedTeamRuns.workspaceId, workspaceId));
      await tx.execute(sql`ALTER TABLE artifact_red_team_runs ENABLE TRIGGER artifact_red_team_runs_append_only_guard`);
    });
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, otherWorkspaceId));
    await db.delete(schema.users).where(eq(schema.users.id, reviewerUserId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await pool.end();
  });

  it('persists ordered version/hash reviews and rejects cross-tenant or malformed rows', async () => {
    const ledger = new ArtifactRedTeamDbLedger(db as never);
    const store = new ArtifactRedTeamJobStore(db as never);
    const contentHash = artifactContentHash(target.content, target.governingMessage, target.soWhat);
    const attacks = [
      { persona: '감사원' as const, severity: 'warning' as const, category: 'cost', message: '20% 계산 근거가 필요합니다.' },
      { persona: '의회' as const, severity: 'warning' as const, category: 'budget', message: '예산 대안이 필요합니다.' },
      { persona: '노조' as const, severity: 'warning' as const, category: 'labor', message: '인력 영향이 필요합니다.' },
    ];
    const defenses = [
      { attackIndex: 0, response: '원가표 추가 예정', disposition: 'unresolved' as const },
      { attackIndex: 1, response: '예산 대안 추가 예정', disposition: 'unresolved' as const },
      { attackIndex: 2, response: '인력 분석 추가 예정', disposition: 'unresolved' as const },
    ];
    const job = await store.enqueue({
      target, contentHash, mode: 'warning', requestedByUserId: reviewerUserId,
      outboxNotBefore: new Date(Date.now() + 60 * 60 * 1_000),
    });
    const claim = await store.claim(job.id);
    if (claim.state !== 'claimed') throw new Error('expected claimed red-team job');
    await store.complete(job.id, claim.leaseToken, {
      reviewerRunId: 'run_red_team_db_1', verdict: 'PASS_WITH_WARNINGS', attacks, defenses,
    });

    expect(await ledger.latest(target)).toMatchObject({
      artifactVersionId,
      workspaceId,
      projectId,
      contentHash,
      status: 'completed',
      verdict: 'PASS_WITH_WARNINGS',
      attacks: expect.arrayContaining([
        expect.objectContaining({ persona: '감사원' }),
        expect.objectContaining({ persona: '의회' }),
        expect.objectContaining({ persona: '노조' }),
      ]),
    });
    await expect(db.delete(schema.users).where(eq(schema.users.id, reviewerUserId))).resolves.toBeDefined();
    const [immutableActor] = await db.select({ reviewedByUserId: schema.artifactRedTeamRuns.reviewedByUserId })
      .from(schema.artifactRedTeamRuns).where(eq(schema.artifactRedTeamRuns.jobId, job.id));
    expect(immutableActor).toEqual({ reviewedByUserId: reviewerUserId });
    await expect(db.delete(schema.artifacts).where(eq(schema.artifacts.id, artifactId))).rejects.toThrow();
    expect(await ledger.latest(target)).toMatchObject({ contentHash, status: 'completed' });

    const createTerminalJob = async (policyVersion: string, status: 'completed' | 'failed') => {
      const [created] = await db.insert(schema.artifactRedTeamJobs).values({
        workspaceId, projectId, artifactId, artifactVersionId, contentHash,
        mode: 'warning', policyVersion, requestedByUserId: userId, status, attemptCount: 1,
      }).returning({ id: schema.artifactRedTeamJobs.id });
      return created!.id;
    };
    const runPayload = {
      workspaceId, projectId, artifactId, artifactVersionId, contentHash, mode: 'warning' as const,
      personas: [...ARTIFACT_RED_TEAM_PERSONAS], attacks, defenses, reviewedByUserId: userId,
    };

    const crossPolicy = 'artifact_red_team_v1_cross_scope';
    const crossJobId = await createTerminalJob(crossPolicy, 'completed');
    await expect(db.insert(schema.artifactRedTeamRuns).values({
      ...runPayload,
      jobId: crossJobId,
      workspaceId: otherWorkspaceId,
      status: 'completed',
      policyVersion: crossPolicy,
      verdict: 'PASS_WITH_WARNINGS',
      reviewerRunId: 'run_cross_scope',
      errorMessage: null,
    })).rejects.toThrow();

    const malformedPolicy = 'artifact_red_team_v1_malformed_hash';
    const malformedJobId = await createTerminalJob(malformedPolicy, 'completed');
    await expect(db.insert(schema.artifactRedTeamRuns).values({
      ...runPayload,
      jobId: malformedJobId,
      contentHash: 'not-a-hash',
      status: 'completed',
      policyVersion: malformedPolicy,
      verdict: 'PASS_WITH_WARNINGS',
      reviewerRunId: 'run_malformed_hash',
      errorMessage: null,
    })).rejects.toThrow();

    const completedPolicy = 'artifact_red_team_v1_bad_completed';
    const completedJobId = await createTerminalJob(completedPolicy, 'completed');
    await expect(db.insert(schema.artifactRedTeamRuns).values({
      ...runPayload,
      jobId: completedJobId,
      status: 'completed',
      policyVersion: completedPolicy,
      verdict: 'PASS',
      reviewerRunId: null,
      errorMessage: null,
    })).rejects.toThrow();

    const failedPolicy = 'artifact_red_team_v1_bad_failed';
    const failedJobId = await createTerminalJob(failedPolicy, 'failed');
    await expect(db.insert(schema.artifactRedTeamRuns).values({
      ...runPayload,
      jobId: failedJobId,
      status: 'failed',
      policyVersion: failedPolicy,
      verdict: 'BLOCKED',
      reviewerRunId: null,
      errorMessage: null,
    })).rejects.toThrow();

    const personaPolicy = 'artifact_red_team_v1_bad_personas';
    const personaJobId = await createTerminalJob(personaPolicy, 'completed');
    await expect(db.insert(schema.artifactRedTeamRuns).values({
      ...runPayload,
      jobId: personaJobId,
      status: 'completed',
      policyVersion: personaPolicy,
      personas: ['감사원', '감사원', '감사원'],
      verdict: 'PASS_WITH_WARNINGS',
      reviewerRunId: 'run_bad_personas',
      errorMessage: null,
    })).rejects.toThrow();

    await expect(db.insert(schema.artifactRedTeamRuns).values({
      ...runPayload,
      jobId: failedJobId,
      status: 'completed',
      policyVersion: failedPolicy,
      verdict: 'PASS_WITH_WARNINGS',
      reviewerRunId: 'run_status_mismatch',
      errorMessage: null,
    })).rejects.toThrow();
  });
});
