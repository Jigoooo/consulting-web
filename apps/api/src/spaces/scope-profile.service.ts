import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, eq, isNull } from 'drizzle-orm';
import { domainError, err, ok, type Result } from '@consulting/shared';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';

export type ScopeProfileScopeType = 'channel' | 'topic';
export type ScopeProfileSource = 'template' | 'manual' | 'inferred';

export interface ScopeProfileFields {
  purpose: string;
  role: string;
  style: string;
  rules: string;
}

export interface ScopeProfileView extends ScopeProfileFields {
  scopeType: ScopeProfileScopeType;
  scopeId: string;
  source: ScopeProfileSource;
  updatedAt: string;
}

export interface ScopeProfileResult {
  profile: ScopeProfileView | null;
}

export interface UpdateScopeProfileCommand {
  actorUserId: string;
  patch: Partial<Record<keyof ScopeProfileFields, string | undefined>>;
}

@Injectable()
export class ScopeProfileService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getProfile(scopeType: ScopeProfileScopeType, scopeId: string): Promise<Result<ScopeProfileResult>> {
    const live = await this.resolveLiveScope(scopeType, scopeId);
    if (!live) return err(domainError('NOT_FOUND', `${scopeType} not found`));
    const profile = await this.findActiveProfile(scopeType, scopeId, live.workspaceId);
    return ok({ profile: profile ? this.toView(profile) : null });
  }

  async updateProfile(scopeType: ScopeProfileScopeType, scopeId: string, cmd: UpdateScopeProfileCommand): Promise<Result<ScopeProfileResult>> {
    const live = await this.resolveLiveScope(scopeType, scopeId);
    if (!live) return err(domainError('NOT_FOUND', `${scopeType} not found`));
    const existing = await this.findAnyProfile(scopeType, scopeId, live.workspaceId);
    const now = new Date();
    const defaults = existing ?? { purpose: '', role: '', style: '', rules: '' };
    const values = {
      purpose: cmd.patch.purpose ?? defaults.purpose,
      role: cmd.patch.role ?? defaults.role,
      style: cmd.patch.style ?? defaults.style,
      rules: cmd.patch.rules ?? defaults.rules,
      source: 'manual' as const,
      updatedByUserId: cmd.actorUserId,
      updatedAt: now,
      deletedAt: null,
    };

    if (existing) {
      const [updated] = await this.db
        .update(schema.scopeProfiles)
        .set(values)
        .where(eq(schema.scopeProfiles.id, existing.id))
        .returning(rowSelection);
      if (!updated) return err(domainError('INTERNAL', 'profile update returned no row'));
      return ok({ profile: this.toView(updated) });
    }

    const [inserted] = await this.db
      .insert(schema.scopeProfiles)
      .values({
        workspaceId: live.workspaceId,
        scopeType,
        scopeId,
        purpose: values.purpose,
        role: values.role,
        style: values.style,
        rules: values.rules,
        source: values.source,
        createdByUserId: cmd.actorUserId,
        updatedByUserId: cmd.actorUserId,
      })
      .returning(rowSelection);
    if (!inserted) return err(domainError('INTERNAL', 'profile insert returned no row'));
    return ok({ profile: this.toView(inserted) });
  }

  private async resolveLiveScope(scopeType: ScopeProfileScopeType, scopeId: string): Promise<{ workspaceId: string } | null> {
    if (scopeType === 'channel') {
      const [row] = await this.db
        .select({ workspaceId: schema.channels.workspaceId })
        .from(schema.channels)
        .innerJoin(schema.projects, eq(schema.projects.id, schema.channels.projectId))
        .where(and(
          eq(schema.channels.id, scopeId),
          eq(schema.channels.status, 'active'),
          isNull(schema.channels.deletedAt),
          eq(schema.projects.status, 'active'),
          isNull(schema.projects.deletedAt),
        ))
        .limit(1);
      return row ?? null;
    }

    const [row] = await this.db
      .select({ workspaceId: schema.topics.workspaceId })
      .from(schema.topics)
      .innerJoin(schema.channels, eq(schema.channels.id, schema.topics.channelId))
      .innerJoin(schema.projects, eq(schema.projects.id, schema.channels.projectId))
      .where(and(
        eq(schema.topics.id, scopeId),
        eq(schema.topics.status, 'active'),
        isNull(schema.topics.deletedAt),
        eq(schema.channels.status, 'active'),
        isNull(schema.channels.deletedAt),
        eq(schema.projects.status, 'active'),
        isNull(schema.projects.deletedAt),
      ))
      .limit(1);
    return row ?? null;
  }

  private async findActiveProfile(scopeType: ScopeProfileScopeType, scopeId: string, workspaceId: string): Promise<ScopeProfileRow | null> {
    const [profile] = await this.db
      .select(rowSelection)
      .from(schema.scopeProfiles)
      .where(and(
        eq(schema.scopeProfiles.workspaceId, workspaceId),
        eq(schema.scopeProfiles.scopeType, scopeType),
        eq(schema.scopeProfiles.scopeId, scopeId),
        isNull(schema.scopeProfiles.deletedAt),
      ))
      .limit(1);
    return profile ?? null;
  }

  private async findAnyProfile(scopeType: ScopeProfileScopeType, scopeId: string, workspaceId: string): Promise<ScopeProfileRow | null> {
    const [profile] = await this.db
      .select(rowSelection)
      .from(schema.scopeProfiles)
      .where(and(
        eq(schema.scopeProfiles.workspaceId, workspaceId),
        eq(schema.scopeProfiles.scopeType, scopeType),
        eq(schema.scopeProfiles.scopeId, scopeId),
      ))
      .limit(1);
    return profile ?? null;
  }

  private toView(row: ScopeProfileRow): ScopeProfileView {
    const scopeType: ScopeProfileScopeType = row.scopeType === 'topic' ? 'topic' : 'channel';
    return {
      scopeType,
      scopeId: row.scopeId,
      purpose: row.purpose,
      role: row.role,
      style: row.style,
      rules: row.rules,
      source: row.source as ScopeProfileSource,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

const rowSelection = {
  id: schema.scopeProfiles.id,
  scopeType: schema.scopeProfiles.scopeType,
  scopeId: schema.scopeProfiles.scopeId,
  purpose: schema.scopeProfiles.purpose,
  role: schema.scopeProfiles.role,
  style: schema.scopeProfiles.style,
  rules: schema.scopeProfiles.rules,
  source: schema.scopeProfiles.source,
  updatedAt: schema.scopeProfiles.updatedAt,
};

type ScopeProfileRow = {
  id: string;
  scopeType: string;
  scopeId: string;
  purpose: string;
  role: string;
  style: string;
  rules: string;
  source: string;
  updatedAt: Date;
};
