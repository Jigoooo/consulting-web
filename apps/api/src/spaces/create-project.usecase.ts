import { Inject, Injectable, Optional } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { ok, err, type Result, domainError } from '@consulting/shared';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';
import { ENV_TOKEN } from '../config/config.module.js';
import { ProjectTemplateService } from './project-template.service.js';

export interface CreateProjectTemplateConfig {
  CONSULTING_DEFAULT_TEMPLATE_ENABLED?: boolean;
}

export interface CreateProjectCommand {
  workspaceId: string;
  actorUserId: string;
  name: string;
  slug: string;
  applyDefaultTemplate?: boolean | undefined;
  templateKey?: 'consulting_default' | undefined;
  connectionDecision?: 'skip' | 'selected' | undefined;
  connections?: { projectId: string; strength: 'strong' | 'weak' }[] | undefined;
  profile?: { overview?: string | undefined; goal?: string | undefined; notes?: string | undefined } | undefined;
  /** Seed tags applied to the project (become inheritable by children). */
  tags?: { key: string; value: string }[];
  requestId?: string;
}

export interface CreateProjectResult {
  projectId: string;
  templateApplied: boolean;
  defaultThreadId: string | null;
  intakeThreadId: string | null;
  created: {
    channels: number;
    topics: number;
    threads: number;
    consultingLinks: number;
    contextEdges: number;
  };
}

/**
 * Create a project under a workspace and (optionally) seed context tags that
 * children (channels) will auto-inherit (ADR-0002).
 */
