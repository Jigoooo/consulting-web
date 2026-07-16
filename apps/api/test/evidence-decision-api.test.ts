import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, inArray } from 'drizzle-orm';
import { Pool } from 'pg';
import { schema } from '@consulting/db-schema';
import {
  AuthSessionResponseSchema,
  CreateChannelResponseSchema,
  CreateProjectResponseSchema,
  CreateThreadResponseSchema,
  CreateTopicResponseSchema,
  ArtifactVersionDecisionAnalyticsResponseSchema,
  DecisionAnalyticsRunResponseSchema,
  EvidenceDecisionSummaryResponseSchema,
  EvidenceDecisionSummaryV2ResponseSchema,
  EvidenceDecisionSummaryV3ResponseSchema,
  ListMessagesResponseSchema,
  OkResponseSchema,
  ReviewQueueResponseSchema,
  SearchMessagesResponseSchema,
  SignUpBootstrapResponseSchema,
  UploadAttachmentResponseSchema,
} from '@consulting/contracts';
import { AppModule } from '../src/app.module.js';
import { EvidenceDecisionStore } from '../src/consulting/evidence-decision.store.js';

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

let app: INestApplication;
let pool: Pool;
let db: NodePgDatabase<typeof schema>;
const createdUsers: string[] = [];
const createdWorkspaces: string[] = [];

