import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, eq, isNull } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';
import { ContextGraphService, type ContextGraphRelatedScope } from '../spaces/context-graph.service.js';

export interface ConsultingResolvedScope {
  workspaceId: string;
  projectId: string;
  channelId: string;
  topicId: string;
  threadId: string;
  projectName: string;
  channelName: string;
  topicName: string;
  threadTitle: string;
  consultingTopicSlug: string;
  consultingTopicId: number | null;
  linkLevel: 'project' | 'channel' | 'topic' | 'thread';
  scopePath: string;
  archived: boolean;
  profiles?: ConsultingScopeProfile[];
}

export interface ConsultingScopeProfile {
  scopeType: 'channel' | 'topic';
  scopeId: string;
  purpose: string;
  role: string;
  style: string;
  rules: string;
  source: 'template' | 'manual' | 'inferred';
}

export interface ConsultingRecallScope {
  topicSlug: string;
  topicId: number | null;
  label: string;
  relation: 'current' | 'cross_project';
  weight: number;
  archived: boolean;
}

export interface ConsultingResolvedFanout {
  scope: ConsultingResolvedScope;
  recallScopes: ConsultingRecallScope[];
}

type ScopeRow = {
  workspaceId: string;
  projectId: string;
  channelId: string;
  topicId: string;
  threadId: string;
  projectName: string;
  channelName: string;
  topicName: string;
  threadTitle: string;
};

type LinkRow = {
  consultingTopicSlug: string;
  consultingTopicId: number | null;
  linkLevel: string;
  scopePath: string;
  status: string;
};

