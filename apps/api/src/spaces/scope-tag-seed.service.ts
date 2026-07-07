import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@consulting/db-schema';
import { and, eq, isNull } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../infra/drizzle.module.js';

type ScopeType = 'project' | 'channel' | 'topic';

export interface ScopeTagSeedResult {
  scopesScanned: number;
  tagsCreated: number;
}

export interface ScopeTagSeedPreview {
  scopesScanned: number;
  tagsSuggested: number;
  scopes: Array<{ scopeType: ScopeType; scopeId: string; tags: DerivedTag[] }>;
}

interface ScopeCandidate {
  scopeType: ScopeType;
  scopeId: string;
  workspaceId: string;
  text: string;
}

interface DerivedTag {
  key: string;
  value: string;
  normalizedValue: string;
}

/**
 * Seeds deterministic, low-risk classifier tags from existing scope metadata.
 * This is the prerequisite for tag-overlap related_to inference: old workspaces
 * may have zero scope_tags because project creation tags were optional.
 */
@Injectable()
export class ScopeTagSeedService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async seedWorkspace(workspaceId: string): Promise<ScopeTagSeedResult> {
    const scopes = await this.loadCandidates(workspaceId);
    let tagsCreated = 0;

    for (const scope of scopes) {
      const tags = deriveScopeTags(scope.text);
      for (const tag of tags) {
        const inserted = await this.applyTag(scope, tag);
        if (inserted) tagsCreated += 1;
      }
    }

    return { scopesScanned: scopes.length, tagsCreated };
  }

  async previewWorkspace(workspaceId: string): Promise<ScopeTagSeedPreview> {
    const scopes = await this.loadCandidates(workspaceId);
    const preview = scopes.map((scope) => ({
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      tags: deriveScopeTags(scope.text),
    }));
    return {
      scopesScanned: scopes.length,
      tagsSuggested: preview.reduce((sum, scope) => sum + scope.tags.length, 0),
      scopes: preview,
    };
  }

  private async loadCandidates(workspaceId: string): Promise<ScopeCandidate[]> {
    const projects = await this.db
      .select({
        id: schema.projects.id,
        workspaceId: schema.projects.workspaceId,
        name: schema.projects.name,
        slug: schema.projects.slug,
      })
      .from(schema.projects)
      .where(and(
        eq(schema.projects.workspaceId, workspaceId),
        eq(schema.projects.status, 'active'),
        isNull(schema.projects.deletedAt),
      ));

    const channels = await this.db
      .select({
        id: schema.channels.id,
        workspaceId: schema.channels.workspaceId,
        name: schema.channels.name,
        slug: schema.channels.slug,
        projectName: schema.projects.name,
        projectSlug: schema.projects.slug,
      })
      .from(schema.channels)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.channels.projectId))
      .where(and(
        eq(schema.channels.workspaceId, workspaceId),
        eq(schema.channels.status, 'active'),
        isNull(schema.channels.deletedAt),
        eq(schema.projects.status, 'active'),
        isNull(schema.projects.deletedAt),
      ));

    const topics = await this.db
      .select({
        id: schema.topics.id,
        workspaceId: schema.topics.workspaceId,
        name: schema.topics.name,
        slug: schema.topics.slug,
        memoryTopicId: schema.topics.memoryTopicId,
        channelName: schema.channels.name,
        channelSlug: schema.channels.slug,
        projectName: schema.projects.name,
        projectSlug: schema.projects.slug,
      })
      .from(schema.topics)
      .innerJoin(schema.channels, eq(schema.channels.id, schema.topics.channelId))
      .innerJoin(schema.projects, eq(schema.projects.id, schema.channels.projectId))
      .where(and(
        eq(schema.topics.workspaceId, workspaceId),
        eq(schema.topics.status, 'active'),
        isNull(schema.topics.deletedAt),
        eq(schema.channels.status, 'active'),
        isNull(schema.channels.deletedAt),
        eq(schema.projects.status, 'active'),
        isNull(schema.projects.deletedAt),
      ));

    return [
      ...projects.map((p) => ({
        scopeType: 'project' as const,
        scopeId: p.id,
        workspaceId: p.workspaceId,
        text: joinText(p.name, p.slug),
      })),
      ...channels.map((c) => ({
        scopeType: 'channel' as const,
        scopeId: c.id,
        workspaceId: c.workspaceId,
        text: joinText(c.name, c.slug, c.projectName, c.projectSlug),
      })),
      ...topics.map((t) => ({
        scopeType: 'topic' as const,
        scopeId: t.id,
        workspaceId: t.workspaceId,
        text: joinText(t.name, t.slug, t.memoryTopicId, t.channelName, t.channelSlug, t.projectName, t.projectSlug),
      })),
    ];
  }

  private async applyTag(scope: ScopeCandidate, tag: DerivedTag): Promise<boolean> {
    const [tagRow] = await this.db
      .insert(schema.contextTags)
      .values({ key: tag.key, value: tag.value, normalizedValue: tag.normalizedValue })
      .onConflictDoUpdate({
        target: [schema.contextTags.key, schema.contextTags.normalizedValue],
        set: { value: tag.value },
      })
      .returning({ id: schema.contextTags.id });
    if (!tagRow) return false;

    const [existing] = await this.db
      .select({ id: schema.scopeTags.id, deletedAt: schema.scopeTags.deletedAt })
      .from(schema.scopeTags)
      .where(and(
        eq(schema.scopeTags.scopeType, scope.scopeType),
        eq(schema.scopeTags.scopeId, scope.scopeId),
        eq(schema.scopeTags.tagId, tagRow.id),
      ))
      .limit(1);

    if (existing) {
      if (existing.deletedAt !== null) {
        await this.db
          .update(schema.scopeTags)
          .set({ deletedAt: null, origin: 'classifier' })
          .where(eq(schema.scopeTags.id, existing.id));
        return true;
      }
      return false;
    }

    await this.db.insert(schema.scopeTags).values({
      workspaceId: scope.workspaceId,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      tagId: tagRow.id,
      origin: 'classifier',
      confidence: '0.8',
    });
    return true;
  }
}

