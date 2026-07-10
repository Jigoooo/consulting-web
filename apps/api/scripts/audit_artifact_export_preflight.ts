import process from 'node:process';
import { schema } from '@consulting/db-schema';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import {
  auditArtifactExportPreflight,
  type ArtifactExportPreflightAuditResult,
} from '../src/artifacts/artifact-export-preflight-audit.js';
import { ArtifactVerificationDbLedger } from '../src/artifacts/artifact-verification-db-ledger.js';

interface Args {
  projectId: string | null;
  json: boolean;
  allowBlocked: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { projectId: null, json: false, allowBlocked: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--json') {
      args.json = true;
      continue;
    }
    if (arg === '--allow-blocked') {
      args.allowBlocked = true;
      continue;
    }
    if (arg === '--project-id') {
      args.projectId = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function printText(result: ArtifactExportPreflightAuditResult): void {
  console.log(`artifact export preflight audit: ${result.status}`);
  console.log(`project: ${result.projectName} (${result.projectId})`);
  console.log(
    `summary: total=${result.summary.total} exportable=${result.summary.exportable} blocked=${result.summary.blocked} verificationRequired=${result.summary.verificationRequired}`,
  );
  for (const row of result.rows) {
    const blockers = row.gate?.blockers
      .map((issue) => `${issue.code}${issue.claimId ? `:${issue.claimId}` : ''}`)
      .join(', ') ?? '';
    console.log(
      `- ${row.canExport ? 'PASS' : 'BLOCK'} v${row.versionNo} ${row.title} reason=${row.reason}${blockers ? ` blockers=[${blockers}]` : ''}`,
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.projectId) throw new Error('--project-id is required');
  const databaseUrl = process.env.DATABASE_URL;
  const hasPgEnv = Boolean(process.env.PGHOST && process.env.PGUSER && process.env.PGDATABASE);
  if (!databaseUrl && !hasPgEnv) {
    throw new Error('DATABASE_URL or PGHOST/PGUSER/PGDATABASE is required. Secret values are never printed by this script.');
  }

  const pool = new Pool(databaseUrl ? { connectionString: databaseUrl, max: 1 } : { max: 1 });
  const client = await pool.connect();
  try {
    await client.query('begin read only');
    const db = drizzle(client, { schema });
    const ledger = new ArtifactVerificationDbLedger(db);
    const project = await ledger.loadProjectHeadTargets(args.projectId);
    const rows = await Promise.all(project.targets.map(async (target) => ({
      ...target,
      verification: await ledger.latest(target),
    })));
    const result = auditArtifactExportPreflight({
      projectId: project.projectId,
      projectName: project.projectName,
      rows,
    });
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else printText(result);
    if (result.status === 'blocked' && !args.allowBlocked) process.exitCode = 1;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.query('rollback').catch(() => undefined);
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
