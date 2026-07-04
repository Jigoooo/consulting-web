import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { schema } from '@consulting/db-schema';
import { eq, inArray } from 'drizzle-orm';
import { Pool } from 'pg';
import { SignUpUseCase } from '../src/auth/sign-up.usecase.js';
import { ScryptPasswordHasher } from '../src/auth/password.js';
import { InvitationUseCase } from '../src/organization/invitation.usecase.js';
import { CreateProjectUseCase } from '../src/spaces/create-project.usecase.js';
import { CreateChannelUseCase } from '../src/spaces/create-channel.usecase.js';
import { ScopeRepository } from '../src/spaces/scope.repository.js';
import { MatrixPolicyEngine } from '../src/permissions/matrix-policy-engine.js';
import { hashToken } from '../src/auth/password.js';

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

let pool: Pool;
let db: NodePgDatabase<typeof schema>;
const users: string[] = [];
const workspaces: string[] = [];

/** Negative security tests (plan §Task 30). Dangerous requests MUST be blocked. */
d('Foundation negative security', () => {
  beforeAll(() => {
    pool = new Pool({ connectionString: url });
    db = drizzle(pool, { schema });
  });

  afterAll(async () => {
    if (workspaces.length) {
      await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, workspaces));
    }
    if (users.length) {
      await db.delete(schema.users).where(inArray(schema.users.id, users));
    }
    await pool.end();
  });

  it('viewer is denied channel.create by the policy engine', () => {
    const engine = new MatrixPolicyEngine();
    const r = engine.evaluate({
      permission: 'channel.create',
      scopeChain: [{ scopeType: 'workspace', scopeId: 'ws' }],
      memberships: [{ scopeType: 'workspace', scopeId: 'ws', role: 'viewer' }],
      overrides: [],
      systemRole: 'user',
    });
    expect(r.allowed).toBe(false);
  });

  it('a non-member has no grant on another workspace scope', () => {
    const engine = new MatrixPolicyEngine();
    const r = engine.evaluate({
      permission: 'message.read',
      scopeChain: [{ scopeType: 'workspace', scopeId: 'foreign-ws' }],
      memberships: [{ scopeType: 'workspace', scopeId: 'my-ws', role: 'owner' }],
      overrides: [],
      systemRole: 'user',
    });
    expect(r.allowed).toBe(false);
    expect(r.source).toBe('no_grant');
  });

  it('share-link invitation can be created without binding to an email', async () => {
    const signup = new SignUpUseCase(db, new ScryptPasswordHasher());
    const owner = await signup.execute({
      email: `link-o-${Date.now()}@example.com`,
      password: 'supersecret1',
      displayName: 'LinkOwner',
    });
    expect(owner.ok).toBe(true);
    if (!owner.ok) return;
    users.push(owner.value.userId);
    workspaces.push(owner.value.personalWorkspaceId);

    const inv = new InvitationUseCase(db);
    const created = await inv.create({
      workspaceId: owner.value.personalWorkspaceId,
      invitedByUserId: owner.value.userId,
      scopeType: 'workspace',
      scopeId: owner.value.personalWorkspaceId,
      role: 'viewer',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const stored = await db.select().from(schema.invitations);
    const row = stored.find((x) => x.id === created.value.invitationId);
    expect(row?.email).toBeNull();
    expect(JSON.stringify(row)).not.toContain(created.value.token);
  });

  it('share-link invitation can be accepted by an already signed-up user', async () => {
    const signup = new SignUpUseCase(db, new ScryptPasswordHasher());
    const owner = await signup.execute({
      email: `link-existing-o-${Date.now()}@example.com`,
      password: 'supersecret1',
      displayName: 'ExistingOwner',
    });
    const member = await signup.execute({
      email: `link-existing-m-${Date.now()}@example.com`,
      password: 'supersecret1',
      displayName: 'ExistingMember',
    });
    expect(owner.ok && member.ok).toBe(true);
    if (!owner.ok || !member.ok) return;
    users.push(owner.value.userId, member.value.userId);
    workspaces.push(owner.value.personalWorkspaceId, member.value.personalWorkspaceId);

    const inv = new InvitationUseCase(db);
    const created = await inv.create({
      workspaceId: owner.value.personalWorkspaceId,
      invitedByUserId: owner.value.userId,
      scopeType: 'workspace',
      scopeId: owner.value.personalWorkspaceId,
      role: 'editor',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const accepted = await inv.accept({ token: created.value.token, userId: member.value.userId });
    expect(accepted.ok).toBe(true);
  });

  it('share-link invitation supports non-signed-up flow: preview first, sign up, then accept', async () => {
    const signup = new SignUpUseCase(db, new ScryptPasswordHasher());
    const owner = await signup.execute({
      email: `link-new-o-${Date.now()}@example.com`,
      password: 'supersecret1',
      displayName: 'NewFlowOwner',
    });
    expect(owner.ok).toBe(true);
    if (!owner.ok) return;
    users.push(owner.value.userId);
    workspaces.push(owner.value.personalWorkspaceId);

    const inv = new InvitationUseCase(db);
    const created = await inv.create({
      workspaceId: owner.value.personalWorkspaceId,
      invitedByUserId: owner.value.userId,
      scopeType: 'workspace',
      scopeId: owner.value.personalWorkspaceId,
      role: 'commenter',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const preview = await inv.preview({ token: created.value.token });
    expect(preview.ok).toBe(true);
    if (preview.ok) {
      expect(preview.value.accepted).toBe(false);
      expect(preview.value.role).toBe('commenter');
      expect(preview.value.scopeType).toBe('workspace');
      expect(preview.value.emailHint).toBeNull();
    }

    const newcomer = await signup.execute({
      email: `link-new-m-${Date.now()}@example.com`,
      password: 'supersecret1',
      displayName: 'NewMember',
    });
    expect(newcomer.ok).toBe(true);
    if (!newcomer.ok) return;
    users.push(newcomer.value.userId);
    workspaces.push(newcomer.value.personalWorkspaceId);

    const accepted = await inv.accept({ token: created.value.token, userId: newcomer.value.userId });
    expect(accepted.ok).toBe(true);
  });

  it('invitation token cannot be reused after acceptance', async () => {
    const signup = new SignUpUseCase(db, new ScryptPasswordHasher());
    const owner = await signup.execute({
      email: `neg-o-${Date.now()}@example.com`,
      password: 'supersecret1',
      displayName: 'Owner',
    });
    const guest = await signup.execute({
      email: `neg-g-${Date.now()}@example.com`,
      password: 'supersecret1',
      displayName: 'Guest',
    });
    expect(owner.ok && guest.ok).toBe(true);
    if (!owner.ok || !guest.ok) return;
    users.push(owner.value.userId, guest.value.userId);
    workspaces.push(owner.value.personalWorkspaceId, guest.value.personalWorkspaceId);

    const inv = new InvitationUseCase(db);
    const created = await inv.create({
      workspaceId: owner.value.personalWorkspaceId,
      invitedByUserId: owner.value.userId,
      email: 'guest@example.com',
      scopeType: 'workspace',
      scopeId: owner.value.personalWorkspaceId,
      role: 'viewer',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const first = await inv.accept({ token: created.value.token, userId: guest.value.userId });
    expect(first.ok).toBe(true);
    const second = await inv.accept({ token: created.value.token, userId: guest.value.userId });
    expect(second.ok).toBe(false);
  });

  it('invitation stores only a hash, never the raw token', async () => {
    const signup = new SignUpUseCase(db, new ScryptPasswordHasher());
    const owner = await signup.execute({
      email: `neg-h-${Date.now()}@example.com`,
      password: 'supersecret1',
      displayName: 'Hasher',
    });
    expect(owner.ok).toBe(true);
    if (!owner.ok) return;
    users.push(owner.value.userId);
    workspaces.push(owner.value.personalWorkspaceId);

    const inv = new InvitationUseCase(db);
    const created = await inv.create({
      workspaceId: owner.value.personalWorkspaceId,
      invitedByUserId: owner.value.userId,
      email: 'x@example.com',
      scopeType: 'workspace',
      scopeId: owner.value.personalWorkspaceId,
      role: 'viewer',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const rows = await db.select().from(schema.invitations);
    const stored = rows.find((x) => x.id === created.value.invitationId);
    expect(stored).toBeTruthy();
    // raw token must NOT be stored anywhere; only its sha256 hash
    expect(stored?.tokenHash).toBe(hashToken(created.value.token));
    expect(stored?.tokenHash).not.toBe(created.value.token);
    expect(JSON.stringify(stored)).not.toContain(created.value.token);
  });

  it('concurrent accept of the same token yields exactly one membership (ADR-0020)', async () => {
    const signup = new SignUpUseCase(db, new ScryptPasswordHasher());
    const owner = await signup.execute({
      email: `neg-race-o-${Date.now()}@example.com`,
      password: 'supersecret1',
      displayName: 'RaceOwner',
    });
    const guest = await signup.execute({
      email: `neg-race-g-${Date.now()}@example.com`,
      password: 'supersecret1',
      displayName: 'RaceGuest',
    });
    expect(owner.ok && guest.ok).toBe(true);
    if (!owner.ok || !guest.ok) return;
    users.push(owner.value.userId, guest.value.userId);
    workspaces.push(owner.value.personalWorkspaceId, guest.value.personalWorkspaceId);

    const inv = new InvitationUseCase(db);
    const created = await inv.create({
      workspaceId: owner.value.personalWorkspaceId,
      invitedByUserId: owner.value.userId,
      email: 'race@example.com',
      scopeType: 'workspace',
      scopeId: owner.value.personalWorkspaceId,
      role: 'viewer',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // fire two accepts concurrently — exactly one must succeed
    const [a, b] = await Promise.all([
      inv.accept({ token: created.value.token, userId: guest.value.userId }),
      inv.accept({ token: created.value.token, userId: guest.value.userId }),
    ]);
    const okCount = [a, b].filter((r) => r.ok).length;
    expect(okCount).toBe(1);

    // exactly one audit row for this acceptance
    const audits = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.workspaceId, owner.value.personalWorkspaceId));
    expect(audits.filter((x) => x.action === 'invitation.accept')).toHaveLength(1);
  });

  it('duplicate channel slug within a project is rejected', async () => {
    const signup = new SignUpUseCase(db, new ScryptPasswordHasher());
    const owner = await signup.execute({
      email: `neg-d-${Date.now()}@example.com`,
      password: 'supersecret1',
      displayName: 'Dup',
    });
    expect(owner.ok).toBe(true);
    if (!owner.ok) return;
    users.push(owner.value.userId);
    workspaces.push(owner.value.personalWorkspaceId);

    const projects = new CreateProjectUseCase(db);
    const proj = await projects.execute({
      workspaceId: owner.value.personalWorkspaceId,
      actorUserId: owner.value.userId,
      name: 'P',
      slug: 'p',
    });
    expect(proj.ok).toBe(true);
    if (!proj.ok) return;

    const scopes = new ScopeRepository(db);
    const channels = new CreateChannelUseCase(db, scopes);
    const first = await channels.commit({
      projectId: proj.value.projectId,
      name: 'C',
      slug: 'c',
      actorUserId: owner.value.userId,
    });
    expect(first.ok).toBe(true);
    const dup = await channels.commit({
      projectId: proj.value.projectId,
      name: 'C2',
      slug: 'c',
      actorUserId: owner.value.userId,
    });
    expect(dup.ok).toBe(false);
  });
});
