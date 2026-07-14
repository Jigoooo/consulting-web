import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { Queue } from 'bullmq';
import { schema } from '@consulting/db-schema';
import { ArtifactRedTeamJobStore } from '../src/artifacts/artifact-red-team-job.store.js';
import { ArtifactRedTeamDbLedger } from '../src/artifacts/artifact-red-team-db-ledger.js';
import { ArtifactRedTeamWorker } from '../src/artifacts/artifact-red-team.worker.js';
import { ArtifactVerificationDbLedger } from '../src/artifacts/artifact-verification-db-ledger.js';
import { artifactContentHash } from '../src/artifacts/artifact-export-preflight-audit.js';
import { artifactVerificationPolicyPrefix } from '../src/artifacts/artifact-verification.service.js';
import { OutboxRelayService, outboxJobId } from '../src/queues/outbox-relay.service.js';
import { QUEUE_NAMES } from '../src/queues/queue.tokens.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const d = databaseUrl && redisUrl ? describe : describe.skip;

let pool: Pool;
let db: NodePgDatabase<typeof schema>;
let worker: ArtifactRedTeamWorker;
let queues: Queue[] = [];
const userId = randomUUID();
const workspaceId = randomUUID();
const projectId = randomUUID();
const artifactId = randomUUID();
const artifactVersionId = randomUUID();

const target = {
  artifactId,
  artifactVersionId,
  workspaceId,
  projectId,
  title: 'red-team queue e2e',
  versionNo: 1,
  content: '단계적 전환의 비용과 일정, 이해관계자 영향을 분석한 보고서입니다.',
  governingMessage: '단계적 전환이 가장 안전합니다.',
  soWhat: '따라서 비용 상한과 반대 논리를 먼저 보강해야 합니다.',
  sourceThreadId: null,
  sourceMessageId: null,
};

function connection(url: string) {
  const parsed = new URL(url);
  return { host: parsed.hostname, port: Number(parsed.port || 6379) };
}

async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timed out waiting for artifact red-team terminal run');
}

d('artifact red-team outbox → Redis worker integration', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    db = drizzle(pool, { schema });
    await db.insert(schema.users).values({ id: userId, email: `${userId}@example.com`, displayName: 'red-team-e2e' });
    await db.insert(schema.workspaces).values({ id: workspaceId, name: 'red-team-e2e', slug: `rte-${workspaceId}`, ownerUserId: userId });
    await db.insert(schema.projects).values({ id: projectId, workspaceId, name: 'red-team-e2e', slug: `rtep-${projectId}` });
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
    await worker?.onModuleDestroy();
    for (const queue of queues) await queue.close();
    await db.transaction(async (tx) => {
      await tx.execute(sql`ALTER TABLE artifact_red_team_runs DISABLE TRIGGER artifact_red_team_runs_append_only_guard`);
      await tx.delete(schema.artifactRedTeamRuns).where(eq(schema.artifactRedTeamRuns.workspaceId, workspaceId));
      await tx.execute(sql`ALTER TABLE artifact_red_team_runs ENABLE TRIGGER artifact_red_team_runs_append_only_guard`);
    });
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await pool.end();
  });

  it('settles one exact review through the real outbox and Bull queue', async () => {
    const contentHash = artifactContentHash(target.content, target.governingMessage, target.soWhat);
    const verification = new ArtifactVerificationDbLedger(db as never);
    await verification.record({
      target,
      contentHash,
      sourceThreadId: null,
      sourceMessageId: null,
      exactness: { gate: 'exactness_gate_v1', required: false, status: 'skipped', checks: [], summary: 'not required', answerInstruction: '정성 요청' },
      verdicts: [{
        claimId: 'GM', claimText: target.governingMessage, evidenceId: null, verdict: 'supports', confidence: 0.9,
        matchedTerms: [], contradictedTerms: [], rationale: '본문과 일치', decisionImpact: 1,
      }],
      gate: { decision: 'PASS', blockers: [], warnings: [] },
      verifier: `${artifactVerificationPolicyPrefix(target)}:test`,
      evidenceCount: 0,
      verifiedByUserId: userId,
    });

    const jobs = new ArtifactRedTeamJobStore(db as never);
    const fakeAgent = { review: async () => ({
      reviewerRunId: 'reviewer_run_queue_e2e',
      rawJson: JSON.stringify({
        verdict: 'PASS_WITH_WARNINGS',
        attacks: [
          { persona: '감사원', severity: 'warning', category: 'cost', message: '비용 상한의 반대 근거가 부족합니다.' },
          { persona: '의회', severity: 'warning', category: 'budget', message: '예산 대안 비교가 부족합니다.' },
          { persona: '노조', severity: 'warning', category: 'labor', message: '인력 영향 분석이 부족합니다.' },
        ],
        defenses: [
          { attack_index: 0, response: '추가 분석 필요', disposition: 'unresolved' },
          { attack_index: 1, response: '추가 분석 필요', disposition: 'unresolved' },
          { attack_index: 2, response: '추가 분석 필요', disposition: 'unresolved' },
        ],
      }),
    }) };
    const env = { REDIS_URL: redisUrl, ARTIFACT_RED_TEAM_MODE: 'warning', ARTIFACT_RED_TEAM_TIMEOUT_MS: 30_000 };
    worker = new ArtifactRedTeamWorker(env as never, jobs, verification, fakeAgent as never);
    await worker.onModuleInit();

    const names = [QUEUE_NAMES.outboxRelay, QUEUE_NAMES.consultingWebIngest, QUEUE_NAMES.chatTurnSettlement, QUEUE_NAMES.notificationPush, QUEUE_NAMES.artifactRedTeam];
    queues = names.map((name) => new Queue(name, { connection: connection(redisUrl!) }));
    const relay = new OutboxRelayService(db as never, queues[0]!, queues[1]!, queues[2]!, queues[3]!, queues[4]!);
    const job = await jobs.enqueue({ target, contentHash, mode: 'warning', requestedByUserId: userId });
    const [outbox] = await db.select({ id: schema.outboxEvents.id }).from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.idempotencyKey, `artifact-red-team:${job.id}:requested`));
    await expect(relay.relayOnce(1, outbox!.id)).resolves.toBe(1);

    const terminal = await waitFor(async () => new ArtifactRedTeamDbLedger(db as never).latest(target));
    expect(terminal).toMatchObject({
      artifactVersionId,
      workspaceId,
      contentHash,
      status: 'completed',
      verdict: 'PASS_WITH_WARNINGS',
      policyVersion: 'artifact_red_team_v1',
    });
    const [storedJob] = await db.select({ status: schema.artifactRedTeamJobs.status, attemptCount: schema.artifactRedTeamJobs.attemptCount })
      .from(schema.artifactRedTeamJobs).where(eq(schema.artifactRedTeamJobs.id, job.id));
    expect(storedJob).toEqual({ status: 'completed', attemptCount: 1 });

    const bullJob = await queues[4]!.getJob(outboxJobId(`artifact-red-team:${job.id}:requested`));
    await bullJob?.remove();
  }, 20_000);
});
