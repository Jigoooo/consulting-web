import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type {
  ArtifactDetailResponse,
  ListArtifactsResponse,
} from '@consulting/contracts';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';

/**
 * Artifact persistence (Phase 2-B). Versions are immutable rows; the artifact
 * row keeps a denormalized head_version. Version numbers are assigned inside
 * a transaction with max(version_no)+1 to survive concurrent writers.
 */
@Injectable()
export class ArtifactStore {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async create(input: {
    workspaceId: string;
    projectId: string;
    title: string;
    content: string;
    governingMessage: string | null;
    soWhat: string | null;
    note: string;
    createdByUserId: string;
    sourceThreadId: string | null;
    sourceMessageId: string | null;
  }, db?: Db): Promise<{ id: string; versionNo: number }> {
    if (!db) return this.db.transaction((tx) => this.create(input, tx as Db));
    const [artifact] = await db
      .insert(schema.artifacts)
      .values({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        title: input.title,
        headVersion: 1,
        createdByUserId: input.createdByUserId,
      })
      .returning({ id: schema.artifacts.id });
    await db.insert(schema.artifactVersions).values({
      workspaceId: input.workspaceId,
      artifactId: artifact!.id,
      versionNo: 1,
      content: input.content,
      governingMessage: input.governingMessage,
      soWhat: input.soWhat,
      note: input.note,
      authorUserId: input.createdByUserId,
      sourceThreadId: input.sourceThreadId,
      sourceMessageId: input.sourceMessageId,
    });
    return { id: artifact!.id, versionNo: 1 };
  }

  async addVersion(input: {
    artifactId: string;
    workspaceId: string;
    content: string;
    governingMessage: string | null;
    soWhat: string | null;
    note: string;
    authorUserId: string;
    sourceThreadId: string | null;
    sourceMessageId: string | null;
  }, db?: Db): Promise<{ versionNo: number }> {
    if (!db) return this.db.transaction((tx) => this.addVersion(input, tx as Db));
    const [head] = await db
      .select({ max: sql<number>`coalesce(max(${schema.artifactVersions.versionNo}), 0)::int` })
      .from(schema.artifactVersions)
      .where(eq(schema.artifactVersions.artifactId, input.artifactId));
    const versionNo = (head?.max ?? 0) + 1;
    await db.insert(schema.artifactVersions).values({
      workspaceId: input.workspaceId,
      artifactId: input.artifactId,
      versionNo,
      content: input.content,
      governingMessage: input.governingMessage,
      soWhat: input.soWhat,
      note: input.note,
      authorUserId: input.authorUserId,
      sourceThreadId: input.sourceThreadId,
      sourceMessageId: input.sourceMessageId,
    });
    await db
      .update(schema.artifacts)
      .set({ headVersion: versionNo, updatedAt: new Date() })
      .where(eq(schema.artifacts.id, input.artifactId));
    return { versionNo };
  }

  /** Workspace id for tenancy check; null when missing or soft-deleted. */
  async artifactWorkspace(artifactId: string): Promise<{ workspaceId: string; projectId: string } | null> {
    const [row] = await this.db
      .select({ workspaceId: schema.artifacts.workspaceId, projectId: schema.artifacts.projectId })
      .from(schema.artifacts)
      .where(and(eq(schema.artifacts.id, artifactId), isNull(schema.artifacts.deletedAt)))
      .limit(1);
    return row ?? null;
  }

  async listForWorkspace(
    workspaceId: string,
    projectIds: readonly string[],
    offset = 0,
  ): Promise<ListArtifactsResponse> {
    if (projectIds.length === 0) return { artifacts: [] };
    const rows = await this.db
      .select({
        id: schema.artifacts.id,
        projectId: schema.artifacts.projectId,
        title: schema.artifacts.title,
        headVersion: schema.artifacts.headVersion,
        createdByUserId: schema.artifacts.createdByUserId,
        createdAt: schema.artifacts.createdAt,
        updatedAt: schema.artifacts.updatedAt,
      })
      .from(schema.artifacts)
      .innerJoin(schema.projects, and(
        eq(schema.artifacts.projectId, schema.projects.id),
        eq(schema.artifacts.workspaceId, schema.projects.workspaceId),
      ))
      .where(
        and(
          eq(schema.artifacts.workspaceId, workspaceId),
          isNull(schema.artifacts.deletedAt),
          inArray(schema.artifacts.projectId, [...projectIds]),
          eq(schema.projects.status, 'active'),
          isNull(schema.projects.deletedAt),
        ),
      )
      .orderBy(desc(schema.artifacts.updatedAt), desc(schema.artifacts.id))
      .limit(500)
      .offset(offset);
    return {
      artifacts: rows.map((r) => ({
        id: r.id,
        projectId: r.projectId,
        title: r.title,
        headVersion: r.headVersion,
        createdByUserId: r.createdByUserId,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
    };
  }

  async detail(artifactId: string): Promise<ArtifactDetailResponse | null> {
    const [artifact] = await this.db
      .select({
        id: schema.artifacts.id,
        projectId: schema.artifacts.projectId,
        title: schema.artifacts.title,
        headVersion: schema.artifacts.headVersion,
      })
      .from(schema.artifacts)
      .where(and(eq(schema.artifacts.id, artifactId), isNull(schema.artifacts.deletedAt)))
      .limit(1);
    if (!artifact) return null;

    const versions = await this.db
      .select({
        id: schema.artifactVersions.id,
        versionNo: schema.artifactVersions.versionNo,
        content: schema.artifactVersions.content,
        governingMessage: schema.artifactVersions.governingMessage,
        soWhat: schema.artifactVersions.soWhat,
        note: schema.artifactVersions.note,
        authorUserId: schema.artifactVersions.authorUserId,
        authorName: schema.users.displayName,
        sourceThreadId: schema.artifactVersions.sourceThreadId,
        sourceMessageId: schema.artifactVersions.sourceMessageId,
        createdAt: schema.artifactVersions.createdAt,
      })
      .from(schema.artifactVersions)
      .leftJoin(schema.users, eq(schema.artifactVersions.authorUserId, schema.users.id))
      .where(eq(schema.artifactVersions.artifactId, artifactId))
      .orderBy(asc(schema.artifactVersions.versionNo));

    return {
      id: artifact.id,
      projectId: artifact.projectId,
      title: artifact.title,
      headVersion: artifact.headVersion,
      versions: versions.map((v) => ({
        id: v.id,
        versionNo: v.versionNo,
        content: v.content,
        governingMessage: v.governingMessage,
        soWhat: v.soWhat,
        note: v.note,
        authorUserId: v.authorUserId,
        authorName: v.authorName,
        sourceThreadId: v.sourceThreadId,
        sourceMessageId: v.sourceMessageId,
        createdAt: v.createdAt.toISOString(),
      })),
    };
  }

  async softDelete(artifactId: string): Promise<void> {
    await this.db
      .update(schema.artifacts)
      .set({ deletedAt: new Date() })
      .where(eq(schema.artifacts.id, artifactId));
  }
}
