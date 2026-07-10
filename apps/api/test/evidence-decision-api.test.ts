import 'reflect-metadata';
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
  EvidenceDecisionSummaryResponseSchema,
  ListMessagesResponseSchema,
  OkResponseSchema,
  ReviewQueueResponseSchema,
  SearchMessagesResponseSchema,
  SignUpBootstrapResponseSchema,
  UploadAttachmentResponseSchema,
} from '@consulting/contracts';
import { AppModule } from '../src/app.module.js';

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

let app: INestApplication;
let pool: Pool;
let db: NodePgDatabase<typeof schema>;
const createdUsers: string[] = [];
const createdWorkspaces: string[] = [];

function installHermesAnswerMock(answer: string) {
  const body = [
    `data: {"event":"message.delta","run_id":"run_e2d","delta":${JSON.stringify(answer)}}`,
    '',
    `data: {"event":"run.completed","run_id":"run_e2d","output":${JSON.stringify(answer)}}`,
    '',
  ].join('\n');
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const u = input instanceof Request ? input.url : String(input);
    if (u.endsWith('/v1/toolsets')) return new Response(JSON.stringify({ data: [{ name: 'web', enabled: true }, { name: 'terminal', enabled: false }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.endsWith('/v1/runs')) return new Response(JSON.stringify({ run_id: 'run_e2d', status: 'started' }), { status: 202, headers: { 'content-type': 'application/json' } });
    if (u.endsWith('/v1/runs/run_e2d')) return new Response(JSON.stringify({ status: 'running', model: 'test-model' }), { status: 200, headers: { 'content-type': 'application/json' } });
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
    if (createdWorkspaces.length > 0) await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, createdWorkspaces));
    if (createdUsers.length > 0) await db.delete(schema.users).where(inArray(schema.users.id, createdUsers));
    await pool.end();
    await app.close();
  });

  afterEach(() => vi.unstubAllGlobals());

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

    await request(app.getHttpServer()).post('/chat/stream').set('authorization', owner.bearer).send({ threadId: thread.id, message: '판단해줘' }).expect(200);

    const summary = EvidenceDecisionSummaryResponseSchema.parse((await request(app.getHttpServer()).get(`/chat/threads/${thread.id}/evidence-decision/summary`).set('authorization', owner.bearer).expect(200)).body);
    expect(summary.verdictSummary.claimCount).toBeGreaterThan(0);
    expect(summary.verdictSummary.supports + summary.verdictSummary.refutes + summary.verdictSummary.notEnoughInfo + summary.verdictSummary.mixed).toBe(summary.verdictSummary.claimCount);
    expect(summary.latestScorecard).toBeDefined();
    expect(summary.documentUnits.total).toBeGreaterThan(0);
    expect(summary.postAnswerVerification.checkedMessageCount).toBeGreaterThan(0);
    expect(summary.postAnswerVerification.gate.decision).toMatch(/PASS|PASS_WITH_WARNINGS|BLOCKED/);
    expect(summary.postAnswerVerification.gate.blockers.length + summary.postAnswerVerification.gate.warnings.length).toBeGreaterThan(0);

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
    const afterDecision = ReviewQueueResponseSchema.parse((await request(app.getHttpServer()).get(`/chat/threads/${thread.id}/review-queue`).set('authorization', owner.bearer).expect(200)).body);
    expect(afterDecision.items.some((item) => item.id === resolvedItemId)).toBe(false);

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
  });

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
      .expect(403);
  });
});
