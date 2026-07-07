import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { DB_POOL } from '../infra/db.module.js';

export const CHANGWON_CONSULTING_BRAIN_SLUG = 'changwon-org-mgmt-diagnosis';
export const TEST_PROJECT_ID = '61f95d26-33e7-47ea-a374-7b19da02c39a';

export interface ProjectProvisioningQueryRow {
  project_id: string;
  workspace_id: string;
  project_name: string;
  project_slug: string;
  channel_count: string | number | bigint;
  topic_count: string | number | bigint;
  thread_count: string | number | bigint;
  message_count: string | number | bigint;
  active_consulting_link_count: string | number | bigint;
  consulting_topic_slugs: unknown;
  memory_topic_ids: unknown;
}

export interface ProjectProvisioningReportProject {
  projectId: string;
  workspaceId: string;
  name: string;
  slug: string;
  expectedDefaultBrainSlug: string;
  provisioningStatus: 'provisioned' | 'unprovisioned';
  counts: {
    channels: number;
    topics: number;
    threads: number;
    messages: number;
    activeConsultingLinks: number;
  };
  consultingTopicSlugs: string[];
  memoryTopicIds: string[];
  isolation: {
    ok: boolean;
    issues: string[];
  };
  issues: string[];
}

export interface ProjectProvisioningReport {
  generatedAt: string;
  readOnly: true;
  projects: ProjectProvisioningReportProject[];
  totals: {
    projects: number;
    provisioned: number;
    unprovisioned: number;
    isolationViolations: number;
  };
}

const PROJECT_PROVISIONING_REPORT_SQL = `
with active_projects as (
  select id, workspace_id, name, slug
  from projects
  where status = 'active' and deleted_at is null
)
select
  p.id::text as project_id,
  p.workspace_id::text as workspace_id,
  p.name as project_name,
  p.slug as project_slug,
  coalesce(ch.channel_count, '0') as channel_count,
  coalesce(tp.topic_count, '0') as topic_count,
  coalesce(th.thread_count, '0') as thread_count,
  coalesce(msg.message_count, '0') as message_count,
  coalesce(link.active_consulting_link_count, '0') as active_consulting_link_count,
  coalesce(link.consulting_topic_slugs, array[]::text[]) as consulting_topic_slugs,
  coalesce(mem.memory_topic_ids, array[]::text[]) as memory_topic_ids
from active_projects p
left join lateral (
  select count(*)::text as channel_count
  from channels c
  where c.project_id = p.id and c.status = 'active' and c.deleted_at is null
) ch on true
left join lateral (
  select count(*)::text as topic_count
  from topics t
  inner join channels c on c.id = t.channel_id
  where c.project_id = p.id
    and c.status = 'active' and c.deleted_at is null
    and t.status = 'active' and t.deleted_at is null
) tp on true
left join lateral (
  select count(*)::text as thread_count
  from threads th
  inner join topics t on t.id = th.topic_id
  inner join channels c on c.id = t.channel_id
  where c.project_id = p.id
    and c.status = 'active' and c.deleted_at is null
    and t.status = 'active' and t.deleted_at is null
    and th.status = 'active' and th.deleted_at is null
) th on true
left join lateral (
  select count(*)::text as message_count
  from chat_messages m
  inner join threads th on th.id = m.thread_id
  inner join topics t on t.id = th.topic_id
  inner join channels c on c.id = t.channel_id
  where c.project_id = p.id
    and c.status = 'active' and c.deleted_at is null
    and t.status = 'active' and t.deleted_at is null
    and th.status = 'active' and th.deleted_at is null
    and m.deleted_at is null
) msg on true
left join lateral (
  select
    count(*)::text as active_consulting_link_count,
    array_agg(distinct l.consulting_topic_slug order by l.consulting_topic_slug) as consulting_topic_slugs
  from consulting_topic_links l
  where l.project_id = p.id
    and l.workspace_id = p.workspace_id
    and l.status = 'active'
    and l.archived_at is null
    and (
      l.link_level = 'project'
      or exists (
        select 1
        from channels c2
        where c2.id = l.channel_id
          and c2.workspace_id = p.workspace_id
          and c2.project_id = p.id
          and c2.status = 'active'
          and c2.deleted_at is null
      )
      or exists (
        select 1
        from topics t2
        inner join channels c2 on c2.id = t2.channel_id
        where t2.id = l.web_topic_id
          and t2.workspace_id = p.workspace_id
          and t2.status = 'active'
          and t2.deleted_at is null
          and c2.workspace_id = p.workspace_id
          and c2.project_id = p.id
          and c2.status = 'active'
          and c2.deleted_at is null
      )
      or exists (
        select 1
        from threads th2
        inner join topics t2 on t2.id = th2.topic_id
        inner join channels c2 on c2.id = t2.channel_id
        where th2.id = l.thread_id
          and th2.workspace_id = p.workspace_id
          and th2.status = 'active'
          and th2.deleted_at is null
          and t2.workspace_id = p.workspace_id
          and t2.status = 'active'
          and t2.deleted_at is null
          and c2.workspace_id = p.workspace_id
          and c2.project_id = p.id
          and c2.status = 'active'
          and c2.deleted_at is null
      )
    )
) link on true
left join lateral (
  select array_agg(distinct t.memory_topic_id order by t.memory_topic_id) filter (where t.memory_topic_id is not null) as memory_topic_ids
  from topics t
  inner join channels c on c.id = t.channel_id
  where c.project_id = p.id
    and c.status = 'active' and c.deleted_at is null
    and t.status = 'active' and t.deleted_at is null
) mem on true
order by p.name, p.slug;
`;

