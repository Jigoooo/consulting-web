import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { domainError, err, ok, type Result } from '@consulting/shared';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';

export type ContextGraphScopeType = 'project' | 'channel' | 'topic' | 'thread';
export type ContextGraphManualEdgeType = 'related_to' | 'references' | 'shares_memory_with';
export type ContextGraphEdgeType = ContextGraphManualEdgeType | 'derived_from' | 'supersedes';
export type ContextGraphOrigin = 'manual' | 'classifier' | 'system' | 'bot' | 'import' | 'inherited';

export interface CreateContextEdgeCommand {
  fromScopeType: ContextGraphScopeType;
  fromScopeId: string;
  toScopeType: ContextGraphScopeType;
  toScopeId: string;
  edgeType: ContextGraphManualEdgeType;
  confidence?: number | undefined;
}

export interface CreateContextEdgeResult {
  edgeId: string;
}

export interface ManualContextEdgeTarget {
  edgeId: string;
  fromScopeType: ContextGraphScopeType;
  fromScopeId: string;
  toScopeType: ContextGraphScopeType;
  toScopeId: string;
}

export interface TraverseContextGraphCommand {
  scopeType: ContextGraphScopeType;
  scopeId: string;
  limit?: number | undefined;
}

export interface InferClassifierEdgesCommand {
  workspaceId: string;
  minSharedTags?: number;
}

export interface InferClassifierEdgesResult {
  scopesScanned: number;
  pairsScanned: number;
  edgesCreated: number;
}

export interface ContextGraphRelatedScope {
  scopeType: ContextGraphScopeType;
  scopeId: string;
  workspaceId: string;
  projectId: string;
  projectName: string;
  channelId: string | null;
  channelName: string | null;
  topicId: string | null;
  topicName: string | null;
  threadId: string | null;
  threadTitle: string | null;
  name: string;
  scopePath: string;
  edgeId: string;
  edgeType: ContextGraphEdgeType;
  origin: ContextGraphOrigin;
  confidence: number | null;
  direction: 'out' | 'in';
  relation: 'same_project' | 'cross_project';
  weight: number;
}

type LiveScope = Omit<ContextGraphRelatedScope, 'edgeId' | 'edgeType' | 'origin' | 'confidence' | 'direction' | 'relation' | 'weight'>;

type EdgeRow = {
  id: string;
  fromScopeType: ContextGraphScopeType;
  fromScopeId: string;
  toScopeType: ContextGraphScopeType;
  toScopeId: string;
  edgeType: ContextGraphEdgeType;
  origin: ContextGraphOrigin;
  confidence: string | null;
};

const TRAVERSABLE_EDGE_TYPES: ContextGraphEdgeType[] = ['related_to', 'references', 'shares_memory_with', 'derived_from', 'supersedes'];
const SYMMETRIC_PROJECT_EDGE_TYPES: ContextGraphManualEdgeType[] = ['related_to', 'shares_memory_with'];

@Injectable()
export class ContextGraphService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async createManualEdge(cmd: CreateContextEdgeCommand): Promise<Result<CreateContextEdgeResult>> {
    if (cmd.fromScopeType === cmd.toScopeType && cmd.fromScopeId === cmd.toScopeId) {
      return err(domainError('VALIDATION', 'cannot create a context edge to itself'));
    }

    const [from, to] = await Promise.all([
      this.resolveLiveScope(cmd.fromScopeType, cmd.fromScopeId),
      this.resolveLiveScope(cmd.toScopeType, cmd.toScopeId),
    ]);
    if (!from || !to) return err(domainError('NOT_FOUND', 'context edge endpoint not found or not active'));
    if (from.workspaceId !== to.workspaceId) {
      return err(domainError('FORBIDDEN', 'context edges cannot cross workspaces'));
    }

    if (isSymmetricProjectEdge(cmd)) {
      return this.upsertSymmetricProjectEdge(cmd, from.workspaceId);
    }

