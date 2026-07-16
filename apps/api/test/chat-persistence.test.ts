import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { inArray } from 'drizzle-orm';
import { Pool } from 'pg';
import { schema } from '@consulting/db-schema';
import { deleteToolPolicyAuditFixtures } from './tool-policy-audit-fixtures.js';
import {
  AuthSessionResponseSchema,
  SignUpBootstrapResponseSchema,
  CreateProjectResponseSchema,
  CreateChannelResponseSchema,
  CreateTopicResponseSchema,
  CreateThreadResponseSchema,
  ListMessagesResponseSchema,
  ListMessagesPageResponseSchema,
  SearchMessagesResponseSchema,
  ThreadDetailResponseSchema,
  ListMembersResponseSchema,
  WorkspaceTreeResponseSchema,
} from '@consulting/contracts';
import { AppModule } from '../src/app.module.js';

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

let app: INestApplication;
let pool: Pool;
let db: NodePgDatabase<typeof schema>;
const createdUsers: string[] = [];
const createdWorkspaces: string[] = [];

function installHermesRunsFetchMock() {
  const body = [
    'data: {"event":"message.delta","run_id":"run_persist","delta":"영속 "}',
    '',
    'data: {"event":"message.delta","run_id":"run_persist","delta":"확인"}',
    '',
    'data: {"event":"run.completed","run_id":"run_persist","output":"영속 확인"}',
    '',
  ].join('\n');
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const u = input instanceof Request ? input.url : String(input);
    if (u.endsWith('/v1/toolsets')) {
      return new Response(JSON.stringify({ object: 'list', platform: 'api_server', inventory_complete: true, inventory_hash: 'a'.repeat(64), effective_toolsets: ['file', 'web'], effective_tools: ['read_file', 'web_search'], data: [{ name: 'web', enabled: true }, { name: 'file', enabled: true }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.endsWith('/v1/capabilities')) {
      return new Response(JSON.stringify({ features: { run_client_idempotency: true, run_tool_inventory_binding: true } }), { status: 200 });
    }
    if (u.endsWith('/v1/runs')) {
      const payload = JSON.parse(String(init?.body ?? '{}')) as { client_run_id?: string; tool_inventory_hash?: string };
      return new Response(JSON.stringify({ run_id: payload.client_run_id, status: 'started', tool_inventory_hash: payload.tool_inventory_hash }), {
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
  return fetchMock;
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

async function makeThread(owner: Awaited<ReturnType<typeof makeUser>>, label: string) {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const project = CreateProjectResponseSchema.parse(
    (await request(app.getHttpServer()).post('/spaces/projects').set('authorization', owner.bearer)
      .send({ workspaceId: owner.personalWorkspaceId, name: `${label} P`, slug: `${label}-p-${stamp}` }).expect(201)).body,
  );
  const channel = CreateChannelResponseSchema.parse(
    (await request(app.getHttpServer()).post('/spaces/channels').set('authorization', owner.bearer)
      .send({ projectId: project.id, name: `${label} C`, slug: `${label}-c-${stamp}` }).expect(201)).body,
  );
  const topic = CreateTopicResponseSchema.parse(
    (await request(app.getHttpServer()).post('/spaces/topics').set('authorization', owner.bearer)
      .send({ channelId: channel.id, name: `${label} T`, slug: `${label}-t-${stamp}` }).expect(201)).body,
  );
  const thread = CreateThreadResponseSchema.parse(
    (await request(app.getHttpServer()).post('/spaces/threads').set('authorization', owner.bearer)
      .send({ topicId: topic.id, title: `${label} thread` }).expect(201)).body,
  );
  return { project, channel, topic, thread };
}

d('chat persistence + space mutations (Phase 1.5)', () => {
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    pool = new Pool({ connectionString: url });
    db = drizzle(pool, { schema });
  });

  afterAll(async () => {
    if (createdWorkspaces.length > 0) {
      await deleteToolPolicyAuditFixtures(pool, createdWorkspaces);
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

  it('persists user+assistant turns across a stream and serves them back', async () => {
    installHermesRunsFetchMock();
    const owner = await makeUser('persist-owner');
    const stamp = Date.now();

    const project = CreateProjectResponseSchema.parse(
      (await request(app.getHttpServer()).post('/spaces/projects').set('authorization', owner.bearer)
        .send({ workspaceId: owner.personalWorkspaceId, name: 'P', slug: `p-${stamp}` }).expect(201)).body,
    );
    const channel = CreateChannelResponseSchema.parse(
      (await request(app.getHttpServer()).post('/spaces/channels').set('authorization', owner.bearer)
        .send({ projectId: project.id, name: 'C', slug: `c-${stamp}` }).expect(201)).body,
    );
    const topic = CreateTopicResponseSchema.parse(
      (await request(app.getHttpServer()).post('/spaces/topics').set('authorization', owner.bearer)
        .send({ channelId: channel.id, name: 'T', slug: `t-${stamp}` }).expect(201)).body,
    );
    const thread = CreateThreadResponseSchema.parse(
      (await request(app.getHttpServer()).post('/spaces/threads').set('authorization', owner.bearer)
        .send({ topicId: topic.id, title: '영속 스레드' }).expect(201)).body,
    );

    const streamResponse = await request(app.getHttpServer())
      .post('/chat/stream')
      .set('authorization', owner.bearer)
      .send({ threadId: thread.id, message: '영속화 테스트 질문', clientMessageId: randomUUID() })
      .expect(200);
    expect(streamResponse.text).toContain('영속 ');
    expect(streamResponse.text).toContain('확인');

    // transcript comes back in order with roles + run id
    const listed = ListMessagesResponseSchema.parse(
      (await request(app.getHttpServer()).get(`/chat/threads/${thread.id}/messages`).set('authorization', owner.bearer).expect(200)).body,
    );
    expect(listed.messages.length).toBe(2);
    expect(listed.messages[0]!.role).toBe('user');
    expect(listed.messages[0]!.content).toBe('영속화 테스트 질문');
    expect(listed.messages[0]!.authorName).toBeTruthy();
    expect(listed.messages[1]!.role).toBe('assistant');
    expect(listed.messages[1]!.content).toBe('영속 확인');
    expect(listed.messages[1]!.runId).toMatch(/^run_[0-9a-f]{32}$/);
    expect(listed.messages[1]!.finishState).toBe('complete');

    // outsider cannot read the transcript
    const outsider = await makeUser('persist-outsider');
    await request(app.getHttpServer())
      .get(`/chat/threads/${thread.id}/messages`)
      .set('authorization', outsider.bearer)
      .expect(404);

    // thread detail (N-6)
    const detail = ThreadDetailResponseSchema.parse(
      (await request(app.getHttpServer()).get(`/spaces/threads/${thread.id}`).set('authorization', owner.bearer).expect(200)).body,
    );
    expect(detail.title).toBe('영속 스레드');
    expect(detail.topicId).toBe(topic.id);
  });

  it('replays one logical turn without duplicating the user, assistant, or Hermes run', async () => {
    const fetchMock = installHermesRunsFetchMock();
    const owner = await makeUser('idempotent-owner');
    const { thread } = await makeThread(owner, 'idempotent');
    const clientMessageId = randomUUID();
    const payload = {
      threadId: thread.id,
      message: '같은 요청은 한 번만 실행',
      clientMessageId,
    };

    const first = await request(app.getHttpServer())
      .post('/chat/stream')
      .set('authorization', owner.bearer)
      .send(payload)
      .expect(200);
    const replay = await request(app.getHttpServer())
      .post('/chat/stream')
      .set('authorization', owner.bearer)
      .send(payload)
      .expect(200);

    const assistantText = (body: string) => body
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as { type?: string; text?: string })
      .filter((event) => event.type === 'delta')
      .map((event) => event.text ?? '')
      .join('');
    expect(assistantText(first.text)).toBe('영속 확인');
    expect(assistantText(replay.text)).toBe('영속 확인');
    const runStarts = fetchMock.mock.calls.filter(([input, init]) => {
      const requestUrl = input instanceof Request ? input.url : String(input);
      return requestUrl.endsWith('/v1/runs') && init?.method === 'POST';
    });
    expect(runStarts).toHaveLength(1);

    const listed = ListMessagesResponseSchema.parse(
      (await request(app.getHttpServer())
        .get(`/chat/threads/${thread.id}/messages`)
        .set('authorization', owner.bearer)
        .expect(200)).body,
    );
    expect(listed.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(listed.messages[0]!.content).toBe(payload.message);
    expect(listed.messages[1]!.content).toBe('영속 확인');
  });

  it('rejects client message id reuse with different request provenance', async () => {
    const fetchMock = installHermesRunsFetchMock();
    const owner = await makeUser('idempotent-conflict-owner');
    const { thread } = await makeThread(owner, 'idempotent-conflict');
    const clientMessageId = randomUUID();

    await request(app.getHttpServer())
      .post('/chat/stream')
      .set('authorization', owner.bearer)
      .send({ threadId: thread.id, message: '원본 요청', clientMessageId })
      .expect(200);
    await request(app.getHttpServer())
      .post('/chat/stream')
      .set('authorization', owner.bearer)
      .send({ threadId: thread.id, message: '변조된 요청', clientMessageId })
      .expect(409);

    const runStarts = fetchMock.mock.calls.filter(([input, init]) => {
      const requestUrl = input instanceof Request ? input.url : String(input);
      return requestUrl.endsWith('/v1/runs') && init?.method === 'POST';
    });
    expect(runStarts).toHaveLength(1);
    const listed = ListMessagesResponseSchema.parse(
      (await request(app.getHttpServer())
        .get(`/chat/threads/${thread.id}/messages`)
        .set('authorization', owner.bearer)
        .expect(200)).body,
    );
    expect(listed.messages.map((message) => message.content)).toEqual(['원본 요청', '영속 확인']);
  });

  it('serializes concurrent duplicate requests into one Hermes run', async () => {
    const fetchMock = installHermesRunsFetchMock();
    const owner = await makeUser('idempotent-race-owner');
    const { thread } = await makeThread(owner, 'idempotent-race');
    const payload = {
      threadId: thread.id,
      message: '동시 요청도 한 번만 실행',
      clientMessageId: randomUUID(),
    };

    const [first, second] = await Promise.all([
      request(app.getHttpServer()).post('/chat/stream').set('authorization', owner.bearer).send(payload),
      request(app.getHttpServer()).post('/chat/stream').set('authorization', owner.bearer).send(payload),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const runStarts = fetchMock.mock.calls.filter(([input, init]) => {
      const requestUrl = input instanceof Request ? input.url : String(input);
      return requestUrl.endsWith('/v1/runs') && init?.method === 'POST';
    });
    expect(runStarts).toHaveLength(1);
    const listed = ListMessagesResponseSchema.parse(
      (await request(app.getHttpServer())
        .get(`/chat/threads/${thread.id}/messages`)
        .set('authorization', owner.bearer)
        .expect(200)).body,
    );
    expect(listed.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
  });

  it('pages messages by newest window, older cursor, and around anchor', async () => {
    const owner = await makeUser('page-owner');
    const { thread } = await makeThread(owner, 'page');
    const base = Date.now() - 10_000;
    const inserted = await db
      .insert(schema.chatMessages)
      .values(
        Array.from({ length: 5 }, (_, i) => ({
          workspaceId: owner.personalWorkspaceId,
          threadId: thread.id,
          role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
          authorUserId: i % 2 === 0 ? owner.userId : null,
          content: `메시지-${i + 1}`,
          runId: i % 2 === 0 ? null : `run_page_${i + 1}`,
          finishState: 'complete',
          createdAt: new Date(base + i * 1000),
          updatedAt: new Date(base + i * 1000),
        })),
      )
      .returning({ id: schema.chatMessages.id });

    const latest = ListMessagesPageResponseSchema.parse(
      (await request(app.getHttpServer())
        .get(`/chat/threads/${thread.id}/messages?page=1&limit=2`)
        .set('authorization', owner.bearer)
        .expect(200)).body,
    );
    expect(latest.messages.map((m) => m.content)).toEqual(['메시지-4', '메시지-5']);
    expect(latest.hasOlder).toBe(true);
    expect(latest.hasNewer).toBe(false);
    expect(latest.olderCursor).toBe(inserted[3]!.id);
    expect(latest.newerCursor).toBe(inserted[4]!.id);

    const older = ListMessagesPageResponseSchema.parse(
      (await request(app.getHttpServer())
        .get(`/chat/threads/${thread.id}/messages?page=1&limit=2&before=${latest.olderCursor}`)
        .set('authorization', owner.bearer)
        .expect(200)).body,
    );
    expect(older.messages.map((m) => m.content)).toEqual(['메시지-2', '메시지-3']);
    expect(older.hasOlder).toBe(true);
    expect(older.hasNewer).toBe(true);

    const around = ListMessagesPageResponseSchema.parse(
      (await request(app.getHttpServer())
        .get(`/chat/threads/${thread.id}/messages?page=1&limit=3&around=${inserted[2]!.id}`)
        .set('authorization', owner.bearer)
        .expect(200)).body,
    );
    expect(around.anchorMessageId).toBe(inserted[2]!.id);
    expect(around.messages.map((m) => m.content)).toEqual(['메시지-2', '메시지-3', '메시지-4']);
  });

  it('searches messages inside a readable thread only', async () => {
    const owner = await makeUser('search-owner');
    const outsider = await makeUser('search-outsider');
    const { thread } = await makeThread(owner, 'search');
    const base = Date.now() - 10_000;
    const inserted = await db.insert(schema.chatMessages).values([
      {
        workspaceId: owner.personalWorkspaceId,
        threadId: thread.id,
        role: 'user',
        authorUserId: owner.userId,
        content: '창원 버스 데이터 품질 질문',
        finishState: 'complete',
        createdAt: new Date(base),
        updatedAt: new Date(base),
      },
      {
        workspaceId: owner.personalWorkspaceId,
        threadId: thread.id,
        role: 'assistant',
        authorUserId: null,
        content: '검색 대상이 아닌 답변',
        finishState: 'complete',
        createdAt: new Date(base + 1000),
        updatedAt: new Date(base + 1000),
      },
    ]).returning({ id: schema.chatMessages.id });
    const [attachment] = await db.insert(schema.fileAttachments).values({
      workspaceId: owner.personalWorkspaceId,
      threadId: thread.id,
      messageId: inserted[0]!.id,
      uploaderUserId: owner.userId,
      fileName: '버스-원문.txt',
      mimeType: 'text/plain',
      sizeBytes: 32,
      dataBase64: Buffer.from('버스 승하차 원문').toString('base64'),
      createdAt: new Date(base + 2000),
      updatedAt: new Date(base + 2000),
    }).returning({ id: schema.fileAttachments.id });
    await db.insert(schema.documentExtractions).values({
      workspaceId: owner.personalWorkspaceId,
      threadId: thread.id,
      attachmentId: attachment!.id,
      status: 'indexed',
      extractor: 'text/plain',
      textContent: '창원 버스 승하차 데이터 원문',
      textChars: 16,
      qualityScore: 90,
      warnings: [],
      createdAt: new Date(base + 2000),
      updatedAt: new Date(base + 2000),
    });
    await db.insert(schema.evidenceItems).values({
      workspaceId: owner.personalWorkspaceId,
      threadId: thread.id,
      messageId: inserted[1]!.id,
      runId: 'run_search',
      sourceType: 'web',
      ref: '버스 통계 출처',
      excerpt: '창원 버스 이용량 근거',
      url: 'https://example.com/bus',
      qualitySignals: [],
      createdAt: new Date(base + 3000),
      updatedAt: new Date(base + 3000),
    });

    const found = SearchMessagesResponseSchema.parse(
      (await request(app.getHttpServer())
        .get(`/chat/threads/${thread.id}/messages/search?q=${encodeURIComponent('버스')}&limit=5`)
        .set('authorization', owner.bearer)
        .expect(200)).body,
    );
    expect(found.results).toHaveLength(1);
    expect(found.messages).toHaveLength(1);
    expect(found.files).toHaveLength(1);
    expect(found.evidence).toHaveLength(1);
    expect(found.results[0]!.snippet).toContain('버스');
    expect(found.files[0]!.fileName).toContain('버스');
    expect(found.files[0]!.messageId).toBe(inserted[0]!.id);
    expect(found.evidence[0]!.ref).toContain('버스');
    expect(found.evidence[0]!.messageId).toBe(inserted[1]!.id);

    await request(app.getHttpServer())
      .get(`/chat/threads/${thread.id}/messages/search?q=버스`)
      .set('authorization', outsider.bearer)
      .expect(404);
  });

  it('renames and soft-deletes space nodes with membership enforcement', async () => {
    const owner = await makeUser('mutate-owner');
    const outsider = await makeUser('mutate-outsider');
    const stamp = Date.now();

    const project = CreateProjectResponseSchema.parse(
      (await request(app.getHttpServer()).post('/spaces/projects').set('authorization', owner.bearer)
        .send({ workspaceId: owner.personalWorkspaceId, name: '원래이름', slug: `m-${stamp}` }).expect(201)).body,
    );
    const channel = CreateChannelResponseSchema.parse(
      (await request(app.getHttpServer()).post('/spaces/channels').set('authorization', owner.bearer)
        .send({ projectId: project.id, name: '채널', slug: `mc-${stamp}` }).expect(201)).body,
    );
    const topic = CreateTopicResponseSchema.parse(
      (await request(app.getHttpServer()).post('/spaces/topics').set('authorization', owner.bearer)
        .send({ channelId: channel.id, name: '토픽', slug: `mt-${stamp}` }).expect(201)).body,
    );

    // outsider cannot rename
    await request(app.getHttpServer())
      .patch(`/spaces/projects/${project.id}`)
      .set('authorization', outsider.bearer)
      .send({ name: '해킹' })
      .expect(403);

    // owner renames
    await request(app.getHttpServer())
      .patch(`/spaces/projects/${project.id}`)
      .set('authorization', owner.bearer)
      .send({ name: '바뀐이름' })
      .expect(200);

    let tree = WorkspaceTreeResponseSchema.parse(
      (await request(app.getHttpServer()).get(`/spaces/workspaces/${owner.personalWorkspaceId}/tree`).set('authorization', owner.bearer).expect(200)).body,
    );
    expect(tree.projects.find((p) => p.id === project.id)?.name).toBe('바뀐이름');

    // soft-delete the channel → topic disappears from the tree too (cascade)
    await request(app.getHttpServer())
      .delete(`/spaces/channels/${channel.id}`)
      .set('authorization', owner.bearer)
      .expect(200);
    tree = WorkspaceTreeResponseSchema.parse(
      (await request(app.getHttpServer()).get(`/spaces/workspaces/${owner.personalWorkspaceId}/tree`).set('authorization', owner.bearer).expect(200)).body,
    );
    const projNode = tree.projects.find((p) => p.id === project.id);
    expect(projNode?.channels.some((c) => c.id === channel.id)).toBe(false);

    // Archived descendants stay restorable/referenceable through the archive
    // endpoint, but active routes hide the archived ancestor chain.
    await request(app.getHttpServer())
      .get(`/spaces/topics/${topic.id}/threads`)
      .set('authorization', owner.bearer)
      .expect(404);
  });

  it('lists workspace members with the strongest role', async () => {
    const owner = await makeUser('member-owner');
    const members = ListMembersResponseSchema.parse(
      (await request(app.getHttpServer()).get(`/spaces/workspaces/${owner.personalWorkspaceId}/members`).set('authorization', owner.bearer).expect(200)).body,
    );
    expect(members.members.length).toBe(1);
    expect(members.members[0]!.userId).toBe(owner.userId);
    expect(members.members[0]!.role).toBe('owner');
    expect(members.members[0]!.email).toContain('member-owner');
  });

  it('rotates refresh tokens: new pair works, old refresh token dies (N-3)', async () => {
    const email = `rotate-${Date.now()}@example.com`;
    const password = 'supersecret1';
    const signup = SignUpBootstrapResponseSchema.parse(
      (await request(app.getHttpServer()).post('/auth/signup').send({ email, password, displayName: '회전' }).expect(201)).body,
    );
    createdUsers.push(signup.userId);
    createdWorkspaces.push(signup.personalWorkspaceId);
    const first = AuthSessionResponseSchema.parse(
      (await request(app.getHttpServer()).post('/auth/login').send({ email, password }).expect(200)).body,
    );

    // rotate
    const second = AuthSessionResponseSchema.parse(
      (await request(app.getHttpServer()).post('/auth/refresh').send({ refreshToken: first.tokens.refreshToken }).expect(200)).body,
    );
    expect(second.tokens.accessToken).toBeTruthy();
    expect(second.tokens.refreshToken).not.toBe(first.tokens.refreshToken);

    // new access token authenticates
    await request(app.getHttpServer())
      .get('/spaces/workspaces')
      .set('authorization', `Bearer ${second.tokens.accessToken}`)
      .expect(200);

    // the OLD refresh token is dead (rotation revoked it)
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: first.tokens.refreshToken })
      .expect(401);

    // garbage refresh token → 401
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: 'garbage.token.value' })
      .expect(401);
  });
});
