import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, eq } from 'drizzle-orm';
import { ok, err, type Result, domainError } from '@consulting/shared';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';
import { ScopeRepository, type ResolvedTag } from './scope.repository.js';

export interface CreateChannelPreviewCommand {
  projectId: string;
  name: string;
  slug: string;
}

export interface CreateChannelPreview {
  parentPath: string;
  inheritedTags: ResolvedTag[];
  inheritedBotPolicy: string;
  memoryPolicy: string;
  warnings: string[];
}

export interface CreateChannelCommitCommand extends CreateChannelPreviewCommand {
  actorUserId: string;
  requestId?: string;
}

const DEFAULT_BOT_POLICY = 'mention_only';

@Injectable()
export class CreateChannelUseCase {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(ScopeRepository) private readonly scopes: ScopeRepository,
  ) {}

  /** Preview: compute inheritance WITHOUT mutating (ADR-0002, design §29.2). */
  async preview(cmd: CreateChannelPreviewCommand): Promise<Result<CreateChannelPreview>> {
    const chain = await this.scopes.chainForProject(cmd.projectId);
    if (!chain) return err(domainError('NOT_FOUND', 'project not found'));
    const workspaceId = chain[0]!.scopeId;

    const [project] = await this.db
      .select({ name: schema.projects.name, workspaceId: schema.projects.workspaceId })
      .from(schema.projects)
      .where(eq(schema.projects.id, cmd.projectId))
      .limit(1);
    if (!project) return err(domainError('NOT_FOUND', 'project not found'));

    const [ws] = await this.db
      .select({ name: schema.workspaces.name })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .limit(1);

    const inheritedTags = await this.scopes.inheritedTags(workspaceId, chain);
    const inheritedBotPolicy =
      (await this.scopes.inheritedBotPolicy(workspaceId, chain)) ?? DEFAULT_BOT_POLICY;

    const warnings: string[] = [];
    const dup = await this.db
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(and(eq(schema.channels.projectId, cmd.projectId), eq(schema.channels.slug, cmd.slug)))
      .limit(1);
    if (dup.length > 0) warnings.push('slug already exists in this project');

    return ok({
      parentPath: `${ws?.name ?? 'Workspace'} > ${project.name}`,
      inheritedTags,
      inheritedBotPolicy,
      memoryPolicy: 'new topic will be isolated',
      warnings,
    });
  }

  /**
   * Commit: create channel + inherited scope_tags + parent_of context edge
   * + outbox + audit, all in one transaction (ADR-0002/0005/0020).
   */
  async commit(cmd: CreateChannelCommitCommand): Promise<Result<{ channelId: string }>> {
    const chain = await this.scopes.chainForProject(cmd.projectId);
    if (!chain) return err(domainError('NOT_FOUND', 'project not found'));
    const workspaceId = chain[0]!.scopeId;
    const inheritedTags = await this.scopes.inheritedTags(workspaceId, chain);

    try {
      return await this.db.transaction(async (tx) => {
        // slug uniqueness within project is enforced by DB constraint too
        const [channel] = await tx
          .insert(schema.channels)
          .values({
            workspaceId,
            projectId: cmd.projectId,
            name: cmd.name,
            slug: cmd.slug,
          })
          .onConflictDoNothing()
          .returning({ id: schema.channels.id });
        if (!channel) return err(domainError('CONFLICT', 'channel slug already exists'));

        // inherit tags (origin=inherited)
        for (const tag of inheritedTags) {
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
              workspaceId,
              scopeType: 'channel',
              scopeId: channel.id,
              tagId: tagRow.id,
              origin: 'inherited',
            })
            .onConflictDoNothing();
        }

        // parent_of edge: project → channel (origin=system)
        await tx
          .insert(schema.contextEdges)
          .values({
            workspaceId,
            fromScopeType: 'project',
            fromScopeId: cmd.projectId,
            toScopeType: 'channel',
            toScopeId: channel.id,
            edgeType: 'parent_of',
            origin: 'system',
          })
          .onConflictDoNothing();

        await tx.insert(schema.outboxEvents).values({
          workspaceId,
          eventType: 'ChannelCreated',
          aggregateType: 'channel',
          aggregateId: channel.id,
          payload: { projectId: cmd.projectId, slug: cmd.slug, inheritedTagCount: inheritedTags.length },
          idempotencyKey: `channel-created:${channel.id}`,
          requestId: cmd.requestId ?? null,
        });

        await tx.insert(schema.auditEvents).values({
          workspaceId,
          actorUserId: cmd.actorUserId,
          action: 'channel.create',
          scopeType: 'channel',
          scopeId: channel.id,
          after: { name: cmd.name, slug: cmd.slug },
          requestId: cmd.requestId ?? null,
        });

        return ok({ channelId: channel.id });
      });
    } catch {
      return err(domainError('INTERNAL', 'create channel transaction failed'));
    }
  }
}
