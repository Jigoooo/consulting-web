import process from 'node:process';
import { Pool, type PoolClient } from 'pg';
import {
  auditArtifactExportPreflight,
  type ArtifactExportPreflightAuditInputRow,
  type ArtifactExportPreflightAuditResult,
  type ArtifactExportPreflightAuditVerdictRow,
} from '../src/artifacts/artifact-export-preflight-audit.js';
import type { ClaimVerdictKind } from '../src/consulting/evidence-to-decision.service.js';

interface Args {
  projectId: string | null;
  json: boolean;
  allowBlocked: boolean;
}

interface ProjectRow {
  id: string;
  workspaceId: string;
  name: string;
}

interface ArtifactRow {
  artifactId: string;
  title: string;
  versionNo: number;
  sourceThreadId: string | null;
  sourceMessageId: string | null;
  sourceValid: boolean | null;
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

function normalizeVerdictKind(value: string): ClaimVerdictKind {
  if (value === 'supports' || value === 'refutes' || value === 'not_enough_info' || value === 'mixed') return value;
  return 'supports';
}

async function loadProject(client: PoolClient, projectId: string): Promise<ProjectRow> {
  const result = await client.query<{ id: string; workspace_id: string; name: string }>(
    `select id::text, workspace_id::text, name
     from projects
     where id = $1 and status = 'active' and deleted_at is null
     limit 1`,
    [projectId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`project not found or inactive: ${projectId}`);
  return { id: row.id, workspaceId: row.workspace_id, name: row.name };
}

async function loadHeadArtifacts(client: PoolClient, projectId: string): Promise<ArtifactRow[]> {
  const result = await client.query<{
    artifactId: string;
    title: string;
    versionNo: number;
    sourceThreadId: string | null;
    sourceMessageId: string | null;
    sourceValid: boolean | null;
  }>(
    `select
       a.id::text as "artifactId",
       a.title as "title",
       v.version_no as "versionNo",
       v.source_thread_id::text as "sourceThreadId",
       v.source_message_id::text as "sourceMessageId",
       case
         when v.source_message_id is null then null
         when cm.id is null then false
         when ch.project_id is distinct from a.project_id then false
         when v.source_thread_id is not null and v.source_thread_id is distinct from cm.thread_id then false
         else true
       end as "sourceValid"
     from artifacts a
     join artifact_versions v
       on v.artifact_id = a.id
      and v.version_no = a.head_version
     left join chat_messages cm
       on cm.id = v.source_message_id
      and cm.deleted_at is null
     left join threads th
       on th.id = cm.thread_id
      and th.deleted_at is null
     left join topics tp
       on tp.id = th.topic_id
      and tp.deleted_at is null
     left join channels ch
       on ch.id = tp.channel_id
      and ch.deleted_at is null
     where a.project_id = $1
       and a.deleted_at is null
     order by a.created_at, a.id`,
    [projectId],
  );
  return result.rows;
}

async function loadLatestExactnessByMessage(client: PoolClient, messageIds: string[]): Promise<Map<string, 'blocked' | 'passed' | 'skipped'>> {
  const out = new Map<string, 'blocked' | 'passed' | 'skipped'>();
  if (messageIds.length === 0) return out;
  const result = await client.query<{ assistantMessageId: string; status: string }>(
    `select distinct on (assistant_message_id)
       assistant_message_id::text as "assistantMessageId",
       status
     from exactness_runs
     where assistant_message_id = any($1::uuid[])
       and deleted_at is null
     order by assistant_message_id, created_at desc`,
    [messageIds],
  );
  for (const row of result.rows) {
    if (row.status === 'blocked' || row.status === 'passed' || row.status === 'skipped') {
      out.set(row.assistantMessageId, row.status);
    }
  }
  return out;
}

async function loadVerdictsByMessage(client: PoolClient, messageIds: string[]): Promise<Map<string, ArtifactExportPreflightAuditVerdictRow[]>> {
  const out = new Map<string, ArtifactExportPreflightAuditVerdictRow[]>();
  if (messageIds.length === 0) return out;
  const result = await client.query<{
    assistantMessageId: string;
    claimId: string;
    claimText: string;
    verdict: string;
    confidence: string | null;
    rationale: string;
  }>(
    `select
       assistant_message_id::text as "assistantMessageId",
       claim_id as "claimId",
       claim_text as "claimText",
       verdict,
       confidence::text as confidence,
       rationale
     from claim_verification_verdicts
     where assistant_message_id = any($1::uuid[])
       and deleted_at is null
     order by assistant_message_id, created_at desc, id`,
    [messageIds],
  );
  for (const row of result.rows) {
    const rows = out.get(row.assistantMessageId) ?? [];
    rows.push({
      claimId: row.claimId,
      claimText: row.claimText,
      verdict: normalizeVerdictKind(row.verdict),
      confidence: row.confidence,
      rationale: row.rationale,
    });
    out.set(row.assistantMessageId, rows);
  }
  return out;
}

async function buildSnapshot(client: PoolClient, project: ProjectRow): Promise<ArtifactExportPreflightAuditInputRow[]> {
  const artifacts = await loadHeadArtifacts(client, project.id);
  const messageIds = [...new Set(artifacts.map((row) => row.sourceMessageId).filter((value): value is string => Boolean(value)))];
  const exactness = await loadLatestExactnessByMessage(client, messageIds);
  const verdicts = await loadVerdictsByMessage(client, messageIds);
  return artifacts.map((row) => ({
    artifactId: row.artifactId,
    title: row.title,
    versionNo: row.versionNo,
    sourceThreadId: row.sourceThreadId,
    sourceMessageId: row.sourceMessageId,
    sourceValid: row.sourceValid,
    exactnessStatus: row.sourceMessageId ? exactness.get(row.sourceMessageId) ?? null : null,
    verdicts: row.sourceMessageId ? verdicts.get(row.sourceMessageId) ?? [] : [],
  }));
}

function printText(result: ArtifactExportPreflightAuditResult): void {
  console.log(`artifact export preflight audit: ${result.status}`);
  console.log(`project: ${result.projectName} (${result.projectId})`);
  console.log(`summary: total=${result.summary.total} exportable=${result.summary.exportable} blocked=${result.summary.blocked} noSourceMessage=${result.summary.noSourceMessage} invalidSourceMessage=${result.summary.invalidSourceMessage}`);
  for (const row of result.rows) {
    const blockers = row.gate?.blockers.map((issue) => `${issue.code}${issue.claimId ? `:${issue.claimId}` : ''}`).join(', ') ?? '';
    console.log(`- ${row.canExport ? 'PASS' : 'BLOCK'} v${row.versionNo} ${row.title} reason=${row.reason}${blockers ? ` blockers=[${blockers}]` : ''}`);
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
    const project = await loadProject(client, args.projectId);
    const rows = await buildSnapshot(client, project);
    const result = auditArtifactExportPreflight({ projectId: project.id, projectName: project.name, rows });
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
