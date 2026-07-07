import { describe, expect, it } from 'vitest';
import { buildProjectProvisioningReport, type ProjectProvisioningQueryRow } from '../src/spaces/project-provisioning-report.service.js';

const baseRow = (overrides: Partial<ProjectProvisioningQueryRow> = {}): ProjectProvisioningQueryRow => ({
  project_id: 'project-1',
  workspace_id: 'workspace-1',
  project_name: 'Project One',
  project_slug: 'project-one',
  channel_count: '5',
  topic_count: '8',
  thread_count: '8',
  message_count: '0',
  active_consulting_link_count: '1',
  consulting_topic_slugs: ['project-one'],
  memory_topic_ids: ['consulting:project-one#conversation/default-chat'],
  ...overrides,
});

describe('project provisioning report', () => {
  it('marks active projects with zero consulting links as unprovisioned without mutating data', () => {
    const report = buildProjectProvisioningReport([
      baseRow({
        project_id: 'test-project-id',
        project_name: 'TEST',
        project_slug: 'test',
        channel_count: '1',
        topic_count: '1',
        thread_count: '1',
        message_count: '10',
        active_consulting_link_count: '0',
        consulting_topic_slugs: [],
        memory_topic_ids: [],
      }),
    ]);

    expect(report.totals).toEqual({ projects: 1, provisioned: 0, unprovisioned: 1, isolationViolations: 0 });
    expect(report.projects[0]).toMatchObject({
      projectId: 'test-project-id',
      name: 'TEST',
      slug: 'test',
      expectedDefaultBrainSlug: 'test',
      provisioningStatus: 'unprovisioned',
      counts: { channels: 1, topics: 1, threads: 1, messages: 10, activeConsultingLinks: 0 },
      issues: ['consulting_links=0'],
    });
    expect(report.projects[0]?.isolation).toEqual({ ok: true, issues: [] });
  });

  it('detects TEST/Changwon brain slug mixing as an isolation violation', () => {
    const report = buildProjectProvisioningReport([
      baseRow({
        project_id: 'test-project-id',
        project_name: 'TEST',
        project_slug: 'test',
        active_consulting_link_count: '1',
        consulting_topic_slugs: ['changwon-org-mgmt-diagnosis'],
      }),
    ]);

    expect(report.totals.isolationViolations).toBe(1);
    expect(report.projects[0]?.isolation.ok).toBe(false);
    expect(report.projects[0]?.isolation.issues).toContain('TEST project is linked to Changwon brain slug');
    expect(report.projects[0]?.isolation.issues).toContain('TEST project is linked to a non-project brain slug');
  });

  it('detects Changwon linked to any non-Changwon brain slug without hardcoding TEST variants', () => {
    const report = buildProjectProvisioningReport([
      baseRow({
        project_id: 'changwon-project-id',
        project_name: '창원시 컨설팅',
        project_slug: 'changwon-consulting',
        active_consulting_link_count: '2',
        consulting_topic_slugs: ['changwon-org-mgmt-diagnosis', 'test-future-brain'],
      }),
    ]);

    expect(report.totals.isolationViolations).toBe(1);
    expect(report.projects[0]?.isolation.ok).toBe(false);
    expect(report.projects[0]?.isolation.issues).toContain('Changwon project is linked to a non-Changwon brain slug');
  });

  it('flags multiple active consulting brain slugs on one project', () => {
    const report = buildProjectProvisioningReport([
      baseRow({ consulting_topic_slugs: ['changwon-org-mgmt-diagnosis', 'test'], active_consulting_link_count: '2' }),
    ]);

    expect(report.projects[0]?.isolation.ok).toBe(false);
    expect(report.projects[0]?.issues).toContain('multiple_active_brain_slugs');
  });
});