async function waitForValue<T>(
  label: string,
  load: () => Promise<T>,
  ready: (value: T) => boolean,
): Promise<T> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const value = await load();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function installHermesAnswerMock(answer: string) {
  const body = [
    `data: {"event":"message.delta","run_id":"run_e2d","delta":${JSON.stringify(answer)}}`,
    '',
    `data: {"event":"run.completed","run_id":"run_e2d","output":${JSON.stringify(answer)}}`,
    '',
  ].join('\n');
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const u = input instanceof Request ? input.url : String(input);
    if (u.endsWith('/v1/toolsets')) return new Response(JSON.stringify({ object: 'list', platform: 'api_server', inventory_complete: true, inventory_hash: 'a'.repeat(64), effective_toolsets: ['web'], effective_tools: ['web_search'], data: [{ name: 'web', enabled: true }, { name: 'terminal', enabled: false }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.endsWith('/v1/capabilities')) return new Response(JSON.stringify({ features: { run_client_idempotency: true, run_tool_inventory_binding: true } }), { status: 200 });
    if (u.endsWith('/v1/runs')) {
      const payload = JSON.parse(String(init?.body ?? '{}')) as { client_run_id?: string; tool_inventory_hash?: string };
      return new Response(JSON.stringify({ run_id: payload.client_run_id, status: 'started', tool_inventory_hash: payload.tool_inventory_hash }), { status: 202, headers: { 'content-type': 'application/json' } });
    }
    if (/\/v1\/runs\/run_[0-9a-f]{32}$/.test(u)) return new Response(JSON.stringify({ status: 'running', model: 'test-model' }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.includes('/events')) return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    return new Response('not found', { status: 404 });
  }));
}

async function makeUser(label: string) {
  const email = `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  const testLoginSecret = 'not-a-real-login-fixture';
  const signup = SignUpBootstrapResponseSchema.parse(
    (await request(app.getHttpServer()).post('/auth/signup').send({ email, ['password']: testLoginSecret, displayName: label }).expect(201)).body,
  );
  createdUsers.push(signup.userId);
  createdWorkspaces.push(signup.personalWorkspaceId);
  const session = AuthSessionResponseSchema.parse(
    (await request(app.getHttpServer()).post('/auth/login').send({ email, ['password']: testLoginSecret }).expect(200)).body,
  );
  return { ...signup, bearer: `Bearer ${session.tokens.accessToken}` };
}

async function makeSpaces(bearer: string, workspaceId: string) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1e4)}`;
  const project = CreateProjectResponseSchema.parse((await request(app.getHttpServer()).post('/spaces/projects').set('authorization', bearer).send({ workspaceId, name: 'E2D Project', slug: `e2d-p-${stamp}` }).expect(201)).body);
  const channel = CreateChannelResponseSchema.parse((await request(app.getHttpServer()).post('/spaces/channels').set('authorization', bearer).send({ projectId: project.id, name: 'E2D Channel', slug: `e2d-c-${stamp}` }).expect(201)).body);
  const topic = CreateTopicResponseSchema.parse((await request(app.getHttpServer()).post('/spaces/topics').set('authorization', bearer).send({ channelId: channel.id, name: 'E2D Topic', slug: `e2d-t-${stamp}` }).expect(201)).body);
  const thread = CreateThreadResponseSchema.parse((await request(app.getHttpServer()).post('/spaces/threads').set('authorization', bearer).send({ topicId: topic.id, title: 'Evidence decision thread' }).expect(201)).body);
  return { project, channel, topic, thread };
}

async function waitForDocumentUnits(attachmentId: string): Promise<number> {
  for (let i = 0; i < 30; i += 1) {
    const rows = await db
      .select({ id: schema.documentRetrievalUnits.id })
      .from(schema.documentRetrievalUnits)
      .where(eq(schema.documentRetrievalUnits.attachmentId, attachmentId));
    if (rows.length > 0) return rows.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return 0;
}

d('Evidence-to-Decision API', () => {
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    pool = new Pool({ connectionString: url });
    db = drizzle(pool, { schema });
  });

  afterAll(async () => {
    if (createdWorkspaces.length > 0) {
      const cleanupClient = await pool.connect();
      try {
        await cleanupClient.query('BEGIN');
        await cleanupClient.query(
          'ALTER TABLE tool_policy_audit_events DISABLE TRIGGER tool_policy_audit_events_no_update_delete',
        );
        await cleanupClient.query(
          'DELETE FROM tool_policy_audit_events WHERE workspace_id = ANY($1::uuid[])',
          [createdWorkspaces],
        );
        await cleanupClient.query(
          'ALTER TABLE tool_policy_audit_events ENABLE TRIGGER tool_policy_audit_events_no_update_delete',
        );
        await cleanupClient.query('COMMIT');
      } catch (error) {
        await cleanupClient.query('ROLLBACK');
        throw error;
      } finally {
        cleanupClient.release();
      }
      await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, createdWorkspaces));
    }
    if (createdUsers.length > 0) await db.delete(schema.users).where(inArray(schema.users.id, createdUsers));
    await pool.end();
    await app.close();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('runs immutable decision analytics, returns strict v3, and deduplicates the same input', async () => {
    const owner = await makeUser('analytics-owner');
    const outsider = await makeUser('analytics-outsider');
    const artifactDenied = await makeUser('analytics-artifact-denied');
    const { project, thread } = await makeSpaces(owner.bearer, owner.personalWorkspaceId);
    const sourceRunId = `analytics-${randomUUID()}`;
    const [sourceMessage] = await db.insert(schema.chatMessages).values({
      workspaceId: owner.personalWorkspaceId,
      threadId: thread.id,
      role: 'assistant',
      content: '현재안을 유지합니다.',
      runId: sourceRunId,
    }).returning({ id: schema.chatMessages.id });
    const [scorecard] = await db.insert(schema.decisionScorecards).values({
      workspaceId: owner.personalWorkspaceId,
      threadId: thread.id,
      question: '정책대안 중 어떤 안이 안정적인가?',
      recommendedAlternativeId: 'keep',
      scoreSummary: { source: 'post_answer_verification_v2', runId: sourceRunId },
    }).returning({ id: schema.decisionScorecards.id });
    await db.insert(schema.decisionScorecardItems).values([
      {
        workspaceId: owner.personalWorkspaceId,
        scorecardId: scorecard!.id,
        alternativeId: 'keep', alternativeLabel: '현재안 유지', weightedScore: '0.8', uncertainty: '0.1',
        evidenceCoverage: '1', requiredAction: 'recommend',
        criteriaBreakdown: [
          { criterionId: 'support', label: '근거 지지율', normalizedWeight: 0.65, direction: 'higher_is_better', score: 0.9, adjustedScore: 0.56, uncertainty: 0.1, evidenceIds: ['ev-1'] },
          { criterionId: 'risk', label: '반박 위험', normalizedWeight: 0.35, direction: 'lower_is_better', score: 0.1, adjustedScore: 0.3, uncertainty: 0.1, evidenceIds: ['ev-1'] },
        ],
      },
      {
        workspaceId: owner.personalWorkspaceId,
        scorecardId: scorecard!.id,
        alternativeId: 'rewrite', alternativeLabel: '재작성', weightedScore: '0.5', uncertainty: '0.2',
        evidenceCoverage: '1', requiredAction: 'recommend',
        criteriaBreakdown: [
          { criterionId: 'support', label: '근거 지지율', normalizedWeight: 0.65, direction: 'higher_is_better', score: 0.5, adjustedScore: 0.3, uncertainty: 0.2, evidenceIds: ['ev-2'] },
          { criterionId: 'risk', label: '반박 위험', normalizedWeight: 0.35, direction: 'lower_is_better', score: 0.4, adjustedScore: 0.19, uncertainty: 0.2, evidenceIds: ['ev-2'] },
        ],
      },
    ]);
    const [artifact] = await db.insert(schema.artifacts).values({
      workspaceId: owner.personalWorkspaceId,
      projectId: project.id,
      title: '결정 분석 대상 산출물',
      createdByUserId: owner.userId,
    }).returning({ id: schema.artifacts.id });
    const [artifactVersion] = await db.insert(schema.artifactVersions).values({
      workspaceId: owner.personalWorkspaceId,
      artifactId: artifact!.id,
      versionNo: 1,
      content: '# 결정안\n현재안을 유지합니다.',
      governingMessage: '현재안 유지가 가장 안정적인 선택입니다.',
      soWhat: '예산 변동 위험을 줄이고 근거 보강에 집중합니다.',
      note: '초판',
      authorUserId: owner.userId,
      sourceThreadId: thread.id,
      sourceMessageId: sourceMessage!.id,
    }).returning({ id: schema.artifactVersions.id });
    const payload = {
      scorecardId: scorecard!.id,
      artifactVersionId: artifactVersion!.id,
      impact: {
        unit: 'KRW', model: 'multiplicative', fixedMultiplier: 12,
        drivers: [
          { id: 'headcount', label: '대상 인원', min: 820, mode: 900, max: 1010 },
          { id: 'monthly_add', label: '월 추가액', min: 90_000, mode: 120_000, max: 160_000 },
        ],
      },
    };
    const first = DecisionAnalyticsRunResponseSchema.parse((await request(app.getHttpServer())
      .post(`/chat/threads/${thread.id}/decision-analytics`).set('authorization', owner.bearer).send(payload).expect(201)).body);
    const second = DecisionAnalyticsRunResponseSchema.parse((await request(app.getHttpServer())
      .post(`/chat/threads/${thread.id}/decision-analytics`).set('authorization', owner.bearer).send(payload).expect(201)).body);
    expect(second.run.id).toBe(first.run.id);
    expect(first.run.artifactVersionId).toBe(artifactVersion!.id);
    expect(first.run.artifactContentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.run.sensitivity.baselineWinnerId).toBe('keep');
    expect(first.run.impact?.interval.p10).toBeLessThanOrEqual(first.run.impact!.interval.p50);
    expect(first.run.impact?.interval.p50).toBeLessThanOrEqual(first.run.impact!.interval.p90);
    const v3 = EvidenceDecisionSummaryV3ResponseSchema.parse((await request(app.getHttpServer())
      .get(`/chat/threads/${thread.id}/evidence-decision/summary?includeAnalytics=1`)
      .set('authorization', owner.bearer).expect(200)).body);
    expect(v3.analytics.latestRun?.id).toBe(first.run.id);
    const [newerScorecard] = await db.insert(schema.decisionScorecards).values({
      workspaceId: owner.personalWorkspaceId,
      threadId: thread.id,
      question: '후속 검증에서 생성된 새 결정표',
      recommendedAlternativeId: 'recheck',
      scoreSummary: { source: 'post_answer_verification_v2', runId: `newer-${randomUUID()}` },
      createdAt: new Date(Date.now() + 1_000),
    }).returning({ id: schema.decisionScorecards.id });
    await db.insert(schema.decisionScorecardItems).values({
      workspaceId: owner.personalWorkspaceId,
      scorecardId: newerScorecard!.id,
      alternativeId: 'recheck',
      alternativeLabel: '재검증',
      weightedScore: '0.7',
      uncertainty: '0.2',
      evidenceCoverage: '0.8',
      requiredAction: 'collect_more_evidence',
      criteriaBreakdown: [],
    });
    const v3AfterNewScorecard = EvidenceDecisionSummaryV3ResponseSchema.parse((await request(app.getHttpServer())
      .get(`/chat/threads/${thread.id}/evidence-decision/summary?includeAnalytics=1`)
      .set('authorization', owner.bearer).expect(200)).body);
    expect(v3AfterNewScorecard.latestScorecard?.id).toBe(newerScorecard!.id);
    expect(v3AfterNewScorecard.analytics.latestRun).toBeNull();
    const missingScorecard = await request(app.getHttpServer())
      .post(`/chat/threads/${thread.id}/decision-analytics`)
      .set('authorization', owner.bearer)
      .send({ scorecardId: randomUUID() })
      .expect(404);
    expect(missingScorecard.body).toEqual({ code: 'NOT_FOUND', message: 'Decision scorecard not found' });
    const invalidScorecard = await request(app.getHttpServer())
      .post(`/chat/threads/${thread.id}/decision-analytics`)
      .set('authorization', owner.bearer)
      .send({ scorecardId: newerScorecard!.id })
      .expect(409);
    expect(invalidScorecard.body).toMatchObject({ code: 'CONFLICT' });

    const concurrentRunClient = await pool.connect();
    const concurrentMutationClient = await pool.connect();
    let concurrentMutationError: unknown;
    try {
      await concurrentRunClient.query('BEGIN');
      await concurrentRunClient.query(
        `INSERT INTO decision_analytics_runs (
          id, workspace_id, thread_id, scorecard_id, method_version, input_hash,
          input_snapshot, sensitivity, actor_kind, actor_user_id
        ) VALUES ($1, $2, $3, $4, 'decision_analytics_v2', $5, '{}'::jsonb, '{}'::jsonb, 'system', NULL)`,
        [randomUUID(), owner.personalWorkspaceId, thread.id, newerScorecard!.id, '7'.repeat(64)],
      );
      const mutationPromise = concurrentMutationClient
        .query('UPDATE decision_scorecards SET question = $2 WHERE id = $1', [newerScorecard!.id, '동시 변조 질문'])
        .catch((error: unknown) => {
          concurrentMutationError = error;
        });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await concurrentRunClient.query('COMMIT');
      await mutationPromise;
    } catch (error) {
      await concurrentRunClient.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      concurrentRunClient.release();
      concurrentMutationClient.release();
    }
    expect(concurrentMutationError).toMatchObject({
      message: expect.stringContaining('source snapshot is immutable'),
    });

    const store = app.get(EvidenceDecisionStore);
    const raceCause = Object.assign(new Error('decision analytics run scope does not match an active scorecard and thread'), { code: '23514' });
    const raceSpy = vi.spyOn(store, 'runDecisionAnalytics').mockRejectedValueOnce(new Error('wrapped database error', { cause: raceCause }));
    const race = await request(app.getHttpServer())
      .post(`/chat/threads/${thread.id}/decision-analytics`)
      .set('authorization', owner.bearer)
      .send({ scorecardId: scorecard!.id });
    raceSpy.mockRestore();
    expect(race.status).toBe(409);
    expect(race.body).toEqual({ code: 'CONFLICT', message: 'Decision analytics inputs changed; retry' });
    const artifactBindingRaceCause = Object.assign(
      new Error('decision analytics artifact binding does not match version scope or content hash'),
      { code: '23514' },
    );
    const artifactBindingRaceSpy = vi.spyOn(store, 'runDecisionAnalytics')
      .mockRejectedValueOnce(new Error('wrapped database error', { cause: artifactBindingRaceCause }));
    const artifactBindingRace = await request(app.getHttpServer())
      .post(`/chat/threads/${thread.id}/decision-analytics`)
      .set('authorization', owner.bearer)
      .send({ scorecardId: scorecard!.id });
    artifactBindingRaceSpy.mockRestore();
    expect(artifactBindingRace.status).toBe(409);
    expect(artifactBindingRace.body).toEqual({ code: 'CONFLICT', message: 'Decision analytics inputs changed; retry' });
    const actorRaceCause = Object.assign(new Error('decision analytics user actor is not an active workspace member'), { code: '23514' });
    const actorRaceSpy = vi.spyOn(store, 'runDecisionAnalytics')
      .mockRejectedValueOnce(new Error('wrapped database error', { cause: actorRaceCause }));
    const actorRace = await request(app.getHttpServer())
      .post(`/chat/threads/${thread.id}/decision-analytics`)
      .set('authorization', owner.bearer)
      .send({ scorecardId: scorecard!.id });
    actorRaceSpy.mockRestore();
    expect(actorRace.status).toBe(404);
    expect(actorRace.body).toEqual({ code: 'NOT_FOUND', message: 'Decision analytics actor is no longer available' });
    const versionAnalytics = ArtifactVersionDecisionAnalyticsResponseSchema.parse((await request(app.getHttpServer())
      .get(`/chat/threads/${thread.id}/decision-analytics/artifact-versions/${artifactVersion!.id}`)
      .set('authorization', owner.bearer).expect(200)).body);
    expect(versionAnalytics.latestRun?.id).toBe(first.run.id);
    expect(versionAnalytics.lineageStatus).toBe('resolved');
    expect(versionAnalytics.scorecard?.id).toBe(scorecard!.id);
    const mismatchedLineage = await request(app.getHttpServer())
      .post(`/chat/threads/${thread.id}/decision-analytics`)
      .set('authorization', owner.bearer)
      .send({ ...payload, scorecardId: newerScorecard!.id })
      .expect(412);
    expect(mismatchedLineage.body).toMatchObject({ code: 'PRECONDITION' });
    const invitation = (await request(app.getHttpServer())
      .post('/invitations')
      .set('authorization', owner.bearer)
      .send({
        workspaceId: owner.personalWorkspaceId,
        scopeType: 'workspace',
        scopeId: owner.personalWorkspaceId,
        role: 'editor',
      })
      .expect(201)).body as { token: string };
    await request(app.getHttpServer())
      .post('/invitations/accept')
      .set('authorization', artifactDenied.bearer)
      .send({ token: invitation.token })
      .expect(201);
    await db.insert(schema.permissionOverrides).values({
      workspaceId: owner.personalWorkspaceId,
      userId: artifactDenied.userId,
      scopeType: 'project',
      scopeId: project.id,
      permission: 'artifact.render',
      allow: false,
    });
    await request(app.getHttpServer())
      .post(`/chat/threads/${thread.id}/decision-analytics`)
      .set('authorization', artifactDenied.bearer)
      .send(payload)
      .expect(403);
    await request(app.getHttpServer())
      .get(`/chat/threads/${thread.id}/decision-analytics/artifact-versions/${artifactVersion!.id}`)
      .set('authorization', artifactDenied.bearer)
      .expect(403);
    const ownerContentRun = DecisionAnalyticsRunResponseSchema.parse((await request(app.getHttpServer())
      .post(`/chat/threads/${thread.id}/decision-analytics`)
      .set('authorization', owner.bearer)
      .send({ scorecardId: scorecard!.id })
      .expect(201)).body);
    const memberContentRun = DecisionAnalyticsRunResponseSchema.parse((await request(app.getHttpServer())
      .post(`/chat/threads/${thread.id}/decision-analytics`)
      .set('authorization', artifactDenied.bearer)
      .send({ scorecardId: scorecard!.id })
      .expect(201)).body);
    expect(memberContentRun.run.id).not.toBe(ownerContentRun.run.id);
    const auditRows = await db.select({ id: schema.decisionAnalyticsRuns.id }).from(schema.decisionAnalyticsRuns)
      .where(eq(schema.decisionAnalyticsRuns.scorecardId, scorecard!.id));
    expect(auditRows).toHaveLength(3);
    await expect(db.update(schema.decisionAnalyticsRuns).set({ actorKind: 'system' })
      .where(eq(schema.decisionAnalyticsRuns.id, auditRows[0]!.id))).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringContaining('append-only') }),
    });
    await expect(db.delete(schema.decisionAnalyticsRuns)
      .where(eq(schema.decisionAnalyticsRuns.id, auditRows[0]!.id))).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringContaining('append-only') }),
    });
    await expect(db.update(schema.decisionScorecards)
      .set({ question: '분석 뒤 변조된 질문' })
      .where(eq(schema.decisionScorecards.id, scorecard!.id))).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringContaining('source snapshot is immutable') }),
    });
    await expect(db.update(schema.decisionScorecardItems)
      .set({ alternativeLabel: '분석 뒤 변조된 대안' })
      .where(eq(schema.decisionScorecardItems.scorecardId, scorecard!.id))).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringContaining('source snapshot is immutable') }),
    });
    const [moveTargetScorecard] = await db.insert(schema.decisionScorecards).values({
      workspaceId: owner.personalWorkspaceId,
      threadId: thread.id,
      question: '이동 공격용 미분석 결정표',
      recommendedAlternativeId: 'move_target',
      scoreSummary: { source: 'post_answer_verification_v2', runId: `move-${randomUUID()}` },
    }).returning({ id: schema.decisionScorecards.id });
    const [moveSourceItem] = await db.insert(schema.decisionScorecardItems).values({
      workspaceId: owner.personalWorkspaceId,
      scorecardId: moveTargetScorecard!.id,
      alternativeId: 'move_source',
      alternativeLabel: '이동 공격 출발 대안',
      weightedScore: '0.2',
      uncertainty: '0.1',
      evidenceCoverage: '0.5',
      requiredAction: 'none',
      criteriaBreakdown: [],
    }).returning({ id: schema.decisionScorecardItems.id });
    await expect(db.update(schema.decisionScorecardItems)
      .set({ scorecardId: scorecard!.id })
      .where(eq(schema.decisionScorecardItems.id, moveSourceItem!.id))).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringContaining('source snapshot is immutable') }),
    });
    await expect(db.update(schema.decisionScorecardItems)
      .set({ scorecardId: moveTargetScorecard!.id })
      .where(eq(schema.decisionScorecardItems.scorecardId, scorecard!.id))).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringContaining('source snapshot is immutable') }),
    });
    await expect(db.insert(schema.decisionScorecardItems).values({
      workspaceId: owner.personalWorkspaceId,
      scorecardId: scorecard!.id,
      alternativeId: 'inserted_after_run',
      alternativeLabel: '분석 뒤 삽입된 대안',
      weightedScore: '0.1',
      uncertainty: '0.9',
      evidenceCoverage: '0.1',
      requiredAction: 'reject',
      criteriaBreakdown: [],
    })).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringContaining('source snapshot is immutable') }),
    });
    await expect(db.update(schema.artifactVersions)
      .set({ content: '# 분석 뒤 변조된 본문' })
      .where(eq(schema.artifactVersions.id, artifactVersion!.id))).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringContaining('source snapshot is immutable') }),
    });
    await expect(db.insert(schema.decisionAnalyticsRuns).values({
      workspaceId: outsider.personalWorkspaceId,
      threadId: thread.id,
      scorecardId: scorecard!.id,
      methodVersion: 'decision_analytics_v2',
      inputHash: 'b'.repeat(64),
      inputSnapshot: {}, sensitivity: first.run.sensitivity, impact: null,
      actorKind: 'user', actorUserId: outsider.userId,
    })).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringContaining('scope does not match') }),
    });
    await expect(db.insert(schema.decisionAnalyticsRuns).values({
      workspaceId: owner.personalWorkspaceId,
      threadId: thread.id,
      scorecardId: scorecard!.id,
      artifactVersionId: artifactVersion!.id,
      artifactContentHash: 'd'.repeat(64),
      methodVersion: 'decision_analytics_v2',
      inputHash: 'e'.repeat(64),
      inputSnapshot: {}, sensitivity: first.run.sensitivity, impact: null,
      actorKind: 'user', actorUserId: owner.userId,
    })).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringContaining('artifact binding does not match') }),
    });
    await expect(db.insert(schema.decisionAnalyticsRuns).values({
      workspaceId: owner.personalWorkspaceId,
      threadId: thread.id,
      scorecardId: newerScorecard!.id,
      artifactVersionId: artifactVersion!.id,
      artifactContentHash: first.run.artifactContentHash!,
      methodVersion: 'decision_analytics_v2',
      inputHash: '9'.repeat(64),
      inputSnapshot: {}, sensitivity: first.run.sensitivity, impact: null,
      actorKind: 'user', actorUserId: owner.userId,
    })).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringContaining('artifact binding does not match') }),
    });
    await expect(db.insert(schema.decisionAnalyticsRuns).values({
      workspaceId: owner.personalWorkspaceId,
      threadId: thread.id,
      scorecardId: scorecard!.id,
      methodVersion: 'decision_analytics_v2',
      inputHash: 'c'.repeat(64),
      inputSnapshot: {}, sensitivity: first.run.sensitivity, impact: null,
      actorKind: 'system', actorUserId: owner.userId,
    })).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringContaining('actor_pair_check') }),
    });

    const expectTransactionalRejection = async (statement: string, params: unknown[] = []) => {
      const client = await pool.connect();
      let rejected: unknown;
      try {
        await client.query('BEGIN');
        try {
          await client.query(statement, params);
        } catch (error) {
          rejected = error;
        }
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
      expect(rejected).toBeDefined();
    };

    await expectTransactionalRejection(
      `INSERT INTO decision_analytics_runs (
        workspace_id, thread_id, scorecard_id, method_version, input_hash,
        input_snapshot, sensitivity, actor_kind, actor_user_id
      ) VALUES ($1, $2, $3, 'decision_analytics_v2', $4, '{}'::jsonb, '{}'::jsonb, 'user', $5)`,
      [owner.personalWorkspaceId, thread.id, scorecard!.id, 'f'.repeat(64), outsider.userId],
    );

    await expectTransactionalRejection(
      `UPDATE threads SET status = 'archived' WHERE id = $1;
       INSERT INTO decision_analytics_runs (
         workspace_id, thread_id, scorecard_id, method_version, input_hash,
         input_snapshot, sensitivity, actor_kind, actor_user_id
       ) VALUES ($2, $1, $3, 'decision_analytics_v2', $4, '{}'::jsonb, '{}'::jsonb, 'system', NULL)`,
      [thread.id, owner.personalWorkspaceId, scorecard!.id, 'a'.repeat(64)],
    );

    await expectTransactionalRejection('DELETE FROM decision_scorecards WHERE id = $1', [scorecard!.id]);
    await expectTransactionalRejection('DELETE FROM artifact_versions WHERE id = $1', [artifactVersion!.id]);
    await expectTransactionalRejection('TRUNCATE decision_scorecard_items');

    const resurrectionClient = await pool.connect();
    let resurrectionError: unknown;
    try {
      await resurrectionClient.query('BEGIN');
      await resurrectionClient.query(
        'CREATE TEMP TABLE workspace_resurrection_snapshot ON COMMIT DROP AS SELECT * FROM workspaces WHERE id = $1',
        [owner.personalWorkspaceId],
      );
      await resurrectionClient.query('DELETE FROM workspaces WHERE id = $1', [owner.personalWorkspaceId]);
      try {
        await resurrectionClient.query('INSERT INTO workspaces SELECT * FROM workspace_resurrection_snapshot');
      } catch (error) {
        resurrectionError = error;
      }
      await resurrectionClient.query('ROLLBACK');
    } finally {
      resurrectionClient.release();
    }
    expect(resurrectionError).toMatchObject({
      message: expect.stringContaining('workspace id cannot be reused'),
    });

    const tombstonedWorkspaceId = randomUUID();
    const movableWorkspaceId = randomUUID();
    const workspacePkClient = await pool.connect();
    let workspacePkError: unknown;
    try {
      await workspacePkClient.query('BEGIN');
      await workspacePkClient.query(
        `INSERT INTO workspaces (id, name, slug, is_personal, owner_user_id)
         VALUES ($1, '삭제 대상', $2, 'false', $3)`,
        [tombstonedWorkspaceId, `deleted-${tombstonedWorkspaceId}`, owner.userId],
      );
      await workspacePkClient.query('DELETE FROM workspaces WHERE id = $1', [tombstonedWorkspaceId]);
      await workspacePkClient.query(
        `INSERT INTO workspaces (id, name, slug, is_personal, owner_user_id)
         VALUES ($1, '이동 대상', $2, 'false', $3)`,
        [movableWorkspaceId, `movable-${movableWorkspaceId}`, owner.userId],
      );
      try {
        await workspacePkClient.query('UPDATE workspaces SET id = $1 WHERE id = $2', [tombstonedWorkspaceId, movableWorkspaceId]);
      } catch (error) {
        workspacePkError = error;
      }
      await workspacePkClient.query('ROLLBACK');
    } finally {
      workspacePkClient.release();
    }
    expect(workspacePkError).toMatchObject({
      message: expect.stringContaining('workspace id is immutable'),
    });

    const poisonedWorkspaceId = randomUUID();
    const poisonedTombstoneClient = await pool.connect();
    let poisonedTombstoneDeleteError: unknown;
    try {
      await poisonedTombstoneClient.query('BEGIN');
      await poisonedTombstoneClient.query(
        `INSERT INTO workspaces (id, name, slug, is_personal, owner_user_id)
         VALUES ($1, 'sentinel 승격 대상', $2, 'false', $3)`,
        [poisonedWorkspaceId, `poisoned-${poisonedWorkspaceId}`, owner.userId],
      );
      await poisonedTombstoneClient.query(
        `INSERT INTO workspace_deletion_tombstones (workspace_id_hash, is_permanent)
         VALUES (encode(digest($1::text, 'sha256'), 'hex'), false)`,
        [poisonedWorkspaceId],
      );
      await poisonedTombstoneClient.query('DELETE FROM workspaces WHERE id = $1', [poisonedWorkspaceId]);
      try {
        await poisonedTombstoneClient.query(
          `DELETE FROM workspace_deletion_tombstones
           WHERE workspace_id_hash = encode(digest($1::text, 'sha256'), 'hex')`,
          [poisonedWorkspaceId],
        );
      } catch (error) {
        poisonedTombstoneDeleteError = error;
      }
      await poisonedTombstoneClient.query('ROLLBACK');
    } finally {
      poisonedTombstoneClient.release();
    }
    expect(poisonedTombstoneDeleteError).toMatchObject({
      message: expect.stringContaining('tombstones are append-only'),
    });

    const concurrentWorkspaceId = randomUUID();
    await pool.query(
      `INSERT INTO workspaces (id, name, slug, is_personal, owner_user_id)
       VALUES ($1, '동시 삭제 대상', $2, 'false', $3)`,
      [concurrentWorkspaceId, `concurrent-${concurrentWorkspaceId}`, owner.userId],
    );
    const workspaceDeleteClient = await pool.connect();
    const workspaceInsertClient = await pool.connect();
    let concurrentWorkspaceInsertError: unknown;
    try {
      await workspaceDeleteClient.query('BEGIN');
      await workspaceDeleteClient.query('DELETE FROM workspaces WHERE id = $1', [concurrentWorkspaceId]);
      const insertPromise = workspaceInsertClient.query(
        `INSERT INTO workspaces (id, name, slug, is_personal, owner_user_id)
         VALUES ($1, '동시 부활 공격', $2, 'false', $3)`,
        [concurrentWorkspaceId, `resurrect-${concurrentWorkspaceId}`, owner.userId],
      ).catch((error: unknown) => {
        concurrentWorkspaceInsertError = error;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await workspaceDeleteClient.query('COMMIT');
      await insertPromise;
    } catch (error) {
      await workspaceDeleteClient.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      workspaceDeleteClient.release();
      workspaceInsertClient.release();
    }
    if (!concurrentWorkspaceInsertError) {
      await pool.query('DELETE FROM workspaces WHERE id = $1', [concurrentWorkspaceId]);
    }
    expect(concurrentWorkspaceInsertError).toMatchObject({
      message: expect.stringContaining('workspace id cannot be reused'),
    });

    const truncateClient = await pool.connect();
    try {
      await truncateClient.query('BEGIN');
      await expect(truncateClient.query('TRUNCATE decision_analytics_runs')).rejects.toThrow('append-only');
      await truncateClient.query('ROLLBACK');
    } finally {
      truncateClient.release();
    }
    await db.insert(schema.permissionOverrides).values({
      workspaceId: owner.personalWorkspaceId,
      userId: artifactDenied.userId,
      scopeType: 'thread',
      scopeId: thread.id,
      permission: 'message.send',
      allow: false,
    });
    await request(app.getHttpServer()).post(`/chat/threads/${thread.id}/decision-analytics`)
      .set('authorization', artifactDenied.bearer).send({ scorecardId: scorecard!.id }).expect(403);
    await request(app.getHttpServer()).post(`/chat/threads/${thread.id}/decision-analytics`)
      .set('authorization', outsider.bearer).send(payload).expect(404);
    await request(app.getHttpServer()).get(`/chat/threads/${thread.id}/evidence-decision/summary?includeAnalytics=1`)
      .set('authorization', outsider.bearer).expect(404);
    await request(app.getHttpServer()).get(`/chat/threads/${randomUUID()}/evidence-decision/summary?includeAnalytics=1`)
      .set('authorization', outsider.bearer).expect(404);
  });

  it('persists post-answer verification, indexes document units, and exposes summary plus review queue', async () => {
    installHermesAnswerMock('정원 증가는 인건비 부담을 증가시킵니다. 주차장 수입은 감소했습니다.');
    const owner = await makeUser('e2d-owner');
    const { thread } = await makeSpaces(owner.bearer, owner.personalWorkspaceId);

    await request(app.getHttpServer()).post('/chat/evidence').set('authorization', owner.bearer).send({
      threadId: thread.id,
      sourceType: 'manual',
      ref: '창원 예산표',
      excerpt: '정원 증가와 인건비 부담 증가는 재정소요의 핵심 요인이다. 주차장 수입은 전년 대비 증가했다.',
    }).expect(201);

    const attachment = UploadAttachmentResponseSchema.parse((await request(app.getHttpServer()).post('/attachments').set('authorization', owner.bearer).send({
      threadId: thread.id,
      fileName: '창원-예산표.pdf',
      mimeType: 'text/plain',
      dataBase64: Buffer.from('창원 예산표\n\n| 항목 | 변화 |\n|---|---|\n| 인건비 | 증가 |\n| 주차장 수입 | 증가 |\n\n본문: 정원 증가와 인건비 부담이 동시에 증가했다.').toString('base64'),
    }).expect(201)).body);
    expect(await waitForDocumentUnits(attachment.id)).toBeGreaterThan(0);
    const visualSearch = SearchMessagesResponseSchema.parse((await request(app.getHttpServer()).get(`/chat/threads/${thread.id}/messages/search?q=page_visual`).set('authorization', owner.bearer).expect(200)).body);
    expect(visualSearch.files.some((file) => file.modality === 'page_visual')).toBe(true);

    await request(app.getHttpServer()).post('/chat/stream').set('authorization', owner.bearer).send({ threadId: thread.id, message: '이거 틀렸어. 2026년 최신 규정 적용을 판단해줘', clientMessageId: randomUUID() }).expect(200);

    const summary = await waitForValue(
      'post-answer verification summary',
      async () => EvidenceDecisionSummaryResponseSchema.parse(
        (await request(app.getHttpServer()).get(`/chat/threads/${thread.id}/evidence-decision/summary`).set('authorization', owner.bearer).expect(200)).body,
      ),
      (value) => value.verdictSummary.claimCount > 0 && value.postAnswerVerification.checkedMessageCount > 0,
    );
    expect(summary.verdictSummary.claimCount).toBeGreaterThan(0);
    expect(summary.verdictSummary.supports + summary.verdictSummary.refutes + summary.verdictSummary.notEnoughInfo + summary.verdictSummary.mixed).toBe(summary.verdictSummary.claimCount);
    expect(summary.latestScorecard).toBeDefined();
    expect(summary.documentUnits.total).toBeGreaterThan(0);
    expect(summary.postAnswerVerification.checkedMessageCount).toBeGreaterThan(0);
    expect(summary.postAnswerVerification.gate.decision).toMatch(/PASS|PASS_WITH_WARNINGS|BLOCKED/);
    expect(summary.postAnswerVerification.gate.blockers.length + summary.postAnswerVerification.gate.warnings.length).toBeGreaterThan(0);
    expect(summary).not.toHaveProperty('judgment');

    const summaryV2 = EvidenceDecisionSummaryV2ResponseSchema.parse(
      (await request(app.getHttpServer())
        .get(`/chat/threads/${thread.id}/evidence-decision/summary?includeJudgment=1`)
        .set('authorization', owner.bearer)
        .expect(200)).body,
    );
    expect(summaryV2.judgment.latestRun?.issues.some((issue) => issue.code === 'user_correction_pattern')).toBe(true);
    expect(summaryV2.postAnswerVerification.gate.warnings.some((issue) => issue.code === 'user_correction_pattern')).toBe(true);

    const automaticV3 = EvidenceDecisionSummaryV3ResponseSchema.parse(
      (await request(app.getHttpServer())
        .get(`/chat/threads/${thread.id}/evidence-decision/summary?includeAnalytics=1`)
        .set('authorization', owner.bearer)
        .expect(200)).body,
    );
    expect(automaticV3.analytics.supported).toBe(true);
    expect(automaticV3.analytics.latestRun?.actorKind).toBe('system');
    const sameContentUserRun = DecisionAnalyticsRunResponseSchema.parse(
      (await request(app.getHttpServer())
        .post(`/chat/threads/${thread.id}/decision-analytics`)
        .set('authorization', owner.bearer)
        .send({ scorecardId: summary.latestScorecard!.id })
        .expect(201)).body,
    );
    expect(sameContentUserRun.run.actorKind).toBe('user');
    expect(sameContentUserRun.run.id).not.toBe(automaticV3.analytics.latestRun!.id);
    const manualRun = DecisionAnalyticsRunResponseSchema.parse(
      (await request(app.getHttpServer())
        .post(`/chat/threads/${thread.id}/decision-analytics`)
        .set('authorization', owner.bearer)
        .send({
          scorecardId: summary.latestScorecard!.id,
          impact: {
            unit: 'KRW', model: 'multiplicative', fixedMultiplier: 12,
            drivers: [
              { id: 'headcount', label: '대상 인원', min: 820, mode: 900, max: 1010 },
              { id: 'monthly_add', label: '월 추가액', min: 90_000, mode: 120_000, max: 160_000 },
            ],
          },
        })
        .expect(201)).body,
    );
    expect(manualRun.run.actorKind).toBe('user');
    expect(manualRun.run.impact?.interval.p10).toBeLessThanOrEqual(manualRun.run.impact!.interval.p50);
    expect(manualRun.run.impact?.interval.p50).toBeLessThanOrEqual(manualRun.run.impact!.interval.p90);
    const manualV3 = EvidenceDecisionSummaryV3ResponseSchema.parse(
      (await request(app.getHttpServer())
        .get(`/chat/threads/${thread.id}/evidence-decision/summary?includeAnalytics=1`)
        .set('authorization', owner.bearer)
        .expect(200)).body,
    );
    expect(manualV3.analytics.latestRun?.id).toBe(manualRun.run.id);

    const queue = ReviewQueueResponseSchema.parse((await request(app.getHttpServer()).get(`/chat/threads/${thread.id}/review-queue`).set('authorization', owner.bearer).expect(200)).body);
    expect(queue.items.length, JSON.stringify({
      verdictSummary: summary.verdictSummary,
      latestVerdicts: summary.latestVerdicts.map((item) => ({ claimText: item.claimText, verdict: item.verdict, confidence: item.confidence, rationale: item.rationale })),
      latestScorecard: summary.latestScorecard ? {
        recommendedAlternativeId: summary.latestScorecard.recommendedAlternativeId,
        rankedCount: summary.latestScorecard.ranked.length,
        ranked: summary.latestScorecard.ranked.map((item) => ({ alternativeId: item.alternativeId, requiredAction: item.requiredAction, weightedScore: item.weightedScore })),
      } : null,
    }, null, 2)).toBeGreaterThan(0);
    expect(queue.items[0]!.priorityScore).toBeGreaterThanOrEqual(queue.items.at(-1)!.priorityScore);
    expect((queue.items[0] as unknown as { actions?: Array<{ id: string; label: string; prompt: string }> }).actions?.map((a) => a.label)).toEqual([
      '근거 보강 후 재작성',
      '해당 문장 제거',
      '추가 자료 요청',
    ]);
    const resolvedItemId = queue.items[0]!.id;
    const decision = OkResponseSchema.parse((await request(app.getHttpServer())
      .post(`/chat/threads/${thread.id}/review-queue/${resolvedItemId}/decision`)
      .set('authorization', owner.bearer)
      .send({ action: 'resolve', note: '근거 보강 완료' })
      .expect(200)).body);
    expect(decision.ok).toBe(true);
    const after = ReviewQueueResponseSchema.parse((await request(app.getHttpServer()).get(`/chat/threads/${thread.id}/review-queue`).set('authorization', owner.bearer).expect(200)).body);
    expect(after.items.some((item) => item.id === resolvedItemId)).toBe(false);
    await request(app.getHttpServer())
      .post(`/chat/threads/${thread.id}/review-queue/${resolvedItemId}/decision`)
      .set('authorization', owner.bearer)
      .send({ action: 'ignore' })
      .expect(404);

    const listed = ListMessagesResponseSchema.parse((await request(app.getHttpServer()).get(`/chat/threads/${thread.id}/messages`).set('authorization', owner.bearer).expect(200)).body);
    const assistant = listed.messages.find((message) => message.role === 'assistant');
    expect(assistant).toBeDefined();
    expect((assistant as unknown as { verification?: { status: string; badgeLabel: string; counts: { supports: number; refutes: number; notEnoughInfo: number }; gate?: { decision: string; blockers: unknown[]; warnings: unknown[] } } }).verification).toEqual(expect.objectContaining({
      status: expect.stringMatching(/supported|needs_review|refuted|unsupported/),
      badgeLabel: expect.stringMatching(/지지됨|근거부족|반박됨/),
      counts: expect.objectContaining({ supports: expect.any(Number), refutes: expect.any(Number), notEnoughInfo: expect.any(Number) }),
      gate: expect.objectContaining({
        decision: expect.stringMatching(/PASS|PASS_WITH_WARNINGS/),
        blockers: [],
        warnings: expect.any(Array),
      }),
    }));
  }, 15_000);

  it('filters the live review queue by explicit claim kind and rejects unknown filters', async () => {
    const owner = await makeUser('review-filter-owner');
    const { thread } = await makeSpaces(owner.bearer, owner.personalWorkspaceId);
    await db.insert(schema.activeReviewItems).values([
      {
        workspaceId: owner.personalWorkspaceId,
        threadId: thread.id,
        itemKind: 'refuted_claim',
        title: '반박된 주장',
        targetRef: 'MSG-REFUTED-1',
        decisionImpact: '0.9',
        uncertainty: '0.1',
        evidenceGap: '0.2',
        deadlineWeight: '0',
        priorityScore: '0.81',
        status: 'open',
        reasons: ['공식 근거와 반대'],
      },
      {
        workspaceId: owner.personalWorkspaceId,
        threadId: thread.id,
        itemKind: 'unsupported_claim',
        title: '근거부족 주장',
        targetRef: 'MSG-UNSUPPORTED-1',
        decisionImpact: '0.7',
        uncertainty: '0.8',
        evidenceGap: '1',
        deadlineWeight: '0',
        priorityScore: '0.56',
        status: 'open',
        reasons: ['확인 가능한 근거 없음'],
      },
    ]);

    const all = ReviewQueueResponseSchema.parse((await request(app.getHttpServer())
      .get(`/chat/threads/${thread.id}/review-queue`)
      .set('authorization', owner.bearer)
      .expect(200)).body);
    const refuted = ReviewQueueResponseSchema.parse((await request(app.getHttpServer())
      .get(`/chat/threads/${thread.id}/review-queue?kind=refuted_claim`)
      .set('authorization', owner.bearer)
      .expect(200)).body);
    const unsupported = ReviewQueueResponseSchema.parse((await request(app.getHttpServer())
      .get(`/chat/threads/${thread.id}/review-queue?kind=unsupported_claim`)
      .set('authorization', owner.bearer)
      .expect(200)).body);

    expect(all.items.map((item) => item.itemKind).sort()).toEqual(['refuted_claim', 'unsupported_claim']);
    expect(refuted.items.map((item) => item.itemKind)).toEqual(['refuted_claim']);
    expect(unsupported.items.map((item) => item.itemKind)).toEqual(['unsupported_claim']);
    await request(app.getHttpServer())
      .get(`/chat/threads/${thread.id}/review-queue?kind=contradiction`)
      .set('authorization', owner.bearer)
      .expect(400);
  });

  it('lists thread retrieval hits and records one-click relevance feedback without cross-workspace access', async () => {
    const owner = await makeUser('retrieval-feedback-owner');
    const outsider = await makeUser('retrieval-feedback-outsider');
    const { project, channel, topic, thread } = await makeSpaces(owner.bearer, owner.personalWorkspaceId);
    const [run] = await db
      .insert(schema.retrievalRuns)
      .values({
        workspaceId: owner.personalWorkspaceId,
        projectId: project.id,
        channelId: channel.id,
        topicId: topic.id,
        threadId: thread.id,
        traceId: `feedback-${Date.now()}`,
        queryHash: 'feedback-query-hash',
        queryText: '근속승진 호봉',
        status: 'ok',
        hitCount: 1,
      })
      .returning({ id: schema.retrievalRuns.id });
    expect(run).toBeDefined();
    const [hit] = await db
      .insert(schema.retrievalHits)
      .values({
        workspaceId: owner.personalWorkspaceId,
        retrievalRunId: run!.id,
        threadId: thread.id,
        rank: 1,
        hitKind: 'dialogue_chunk',
        sourceTopicSlug: 'changwon-org-mgmt-diagnosis',
        docTitle: '창원 근속승진 검토',
        textPreview: '근속승진과 호봉 관련 검색 근거',
      })
      .returning({ id: schema.retrievalHits.id });
    expect(hit).toBeDefined();

    const listed = (await request(app.getHttpServer())
      .get(`/chat/threads/${thread.id}/retrieval-hits`)
      .set('authorization', owner.bearer)
      .expect(200)).body as { hits: Array<{ id: string; judgedRelevant: boolean | null; failureType: string | null }> };
    expect(listed.hits).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: hit!.id, judgedRelevant: null, failureType: null }),
    ]));

    await request(app.getHttpServer())
      .post(`/chat/threads/${thread.id}/retrieval-hits/${hit!.id}/feedback`)
      .set('authorization', owner.bearer)
      .send({ judgedRelevant: false, failureType: 'wrong_project' })
      .expect(200);
    expect((await db.select({ judgedRelevant: schema.retrievalHits.judgedRelevant, failureType: schema.retrievalHits.failureType })
      .from(schema.retrievalHits)
      .where(eq(schema.retrievalHits.id, hit!.id)))[0]).toEqual({ judgedRelevant: false, failureType: 'wrong_project' });

    await request(app.getHttpServer())
      .post(`/chat/threads/${thread.id}/retrieval-hits/${hit!.id}/feedback`)
      .set('authorization', owner.bearer)
      .send({ judgedRelevant: true })
      .expect(200);
    expect((await db.select({ judgedRelevant: schema.retrievalHits.judgedRelevant, failureType: schema.retrievalHits.failureType })
      .from(schema.retrievalHits)
      .where(eq(schema.retrievalHits.id, hit!.id)))[0]).toEqual({ judgedRelevant: true, failureType: null });

    await request(app.getHttpServer())
      .get(`/chat/threads/${thread.id}/retrieval-hits`)
      .set('authorization', outsider.bearer)
      .expect(404);
  });
});
