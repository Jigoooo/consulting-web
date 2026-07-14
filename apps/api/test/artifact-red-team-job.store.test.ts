import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from '@consulting/db-schema';
import { ArtifactRedTeamJobStore } from '../src/artifacts/artifact-red-team-job.store.js';
import { ArtifactRedTeamDbLedger } from '../src/artifacts/artifact-red-team-db-ledger.js';
import { ARTIFACT_RED_TEAM_PERSONAS } from '../src/artifacts/artifact-red-team.service.js';
import { artifactContentHash } from '../src/artifacts/artifact-export-preflight-audit.js';

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

let pool: Pool;
let db: NodePgDatabase<typeof schema>;
const userId = randomUUID();
const workspaceId = randomUUID();
const projectId = randomUUID();
const artifactId = randomUUID();
const versionOneId = randomUUID();
const versionTwoId = randomUUID();

function target(artifactVersionId: string, versionNo: number, content: string) {
  return {
    artifactId,
    artifactVersionId,
    workspaceId,
    projectId,
    title: 'durable red-team artifact',
    versionNo,
    content,
    governingMessage: '단계적 전환이 가장 안전합니다.',
    soWhat: '따라서 반대 근거와 비용 산식을 먼저 검토해야 합니다.',
    sourceThreadId: null,
    sourceMessageId: null,
  };
}

