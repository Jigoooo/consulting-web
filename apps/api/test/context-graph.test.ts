import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { schema } from '@consulting/db-schema';
import { and, eq, inArray } from 'drizzle-orm';
import { Pool } from 'pg';
import { SignUpUseCase } from '../src/auth/sign-up.usecase.js';
import { ScryptPasswordHasher } from '../src/auth/password.js';
import { CreateProjectUseCase } from '../src/spaces/create-project.usecase.js';
import { CreateChannelUseCase } from '../src/spaces/create-channel.usecase.js';
import { ScopeRepository } from '../src/spaces/scope.repository.js';

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

let pool: Pool;
let db: NodePgDatabase<typeof schema>;
const users: string[] = [];
const workspaces: string[] = [];

d('context graph auto-linking on direct channel creation (ADR-0002)', () => {
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

  it('user-created channel inherits project tags + gets parent_of edge + outbox', async () => {
    const signup = new SignUpUseCase(db, new ScryptPasswordHasher());
    const owner = await signup.execute({
      email: `cw-${Date.now()}@example.com`,
      password: 'supersecret1',
      displayName: 'Changwon Owner',
    });
    expect(owner.ok).toBe(true);
    if (!owner.ok) return;
    users.push(owner.value.userId);
    workspaces.push(owner.value.personalWorkspaceId);
    const workspaceId = owner.value.personalWorkspaceId;

    // Project "조직관리 진단" with seed tags
    const projects = new CreateProjectUseCase(db);
    const proj = await projects.execute({
      workspaceId,
      actorUserId: owner.value.userId,
      name: '조직관리 진단',
      slug: 'org-diagnosis',
      tags: [
        { key: 'client', value: '창원' },
        { key: 'domain', value: 'HR' },
      ],
    });
    expect(proj.ok).toBe(true);
    if (!proj.ok) return;

    const scopes = new ScopeRepository(db);
    const channels = new CreateChannelUseCase(db, scopes);

    // PREVIEW: no mutation, shows inherited tags
    const preview = await channels.preview({
      projectId: proj.value.projectId,
      name: '공로연수 실무방',
      slug: 'merit-training',
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.inheritedTags.map((t) => t.value).sort()).toEqual(['HR', '창원']);
    expect(preview.value.inheritedBotPolicy).toBe('mention_only');
    expect(preview.value.parentPath).toContain('조직관리 진단');

    // preview must NOT create the channel
    const before = await db
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(eq(schema.channels.projectId, proj.value.projectId));
    expect(before).toHaveLength(0);

    // COMMIT
    const commit = await channels.commit({
      projectId: proj.value.projectId,
      name: '공로연수 실무방',
      slug: 'merit-training',
      actorUserId: owner.value.userId,
    });
    expect(commit.ok).toBe(true);
    if (!commit.ok) return;
    const channelId = commit.value.channelId;

    // inherited scope_tags exist on the channel
    const chTags = await db
      .select({ value: schema.contextTags.value, origin: schema.scopeTags.origin })
      .from(schema.scopeTags)
      .innerJoin(schema.contextTags, eq(schema.scopeTags.tagId, schema.contextTags.id))
      .where(
        and(
          eq(schema.scopeTags.scopeType, 'channel'),
          eq(schema.scopeTags.scopeId, channelId),
        ),
      );
    expect(chTags.map((t) => t.value).sort()).toEqual(['HR', '창원']);
    expect(chTags.every((t) => t.origin === 'inherited')).toBe(true);

    // parent_of edge project → channel
    const edges = await db
      .select()
      .from(schema.contextEdges)
      .where(
        and(
          eq(schema.contextEdges.toScopeType, 'channel'),
          eq(schema.contextEdges.toScopeId, channelId),
        ),
      );
    expect(edges).toHaveLength(1);
    expect(edges[0]?.edgeType).toBe('parent_of');
    expect(edges[0]?.fromScopeId).toBe(proj.value.projectId);

    // outbox ChannelCreated
    const outbox = await db
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.aggregateId, channelId));
    expect(outbox.some((o) => o.eventType === 'ChannelCreated')).toBe(true);

    // duplicate slug rejected
    const dup = await channels.commit({
      projectId: proj.value.projectId,
      name: 'dup',
      slug: 'merit-training',
      actorUserId: owner.value.userId,
    });
    expect(dup.ok).toBe(false);
  });
});
