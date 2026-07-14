import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { schema } from '@consulting/db-schema';
import { ArtifactVerificationDbLedger } from '../src/artifacts/artifact-verification-db-ledger.js';
import { artifactContentHash } from '../src/artifacts/artifact-export-preflight-audit.js';
import { artifactVerificationPolicyPrefix } from '../src/artifacts/artifact-verification.service.js';

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

let pool: Pool;
let db: NodePgDatabase<typeof schema>;
const users: string[] = [];
const workspaces: string[] = [];

function policyVerifier(target: { title: string }, provider: string): string {
  return `${artifactVerificationPolicyPrefix(target)}:${provider}`;
}

d('ArtifactVerificationDbLedger', () => {
  beforeAll(() => {
    pool = new Pool({ connectionString: url });
    db = drizzle(pool, { schema });
  });

  afterAll(async () => {
    for (const workspaceId of workspaces) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    for (const userId of users) await db.delete(schema.users).where(eq(schema.users.id, userId));
    await pool.end();
  });

  it('persists an append-only version/hash verification and fails closed on tenant, content, or malformed gate mismatch', async () => {
    const userId = randomUUID();
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    const artifactId = randomUUID();
    const artifactVersionId = randomUUID();
    users.push(userId);
    workspaces.push(workspaceId);

    await db.insert(schema.users).values({ id: userId, email: `${userId}@example.com`, displayName: 'ledger-test' });
    await db.insert(schema.workspaces).values({ id: workspaceId, name: 'ledger-test', slug: `ledger-${workspaceId}`, ownerUserId: userId });
    await db.insert(schema.projects).values({ id: projectId, workspaceId, name: 'ledger-project', slug: `p-${projectId}` });
    await db.insert(schema.artifacts).values({ id: artifactId, workspaceId, projectId, title: '검증 원장 테스트', createdByUserId: userId });
    const governingMessage = '핵심 결론은 사업 범위를 단계적으로 조정해야 한다는 것입니다.';
    const soWhat = '따라서 이번 분기에 예산 우선순위와 실행 일정을 다시 확정해야 합니다.';
    await db.insert(schema.artifactVersions).values({
      id: artifactVersionId,
      workspaceId,
      artifactId,
      versionNo: 1,
      content: '검증 대상 본문입니다.',
      governingMessage,
      soWhat,
      authorUserId: userId,
    });

    const target = {
      artifactId,
      artifactVersionId,
      workspaceId,
      projectId,
      title: '검증 원장 테스트',
      versionNo: 1,
      content: '검증 대상 본문입니다.',
      governingMessage,
      soWhat,
      sourceThreadId: null,
      sourceMessageId: null,
    };
    const gate = { decision: 'PASS' as const, blockers: [], warnings: [] };
    const ledger = new ArtifactVerificationDbLedger(db);
    await ledger.record({
      target,
      contentHash: artifactContentHash(target.content, target.governingMessage, target.soWhat),
      sourceThreadId: null,
      sourceMessageId: null,
      exactness: {
        gate: 'exactness_gate_v1',
        required: false,
        status: 'skipped',
        checks: [],
        summary: 'exactness_not_required',
        answerInstruction: '정성 요청',
      },
      verdicts: [],
      gate,
      verifier: policyVerifier(target, 'fixture'),
      evidenceCount: 0,
      verifiedByUserId: userId,
    });

    const currentContentHash = artifactContentHash(target.content, target.governingMessage, target.soWhat);
    expect(await ledger.latest(target)).toMatchObject({ artifactVersionId, workspaceId, contentHash: currentContentHash, gate });
    expect(await ledger.loadCurrentPassVerdicts(target, currentContentHash)).toEqual([]);
    expect(await ledger.loadCurrentPassVerdicts({ ...target, title: '변경된 사실형 제목' }, currentContentHash)).toBeNull();
    expect(await ledger.loadCurrentPassVerdicts({ ...target, workspaceId: randomUUID() }, currentContentHash)).toBeNull();
    expect(await ledger.loadCurrentPassVerdicts(target, artifactContentHash(`${target.content} mismatch`))).toBeNull();
    expect(await ledger.latest({ ...target, title: '변경된 사실형 제목' })).toBeNull();
    expect(await ledger.latest({ ...target, workspaceId: randomUUID() })).toMatchObject({ workspaceId });
    expect(await ledger.latest({ ...target, content: `${target.content} 변경` })).toMatchObject({
      contentHash: artifactContentHash(target.content, target.governingMessage, target.soWhat),
    });

    const newerWrongHash = artifactContentHash(`${target.content} newer wrong hash`);
    await db.insert(schema.artifactVersionVerifications).values({
      workspaceId,
      projectId,
      artifactId,
      artifactVersionId,
      contentHash: newerWrongHash,
      status: 'passed',
      exactness: {},
      verdicts: [],
      gate,
      verifier: policyVerifier(target, 'newer-wrong-hash-fixture'),
      verifiedByUserId: userId,
    });
    expect(await ledger.latest(target)).toMatchObject({ contentHash: newerWrongHash });

    const warningGate = {
      decision: 'PASS_WITH_WARNINGS' as const,
      blockers: [],
      warnings: [{
        code: 'semantic_unsupported' as const,
        severity: 'warning' as const,
        message: '근거가 부족한 claim이 있습니다.',
      }],
    };
    await ledger.record({
      target,
      contentHash: artifactContentHash(target.content, target.governingMessage, target.soWhat),
      sourceThreadId: null,
      sourceMessageId: null,
      exactness: {
        gate: 'exactness_gate_v1',
        required: false,
        status: 'skipped',
        checks: [],
        summary: 'exactness_not_required',
        answerInstruction: '정성 요청',
      },
      verdicts: [],
      gate: warningGate,
      verifier: policyVerifier(target, 'fixture-warning'),
      evidenceCount: 0,
      verifiedByUserId: userId,
    });
    const persistedRows = await db
      .select({ status: schema.artifactVersionVerifications.status, gate: schema.artifactVersionVerifications.gate })
      .from(schema.artifactVersionVerifications)
      .where(eq(schema.artifactVersionVerifications.artifactVersionId, artifactVersionId));
    expect(persistedRows.find((row) => row.gate['decision'] === 'PASS_WITH_WARNINGS')?.status).toBe('blocked');

    await expect(db.insert(schema.artifactVersionVerifications).values({
      workspaceId,
      projectId,
      artifactId,
      artifactVersionId,
      contentHash: artifactContentHash(target.content, target.governingMessage, target.soWhat),
      status: 'passed',
      exactness: {},
      verdicts: [],
      gate: { decision: 'PASS' },
      verifier: policyVerifier(target, 'malformed-fixture'),
      verifiedByUserId: userId,
    })).rejects.toThrow();

    await expect(db.insert(schema.artifactVersionVerifications).values({
      workspaceId,
      projectId,
      artifactId,
      artifactVersionId,
      contentHash: artifactContentHash(target.content, target.governingMessage, target.soWhat),
      status: 'blocked',
      exactness: {},
      verdicts: [],
      gate,
      verifier: policyVerifier(target, 'status-gate-mismatch-fixture'),
      verifiedByUserId: userId,
    })).rejects.toThrow();

    await db.insert(schema.artifactVersionVerifications).values({
      workspaceId,
      projectId,
      artifactId,
      artifactVersionId,
      contentHash: artifactContentHash(target.content, target.governingMessage, target.soWhat),
      status: 'passed',
      exactness: {},
      verdicts: [],
      gate,
      verifier: policyVerifier(target, 'deleted-latest-fixture'),
      verifiedByUserId: userId,
      deletedAt: new Date(),
    });
    expect(await ledger.latest(target)).toMatchObject({
      gate: {
        decision: 'BLOCKED',
        blockers: [expect.objectContaining({ code: 'missing_verifier_telemetry' })],
      },
    });

    await db.insert(schema.artifactVersionVerifications).values({
      workspaceId,
      projectId,
      artifactId,
      artifactVersionId,
      contentHash: artifactContentHash(target.content, target.governingMessage, target.soWhat),
      status: 'passed',
      exactness: {},
      verdicts: [],
      gate,
      verifier: 'legacy-unversioned-fixture',
      verifiedByUserId: userId,
    });
    expect(await ledger.latest(target)).toBeNull();
  });
});
