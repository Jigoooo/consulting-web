import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { inArray } from 'drizzle-orm';
import { Pool } from 'pg';
import { schema } from '@consulting/db-schema';
import {
  AuthSessionResponseSchema,
  SignUpBootstrapResponseSchema,
  CreateProjectResponseSchema,
  CreateChannelResponseSchema,
  CreateTopicResponseSchema,
  CreateThreadResponseSchema,
  ListEvidenceResponseSchema,
  ListArtifactsResponseSchema,
  ArtifactDetailResponseSchema,
  CreateArtifactResponseSchema,
  ListNotificationsResponseSchema,
  UploadAttachmentResponseSchema,
  ListAttachmentsResponseSchema,
} from '@consulting/contracts';
import { AppModule } from '../src/app.module.js';

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

let app: INestApplication;
let pool: Pool;
let db: NodePgDatabase<typeof schema>;
const createdUsers: string[] = [];
const createdWorkspaces: string[] = [];

/** Hermes mock that emits tool.started/completed around deltas (Phase 2-A). */
function installHermesToolEventFetchMock() {
  const body = [
    'data: {"event":"tool.started","run_id":"run_p2","tool":"web_search","preview":"창원시 인구 추이 https://kosis.kr/stat"}',
    '',
    'data: {"event":"tool.completed","run_id":"run_p2","tool":"web_search","duration":"1.2","error":"False"}',
    '',
    'data: {"event":"tool.started","run_id":"run_p2","tool":"gbrain_query","preview":"창원 공공시설 적정성"}',
    '',
    'data: {"event":"message.delta","run_id":"run_p2","delta":"근거 기반 "}',
    '',
    'data: {"event":"message.delta","run_id":"run_p2","delta":"답변"}',
    '',
    'data: {"event":"run.completed","run_id":"run_p2","output":"근거 기반 답변"}',
    '',
  ].join('\n');
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const u = input instanceof Request ? input.url : String(input);
    if (u.endsWith('/v1/runs')) {
      return new Response(JSON.stringify({ run_id: 'run_p2', status: 'started' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('/events')) {
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
}

async function makeUser(label: string) {
  const email = `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  const password = 'supersecret1';
  const signup = SignUpBootstrapResponseSchema.parse(
    (await request(app.getHttpServer()).post('/auth/signup').send({ email, password, displayName: label }).expect(201)).body,
  );
  createdUsers.push(signup.userId);
  createdWorkspaces.push(signup.personalWorkspaceId);
  const session = AuthSessionResponseSchema.parse(
    (await request(app.getHttpServer()).post('/auth/login').send({ email, password }).expect(200)).body,
  );
  return { ...signup, bearer: `Bearer ${session.tokens.accessToken}` };
}

async function makeSpaces(bearer: string, workspaceId: string) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1e4)}`;
  const project = CreateProjectResponseSchema.parse(
    (await request(app.getHttpServer()).post('/spaces/projects').set('authorization', bearer)
      .send({ workspaceId, name: 'P', slug: `p-${stamp}` }).expect(201)).body,
  );
  const channel = CreateChannelResponseSchema.parse(
    (await request(app.getHttpServer()).post('/spaces/channels').set('authorization', bearer)
      .send({ projectId: project.id, name: 'C', slug: `c-${stamp}` }).expect(201)).body,
  );
  const topic = CreateTopicResponseSchema.parse(
    (await request(app.getHttpServer()).post('/spaces/topics').set('authorization', bearer)
      .send({ channelId: channel.id, name: 'T', slug: `t-${stamp}` }).expect(201)).body,
  );
  const thread = CreateThreadResponseSchema.parse(
    (await request(app.getHttpServer()).post('/spaces/threads').set('authorization', bearer)
      .send({ topicId: topic.id, title: 'Phase2 스레드' }).expect(201)).body,
  );
  return { project, channel, topic, thread };
}

d('Phase 2 — evidence, artifacts, notifications', () => {
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    pool = new Pool({ connectionString: url });
    db = drizzle(pool, { schema });
  });

  afterAll(async () => {
    if (createdWorkspaces.length > 0) {
      await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, createdWorkspaces));
    }
    if (createdUsers.length > 0) {
      await db.delete(schema.users).where(inArray(schema.users.id, createdUsers));
    }
    await pool.end();
    await app.close();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('E-2: captures tool events from a stream as evidence linked to the assistant message', async () => {
    installHermesToolEventFetchMock();
    const owner = await makeUser('ev-owner');
    const { thread } = await makeSpaces(owner.bearer, owner.personalWorkspaceId);

    await request(app.getHttpServer())
      .post('/chat/stream')
      .set('authorization', owner.bearer)
      .send({ threadId: thread.id, message: '근거를 찾아줘' })
      .expect(200);

    const evidence = ListEvidenceResponseSchema.parse(
      (await request(app.getHttpServer())
        .get(`/chat/threads/${thread.id}/evidence`)
        .set('authorization', owner.bearer)
        .expect(200)).body,
    );
    expect(evidence.evidence.length).toBe(2);
    const bySource = Object.fromEntries(evidence.evidence.map((e) => [e.sourceType, e]));
    expect(bySource.web).toBeDefined();
    expect(bySource.web!.ref).toBe('web_search');
    expect(bySource.web!.url).toContain('https://kosis.kr');
    expect(bySource.gbrain).toBeDefined();
    expect(bySource.gbrain!.excerpt).toContain('적정성');
    // Both linked to the settled assistant message.
    expect(evidence.evidence.every((e) => e.messageId !== null)).toBe(true);
    expect(evidence.evidence.every((e) => e.runId === 'run_p2')).toBe(true);
  });

  it('E-3: manual evidence attach + membership isolation on evidence reads', async () => {
    installHermesToolEventFetchMock();
    const owner = await makeUser('ev-manual');
    const outsider = await makeUser('ev-outsider');
    const { thread } = await makeSpaces(owner.bearer, owner.personalWorkspaceId);

    await request(app.getHttpServer())
      .post('/chat/evidence')
      .set('authorization', owner.bearer)
      .send({
        threadId: thread.id,
        sourceType: 'manual',
        ref: '창원시 2026 예산서',
        excerpt: '3장 세출예산 — 공공시설 운영비 12% 증가',
        url: 'https://changwon.go.kr/budget2026',
      })
      .expect(201);

    const evidence = ListEvidenceResponseSchema.parse(
      (await request(app.getHttpServer())
        .get(`/chat/threads/${thread.id}/evidence`)
        .set('authorization', owner.bearer)
        .expect(200)).body,
    );
    expect(evidence.evidence.length).toBe(1);
    expect(evidence.evidence[0]!.sourceType).toBe('manual');
    expect(evidence.evidence[0]!.addedByUserId).toBe(owner.userId);

    // Non-member cannot read evidence.
    await request(app.getHttpServer())
      .get(`/chat/threads/${thread.id}/evidence`)
      .set('authorization', outsider.bearer)
      .expect(403);
  });

  it('A-1/A-2: artifact create → version append → detail with immutable chain', async () => {
    const owner = await makeUser('art-owner');
    const { project, thread } = await makeSpaces(owner.bearer, owner.personalWorkspaceId);

    const created = CreateArtifactResponseSchema.parse(
      (await request(app.getHttpServer())
        .post('/artifacts')
        .set('authorization', owner.bearer)
        .send({
          projectId: project.id,
          title: '공공시설 적정성 1차 보고',
          content: '# 초안\n\n| 시설 | 판정 |\n|---|---|\n| A | 유지 |',
          note: '초판',
          sourceThreadId: thread.id,
        })
        .expect(201)).body,
    );
    expect(created.versionNo).toBe(1);

    const v2 = CreateArtifactResponseSchema.parse(
      (await request(app.getHttpServer())
        .post(`/artifacts/${created.id}/versions`)
        .set('authorization', owner.bearer)
        .send({ content: '# 개정\n\n수치 보강판', note: '수치 보강' })
        .expect(201)).body,
    );
    expect(v2.versionNo).toBe(2);

    const detail = ArtifactDetailResponseSchema.parse(
      (await request(app.getHttpServer())
        .get(`/artifacts/${created.id}`)
        .set('authorization', owner.bearer)
        .expect(200)).body,
    );
    expect(detail.headVersion).toBe(2);
    expect(detail.versions.map((v) => v.versionNo)).toEqual([1, 2]);
    expect(detail.versions[0]!.content).toContain('초안');
    expect(detail.versions[1]!.note).toBe('수치 보강');

    const list = ListArtifactsResponseSchema.parse(
      (await request(app.getHttpServer())
        .get(`/artifacts/workspaces/${owner.personalWorkspaceId}`)
        .set('authorization', owner.bearer)
        .expect(200)).body,
    );
    expect(list.artifacts.some((a) => a.id === created.id && a.headVersion === 2)).toBe(true);
  });

  it('A-2: outsider cannot read or write artifacts (tenant isolation)', async () => {
    const owner = await makeUser('art-iso-owner');
    const outsider = await makeUser('art-iso-out');
    const { project } = await makeSpaces(owner.bearer, owner.personalWorkspaceId);

    const created = CreateArtifactResponseSchema.parse(
      (await request(app.getHttpServer())
        .post('/artifacts')
        .set('authorization', owner.bearer)
        .send({ projectId: project.id, title: '격리 테스트', content: '내용' })
        .expect(201)).body,
    );

    await request(app.getHttpServer())
      .get(`/artifacts/${created.id}`)
      .set('authorization', outsider.bearer)
      .expect(403);
    await request(app.getHttpServer())
      .post(`/artifacts/${created.id}/versions`)
      .set('authorization', outsider.bearer)
      .send({ content: '악성 개정' })
      .expect(403);
    await request(app.getHttpServer())
      .post('/artifacts')
      .set('authorization', outsider.bearer)
      .send({ projectId: project.id, title: '침투', content: 'x' })
      .expect(403);
  });

  it('F-1/F-3: assistant reply notifies OTHER members; mark-read clears unread', async () => {
    installHermesToolEventFetchMock();
    const owner = await makeUser('noti-owner');
    const member = await makeUser('noti-member');
    const { thread } = await makeSpaces(owner.bearer, owner.personalWorkspaceId);

    // Bring member into the workspace via share-link invitation.
    const invite = (await request(app.getHttpServer())
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
      .set('authorization', member.bearer)
      .send({ token: invite.token })
      .expect(201);

    // member_joined lands in owner's feed.
    const ownerFeed = ListNotificationsResponseSchema.parse(
      (await request(app.getHttpServer()).get('/notifications').set('authorization', owner.bearer).expect(200)).body,
    );
    expect(ownerFeed.notifications.some((n) => n.type === 'member_joined')).toBe(true);

    // Owner chats — assistant settle should notify member (not owner).
    await request(app.getHttpServer())
      .post('/chat/stream')
      .set('authorization', owner.bearer)
      .send({ threadId: thread.id, message: '알림 테스트' })
      .expect(200);

    const memberFeed = ListNotificationsResponseSchema.parse(
      (await request(app.getHttpServer()).get('/notifications').set('authorization', member.bearer).expect(200)).body,
    );
    const reply = memberFeed.notifications.find((n) => n.type === 'assistant_reply');
    expect(reply).toBeDefined();
    expect(reply!.refType).toBe('thread');
    expect(reply!.refId).toBe(thread.id);
    expect(memberFeed.unreadCount).toBeGreaterThan(0);

    // Owner does NOT get their own assistant_reply notification.
    const ownerFeed2 = ListNotificationsResponseSchema.parse(
      (await request(app.getHttpServer()).get('/notifications').set('authorization', owner.bearer).expect(200)).body,
    );
    expect(ownerFeed2.notifications.some((n) => n.type === 'assistant_reply')).toBe(false);

    // Mark all read.
    await request(app.getHttpServer())
      .post('/notifications/read')
      .set('authorization', member.bearer)
      .send({})
      .expect(201);
    const memberFeed2 = ListNotificationsResponseSchema.parse(
      (await request(app.getHttpServer()).get('/notifications').set('authorization', member.bearer).expect(200)).body,
    );
    expect(memberFeed2.unreadCount).toBe(0);
  });

  it('G-3: upload/list/download attachment with mime allowlist + isolation', async () => {
    const owner = await makeUser('att-owner');
    const outsider = await makeUser('att-out');
    const { thread } = await makeSpaces(owner.bearer, owner.personalWorkspaceId);

    const payload = Buffer.from('창원시 예산서 텍스트 본문 — 공공시설 운영비 근거자료').toString('base64');
    const uploaded = UploadAttachmentResponseSchema.parse(
      (await request(app.getHttpServer())
        .post('/attachments')
        .set('authorization', owner.bearer)
        .send({ threadId: thread.id, fileName: '예산서.txt', mimeType: 'text/plain', dataBase64: payload })
        .expect(201)).body,
    );

    // mime not on allowlist → 400
    await request(app.getHttpServer())
      .post('/attachments')
      .set('authorization', owner.bearer)
      .send({ threadId: thread.id, fileName: 'x.exe', mimeType: 'application/x-msdownload', dataBase64: payload })
      .expect(400);

    const list = ListAttachmentsResponseSchema.parse(
      (await request(app.getHttpServer())
        .get(`/attachments/threads/${thread.id}`)
        .set('authorization', owner.bearer)
        .expect(200)).body,
    );
    expect(list.attachments.length).toBe(1);
    expect(list.attachments[0]!.fileName).toBe('예산서.txt');
    expect(list.attachments[0]!.sizeBytes).toBeGreaterThan(0);
    expect(list.attachments[0]!.extraction?.status).toBe('indexed');
    expect(list.attachments[0]!.extraction?.extractor).toBe('text/plain');
    expect(list.attachments[0]!.extraction?.textChars).toBeGreaterThan(10);
    expect(list.attachments[0]!.extraction?.qualityScore).toBeGreaterThanOrEqual(60);

    const evidence = ListEvidenceResponseSchema.parse(
      (await request(app.getHttpServer())
        .get(`/chat/threads/${thread.id}/evidence`)
        .set('authorization', owner.bearer)
        .expect(200)).body,
    );
    const fileEvidence = evidence.evidence.find((e) => e.sourceType === 'file' && e.ref === '예산서.txt');
    expect(fileEvidence).toBeDefined();
    expect(fileEvidence!.excerpt).toContain('공공시설');
    expect(fileEvidence!.qualityScore).toBeGreaterThanOrEqual(60);
    expect(fileEvidence!.qualitySignals.length).toBeGreaterThan(0);

    const dl = await request(app.getHttpServer())
      .get(`/attachments/${uploaded.id}/content`)
      .set('authorization', owner.bearer)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(Buffer.from(dl.body as Buffer).toString('utf8')).toContain('창원시 예산서');

    // outsider blocked on list + download
    await request(app.getHttpServer())
      .get(`/attachments/threads/${thread.id}`)
      .set('authorization', outsider.bearer)
      .expect(403);
    await request(app.getHttpServer())
      .get(`/attachments/${uploaded.id}/content`)
      .set('authorization', outsider.bearer)
      .expect(403);
  });
});
