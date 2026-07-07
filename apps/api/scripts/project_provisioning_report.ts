import process from 'node:process';
import { Pool } from 'pg';
import { ProjectProvisioningReportService, type ProjectProvisioningReport } from '../src/spaces/project-provisioning-report.service.js';

function printText(report: ProjectProvisioningReport): void {
  console.log(`read_only: ${report.readOnly}`);
  console.log(`generated_at: ${report.generatedAt}`);
  console.log(`totals: projects=${report.totals.projects} provisioned=${report.totals.provisioned} unprovisioned=${report.totals.unprovisioned} isolation_violations=${report.totals.isolationViolations}`);
  for (const project of report.projects) {
    const counts = `channels=${project.counts.channels} topics=${project.counts.topics} threads=${project.counts.threads} messages=${project.counts.messages} links=${project.counts.activeConsultingLinks}`;
    const slugs = project.consultingTopicSlugs.length ? project.consultingTopicSlugs.join(',') : '-';
    const issues = project.issues.length ? project.issues.join('; ') : '-';
    console.log(`${project.name} (${project.slug}) id=${project.projectId} workspace=${project.workspaceId} [${project.provisioningStatus}] ${counts} brain=${slugs} expected=${project.expectedDefaultBrainSlug} issues=${issues}`);
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const hasPgEnv = Boolean(process.env.PGHOST && process.env.PGUSER && process.env.PGDATABASE);
  if (!databaseUrl && !hasPgEnv) {
    console.error('DATABASE_URL or PGHOST/PGUSER/PGDATABASE is required. Secret values are never printed by this script.');
    process.exit(1);
  }

  const format = process.argv.includes('--text') ? 'text' : 'json';
  const pool = new Pool(databaseUrl ? { connectionString: databaseUrl, max: 1 } : { max: 1 });
  const client = await pool.connect();

  try {
    await client.query('BEGIN READ ONLY');
    const report = await new ProjectProvisioningReportService(client).loadReport(new Date());
    await client.query('COMMIT');
    if (format === 'text') printText(report);
    else console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

void main();