d('ArtifactRedTeamJobStore durable state machine', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    db = drizzle(pool, { schema });
    await db.insert(schema.users).values({ id: userId, email: `${userId}@example.com`, displayName: 'red-team-job' });
    await db.insert(schema.workspaces).values({ id: workspaceId, name: 'red-team-job', slug: `rtj-${workspaceId}`, ownerUserId: userId });
    await db.insert(schema.projects).values({ id: projectId, workspaceId, name: 'red-team-job', slug: `rtjp-${projectId}` });
    await db.insert(schema.artifacts).values({ id: artifactId, workspaceId, projectId, title: 'durable red-team artifact', createdByUserId: userId });
    for (const [id, versionNo, content] of [[versionOneId, 1, '첫 번째 artifact 본문'], [versionTwoId, 2, '두 번째 artifact 본문']] as const) {
      await db.insert(schema.artifactVersions).values({
        id,
        workspaceId,
        artifactId,
        versionNo,
        content,
        governingMessage: '단계적 전환이 가장 안전합니다.',
        soWhat: '따라서 반대 근거와 비용 산식을 먼저 검토해야 합니다.',
        authorUserId: userId,
      });
    }
  });

  afterAll(async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`ALTER TABLE artifact_red_team_runs DISABLE TRIGGER artifact_red_team_runs_append_only_guard`);
      await tx.delete(schema.artifactRedTeamRuns).where(eq(schema.artifactRedTeamRuns.workspaceId, workspaceId));
      await tx.execute(sql`ALTER TABLE artifact_red_team_runs ENABLE TRIGGER artifact_red_team_runs_append_only_guard`);
    });
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await pool.end();
  });

  it('deduplicates enqueue, fences stale workers, recovers crashes, and keeps results append-only', async () => {
    const store = new ArtifactRedTeamJobStore(db as never);
    const firstTarget = target(versionOneId, 1, '첫 번째 artifact 본문');
    const contentHash = artifactContentHash(firstTarget.content, firstTarget.governingMessage, firstTarget.soWhat);
    const isolatedUntil = new Date(Date.now() + 60 * 60 * 1_000);
    const [jobA, jobB] = await Promise.all([
      store.enqueue({ target: firstTarget, contentHash, mode: 'warning', requestedByUserId: userId, outboxNotBefore: isolatedUntil }),
      store.enqueue({ target: firstTarget, contentHash, mode: 'warning', requestedByUserId: userId, outboxNotBefore: isolatedUntil }),
    ]);
    expect(jobA.id).toBe(jobB.id);
    expect(jobA.status).toBe('pending');
    const [jobCount, outboxCount] = await Promise.all([
      db.select({ count: sql<number>`count(*)::int` }).from(schema.artifactRedTeamJobs).where(eq(schema.artifactRedTeamJobs.id, jobA.id)),
      db.select({ count: sql<number>`count(*)::int` }).from(schema.outboxEvents).where(eq(schema.outboxEvents.idempotencyKey, `artifact-red-team:${jobA.id}:requested`)),
    ]);
    expect(jobCount[0]!.count).toBe(1);
    expect(outboxCount[0]!.count).toBe(1);

    const claimed = await store.claim(jobA.id);
    expect(claimed.state).toBe('claimed');
    if (claimed.state !== 'claimed') throw new Error('expected claimed job');
    expect(await store.claim(jobA.id)).toMatchObject({ state: 'busy' });
    await expect(store.heartbeat(jobA.id, 'stale-token')).resolves.toBe(false);
    await expect(store.heartbeat(jobA.id, claimed.leaseToken)).resolves.toBe(true);
    await expect(store.complete(jobA.id, 'stale-token', {
      reviewerRunId: 'run_stale',
      verdict: 'PASS',
      attacks: [],
      defenses: [],
    })).rejects.toThrow(/lease/iu);

    await store.complete(jobA.id, claimed.leaseToken, {
      reviewerRunId: 'run_durable_1',
      verdict: 'PASS_WITH_WARNINGS',
      attacks: [
        { persona: '감사원', severity: 'warning', category: 'cost', message: '비용 상한 근거가 없습니다.' },
        { persona: '의회', severity: 'warning', category: 'budget', message: '예산 대안이 없습니다.' },
        { persona: '노조', severity: 'warning', category: 'labor', message: '인력 영향이 없습니다.' },
      ],
      defenses: [
        { attackIndex: 0, response: '추가 분석 필요', disposition: 'unresolved' },
        { attackIndex: 1, response: '추가 분석 필요', disposition: 'unresolved' },
        { attackIndex: 2, response: '추가 분석 필요', disposition: 'unresolved' },
      ],
    });
    expect(await store.latest(firstTarget)).toBeNull();
    expect(await new ArtifactRedTeamDbLedger(db as never).latest(firstTarget)).toMatchObject({ status: 'completed', contentHash });
    await db.update(schema.artifactVersions).set({ content: '직접 변경된 본문' })
      .where(eq(schema.artifactVersions.id, versionOneId));
    await expect(store.loadReviewContext(jobA)).rejects.toThrow(/content hash/iu);
    await db.update(schema.artifactVersions).set({ content: firstTarget.content })
      .where(eq(schema.artifactVersions.id, versionOneId));
    const [run] = await db.select({ id: schema.artifactRedTeamRuns.id }).from(schema.artifactRedTeamRuns)
      .where(eq(schema.artifactRedTeamRuns.jobId, jobA.id));
    expect(run?.id).toBeTruthy();
    await expect(db.update(schema.artifactRedTeamRuns).set({ errorMessage: 'mutated' }).where(eq(schema.artifactRedTeamRuns.id, run!.id))).rejects.toThrow();
    await expect(db.delete(schema.artifactRedTeamRuns).where(eq(schema.artifactRedTeamRuns.id, run!.id))).rejects.toThrow();
    const [immutableRun] = await db.select({ errorMessage: schema.artifactRedTeamRuns.errorMessage })
      .from(schema.artifactRedTeamRuns).where(eq(schema.artifactRedTeamRuns.id, run!.id));
    expect(immutableRun).toEqual({ errorMessage: null });

    const secondTarget = target(versionTwoId, 2, '두 번째 artifact 본문');
    const secondHash = artifactContentHash(secondTarget.content, secondTarget.governingMessage, secondTarget.soWhat);
    const second = await store.enqueue({ target: secondTarget, contentHash: secondHash, mode: 'shadow', requestedByUserId: userId, outboxNotBefore: isolatedUntil });
    const secondClaim = await store.claim(second.id);
    if (secondClaim.state !== 'claimed') throw new Error('expected second claim');
    await db.update(schema.artifactRedTeamJobs).set({ leaseExpiresAt: sql`now() - interval '1 second'` })
      .where(and(eq(schema.artifactRedTeamJobs.id, second.id), eq(schema.artifactRedTeamJobs.leaseToken, secondClaim.leaseToken)));
    await expect(store.recoverStalled(100, isolatedUntil)).resolves.toBe(1);
    const reclaimed = await store.claim(second.id);
    if (reclaimed.state !== 'claimed') throw new Error('expected reclaimed job');
    expect(reclaimed.job.attemptCount).toBe(2);
    await expect(store.fail(second.id, reclaimed.leaseToken, new Error('reviewer unavailable'), 2)).resolves.toMatchObject({ terminal: true });
    expect(await store.latest(secondTarget)).toBeNull();
    expect(await new ArtifactRedTeamDbLedger(db as never).latest(secondTarget)).toMatchObject({ status: 'failed', verdict: 'BLOCKED', contentHash: secondHash });
    const recoveryOutbox = await db.select({ count: sql<number>`count(*)::int` }).from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.idempotencyKey, `artifact-red-team:${second.id}:recovery:1`));
    expect(recoveryOutbox[0]!.count).toBe(1);

    expect(ARTIFACT_RED_TEAM_PERSONAS).toEqual(['감사원', '의회', '노조']);
  });
});
