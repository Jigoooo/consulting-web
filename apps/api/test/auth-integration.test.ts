import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { schema } from '@consulting/db-schema';
import { eq, inArray } from 'drizzle-orm';
import { Pool } from 'pg';
import { SignUpUseCase } from '../src/auth/sign-up.usecase.js';
import { InvitationUseCase } from '../src/organization/invitation.usecase.js';
import { ScryptPasswordHasher } from '../src/auth/password.js';

/**
 * Integration tests against the real dev DB (5434). Requires:
 *   docker compose -f docker-compose.local.yml up -d  &&  migrate
 * Skipped automatically if DATABASE_URL is not set.
 */
const url = process.env.DATABASE_URL;
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
