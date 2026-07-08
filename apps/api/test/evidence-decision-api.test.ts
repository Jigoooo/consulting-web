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
    if (u.endsWith('/v1/runs')) return new Response(JSON.stringify({ run_id: 'run_e2d', status: 'started' }), { status: 202, headers: { 'content-type': 'application/json' } });
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
    expect(queue.items.length).toBeGreaterThan(0);
    expect(queue.items[0]!.priorityScore).toBeGreaterThanOrEqual(queue.items.at(-1)!.priorityScore);
    expect((queue.items[0] as unknown as { actions?: Array<{ id: string; label: string; prompt: string }> }).actions?.map((a) => a.label)).toEqual([
      '근거 보강 후 재작성',
      '해당 문장 제거',
      '추가 자료 요청',
    ]);

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
});