export function deriveScopeTags(text: string): DerivedTag[] {
  const haystack = normalizeText(text);
  const tags: DerivedTag[] = [];

  if (matchesAny(haystack, ['changwon', '창원'])) tags.push(tag('client', 'changwon'));
  if (matchesAny(haystack, ['organization', 'org-', 'org_', '조직', '진단', 'diagnosis', 'mgmt'])) {
    tags.push(tag('domain', 'organization-diagnosis'));
  }
  if (matchesAny(haystack, ['data-collection', 'data_collection', '자료', '수집'])) {
    tags.push(tag('phase', 'data-collection'));
  }
  if (matchesAny(haystack, ['analysis', '분석'])) tags.push(tag('phase', 'analysis'));
  if (matchesAny(haystack, ['report', '보고서', '결과보고'])) tags.push(tag('phase', 'report'));
  if (matchesAny(haystack, ['telegram', '텔레그램'])) tags.push(tag('source', 'telegram'));
  if (matchesAny(haystack, ['budget', '예산'])) tags.push(tag('topic', 'budget'));
  if (matchesAny(haystack, ['field-audit', 'field_audit', 'audit', '현장', '감사'])) tags.push(tag('topic', 'field-audit'));

  return dedupeTags(tags);
}

function joinText(...parts: Array<string | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

function normalizeText(text: string): string {
  return text.trim().toLowerCase();
}

function matchesAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

function tag(key: string, value: string): DerivedTag {
  return { key, value, normalizedValue: value.trim().toLowerCase() };
}

function dedupeTags(tags: DerivedTag[]): DerivedTag[] {
  const seen = new Set<string>();
  const out: DerivedTag[] = [];
  for (const tag of tags) {
    const key = `${tag.key}:${tag.normalizedValue}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}
