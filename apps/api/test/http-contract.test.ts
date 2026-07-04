import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, inArray } from 'drizzle-orm';
import { Pool } from 'pg';
import { schema } from '@consulting/db-schema';
import {
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

  it('invitation create/preview/accept endpoints use strict public response shapes', async () => {
    const owner = await request(app.getHttpServer())
      .post('/auth/signup')
      .send({ email: `owner-http-${Date.now()}@example.com`, password: 'supersecret1', displayName: 'Owner' })
      .expect(201);
    const guest = await request(app.getHttpServer())
      .post('/auth/signup')
      .send({ email: `guest-http-${Date.now()}@example.com`, password: 'supersecret1', displayName: 'Guest' })
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

    const accepted = await request(app.getHttpServer())
      .post('/invitations/accept')
      .send({ token: createBody.token, userId: guestBody.userId })
      .expect(201);
    const acceptedBody = AcceptInvitationResponseSchema.parse(accepted.body);
    expect(acceptedBody.membershipId).toBeTruthy();

    const memberships = await db
      .select()
      .from(schema.memberships)
      .where(eq(schema.memberships.userId, guestBody.userId));
    expect(memberships.some((m) => m.workspaceId === ownerBody.personalWorkspaceId)).toBe(true);
  });
});
