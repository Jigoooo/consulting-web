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
  ListMessagesResponseSchema,
  ThreadDetailResponseSchema,
  ListMembersResponseSchema,
  WorkspaceTreeResponseSchema,
} from '@consulting/contracts';
import { AppModule } from '../src/app.module.js';

const url = process.env.DATABASE_URL;
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
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const u = input instanceof Request ? input.url : String(input);
    if (u.endsWith('/v1/runs')) {
      return new Response(JSON.stringify({ run_id: 'run_persist', status: 'started' }), {
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

    await request(app.getHttpServer())
      .post('/chat/stream')
      .set('authorization', owner.bearer)
      .send({ threadId: thread.id, message: '영속화 테스트 질문' })
      .expect(200);

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
    expect(listed.messages[1]!.runId).toBe('run_persist');
    expect(listed.messages[1]!.finishState).toBe('complete');

    // outsider cannot read the transcript
    const outsider = await makeUser('persist-outsider');
    await request(app.getHttpServer())
      .get(`/chat/threads/${thread.id}/messages`)
      .set('authorization', outsider.bearer)
      .expect(403);

    // thread detail (N-6)
    const detail = ThreadDetailResponseSchema.parse(
      (await request(app.getHttpServer()).get(`/spaces/threads/${thread.id}`).set('authorization', owner.bearer).expect(200)).body,
    );
    expect(detail.title).toBe('영속 스레드');
    expect(detail.topicId).toBe(topic.id);
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

    // deleted topic's threads endpoint → 404 (topic soft-deleted via cascade)
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
