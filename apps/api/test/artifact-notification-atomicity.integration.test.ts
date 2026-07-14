import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from '@consulting/db-schema';
import { ArtifactStore } from '../src/artifacts/artifact.store.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const d = databaseUrl ? describe : describe.skip;

d('artifact mutation transaction boundary', () => {
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    db = drizzle(pool, { schema });
    await db.insert(schema.users).values({ id: userId, email: `${userId}@example.com`, displayName: 'artifact owner' });
    await db.insert(schema.workspaces).values({
      id: workspaceId,
      name: 'artifact atomic workspace',
      slug: `artifact-atomic-${workspaceId}`,
      ownerUserId: userId,
    });
    await db.insert(schema.projects).values({
      id: projectId,
      workspaceId,
      name: 'artifact atomic project',
      slug: `artifact-atomic-${projectId}`,
    });
  });

  afterAll(async () => {
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await pool.end();
  });

  it('rejects partial or placeholder artifact structure at the database boundary', async () => {
    const artifactId = randomUUID();
    await db.insert(schema.artifacts).values({
      id: artifactId,
      workspaceId,
      projectId,
      title: 'structure constraint target',
      createdByUserId: userId,
    });

    await expect(db.insert(schema.artifactVersions).values({
      workspaceId,
      artifactId,
      versionNo: 1,
      content: '# partial structure',
      governingMessage: '핵심 결론은 충분히 구체적인 문장입니다.',
      soWhat: null,
      authorUserId: userId,
    })).rejects.toThrow();

    await expect(db.insert(schema.artifactVersions).values({
      workspaceId,
      artifactId,
      versionNo: 1,
      content: '# placeholder structure',
      governingMessage: '짧음',
      soWhat: '짧음',
      authorUserId: userId,
    })).rejects.toThrow();
  });

  it('rolls back artifact and v1 when a later notification write fails', async () => {
    const store = new ArtifactStore(db as never);
    const title = `rollback-create-${randomUUID()}`;
    await expect(db.transaction(async (tx) => {
      await store.create({
        workspaceId,
        projectId,
        title,
        content: '# v1',
        governingMessage: null,
        soWhat: null,
        note: 'v1',
        createdByUserId: userId,
        sourceThreadId: null,
        sourceMessageId: null,
      }, tx as never);
      throw new Error('notification write failed');
    })).rejects.toThrow('notification write failed');

    const artifacts = await db.select().from(schema.artifacts).where(eq(schema.artifacts.title, title));
    expect(artifacts).toHaveLength(0);
  });

  it('rolls back a new version and head pointer when a later notification write fails', async () => {
    const store = new ArtifactStore(db as never);
    const created = await store.create({
      workspaceId,
      projectId,
      title: `rollback-version-${randomUUID()}`,
      content: '# v1',
      governingMessage: null,
      soWhat: null,
      note: 'v1',
      createdByUserId: userId,
      sourceThreadId: null,
      sourceMessageId: null,
    });

    await expect(db.transaction(async (tx) => {
      await store.addVersion({
        artifactId: created.id,
        workspaceId,
        content: '# v2',
        governingMessage: null,
        soWhat: null,
        note: 'v2',
        authorUserId: userId,
        sourceThreadId: null,
        sourceMessageId: null,
      }, tx as never);
      throw new Error('version notification write failed');
    })).rejects.toThrow('version notification write failed');

    const [artifact] = await db.select({ headVersion: schema.artifacts.headVersion })
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, created.id));
    const versions = await db.select({ versionNo: schema.artifactVersions.versionNo })
      .from(schema.artifactVersions)
      .where(eq(schema.artifactVersions.artifactId, created.id));
    expect(artifact?.headVersion).toBe(1);
    expect(versions.map((version) => version.versionNo)).toEqual([1]);
  });
});
