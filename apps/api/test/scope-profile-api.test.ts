import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { inArray } from 'drizzle-orm';
import { schema } from '@consulting/db-schema';
import {
  AuthSessionResponseSchema,
  CreateChannelResponseSchema,
  CreateProjectResponseSchema,
  CreateTopicResponseSchema,
  ScopeProfileResponseSchema,
  SignUpBootstrapResponseSchema,
} from '@consulting/contracts';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module.js';

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

let app: INestApplication;
let pool: Pool;
let db: NodePgDatabase<typeof schema>;
const users: string[] = [];
const workspaces: string[] = [];

async function signupAndLogin(label: string) {
  const email = `scope-profile-api-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
  const password = 'supersecret1';
  const signup = SignUpBootstrapResponseSchema.parse(
    (await request(app.getHttpServer()).post('/auth/signup').send({ email, password, displayName: label }).expect(201)).body,
  );
  users.push(signup.userId);
  workspaces.push(signup.personalWorkspaceId);
  const session = AuthSessionResponseSchema.parse(
    (await request(app.getHttpServer()).post('/auth/login').send({ email, password }).expect(200)).body,
  );
  return { ...signup, bearer: `Bearer ${session.tokens.accessToken}` };
}

d('scope profile API', () => {
  beforeAll(async () => {
    process.env.APP_ENV = 'test';
    process.env.APP_PUBLIC_URL = 'http://localhost:5173';
    process.env.REDIS_URL = 'redis://127.0.0.1:6380';
    process.env.JWT_ACCESS_SECRET = 'x'.repeat(16);
    process.env.JWT_REFRESH_SECRET = 'y'.repeat(16);
    process.env.HERMES_API_BASE_URL = 'http://127.0.0.1:8000';
    process.env.HERMES_API_KEY = 'test-key';
    process.env.CONSULTING_DEFAULT_TEMPLATE_ENABLED = 'false';
    pool = new Pool({ connectionString: url });
    db = drizzle(pool, { schema });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (workspaces.length) await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, workspaces));
    if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
    await app?.close();
    await pool.end();
  });

  it('reads null profiles and updates channel/topic profiles through separate strict endpoints', async () => {
    const owner = await signupAndLogin('owner');
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1e4)}`;
    const project = CreateProjectResponseSchema.parse(
      (await request(app.getHttpServer()).post('/spaces/projects').set('authorization', owner.bearer)
        .send({ workspaceId: owner.personalWorkspaceId, name: 'Profile API Project', slug: `profile-api-p-${suffix}` }).expect(201)).body,
    );
    const channel = CreateChannelResponseSchema.parse(
      (await request(app.getHttpServer()).post('/spaces/channels').set('authorization', owner.bearer)
        .send({ projectId: project.id, name: 'Profile API Channel', slug: `profile-api-c-${suffix}` }).expect(201)).body,
    );
    const topic = CreateTopicResponseSchema.parse(
      (await request(app.getHttpServer()).post('/spaces/topics').set('authorization', owner.bearer)
        .send({ channelId: channel.id, name: 'Profile API Topic', slug: `profile-api-t-${suffix}` }).expect(201)).body,
    );

    const empty = ScopeProfileResponseSchema.parse(
      (await request(app.getHttpServer()).get(`/spaces/channels/${channel.id}/profile`).set('authorization', owner.bearer).expect(200)).body,
    );
    expect(empty.profile).toBeNull();

    const updated = ScopeProfileResponseSchema.parse(
      (await request(app.getHttpServer()).patch(`/spaces/topics/${topic.id}/profile`).set('authorization', owner.bearer)
        .send({ purpose: 'API에서 수정한 목적', rules: '숫자는 재계산한다.' }).expect(200)).body,
    );
    expect(updated.profile).toEqual(expect.objectContaining({
      scopeType: 'topic',
      scopeId: topic.id,
      source: 'manual',
      purpose: 'API에서 수정한 목적',
      rules: '숫자는 재계산한다.',
    }));
  });
});
