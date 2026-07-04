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
  ChatStreamEventSchema,
  CreateProjectResponseSchema,
  CreateChannelResponseSchema,
  CreateTopicResponseSchema,
  CreateThreadResponseSchema,
  AuthSessionResponseSchema,
  AcceptInvitationResponseSchema,
  CreateInvitationResponseSchema,
  InvitationPreviewResponseSchema,
  SignUpBootstrapResponseSchema,
} from '@consulting/contracts';
import { AppModule } from '../src/app.module.js';

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

let app: INestApplication;
let pool: Pool;
let db: NodePgDatabase<typeof schema>;
const createdUsers: string[] = [];
const createdWorkspaces: string[] = [];

function sseEvents(text: string): unknown[] {
  return text
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const dataLine = chunk.split('\n').find((line) => line.startsWith('data: '));
      if (!dataLine) throw new Error(`missing data line in ${chunk}`);
      return JSON.parse(dataLine.slice('data: '.length));
    });
}

function installHermesRunsFetchMock(finalText = 'proxied hello') {
  const calls: string[] = [];
  const body = [
    'data: {"event":"message.delta","run_id":"run_test_proxy","delta":"proxied "}',
    '',
    `data: {"event":"run.completed","run_id":"run_test_proxy","output":"${finalText}"}`,
    '',
    ': stream closed',
    '',
  ].join('\n');
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    if (url.endsWith('/v1/runs')) {
      const parsed = JSON.parse(String(init?.body ?? '{}')) as { input?: string; session_id?: string };
      expect(parsed.input).toBeTruthy();
      expect(parsed.session_id).toBeTruthy();
      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers?.authorization).toMatch(/^Bearer\s+.+/);
      return new Response(JSON.stringify({ run_id: 'run_test_proxy', status: 'started' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/v1/runs/run_test_proxy/events')) {
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

d('HTTP API contract adapters', () => {
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

  it('POST /auth/signup returns strict bootstrap response without password/token secrets', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/signup')
      .send({ email: `http-${Date.now()}@example.com`, password: 'supersecret1', displayName: 'HTTP User' })
      .expect(201);

    const parsed = SignUpBootstrapResponseSchema.parse(res.body);
    createdUsers.push(parsed.userId);
    createdWorkspaces.push(parsed.personalWorkspaceId);
    expect(JSON.stringify(res.body)).not.toContain('password');
    expect(JSON.stringify(res.body)).not.toContain('token');
  });

  it('POST /auth/login returns public user plus intended JWT envelope', async () => {
    const email = `login-http-${Date.now()}@example.com`;
    const password = 'supersecret1';
    const signedUp = await request(app.getHttpServer())
      .post('/auth/signup')
      .send({ email, password, displayName: 'Login User' })
      .expect(201);
    const signedUpBody = SignUpBootstrapResponseSchema.parse(signedUp.body);
    createdUsers.push(signedUpBody.userId);
    createdWorkspaces.push(signedUpBody.personalWorkspaceId);

    const loggedIn = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);

    const parsed = AuthSessionResponseSchema.parse(loggedIn.body);
    expect(parsed.user.id).toBe(signedUpBody.userId);
    expect(parsed.user.email).toBe(email);
    expect(parsed.tokens.accessToken).toBeTruthy();
    expect(parsed.tokens.refreshToken).toBeTruthy();
    expect(JSON.stringify(loggedIn.body)).not.toContain('password');
    expect(JSON.stringify(loggedIn.body)).not.toContain('jwtSecret');

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'wrong-password' })
      .expect(401);
  });

  it('invitation create/preview/accept endpoints use strict public response shapes', async () => {
    const ownerEmail = `owner-http-${Date.now()}@example.com`;
    const guestEmail = `guest-http-${Date.now()}@example.com`;
    const owner = await request(app.getHttpServer())
      .post('/auth/signup')
      .send({ email: ownerEmail, password: 'supersecret1', displayName: 'Owner' })
      .expect(201);
    const guest = await request(app.getHttpServer())
      .post('/auth/signup')
      .send({ email: guestEmail, password: 'supersecret1', displayName: 'Guest' })
      .expect(201);
    const ownerBody = SignUpBootstrapResponseSchema.parse(owner.body);
    const guestBody = SignUpBootstrapResponseSchema.parse(guest.body);
    createdUsers.push(ownerBody.userId, guestBody.userId);
    createdWorkspaces.push(ownerBody.personalWorkspaceId, guestBody.personalWorkspaceId);

    const created = await request(app.getHttpServer())
      .post('/invitations')
      .send({
        workspaceId: ownerBody.personalWorkspaceId,
        invitedByUserId: ownerBody.userId,
        scopeType: 'workspace',
        scopeId: ownerBody.personalWorkspaceId,
        role: 'viewer',
      })
      .expect(201);
    const createBody = CreateInvitationResponseSchema.parse(created.body);
    expect(createBody.token).toBeTruthy();
    expect(JSON.stringify(created.body)).not.toContain('tokenHash');

    const preview = await request(app.getHttpServer())
      .post('/invitations/preview')
      .send({ token: createBody.token })
      .expect(200);
    const previewBody = InvitationPreviewResponseSchema.parse(preview.body);
    expect(previewBody.workspaceId).toBe(ownerBody.personalWorkspaceId);
    expect(JSON.stringify(preview.body)).not.toContain(createBody.token);
    expect(JSON.stringify(preview.body)).not.toContain('tokenHash');

    const guestLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: guestEmail, password: 'supersecret1' })
      .expect(200);
    const guestSession = AuthSessionResponseSchema.parse(guestLogin.body);

    await request(app.getHttpServer())
      .post('/invitations/accept')
      .send({ token: createBody.token })
      .expect(401);

    await request(app.getHttpServer())
      .post('/invitations/accept')
      .set('authorization', `Bearer ${guestSession.tokens.accessToken}`)
      .send({ token: createBody.token, userId: ownerBody.userId })
      .expect(400);

    const accepted = await request(app.getHttpServer())
      .post('/invitations/accept')
      .set('authorization', `Bearer ${guestSession.tokens.accessToken}`)
      .send({ token: createBody.token })
      .expect(201);
    const acceptedBody = AcceptInvitationResponseSchema.parse(accepted.body);
    expect(acceptedBody.membershipId).toBeTruthy();

    const memberships = await db
      .select()
      .from(schema.memberships)
      .where(eq(schema.memberships.userId, guestBody.userId));
    expect(memberships.some((m) => m.workspaceId === ownerBody.personalWorkspaceId)).toBe(true);
  });

  it('protected chat stream requires bearer access and proxies readable threads through Hermes runs SSE', async () => {
    const { calls } = installHermesRunsFetchMock('proxied hello');
    const email = `chat-owner-${Date.now()}@example.com`;
    const password = 'supersecret1';
    const signedUp = await request(app.getHttpServer())
      .post('/auth/signup')
      .send({ email, password, displayName: 'Chat Owner' })
      .expect(201);
    const ownerBody = SignUpBootstrapResponseSchema.parse(signedUp.body);
    createdUsers.push(ownerBody.userId);
    createdWorkspaces.push(ownerBody.personalWorkspaceId);

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    const session = AuthSessionResponseSchema.parse(login.body);

    const [project] = await db.insert(schema.projects).values({
      workspaceId: ownerBody.personalWorkspaceId,
      name: 'Chat Project',
      slug: `chat-project-${Date.now()}`,
    }).returning({ id: schema.projects.id });
    const [channel] = await db.insert(schema.channels).values({
      workspaceId: ownerBody.personalWorkspaceId,
      projectId: project!.id,
      name: 'Chat Channel',
      slug: `chat-channel-${Date.now()}`,
    }).returning({ id: schema.channels.id });
    const [topic] = await db.insert(schema.topics).values({
      workspaceId: ownerBody.personalWorkspaceId,
      channelId: channel!.id,
      name: 'Chat Topic',
      slug: `chat-topic-${Date.now()}`,
    }).returning({ id: schema.topics.id });
    const [thread] = await db.insert(schema.threads).values({
      workspaceId: ownerBody.personalWorkspaceId,
      topicId: topic!.id,
      title: 'Chat Thread',
    }).returning({ id: schema.threads.id });

    await request(app.getHttpServer())
      .post('/chat/stream')
      .send({ threadId: thread!.id, message: 'hello' })
      .expect(401);

    const outsiderEmail = `chat-outsider-${Date.now()}@example.com`;
    const outsider = await request(app.getHttpServer())
      .post('/auth/signup')
      .send({ email: outsiderEmail, password, displayName: 'Outsider' })
      .expect(201);
    const outsiderBody = SignUpBootstrapResponseSchema.parse(outsider.body);
    createdUsers.push(outsiderBody.userId);
    createdWorkspaces.push(outsiderBody.personalWorkspaceId);
    const outsiderLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: outsiderEmail, password })
      .expect(200);
    const outsiderSession = AuthSessionResponseSchema.parse(outsiderLogin.body);

    await request(app.getHttpServer())
      .post('/chat/stream')
      .set('authorization', `Bearer ${outsiderSession.tokens.accessToken}`)
      .send({ threadId: thread!.id, message: 'hello' })
      .expect(403);

    const response = await request(app.getHttpServer())
      .post('/chat/stream')
      .set('authorization', `Bearer ${session.tokens.accessToken}`)
      .send({ threadId: thread!.id, message: 'hello' })
      .expect(200)
      .expect('content-type', /text\/event-stream/);

    const events = sseEvents(response.text);
    expect(events.map((e) => (e as { type: string }).type)).toEqual(['start', 'delta', 'done']);
    expect((events[0] as { runId: string }).runId).toBe('run_test_proxy');
    expect((events[1] as { text: string }).text).toBe('proxied ');
    const hermesBase = (process.env.HERMES_API_BASE_URL ?? 'http://127.0.0.1:8642').replace(/\/$/, '');
    expect(calls).toEqual([
      `${hermesBase}/v1/runs`,
      `${hermesBase}/v1/runs/run_test_proxy/events`,
    ]);
    for (const event of events) {
      expect(ChatStreamEventSchema.parse(event)).toEqual(event);
      expect(JSON.stringify(event)).not.toContain('HERMES_API_KEY');
      expect(JSON.stringify(event)).not.toContain('jwtSecret');
      expect(JSON.stringify(event)).not.toContain('test-hermes-key');
    }
  });

  it('protected space creation endpoints create a thread that can be streamed', async () => {
    installHermesRunsFetchMock('thread api smoke');
    const email = `space-owner-${Date.now()}@example.com`;
    const outsiderEmail = `space-outsider-${Date.now()}@example.com`;
    const password = 'supersecret1';
    const ownerSignup = await request(app.getHttpServer())
      .post('/auth/signup')
      .send({ email, password, displayName: 'Space Owner' })
      .expect(201);
    const ownerBody = SignUpBootstrapResponseSchema.parse(ownerSignup.body);
    createdUsers.push(ownerBody.userId);
    createdWorkspaces.push(ownerBody.personalWorkspaceId);

    const ownerLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    const ownerSession = AuthSessionResponseSchema.parse(ownerLogin.body);

    await request(app.getHttpServer())
      .post('/spaces/projects')
      .send({ workspaceId: ownerBody.personalWorkspaceId, name: 'No Auth Project', slug: `no-auth-${Date.now()}` })
      .expect(401);

    const outsiderSignup = await request(app.getHttpServer())
      .post('/auth/signup')
      .send({ email: outsiderEmail, password, displayName: 'Space Outsider' })
      .expect(201);
    const outsiderBody = SignUpBootstrapResponseSchema.parse(outsiderSignup.body);
    createdUsers.push(outsiderBody.userId);
    createdWorkspaces.push(outsiderBody.personalWorkspaceId);
    const outsiderLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: outsiderEmail, password })
      .expect(200);
    const outsiderSession = AuthSessionResponseSchema.parse(outsiderLogin.body);

    await request(app.getHttpServer())
      .post('/spaces/projects')
      .set('authorization', `Bearer ${outsiderSession.tokens.accessToken}`)
      .send({ workspaceId: ownerBody.personalWorkspaceId, name: 'Foreign Project', slug: `foreign-${Date.now()}` })
      .expect(403);

    const project = await request(app.getHttpServer())
      .post('/spaces/projects')
      .set('authorization', `Bearer ${ownerSession.tokens.accessToken}`)
      .send({ workspaceId: ownerBody.personalWorkspaceId, name: 'HTTP Project', slug: `http-project-${Date.now()}` })
      .expect(201);
    const projectBody = CreateProjectResponseSchema.parse(project.body);

    const channel = await request(app.getHttpServer())
      .post('/spaces/channels')
      .set('authorization', `Bearer ${ownerSession.tokens.accessToken}`)
      .send({ projectId: projectBody.id, name: 'HTTP Channel', slug: `http-channel-${Date.now()}` })
      .expect(201);
    const channelBody = CreateChannelResponseSchema.parse(channel.body);

    const topic = await request(app.getHttpServer())
      .post('/spaces/topics')
      .set('authorization', `Bearer ${ownerSession.tokens.accessToken}`)
      .send({ channelId: channelBody.id, name: 'HTTP Topic', slug: `http-topic-${Date.now()}` })
      .expect(201);
    const topicBody = CreateTopicResponseSchema.parse(topic.body);

    const thread = await request(app.getHttpServer())
      .post('/spaces/threads')
      .set('authorization', `Bearer ${ownerSession.tokens.accessToken}`)
      .send({ topicId: topicBody.id, title: 'HTTP Thread' })
      .expect(201);
    const threadBody = CreateThreadResponseSchema.parse(thread.body);

    const stream = await request(app.getHttpServer())
      .post('/chat/stream')
      .set('authorization', `Bearer ${ownerSession.tokens.accessToken}`)
      .send({ threadId: threadBody.id, message: 'thread api smoke' })
      .expect(200)
      .expect('content-type', /text\/event-stream/);
    const events = sseEvents(stream.text);
    expect(events.map((e) => (e as { type: string }).type)).toEqual(['start', 'delta', 'done']);
  });
});