@Injectable()
export class ConsultingTopicResolver {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(ContextGraphService) private readonly contextGraph: ContextGraphService,
  ) {}

  async resolveThread(threadId: string): Promise<ConsultingResolvedScope | null> {
    const scope = await this.scopeForThread(threadId);
    if (!scope) return null;
    const link = await this.bestLink(scope);
    if (!link) return null;
    const profiles = await this.scopeProfiles(scope);
    return {
      ...scope,
      consultingTopicSlug: link.consultingTopicSlug,
      consultingTopicId: link.consultingTopicId,
      linkLevel: this.normalizeLevel(link.linkLevel),
      scopePath: link.scopePath || this.defaultScopePath(scope),
      archived: link.status === 'archived',
      profiles,
    };
  }

  async resolveThreadFanout(threadId: string): Promise<ConsultingResolvedFanout | null> {
    const scope = await this.resolveThread(threadId);
    if (!scope) return null;
    const recallScopes: ConsultingRecallScope[] = [{
      topicSlug: scope.consultingTopicSlug,
      topicId: scope.consultingTopicId,
      label: `현재 프로젝트: ${scope.projectName}`,
      relation: 'current',
      weight: 1,
      archived: scope.archived,
    }];

    const related = await this.contextGraphLinks(scope);
    const seen = new Set(recallScopes.map((item) => item.topicSlug));
    for (const relatedScope of related) {
      const link = await this.bestLinkForGraphScope(relatedScope);
      if (!link) continue;
      if (seen.has(link.consultingTopicSlug)) continue;
      seen.add(link.consultingTopicSlug);
      recallScopes.push({
        topicSlug: link.consultingTopicSlug,
        topicId: link.consultingTopicId,
        label: relatedScope.relation === 'cross_project'
          ? `다른 프로젝트: ${relatedScope.projectName}`
          : `관련 범위: ${relatedScope.scopePath}`,
        relation: relatedScope.relation === 'cross_project' ? 'cross_project' : 'current',
        weight: relatedScope.weight,
        archived: link.status === 'archived',
      });
    }
    return { scope, recallScopes };
  }

  async scopeForThread(threadId: string): Promise<ScopeRow | null> {
    const [row] = await this.db
      .select({
        workspaceId: schema.threads.workspaceId,
        projectId: schema.channels.projectId,
        channelId: schema.channels.id,
        topicId: schema.topics.id,
        threadId: schema.threads.id,
        projectName: schema.projects.name,
        channelName: schema.channels.name,
        topicName: schema.topics.name,
        threadTitle: schema.threads.title,
      })
      .from(schema.threads)
      .innerJoin(schema.topics, eq(schema.threads.topicId, schema.topics.id))
      .innerJoin(schema.channels, eq(schema.topics.channelId, schema.channels.id))
      .innerJoin(schema.projects, eq(schema.channels.projectId, schema.projects.id))
      .where(and(
        eq(schema.threads.id, threadId),
        isNull(schema.threads.deletedAt),
        isNull(schema.topics.deletedAt),
        isNull(schema.channels.deletedAt),
        isNull(schema.projects.deletedAt),
      ))
      .limit(1);
    return row ?? null;
  }

  private async bestLink(scope: ScopeRow): Promise<LinkRow | null> {
    const queries = [
      and(eq(schema.consultingTopicLinks.threadId, scope.threadId), eq(schema.consultingTopicLinks.linkLevel, 'thread'), eq(schema.consultingTopicLinks.status, 'active')),
      and(eq(schema.consultingTopicLinks.webTopicId, scope.topicId), eq(schema.consultingTopicLinks.linkLevel, 'topic'), eq(schema.consultingTopicLinks.status, 'active')),
      and(eq(schema.consultingTopicLinks.channelId, scope.channelId), eq(schema.consultingTopicLinks.linkLevel, 'channel'), eq(schema.consultingTopicLinks.status, 'active')),
      and(eq(schema.consultingTopicLinks.projectId, scope.projectId), eq(schema.consultingTopicLinks.linkLevel, 'project'), eq(schema.consultingTopicLinks.status, 'active')),
    ];
    for (const where of queries) {
      const [link] = await this.db
        .select({
          consultingTopicSlug: schema.consultingTopicLinks.consultingTopicSlug,
          consultingTopicId: schema.consultingTopicLinks.consultingTopicId,
          linkLevel: schema.consultingTopicLinks.linkLevel,
          scopePath: schema.consultingTopicLinks.scopePath,
          status: schema.consultingTopicLinks.status,
        })
        .from(schema.consultingTopicLinks)
        .where(where)
        .limit(1);
      if (link) return link;
    }
    return null;
  }

  private async bestLinkForGraphScope(scope: ContextGraphRelatedScope): Promise<LinkRow | null> {
    const queries = [];
    if (scope.threadId) queries.push(and(eq(schema.consultingTopicLinks.threadId, scope.threadId), eq(schema.consultingTopicLinks.linkLevel, 'thread'), eq(schema.consultingTopicLinks.status, 'active')));
    if (scope.topicId) queries.push(and(eq(schema.consultingTopicLinks.webTopicId, scope.topicId), eq(schema.consultingTopicLinks.linkLevel, 'topic'), eq(schema.consultingTopicLinks.status, 'active')));
    if (scope.channelId) queries.push(and(eq(schema.consultingTopicLinks.channelId, scope.channelId), eq(schema.consultingTopicLinks.linkLevel, 'channel'), eq(schema.consultingTopicLinks.status, 'active')));
    queries.push(and(eq(schema.consultingTopicLinks.projectId, scope.projectId), eq(schema.consultingTopicLinks.linkLevel, 'project'), eq(schema.consultingTopicLinks.status, 'active')));

    for (const where of queries) {
      const [link] = await this.db
        .select({
          consultingTopicSlug: schema.consultingTopicLinks.consultingTopicSlug,
          consultingTopicId: schema.consultingTopicLinks.consultingTopicId,
          linkLevel: schema.consultingTopicLinks.linkLevel,
          scopePath: schema.consultingTopicLinks.scopePath,
          status: schema.consultingTopicLinks.status,
        })
        .from(schema.consultingTopicLinks)
        .where(and(eq(schema.consultingTopicLinks.workspaceId, scope.workspaceId), where))
        .limit(1);
      if (link) return link;
    }
    return null;
  }

  private async contextGraphLinks(scope: ConsultingResolvedScope): Promise<ContextGraphRelatedScope[]> {
    const anchors = [
      { scopeType: 'thread' as const, scopeId: scope.threadId },
      { scopeType: 'topic' as const, scopeId: scope.topicId },
      { scopeType: 'channel' as const, scopeId: scope.channelId },
      { scopeType: 'project' as const, scopeId: scope.projectId },
    ];
    const seen = new Set<string>();
    const out: ContextGraphRelatedScope[] = [];
    for (const anchor of anchors) {
      const links = await this.contextGraph.traverseRelatedScopes(anchor);
      for (const link of links) {
        const key = `${link.scopeType}:${link.scopeId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(link);
      }
    }
    return out.sort((a, b) => b.weight - a.weight || (b.confidence ?? 0) - (a.confidence ?? 0) || a.scopePath.localeCompare(b.scopePath));
  }

  private normalizeLevel(level: string): ConsultingResolvedScope['linkLevel'] {
    if (level === 'thread' || level === 'topic' || level === 'channel' || level === 'project') return level;
    return 'project';
  }

  private async scopeProfiles(scope: ScopeRow): Promise<ConsultingScopeProfile[]> {
    try {
      const rows = await this.db
        .select({
          scopeType: schema.scopeProfiles.scopeType,
          scopeId: schema.scopeProfiles.scopeId,
          purpose: schema.scopeProfiles.purpose,
          role: schema.scopeProfiles.role,
          style: schema.scopeProfiles.style,
          rules: schema.scopeProfiles.rules,
          source: schema.scopeProfiles.source,
        })
        .from(schema.scopeProfiles)
        .where(and(eq(schema.scopeProfiles.workspaceId, scope.workspaceId), isNull(schema.scopeProfiles.deletedAt)));
      const wanted = new Set([`channel:${scope.channelId}`, `topic:${scope.topicId}`]);
      return rows
        .filter((row) => wanted.has(`${row.scopeType}:${row.scopeId}`))
        .sort((a, b) => (a.scopeType === b.scopeType ? 0 : a.scopeType === 'channel' ? -1 : 1))
        .map((row) => ({
          scopeType: row.scopeType === 'topic' ? 'topic' : 'channel',
          scopeId: row.scopeId,
          purpose: row.purpose,
          role: row.role,
          style: row.style,
          rules: row.rules,
          source: row.source === 'manual' || row.source === 'inferred' ? row.source : 'template',
        }));
    } catch (error) {
      if (isMissingRelationError(error, 'scope_profiles')) return [];
      throw error;
    }
  }

  private defaultScopePath(scope: ScopeRow): string {
    return `${scope.projectName}/${scope.channelName}/${scope.topicName}/${scope.threadTitle}`;
  }
}

function isMissingRelationError(error: unknown, relationName: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { code?: unknown; cause?: unknown; message?: unknown };
  const cause = record.cause as { code?: unknown; message?: unknown } | undefined;
  const message = `${typeof record.message === 'string' ? record.message : ''}\n${typeof cause?.message === 'string' ? cause.message : ''}`;
  return record.code === '42P01' || cause?.code === '42P01' || message.includes(relationName);
}
