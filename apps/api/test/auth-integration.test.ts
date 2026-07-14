import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { schema } from '@consulting/db-schema';
import { eq, inArray } from 'drizzle-orm';
import { Pool } from 'pg';
import { SignUpUseCase } from '../src/auth/sign-up.usecase.js';
import { InvitationUseCase } from '../src/organization/invitation.usecase.js';
import { ScryptPasswordHasher } from '../src/auth/password.js';
import { AuthSessionUseCase } from '../src/auth/auth-session.usecase.js';

/**
 * Integration tests against the real dev DB (5434). Requires:
 *   docker compose -f docker-compose.local.yml up -d  &&  migrate
 * Skipped automatically if DATABASE_URL is not set.
 */
const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

let pool: Pool;
let db: NodePgDatabase<typeof schema>;
const createdUsers: string[] = [];
const createdWorkspaces: string[] = [];

d('auth + invitation integration (ADR-0001/0009)', () => {
  beforeAll(() => {
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
  });

  it('sign-up creates user + personal workspace + owner membership + events', async () => {
    const uc = new SignUpUseCase(db, new ScryptPasswordHasher());
    const email = `t-${Date.now()}@example.com`;
    const r = await uc.execute({ email, password: 'supersecret1', displayName: 'Tester' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    createdUsers.push(r.value.userId);
    createdWorkspaces.push(r.value.personalWorkspaceId);

    const ms = await db
      .select()
      .from(schema.memberships)
      .where(eq(schema.memberships.userId, r.value.userId));
    expect(ms).toHaveLength(1);
    expect(ms[0]?.role).toBe('owner');

    const outbox = await db
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.workspaceId, r.value.personalWorkspaceId));
    expect(outbox.some((o) => o.eventType === 'WorkspaceCreated')).toBe(true);

    const audit = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.workspaceId, r.value.personalWorkspaceId));
    expect(audit.some((a) => a.action === 'user.signup')).toBe(true);
  });

  it('rejects duplicate email', async () => {
    const uc = new SignUpUseCase(db, new ScryptPasswordHasher());
    const email = `dup-${Date.now()}@example.com`;
    const a = await uc.execute({ email, password: 'supersecret1', displayName: 'A' });
    expect(a.ok).toBe(true);
    if (a.ok) {
      createdUsers.push(a.value.userId);
      createdWorkspaces.push(a.value.personalWorkspaceId);
    }
    const b = await uc.execute({ email, password: 'supersecret1', displayName: 'B' });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.error.code).toBe('CONFLICT');
  });

  it('concurrent sign-up with the same email returns CONFLICT, not INTERNAL (double-submit)', async () => {
    const uc = new SignUpUseCase(db, new ScryptPasswordHasher());
    const email = `race-${Date.now()}@example.com`;
    const [a, b] = await Promise.all([
      uc.execute({ email, password: 'supersecret1', displayName: 'A' }),
      uc.execute({ email, password: 'supersecret1', displayName: 'B' }),
    ]);
    for (const r of [a, b]) {
      if (r.ok) {
        createdUsers.push(r.value.userId);
        createdWorkspaces.push(r.value.personalWorkspaceId);
      }
    }
    const okCount = [a, b].filter((r) => r.ok).length;
    expect(okCount).toBe(1);
    const loser = [a, b].find((r) => !r.ok);
    // the concurrent loser must be a clean CONFLICT (409), never INTERNAL (500)
    expect(loser && !loser.ok && loser.error.code).toBe('CONFLICT');
  });

  it('allows exactly one successor when the same refresh token is rotated concurrently', async () => {
    const hasher = new ScryptPasswordHasher();
    const signup = new SignUpUseCase(db, hasher);
    const email = `refresh-race-${crypto.randomUUID()}@example.com`;
    const created = await signup.execute({ email, password: 'supersecret1', displayName: 'Refresh Race' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    createdUsers.push(created.value.userId);
    createdWorkspaces.push(created.value.personalWorkspaceId);

    const auth = new AuthSessionUseCase(db, {
      JWT_ACCESS_SECRET: 'access-secret-for-refresh-race',
      JWT_REFRESH_SECRET: 'refresh-secret-for-refresh-race',
    } as any, hasher);
    const login = await auth.login({ email, password: 'supersecret1' });
    expect(login.ok).toBe(true);
    if (!login.ok) return;

    await pool.query(`
      CREATE OR REPLACE FUNCTION test_auth_refresh_delete_delay() RETURNS trigger AS $$
      BEGIN
        PERFORM pg_sleep(0.15);
        RETURN OLD;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS test_auth_refresh_delete_delay ON sessions;
      CREATE TRIGGER test_auth_refresh_delete_delay
        BEFORE DELETE ON sessions
        FOR EACH ROW EXECUTE FUNCTION test_auth_refresh_delete_delay();
    `);
    let first: Awaited<ReturnType<AuthSessionUseCase['refresh']>>;
    let second: Awaited<ReturnType<AuthSessionUseCase['refresh']>>;
    try {
      [first, second] = await Promise.all([
        auth.refresh(login.value.tokens.refreshToken),
        auth.refresh(login.value.tokens.refreshToken),
      ]);
    } finally {
      await pool.query(`
        DROP TRIGGER IF EXISTS test_auth_refresh_delete_delay ON sessions;
        DROP FUNCTION IF EXISTS test_auth_refresh_delete_delay();
      `);
    }
    expect([first, second].filter((result) => result.ok)).toHaveLength(1);
    const loser = [first, second].find((result) => !result.ok);
    expect(loser && !loser.ok && loser.error.code).toBe('UNAUTHENTICATED');

    const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.userId, created.value.userId));
    expect(sessions).toHaveLength(1);
  });

  it('explicit logout revokes only the presented refresh session', async () => {
    const hasher = new ScryptPasswordHasher();
    const signup = new SignUpUseCase(db, hasher);
    const email = `logout-${crypto.randomUUID()}@example.com`;
    const created = await signup.execute({ email, password: 'supersecret1', displayName: 'Logout Test' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    createdUsers.push(created.value.userId);
    createdWorkspaces.push(created.value.personalWorkspaceId);

    const auth = new AuthSessionUseCase(db, {
      JWT_ACCESS_SECRET: 'access-secret-for-logout-test',
      JWT_REFRESH_SECRET: 'refresh-secret-for-logout-test',
    } as any, hasher);
    const first = await auth.login({ email, password: 'supersecret1' });
    const sibling = await auth.login({ email, password: 'supersecret1' });
    expect(first.ok && sibling.ok).toBe(true);
    if (!first.ok || !sibling.ok) return;

    const revoked = await auth.logout(first.value.tokens.refreshToken);
    expect(revoked).toEqual({ revoked: true });
    expect(await auth.logout(first.value.tokens.refreshToken)).toEqual({ revoked: false });

    const replay = await auth.refresh(first.value.tokens.refreshToken);
    expect(replay.ok).toBe(false);
    const siblingRefresh = await auth.refresh(sibling.value.tokens.refreshToken);
    expect(siblingRefresh.ok).toBe(true);
  });

  it('invitation: create → accept creates membership; reuse rejected', async () => {
    const signup = new SignUpUseCase(db, new ScryptPasswordHasher());
    const inviter = await signup.execute({
      email: `owner-${Date.now()}@example.com`,
      password: 'supersecret1',
      displayName: 'Owner',
    });
    const invitee = await signup.execute({
      email: `guest-${Date.now()}@example.com`,
      password: 'supersecret1',
      displayName: 'Guest',
    });
    expect(inviter.ok && invitee.ok).toBe(true);
    if (!inviter.ok || !invitee.ok) return;
    createdUsers.push(inviter.value.userId, invitee.value.userId);
    createdWorkspaces.push(inviter.value.personalWorkspaceId, invitee.value.personalWorkspaceId);

    const inv = new InvitationUseCase(db);
    const created = await inv.create({
      workspaceId: inviter.value.personalWorkspaceId,
      invitedByUserId: inviter.value.userId,
      email: 'guest@example.com',
      scopeType: 'workspace',
      scopeId: inviter.value.personalWorkspaceId,
      role: 'editor',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const accepted = await inv.accept({ token: created.value.token, userId: invitee.value.userId });
    expect(accepted.ok).toBe(true);

    // reuse must fail
    const reuse = await inv.accept({ token: created.value.token, userId: invitee.value.userId });
    expect(reuse.ok).toBe(false);
    if (!reuse.ok) expect(reuse.error.code).toBe('NOT_FOUND');
  });
});