export type ProjectProvisioningReportQueryable = Pick<Pool, 'query'>;

@Injectable()
export class ProjectProvisioningReportService {
  constructor(@Inject(DB_POOL) private readonly pool: ProjectProvisioningReportQueryable) {}

  async loadReport(generatedAt = new Date()): Promise<ProjectProvisioningReport> {
    const result = await this.pool.query<ProjectProvisioningQueryRow>(PROJECT_PROVISIONING_REPORT_SQL);
    return buildProjectProvisioningReport(result.rows, generatedAt);
  }
}

export function buildProjectProvisioningReport(
  rows: ProjectProvisioningQueryRow[],
  generatedAt = new Date('2026-07-07T00:00:00.000Z'),
): ProjectProvisioningReport {
  const projects = rows.map((row) => buildProjectRow(row));
  return {
    generatedAt: generatedAt.toISOString(),
    readOnly: true,
    projects,
    totals: {
      projects: projects.length,
      provisioned: projects.filter((project) => project.provisioningStatus === 'provisioned').length,
      unprovisioned: projects.filter((project) => project.provisioningStatus === 'unprovisioned').length,
      isolationViolations: projects.filter((project) => !project.isolation.ok).length,
    },
  };
}

function buildProjectRow(row: ProjectProvisioningQueryRow): ProjectProvisioningReportProject {
  const consultingTopicSlugs = uniqueStrings(row.consulting_topic_slugs);
  const memoryTopicIds = uniqueStrings(row.memory_topic_ids);
  const activeConsultingLinks = toNumber(row.active_consulting_link_count);
  const issues: string[] = [];

  if (activeConsultingLinks === 0) issues.push('consulting_links=0');
  if (consultingTopicSlugs.length > 1) issues.push('multiple_active_brain_slugs');

  const isolationIssues = brainIsolationIssues({
    projectId: row.project_id,
    projectName: row.project_name,
    projectSlug: row.project_slug,
    consultingTopicSlugs,
  });

  return {
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    name: row.project_name,
    slug: row.project_slug,
    expectedDefaultBrainSlug: defaultBrainSlug(row.project_slug, row.project_id),
    provisioningStatus: activeConsultingLinks === 0 ? 'unprovisioned' : 'provisioned',
    counts: {
      channels: toNumber(row.channel_count),
      topics: toNumber(row.topic_count),
      threads: toNumber(row.thread_count),
      messages: toNumber(row.message_count),
      activeConsultingLinks,
    },
    consultingTopicSlugs,
    memoryTopicIds,
    isolation: { ok: isolationIssues.length === 0, issues: isolationIssues },
    issues: [...issues, ...isolationIssues],
  };
}

function brainIsolationIssues(input: {
  projectId: string;
  projectName: string;
  projectSlug: string;
  consultingTopicSlugs: string[];
}): string[] {
  const issues: string[] = [];
  const expectedDefaultBrainSlug = defaultBrainSlug(input.projectSlug, input.projectId);
  const isTestProject =
    input.projectId === TEST_PROJECT_ID || input.projectName.trim().toLowerCase() === 'test' || expectedDefaultBrainSlug === 'test';
  const isChangwonProject = input.projectName.includes('창원') || expectedDefaultBrainSlug === CHANGWON_CONSULTING_BRAIN_SLUG;

  if (isTestProject && input.consultingTopicSlugs.includes(CHANGWON_CONSULTING_BRAIN_SLUG)) {
    issues.push('TEST project is linked to Changwon brain slug');
  }
  if (isTestProject && input.consultingTopicSlugs.some((slug) => slug !== expectedDefaultBrainSlug)) {
    issues.push('TEST project is linked to a non-project brain slug');
  }
  if (!isChangwonProject && input.consultingTopicSlugs.includes(CHANGWON_CONSULTING_BRAIN_SLUG)) {
    issues.push('Non-Changwon project is linked to Changwon brain slug');
  }
  if (isChangwonProject && input.consultingTopicSlugs.some((slug) => slug !== CHANGWON_CONSULTING_BRAIN_SLUG)) {
    issues.push('Changwon project is linked to a non-Changwon brain slug');
  }
  if (input.consultingTopicSlugs.length > 1) {
    issues.push('Project has multiple active consulting brain slugs');
  }

  return issues;
}

function uniqueStrings(value: unknown): string[] {
  if (Array.isArray(value)) return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))].sort();
  if (typeof value === 'string' && value.length > 0) return [value];
  return [];
}

function toNumber(value: string | number | bigint | null | undefined): number {
  if (typeof value === 'bigint') return Number(value);
  if (value == null) return 0;
  return Number(value);
}

function defaultBrainSlug(projectSlug: string, projectId: string): string {
  const normalized = projectSlug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || `project-${projectId.slice(0, 8)}`;
}
