import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, eq } from 'drizzle-orm';
import type { ScopeType } from '@consulting/shared';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';

export interface ScopeChainNode {
  scopeType: ScopeType;
  scopeId: string;
}

export interface ResolvedTag {
  key: string;
  value: string;
}

/**
 * Reads the scope chain and inherited context for a target scope (ADR-0002).
 * Used by preview/commit to compute auto-linked tags/policies.
 */
@Injectable()
export class ScopeRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /** Build the root→target chain for a project (workspace → project). */
  async chainForProject(projectId: string): Promise<ScopeChainNode[] | null> {
    const [project] = await this.db
      .select({ id: schema.projects.id, workspaceId: schema.projects.workspaceId })
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId))
      .limit(1);
    if (!project) return null;
    return [
      { scopeType: 'workspace', scopeId: project.workspaceId },
      { scopeType: 'project', scopeId: project.id },
    ];
  }

  /** All tags attached to any scope in the chain (inherited pool). */
  async inheritedTags(
    workspaceId: string,
    chain: ScopeChainNode[],
  ): Promise<ResolvedTag[]> {
    const out: ResolvedTag[] = [];
    for (const node of chain) {
      const rows = await this.db
        .select({ key: schema.contextTags.key, value: schema.contextTags.value })
        .from(schema.scopeTags)
        .innerJoin(schema.contextTags, eq(schema.scopeTags.tagId, schema.contextTags.id))
        .where(
          and(
            eq(schema.scopeTags.workspaceId, workspaceId),
            eq(schema.scopeTags.scopeType, node.scopeType),
            eq(schema.scopeTags.scopeId, node.scopeId),
          ),
        );
      out.push(...rows);
    }
    // dedup by key:value
    const seen = new Set<string>();
    return out.filter((t) => {
      const k = `${t.key}:${t.value}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  /** Bot install policy inherited from the nearest ancestor, if any. */
  async inheritedBotPolicy(
    workspaceId: string,
    chain: ScopeChainNode[],
  ): Promise<string | null> {
    for (const node of [...chain].reverse()) {
      const [row] = await this.db
        .select({ policy: schema.botInstallations.invokePolicy })
        .from(schema.botInstallations)
        .where(
          and(
            eq(schema.botInstallations.workspaceId, workspaceId),
            eq(schema.botInstallations.scopeType, node.scopeType),
            eq(schema.botInstallations.scopeId, node.scopeId),
          ),
        )
        .limit(1);
      if (row) return row.policy;
    }
    return null;
  }
}
