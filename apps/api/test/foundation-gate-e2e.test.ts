import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { schema } from '@consulting/db-schema';
import { and, eq, inArray } from 'drizzle-orm';
import { Pool } from 'pg';
import { SignUpUseCase } from '../src/auth/sign-up.usecase.js';
import { ScryptPasswordHasher } from '../src/auth/password.js';
import { InvitationUseCase } from '../src/organization/invitation.usecase.js';
import { CreateProjectUseCase } from '../src/spaces/create-project.usecase.js';
import { CreateChannelUseCase } from '../src/spaces/create-channel.usecase.js';
import { ScopeRepository } from '../src/spaces/scope.repository.js';
import { MatrixPolicyEngine } from '../src/permissions/matrix-policy-engine.js';

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

let pool: Pool;
let db: NodePgDatabase<typeof schema>;
const users: string[] = [];
const workspaces: string[] = [];

/**
 * Phase 0 Foundation Gate E2E (plan §Task 31):
 * signup → personal workspace → shared workspace → invite → accept →
 * project → channel preview → commit → permission check → events/audit/outbox.
 */
d('Foundation Gate E2E', () => {
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

  it('runs the full foundation flow end to end', async () => {
    const signup = new SignUpUseCase(db, new ScryptPasswordHasher());
    const invitations = new InvitationUseCase(db);
    const projects = new CreateProjectUseCase(db);
    const scopes = new ScopeRepository(db);
    const channels = new CreateChannelUseCase(db, scopes);
    const engine = new MatrixPolicyEngine();

    // 1. user A signs up → personal workspace auto-created
    const a = await signup.execute({
      email: `e2e-a-${Date.now()}@example.com`,
      password: 'supersecret1',
      displayName: 'Alice',
    });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    users.push(a.value.userId);
    workspaces.push(a.value.personalWorkspaceId);
    const wsId = a.value.personalWorkspaceId;

    // 2. user B signs up (the invitee)
    const b = await signup.execute({
      email: `e2e-b-${Date.now()}@example.com`,
      password: 'supersecret1',
      displayName: 'Bob',
    });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    users.push(b.value.userId);
    workspaces.push(b.value.personalWorkspaceId);

    // 3. A invites B into A's workspace as editor
    const invite = await invitations.create({
      workspaceId: wsId,
      invitedByUserId: a.value.userId,
      email: 'bob@example.com',
      scopeType: 'workspace',
      scopeId: wsId,
      role: 'editor',
    });
    expect(invite.ok).toBe(true);
    if (!invite.ok) return;

    // 4. B accepts → membership created
    const accept = await invitations.accept({ token: invite.value.token, userId: b.value.userId });
    expect(accept.ok).toBe(true);

    // 5. A creates a project with seed tags
    const proj = await projects.execute({
      workspaceId: wsId,
      actorUserId: a.value.userId,
      name: '조직관리 진단',
      slug: 'org-diagnosis',
      tags: [{ key: 'client', value: '창원' }],
    });
    expect(proj.ok).toBe(true);
    if (!proj.ok) return;

    // 6. permission check: B (editor at workspace) may create a channel
    const bMemberships = await db
      .select()
      .from(schema.memberships)
      .where(eq(schema.memberships.userId, b.value.userId));
    const decision = engine.evaluate({
      permission: 'channel.create',
      scopeChain: [
        { scopeType: 'workspace', scopeId: wsId },
        { scopeType: 'project', scopeId: proj.value.projectId },
      ],
      memberships: bMemberships.map((m) => ({
        scopeType: m.scopeType,
        scopeId: m.scopeId,
        role: m.role,
      })),
      overrides: [],
      systemRole: 'user',
    });
    expect(decision.allowed).toBe(true);

    // 7. B previews then commits a channel; tags auto-inherit
    const preview = await channels.preview({
      projectId: proj.value.projectId,
      name: '공로연수 실무방',
      slug: 'merit-training',
    });
    expect(preview.ok).toBe(true);
    if (preview.ok) {
      expect(preview.value.inheritedTags.map((t) => t.value)).toContain('창원');
    }

    const commit = await channels.commit({
      projectId: proj.value.projectId,
      name: '공로연수 실무방',
      slug: 'merit-training',
      actorUserId: b.value.userId,
    });
    expect(commit.ok).toBe(true);
    if (!commit.ok) return;

    // 8. verify events + audit + outbox all recorded for this workspace
    const outbox = await db
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.workspaceId, wsId));
    expect(outbox.some((o) => o.eventType === 'WorkspaceCreated')).toBe(true);
    expect(outbox.some((o) => o.eventType === 'ChannelCreated')).toBe(true);

    const audit = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.workspaceId, wsId));
    const actions = audit.map((x) => x.action);
    expect(actions).toContain('user.signup');
    expect(actions).toContain('invitation.accept');
    expect(actions).toContain('project.create');
    expect(actions).toContain('channel.create');

    // channel has inherited tag on the graph
    const chTags = await db
      .select({ value: schema.contextTags.value })
      .from(schema.scopeTags)
      .innerJoin(schema.contextTags, eq(schema.scopeTags.tagId, schema.contextTags.id))
      .where(
        and(
          eq(schema.scopeTags.scopeType, 'channel'),
          eq(schema.scopeTags.scopeId, commit.value.channelId),
        ),
      );
    expect(chTags.map((t) => t.value)).toContain('창원');
  });
});
