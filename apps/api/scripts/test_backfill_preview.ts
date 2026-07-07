import process from 'node:process';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { schema } from '@consulting/db-schema';
import { ProjectTemplateService, type ProjectTemplateBackfillPreview } from '../src/spaces/project-template.service.js';
import type { Db } from '../src/infra/drizzle.module.js';

const DEFAULT_TEST_PROJECT_ID = '61f95d26-33e7-47ea-a374-7b19da02c39a';

function argValue(name: string): string | undefined {
  const exact = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function printText(preview: ProjectTemplateBackfillPreview): void {
  console.log(`read_only: ${preview.readOnly}`);
  console.log(`project: ${preview.projectName} (${preview.projectSlug}) id=${preview.projectId}`);
  console.log(`brain_slug: ${preview.brainSlug}`);
  console.log(`memory_prefix: ${preview.expectedMemoryTopicPrefix}`);
  console.log(
    `before: channels=${preview.before.channels} topics=${preview.before.topics} threads=${preview.before.threads} messages=${preview.before.messages} consulting_links=${preview.before.consultingLinks}`,
  );
  console.log(
    `planned_creates: channels=${preview.plannedCreates.channels} topics=${preview.plannedCreates.topics} threads=${preview.plannedCreates.threads} consulting_links=${preview.plannedCreates.consultingLinks}`,
  );
  console.log(`existing_brains: ${preview.existingConsultingTopicSlugs.length ? preview.existingConsultingTopicSlugs.join(',') : '-'}`);
  console.log(`warnings: ${preview.warnings.length ? preview.warnings.join('; ') : '-'}`);
}

async function main(): Promise<void> {
  const projectId = argValue('--project-id') ?? DEFAULT_TEST_PROJECT_ID;
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
    const db = drizzle(client, { schema }) as unknown as Db;
    const result = await new ProjectTemplateService(db).previewConsultingDefaultBackfill(projectId);
    await client.query('COMMIT');

    if (!result.ok) {
      console.error(`${result.error.code}: ${result.error.message}`);
      process.exitCode = 1;
      return;
    }

    if (format === 'text') printText(result.value);
    else console.log(JSON.stringify(result.value, null, 2));
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
