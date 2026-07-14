import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq, inArray } from 'drizzle-orm';
import { schema } from '@consulting/db-schema';
import { Pool } from 'pg';
import { SignUpUseCase } from '../src/auth/sign-up.usecase.js';
import { ScryptPasswordHasher } from '../src/auth/password.js';
import { CreateProjectUseCase } from '../src/spaces/create-project.usecase.js';
import { CreateChannelUseCase } from '../src/spaces/create-channel.usecase.js';
import { ScopeRepository } from '../src/spaces/scope.repository.js';
import { CreateChannelBundleUseCase } from '../src/spaces/create-channel-bundle.usecase.js';

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

let pool: Pool;
let db: NodePgDatabase<typeof schema>;
const users: string[] = [];
const workspaces: string[] = [];

async function seedProject() {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const owner = await new SignUpUseCase(db, new ScryptPasswordHasher()).execute({
    email: `bundle-${suffix}@example.com`,
    password: 'supersecret1',
    displayName: 'Bundle Owner',
  });
  expect(owner.ok).toBe(true);
  if (!owner.ok) throw new Error('signup failed');
  users.push(owner.value.userId);
  workspaces.push(owner.value.personalWorkspaceId);

  const project = await new CreateProjectUseCase(db).execute({
    workspaceId: owner.value.personalWorkspaceId,
    actorUserId: owner.value.userId,
    name: 'Atomic Bundle Project',
    slug: `bundle-project-${suffix}`,
    tags: [{ key: 'domain', value: 'atomicity' }],
  });
  expect(project.ok).toBe(true);
  if (!project.ok) throw new Error('project failed');
  return { userId: owner.value.userId, projectId: project.value.projectId, suffix };
}

d('channel bundle atomicity integration', () => {
  beforeAll(() => {
    pool = new Pool({ connectionString: url });
    db = drizzle(pool, { schema });
  });

  afterAll(async () => {
    if (workspaces.length) await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, workspaces));
    if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
    await pool.end();
  });

  it('rolls back channel and topic if first-thread insertion fails', async () => {
    const seeded = await seedProject();
    const slug = `rollback-${seeded.suffix}`;
    await pool.query(`
      create or replace function cw_test_reject_bundle_thread()
      returns trigger language plpgsql as $$
      begin
        raise exception 'simulated bundle thread failure';
      end;
      $$;
      create trigger cw_test_reject_bundle_thread_trigger
      before insert on threads
      for each row execute function cw_test_reject_bundle_thread();
    `);

    try {
      const result = await new CreateChannelBundleUseCase(db, new ScopeRepository(db)).execute({
        projectId: seeded.projectId,
        actorUserId: seeded.userId,
        name: 'Rollback Channel',
        slug,
      });
      expect(result.ok).toBe(false);
    } finally {
      await pool.query(`
        drop trigger if exists cw_test_reject_bundle_thread_trigger on threads;
        drop function if exists cw_test_reject_bundle_thread();
      `);
    }

    const channels = await db.select({ id: schema.channels.id }).from(schema.channels)
      .where(and(eq(schema.channels.projectId, seeded.projectId), eq(schema.channels.slug, slug)));
    expect(channels).toEqual([]);
  });

  it('converges retries to one channel, one default topic, and one first thread', async () => {
    const seeded = await seedProject();
    const slug = `retry-${seeded.suffix}`;
    const usecase = new CreateChannelBundleUseCase(db, new ScopeRepository(db));
    const command = {
      projectId: seeded.projectId,
      actorUserId: seeded.userId,
      name: 'Retry Channel',
      slug,
    };

    const [first, second] = await Promise.all([
      usecase.execute(command),
      usecase.execute(command),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('bundle failed');
    expect(second.value).toEqual(first.value);

    const channels = await db.select({ id: schema.channels.id }).from(schema.channels)
      .where(and(eq(schema.channels.projectId, seeded.projectId), eq(schema.channels.slug, slug)));
    expect(channels).toHaveLength(1);
    const topics = await db.select({ id: schema.topics.id }).from(schema.topics)
      .where(eq(schema.topics.channelId, first.value.channelId));
    expect(topics).toHaveLength(1);
    const threads = await db.select({ id: schema.threads.id }).from(schema.threads)
      .where(eq(schema.threads.topicId, first.value.topicId));
    expect(threads).toHaveLength(1);
  });

  it('atomically repairs an existing empty channel and converges concurrent retries', async () => {
    const seeded = await seedProject();
    const scopes = new ScopeRepository(db);
    const channel = await new CreateChannelUseCase(db, scopes).commit({
      projectId: seeded.projectId,
      actorUserId: seeded.userId,
      name: 'Legacy Empty Channel',
      slug: `legacy-empty-${seeded.suffix}`,
    });
    expect(channel.ok).toBe(true);
    if (!channel.ok) throw new Error('channel failed');
    const usecase = new CreateChannelBundleUseCase(db, scopes);

    await pool.query(`
      create or replace function cw_test_reject_ensure_thread()
      returns trigger language plpgsql as $$
      begin
        raise exception 'simulated ensure thread failure';
      end;
      $$;
      create trigger cw_test_reject_ensure_thread_trigger
      before insert on threads
      for each row execute function cw_test_reject_ensure_thread();
    `);
    try {
      const failed = await usecase.ensureConversation({
        channelId: channel.value.channelId,
        actorUserId: seeded.userId,
      });
      expect(failed.ok).toBe(false);
    } finally {
      await pool.query(`
        drop trigger if exists cw_test_reject_ensure_thread_trigger on threads;
        drop function if exists cw_test_reject_ensure_thread();
      `);
    }
    const afterFailure = await db.select({ id: schema.topics.id }).from(schema.topics)
      .where(eq(schema.topics.channelId, channel.value.channelId));
    expect(afterFailure).toEqual([]);

    const [first, second] = await Promise.all([
      usecase.ensureConversation({ channelId: channel.value.channelId, actorUserId: seeded.userId }),
      usecase.ensureConversation({ channelId: channel.value.channelId, actorUserId: seeded.userId }),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('ensure conversation failed');
    expect(second.value).toEqual(first.value);

    const topics = await db.select({ id: schema.topics.id }).from(schema.topics)
      .where(eq(schema.topics.channelId, channel.value.channelId));
    expect(topics).toHaveLength(1);
    const threads = await db.select({ id: schema.threads.id }).from(schema.threads)
      .where(eq(schema.threads.topicId, first.value.topicId));
    expect(threads).toHaveLength(1);
  });
});