    try {
      const now = new Date();
      const confidence = String(cmd.confidence ?? 1);
      const [edge] = await this.db
        .insert(schema.contextEdges)
        .values({
          workspaceId: from.workspaceId,
          fromScopeType: cmd.fromScopeType,
          fromScopeId: cmd.fromScopeId,
          toScopeType: cmd.toScopeType,
          toScopeId: cmd.toScopeId,
          edgeType: cmd.edgeType,
          origin: 'manual',
          confidence,
        })
        .onConflictDoUpdate({
          target: [
            schema.contextEdges.fromScopeType,
            schema.contextEdges.fromScopeId,
            schema.contextEdges.toScopeType,
            schema.contextEdges.toScopeId,
            schema.contextEdges.edgeType,
          ],
          set: { deletedAt: null, origin: 'manual', confidence, updatedAt: now },
        })
        .returning({ id: schema.contextEdges.id });
      if (!edge) return err(domainError('INTERNAL', 'context edge insert returned no row'));
      return ok({ edgeId: edge.id });
    } catch {
      return err(domainError('INTERNAL', 'context edge create failed'));
    }
  }

  private async upsertSymmetricProjectEdge(cmd: CreateContextEdgeCommand, workspaceId: string): Promise<Result<CreateContextEdgeResult>> {
    try {
      return await this.db.transaction(async (tx) => {
        const now = new Date();
        const confidence = String(cmd.confidence ?? 1);
        const [fromProjectId, toProjectId] = orderProjectPair(cmd.fromScopeId, cmd.toScopeId);

        await tx.update(schema.contextEdges).set({ deletedAt: now, updatedAt: now }).where(and(
          eq(schema.contextEdges.workspaceId, workspaceId),
          eq(schema.contextEdges.origin, 'manual'),
          inArray(schema.contextEdges.edgeType, SYMMETRIC_PROJECT_EDGE_TYPES),
          isNull(schema.contextEdges.deletedAt),
          or(
            and(
              eq(schema.contextEdges.fromScopeType, 'project'),
              eq(schema.contextEdges.fromScopeId, cmd.fromScopeId),
              eq(schema.contextEdges.toScopeType, 'project'),
              eq(schema.contextEdges.toScopeId, cmd.toScopeId),
            ),
            and(
              eq(schema.contextEdges.fromScopeType, 'project'),
              eq(schema.contextEdges.fromScopeId, cmd.toScopeId),
              eq(schema.contextEdges.toScopeType, 'project'),
              eq(schema.contextEdges.toScopeId, cmd.fromScopeId),
            ),
          ),
        ));

        const [edge] = await tx
          .insert(schema.contextEdges)
          .values({
            workspaceId,
            fromScopeType: 'project',
            fromScopeId: fromProjectId,
            toScopeType: 'project',
            toScopeId: toProjectId,
            edgeType: cmd.edgeType,
            origin: 'manual',
            confidence,
          })
          .onConflictDoUpdate({
            target: [
              schema.contextEdges.fromScopeType,
              schema.contextEdges.fromScopeId,
              schema.contextEdges.toScopeType,
              schema.contextEdges.toScopeId,
              schema.contextEdges.edgeType,
            ],
            set: { deletedAt: null, origin: 'manual', confidence, updatedAt: now },
          })
          .returning({ id: schema.contextEdges.id });
        if (!edge) return err(domainError('INTERNAL', 'context edge insert returned no row'));
        return ok({ edgeId: edge.id });
      });
    } catch {
      return err(domainError('INTERNAL', 'context edge create failed'));
    }
  }

  async getManualEdgeTarget(edgeId: string): Promise<Result<ManualContextEdgeTarget>> {
    const [edge] = await this.db
      .select({
        edgeId: schema.contextEdges.id,
        fromScopeType: schema.contextEdges.fromScopeType,
        fromScopeId: schema.contextEdges.fromScopeId,
        toScopeType: schema.contextEdges.toScopeType,
        toScopeId: schema.contextEdges.toScopeId,
      })
      .from(schema.contextEdges)
      .where(and(
        eq(schema.contextEdges.id, edgeId),
        eq(schema.contextEdges.origin, 'manual'),
        isNull(schema.contextEdges.deletedAt),
      ))
      .limit(1);
    if (!edge) return err(domainError('NOT_FOUND', 'manual context edge not found'));

    const fromScopeType = edge.fromScopeType as ContextGraphScopeType;
    const toScopeType = edge.toScopeType as ContextGraphScopeType;
    const [from, to] = await Promise.all([
      this.resolveLiveScope(fromScopeType, edge.fromScopeId),
      this.resolveLiveScope(toScopeType, edge.toScopeId),
    ]);
    if (!from || !to || from.workspaceId !== to.workspaceId) {
      return err(domainError('NOT_FOUND', 'manual context edge endpoint not found or not active'));
    }
    return ok({ edgeId: edge.edgeId, fromScopeType, fromScopeId: edge.fromScopeId, toScopeType, toScopeId: edge.toScopeId });
  }

  async deleteManualEdge(edgeId: string): Promise<Result<{ ok: true }>> {
    try {
      const [deleted] = await this.db
        .update(schema.contextEdges)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(and(
          eq(schema.contextEdges.id, edgeId),
          eq(schema.contextEdges.origin, 'manual'),
          isNull(schema.contextEdges.deletedAt),
        ))
        .returning({ id: schema.contextEdges.id });
      if (!deleted) return err(domainError('NOT_FOUND', 'manual context edge not found'));
      return ok({ ok: true });
    } catch {
      return err(domainError('INTERNAL', 'context edge delete failed'));
    }
  }

  async traverseRelatedScopes(cmd: TraverseContextGraphCommand): Promise<ContextGraphRelatedScope[]> {
    const anchor = await this.resolveLiveScope(cmd.scopeType, cmd.scopeId);
    if (!anchor) return [];

    const edges = await this.db
      .select({
        id: schema.contextEdges.id,
        fromScopeType: schema.contextEdges.fromScopeType,
        fromScopeId: schema.contextEdges.fromScopeId,
        toScopeType: schema.contextEdges.toScopeType,
        toScopeId: schema.contextEdges.toScopeId,
        edgeType: schema.contextEdges.edgeType,
        origin: schema.contextEdges.origin,
        confidence: schema.contextEdges.confidence,
      })
      .from(schema.contextEdges)
      .where(and(
        eq(schema.contextEdges.workspaceId, anchor.workspaceId),
        isNull(schema.contextEdges.deletedAt),
        inArray(schema.contextEdges.edgeType, TRAVERSABLE_EDGE_TYPES),
        or(
          and(eq(schema.contextEdges.fromScopeType, cmd.scopeType), eq(schema.contextEdges.fromScopeId, cmd.scopeId)),
          and(eq(schema.contextEdges.toScopeType, cmd.scopeType), eq(schema.contextEdges.toScopeId, cmd.scopeId)),
        ),
      ));

    const out: ContextGraphRelatedScope[] = [];
    const seen = new Set<string>();
    for (const edge of edges as EdgeRow[]) {
      const isOutgoing = edge.fromScopeType === cmd.scopeType && edge.fromScopeId === cmd.scopeId;
      const targetType = isOutgoing ? edge.toScopeType : edge.fromScopeType;
      const targetId = isOutgoing ? edge.toScopeId : edge.fromScopeId;
      const target = await this.resolveLiveScope(targetType, targetId);
      if (!target || target.workspaceId !== anchor.workspaceId) continue;
      const key = `${target.scopeType}:${target.scopeId}:${edge.edgeType}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const relation = target.projectId === anchor.projectId ? 'same_project' : 'cross_project';
      out.push({
        ...target,
        edgeId: edge.id,
        edgeType: edge.edgeType,
        origin: edge.origin,
        confidence: edge.confidence === null ? null : Number(edge.confidence),
        direction: isOutgoing ? 'out' : 'in',
        relation,
        weight: relation === 'cross_project' ? 0.6 : 1,
      });
    }

    return out
      .sort((a, b) => b.weight - a.weight || (b.confidence ?? 0) - (a.confidence ?? 0) || a.scopePath.localeCompare(b.scopePath))
      .slice(0, cmd.limit ?? 12);
  }

  async inferClassifierEdges(cmd: InferClassifierEdgesCommand): Promise<InferClassifierEdgesResult> {
    const minSharedTags = cmd.minSharedTags ?? 2;
    const tagRows = await this.db
      .select({
        scopeType: schema.scopeTags.scopeType,
        scopeId: schema.scopeTags.scopeId,
        key: schema.contextTags.key,
        normalizedValue: schema.contextTags.normalizedValue,
      })
      .from(schema.scopeTags)
      .innerJoin(schema.contextTags, eq(schema.scopeTags.tagId, schema.contextTags.id))
      .where(and(
        eq(schema.scopeTags.workspaceId, cmd.workspaceId),
        isNull(schema.scopeTags.deletedAt),
        inArray(schema.scopeTags.scopeType, ['project', 'channel', 'topic', 'thread']),
      ));

    const tagMap = new Map<string, { scopeType: ContextGraphScopeType; scopeId: string; tags: Set<string>; scope: LiveScope }>();
    for (const row of tagRows) {
      const scopeType = row.scopeType as ContextGraphScopeType;
      const scope = await this.resolveLiveScope(scopeType, row.scopeId);
      if (!scope || scope.workspaceId !== cmd.workspaceId) continue;
      const mapKey = `${scopeType}:${row.scopeId}`;
      const current = tagMap.get(mapKey) ?? { scopeType, scopeId: row.scopeId, tags: new Set<string>(), scope };
      current.tags.add(`${row.key}:${row.normalizedValue}`);
      tagMap.set(mapKey, current);
    }

    const scopes = [...tagMap.values()].filter((item) => item.tags.size >= minSharedTags)
      .sort((a, b) => a.scope.scopePath.localeCompare(b.scope.scopePath));
    let pairsScanned = 0;
    let edgesCreated = 0;
    for (let i = 0; i < scopes.length; i += 1) {
      for (let j = i + 1; j < scopes.length; j += 1) {
        const left = scopes[i]!;
        const right = scopes[j]!;
        pairsScanned += 1;
        const shared = intersectionSize(left.tags, right.tags);
        if (shared < minSharedTags) continue;
        const union = new Set([...left.tags, ...right.tags]).size;
        const confidence = union === 0 ? 0 : shared / union;
        const inserted = await this.upsertClassifierEdge(left.scope, right.scope, confidence);
        if (inserted) edgesCreated += 1;
      }
    }

    return { scopesScanned: scopes.length, pairsScanned, edgesCreated };
  }

  private async upsertClassifierEdge(from: LiveScope, to: LiveScope, confidence: number): Promise<boolean> {
    const [canonicalFrom, canonicalTo] = orderClassifierScopes(from, to);
    const [existing] = await this.db
      .select({ id: schema.contextEdges.id, deletedAt: schema.contextEdges.deletedAt })
      .from(schema.contextEdges)
      .where(and(
        or(
          and(
            eq(schema.contextEdges.fromScopeType, canonicalFrom.scopeType),
            eq(schema.contextEdges.fromScopeId, canonicalFrom.scopeId),
            eq(schema.contextEdges.toScopeType, canonicalTo.scopeType),
            eq(schema.contextEdges.toScopeId, canonicalTo.scopeId),
          ),
          and(
            eq(schema.contextEdges.fromScopeType, canonicalTo.scopeType),
            eq(schema.contextEdges.fromScopeId, canonicalTo.scopeId),
            eq(schema.contextEdges.toScopeType, canonicalFrom.scopeType),
            eq(schema.contextEdges.toScopeId, canonicalFrom.scopeId),
          ),
        ),
        eq(schema.contextEdges.edgeType, 'related_to'),
        eq(schema.contextEdges.origin, 'classifier'),
      ))
      .limit(1);

    const now = new Date();
    const confidenceText = confidence.toFixed(4);
    if (existing) {
      if (existing.deletedAt !== null) {
        await this.db
          .update(schema.contextEdges)
          .set({ deletedAt: null, origin: 'classifier', confidence: confidenceText, updatedAt: now })
          .where(eq(schema.contextEdges.id, existing.id));
        return true;
      }
      return false;
    }

    await this.db.insert(schema.contextEdges).values({
      workspaceId: canonicalFrom.workspaceId,
      fromScopeType: canonicalFrom.scopeType,
      fromScopeId: canonicalFrom.scopeId,
      toScopeType: canonicalTo.scopeType,
      toScopeId: canonicalTo.scopeId,
      edgeType: 'related_to',
      origin: 'classifier',
      confidence: confidenceText,
    });
    return true;
  }

  async resolveLiveScope(scopeType: ContextGraphScopeType, scopeId: string): Promise<LiveScope | null> {
    if (scopeType === 'project') return this.projectScope(scopeId);
    if (scopeType === 'channel') return this.channelScope(scopeId);
    if (scopeType === 'topic') return this.topicScope(scopeId);
    return this.threadScope(scopeId);
  }

  private async projectScope(id: string): Promise<LiveScope | null> {
    const [row] = await this.db
      .select({ id: schema.projects.id, workspaceId: schema.projects.workspaceId, name: schema.projects.name })
      .from(schema.projects)
      .where(and(eq(schema.projects.id, id), eq(schema.projects.status, 'active'), isNull(schema.projects.deletedAt)))
      .limit(1);
    if (!row) return null;
    return {
      scopeType: 'project', scopeId: row.id, workspaceId: row.workspaceId,
      projectId: row.id, projectName: row.name,
      channelId: null, channelName: null, topicId: null, topicName: null, threadId: null, threadTitle: null,
      name: row.name, scopePath: row.name,
    };
  }

  private async channelScope(id: string): Promise<LiveScope | null> {
    const [row] = await this.db
      .select({
        id: schema.channels.id,
        workspaceId: schema.channels.workspaceId,
        name: schema.channels.name,
        projectId: schema.projects.id,
        projectName: schema.projects.name,
      })
      .from(schema.channels)
      .innerJoin(schema.projects, eq(schema.channels.projectId, schema.projects.id))
      .where(and(
        eq(schema.channels.id, id),
        eq(schema.channels.status, 'active'),
        isNull(schema.channels.deletedAt),
        eq(schema.projects.status, 'active'),
        isNull(schema.projects.deletedAt),
      ))
      .limit(1);
    if (!row) return null;
    return {
      scopeType: 'channel', scopeId: row.id, workspaceId: row.workspaceId,
      projectId: row.projectId, projectName: row.projectName,
      channelId: row.id, channelName: row.name, topicId: null, topicName: null, threadId: null, threadTitle: null,
      name: row.name, scopePath: `${row.projectName} > ${row.name}`,
    };
  }

  private async topicScope(id: string): Promise<LiveScope | null> {
    const [row] = await this.db
      .select({
        id: schema.topics.id,
        workspaceId: schema.topics.workspaceId,
        name: schema.topics.name,
        channelId: schema.channels.id,
        channelName: schema.channels.name,
        projectId: schema.projects.id,
        projectName: schema.projects.name,
      })
      .from(schema.topics)
      .innerJoin(schema.channels, eq(schema.topics.channelId, schema.channels.id))
      .innerJoin(schema.projects, eq(schema.channels.projectId, schema.projects.id))
      .where(and(
        eq(schema.topics.id, id),
        eq(schema.topics.status, 'active'),
        isNull(schema.topics.deletedAt),
        eq(schema.channels.status, 'active'),
        isNull(schema.channels.deletedAt),
        eq(schema.projects.status, 'active'),
        isNull(schema.projects.deletedAt),
      ))
      .limit(1);
    if (!row) return null;
    return {
      scopeType: 'topic', scopeId: row.id, workspaceId: row.workspaceId,
      projectId: row.projectId, projectName: row.projectName,
      channelId: row.channelId, channelName: row.channelName, topicId: row.id, topicName: row.name, threadId: null, threadTitle: null,
      name: row.name, scopePath: `${row.projectName} > ${row.channelName} > ${row.name}`,
    };
  }

  private async threadScope(id: string): Promise<LiveScope | null> {
    const [row] = await this.db
      .select({
        id: schema.threads.id,
        workspaceId: schema.threads.workspaceId,
        title: schema.threads.title,
        topicId: schema.topics.id,
        topicName: schema.topics.name,
        channelId: schema.channels.id,
        channelName: schema.channels.name,
        projectId: schema.projects.id,
        projectName: schema.projects.name,
      })
      .from(schema.threads)
      .innerJoin(schema.topics, eq(schema.threads.topicId, schema.topics.id))
      .innerJoin(schema.channels, eq(schema.topics.channelId, schema.channels.id))
      .innerJoin(schema.projects, eq(schema.channels.projectId, schema.projects.id))
      .where(and(
        eq(schema.threads.id, id),
        eq(schema.threads.status, 'active'),
        isNull(schema.threads.deletedAt),
        eq(schema.topics.status, 'active'),
        isNull(schema.topics.deletedAt),
        eq(schema.channels.status, 'active'),
        isNull(schema.channels.deletedAt),
        eq(schema.projects.status, 'active'),
        isNull(schema.projects.deletedAt),
      ))
      .limit(1);
    if (!row) return null;
    return {
      scopeType: 'thread', scopeId: row.id, workspaceId: row.workspaceId,
      projectId: row.projectId, projectName: row.projectName,
      channelId: row.channelId, channelName: row.channelName, topicId: row.topicId, topicName: row.topicName, threadId: row.id, threadTitle: row.title,
      name: row.title, scopePath: `${row.projectName} > ${row.channelName} > ${row.topicName} > ${row.title}`,
    };
  }
}

function intersectionSize(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const value of left) {
    if (right.has(value)) count += 1;
  }
  return count;
}

function orderClassifierScopes(left: LiveScope, right: LiveScope): [LiveScope, LiveScope] {
  return scopeStableKey(left).localeCompare(scopeStableKey(right)) <= 0 ? [left, right] : [right, left];
}

function isSymmetricProjectEdge(cmd: CreateContextEdgeCommand): boolean {
  return cmd.fromScopeType === 'project' && cmd.toScopeType === 'project' && SYMMETRIC_PROJECT_EDGE_TYPES.includes(cmd.edgeType);
}

function orderProjectPair(left: string, right: string): [string, string] {
  return left.localeCompare(right) <= 0 ? [left, right] : [right, left];
}

function scopeStableKey(scope: LiveScope): string {
  return `${scope.scopeType}:${scope.scopeId}`;
}
