import { Inject, Injectable, Optional } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
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
  applyDefaultTemplate?: boolean;
  /** Seed tags applied to the project (become inheritable by children). */
  tags?: { key: string; value: string }[];
  requestId?: string;
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

  async execute(cmd: CreateProjectCommand): Promise<Result<{ projectId: string }>> {
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

        await tx.insert(schema.auditEvents).values({
          workspaceId: cmd.workspaceId,
          actorUserId: cmd.actorUserId,
          action: 'project.create',
          scopeType: 'project',
          scopeId: project.id,
          after: { name: cmd.name, slug: cmd.slug },
          requestId: cmd.requestId ?? null,
        });

        if (this.shouldApplyDefaultTemplate(cmd)) {
          await this.templates!.applyConsultingDefaultToProjectInTransaction(
            tx,
            { id: project.id, workspaceId: cmd.workspaceId, name: cmd.name, slug: cmd.slug },
            { actorUserId: cmd.actorUserId, ...(cmd.requestId ? { requestId: cmd.requestId } : {}) },
          );
        }

        return ok({ projectId: project.id });
      });
    } catch {
      return err(domainError('INTERNAL', 'create project transaction failed'));
    }
  }

  private shouldApplyDefaultTemplate(cmd: CreateProjectCommand): boolean {
    if (!this.templates) return false;
    return cmd.applyDefaultTemplate ?? this.templateConfig?.CONSULTING_DEFAULT_TEMPLATE_ENABLED ?? false;
  }
}