@Injectable()
export class CreateProjectUseCase {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Optional() @Inject(ProjectTemplateService) private readonly templates?: ProjectTemplateService,
    @Optional() @Inject(ENV_TOKEN) private readonly templateConfig?: CreateProjectTemplateConfig,
  ) {}

  async execute(cmd: CreateProjectCommand): Promise<Result<CreateProjectResult>> {
    try {
      return await this.db.transaction(async (tx) => {
        const [project] = await tx
          .insert(schema.projects)
          .values({ workspaceId: cmd.workspaceId, name: cmd.name, slug: cmd.slug })
          .onConflictDoNothing()
          .returning({ id: schema.projects.id });
        if (!project) return err(domainError('CONFLICT', 'project slug already exists'));

        for (const tag of cmd.tags ?? []) {
          const normalized = tag.value.trim().toLowerCase();
          const [tagRow] = await tx
            .insert(schema.contextTags)
            .values({ key: tag.key, value: tag.value, normalizedValue: normalized })
            .onConflictDoUpdate({
              target: [schema.contextTags.key, schema.contextTags.normalizedValue],
              set: { value: tag.value },
            })
            .returning({ id: schema.contextTags.id });
          if (!tagRow) continue;
          await tx
            .insert(schema.scopeTags)
            .values({
              workspaceId: cmd.workspaceId,
              scopeType: 'project',
              scopeId: project.id,
              tagId: tagRow.id,
              origin: 'manual',
            })
            .onConflictDoNothing();
        }

        await this.upsertProjectProfile(tx, cmd, project.id);
        const contextEdges = await this.createProjectConnections(tx, cmd, project.id);

        await tx.insert(schema.auditEvents).values({
          workspaceId: cmd.workspaceId,
          actorUserId: cmd.actorUserId,
          action: 'project.create',
          scopeType: 'project',
          scopeId: project.id,
          after: {
            name: cmd.name,
            slug: cmd.slug,
            templateKey: cmd.templateKey ?? null,
            connectionCount: cmd.connections?.length ?? 0,
            profileSeeded: hasProfileSeed(cmd.profile),
          },
          requestId: cmd.requestId ?? null,
        });

        let templateApplied = false;
        const created = { channels: 0, topics: 0, threads: 0, consultingLinks: 0, contextEdges };
        let defaultThreadId: string | null = null;
        let intakeThreadId: string | null = null;

        if (this.shouldApplyDefaultTemplate(cmd)) {
          const templateResult = await this.templates!.applyConsultingDefaultToProjectInTransaction(
            tx,
            { id: project.id, workspaceId: cmd.workspaceId, name: cmd.name, slug: cmd.slug },
            { actorUserId: cmd.actorUserId, ...(cmd.requestId ? { requestId: cmd.requestId } : {}) },
          );
          templateApplied = true;
          created.channels = templateResult.created.channels;
          created.topics = templateResult.created.topics;
          created.threads = templateResult.created.threads;
          created.consultingLinks = templateResult.created.consultingLinks;
          const threadTargets = await this.templateThreadTargets(tx, project.id);
          defaultThreadId = threadTargets.defaultThreadId;
          intakeThreadId = threadTargets.intakeThreadId;
        }

        return ok({ projectId: project.id, templateApplied, defaultThreadId, intakeThreadId, created });
      });
    } catch (error) {
      if (error instanceof CreateProjectValidationError) {
        return err(domainError(error.code, error.message));
      }
      return err(domainError('INTERNAL', 'create project transaction failed'));
    }
  }

  private shouldApplyDefaultTemplate(cmd: CreateProjectCommand): boolean {
    if (!this.templates) return false;
    if (cmd.applyDefaultTemplate === false) return false;
    return cmd.templateKey === 'consulting_default' || (cmd.applyDefaultTemplate ?? this.templateConfig?.CONSULTING_DEFAULT_TEMPLATE_ENABLED ?? false);
  }

  private async upsertProjectProfile(tx: Tx, cmd: CreateProjectCommand, projectId: string): Promise<void> {
    if (!hasProfileSeed(cmd.profile)) return;
    await tx.insert(schema.scopeProfiles).values({
      workspaceId: cmd.workspaceId,
      scopeType: 'project',
      scopeId: projectId,
      purpose: cmd.profile?.goal?.trim() ?? '',
      role: cmd.profile?.overview?.trim() ?? '',
      style: '',
      rules: cmd.profile?.notes?.trim() ?? '',
      source: 'manual',
      createdByUserId: cmd.actorUserId,
      updatedByUserId: cmd.actorUserId,
    }).onConflictDoUpdate({
      target: [schema.scopeProfiles.workspaceId, schema.scopeProfiles.scopeType, schema.scopeProfiles.scopeId],
      set: {
        purpose: cmd.profile?.goal?.trim() ?? '',
        role: cmd.profile?.overview?.trim() ?? '',
        style: '',
        rules: cmd.profile?.notes?.trim() ?? '',
        source: 'manual',
        updatedByUserId: cmd.actorUserId,
        updatedAt: new Date(),
        deletedAt: null,
      },
    });
  }

  private async createProjectConnections(tx: Tx, cmd: CreateProjectCommand, projectId: string): Promise<number> {
    const connections = cmd.connections ?? [];
    if (connections.length === 0) return 0;
    const uniqueProjectIds = new Set(connections.map((connection) => connection.projectId));
    if (uniqueProjectIds.size !== connections.length) {
      throw new CreateProjectValidationError('VALIDATION', 'project connections must be unique');
    }
    if (uniqueProjectIds.has(projectId)) {
      throw new CreateProjectValidationError('VALIDATION', 'project cannot connect to itself');
    }

    let created = 0;
    for (const connection of connections) {
      const [target] = await tx
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(and(
          eq(schema.projects.id, connection.projectId),
          eq(schema.projects.workspaceId, cmd.workspaceId),
          eq(schema.projects.status, 'active'),
          isNull(schema.projects.deletedAt),
        ))
        .limit(1);
      if (!target) throw new CreateProjectValidationError('NOT_FOUND', 'connected project not found');
      const edgeType = connection.strength === 'strong' ? 'shares_memory_with' : 'related_to';
      const confidence = connection.strength === 'strong' ? '1' : '0.65';
      const [fromProjectId, toProjectId] = orderProjectPair(projectId, target.id);
      const now = new Date();

      await tx.update(schema.contextEdges).set({ deletedAt: now, updatedAt: now }).where(and(
        eq(schema.contextEdges.workspaceId, cmd.workspaceId),
        eq(schema.contextEdges.origin, 'manual'),
        inArray(schema.contextEdges.edgeType, PROJECT_CONNECTION_EDGE_TYPES),
        isNull(schema.contextEdges.deletedAt),
        or(
          and(
            eq(schema.contextEdges.fromScopeType, 'project'),
            eq(schema.contextEdges.fromScopeId, projectId),
            eq(schema.contextEdges.toScopeType, 'project'),
            eq(schema.contextEdges.toScopeId, target.id),
          ),
          and(
            eq(schema.contextEdges.fromScopeType, 'project'),
            eq(schema.contextEdges.fromScopeId, target.id),
            eq(schema.contextEdges.toScopeType, 'project'),
            eq(schema.contextEdges.toScopeId, projectId),
          ),
        ),
      ));

      const [edge] = await tx.insert(schema.contextEdges).values({
        workspaceId: cmd.workspaceId,
        fromScopeType: 'project',
        fromScopeId: fromProjectId,
        toScopeType: 'project',
        toScopeId: toProjectId,
        edgeType,
        origin: 'manual',
        confidence,
      }).onConflictDoUpdate({
        target: [
          schema.contextEdges.fromScopeType,
          schema.contextEdges.fromScopeId,
          schema.contextEdges.toScopeType,
          schema.contextEdges.toScopeId,
          schema.contextEdges.edgeType,
        ],
        set: { deletedAt: null, origin: 'manual', confidence, updatedAt: now },
      }).returning({ id: schema.contextEdges.id });
      if (edge) created += 1;
    }
    return created;
  }

  private async templateThreadTargets(tx: Tx, projectId: string): Promise<{ defaultThreadId: string | null; intakeThreadId: string | null }> {
    const rows = await tx
      .select({ topicSlug: schema.topics.slug, threadId: schema.threads.id })
      .from(schema.threads)
      .innerJoin(schema.topics, eq(schema.topics.id, schema.threads.topicId))
      .innerJoin(schema.channels, eq(schema.channels.id, schema.topics.channelId))
      .where(and(
        eq(schema.channels.projectId, projectId),
        isNull(schema.channels.deletedAt),
        isNull(schema.topics.deletedAt),
        isNull(schema.threads.deletedAt),
      ));
    return {
      defaultThreadId: rows.find((row) => row.topicSlug === 'default-chat')?.threadId ?? null,
      intakeThreadId: rows.find((row) => row.topicSlug === 'source-evidence')?.threadId ?? null,
    };
  }
}

const PROJECT_CONNECTION_EDGE_TYPES = ['related_to', 'shares_memory_with'] as const;

function orderProjectPair(left: string, right: string): [string, string] {
  return left.localeCompare(right) <= 0 ? [left, right] : [right, left];
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

class CreateProjectValidationError extends Error {
  constructor(readonly code: 'VALIDATION' | 'NOT_FOUND', message: string) {
    super(message);
  }
}

function hasProfileSeed(profile: CreateProjectCommand['profile']): boolean {
  return Boolean(profile && [profile.overview, profile.goal, profile.notes].some((value) => value?.trim()));
}
