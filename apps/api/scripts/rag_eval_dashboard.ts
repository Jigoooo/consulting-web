/**
 * P3 RAG eval dashboard — reads labeled retrieval_hits from Postgres, groups by
 * retrieval run, and computes precision@k / MRR / hit-rate / failure taxonomy +
 * exportable failure fixtures. read-only; no writes.
 *
 * Run:
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:55420/consulting_rbac \
 *   pnpm --filter @consulting/api exec tsx scripts/rag_eval_dashboard.ts [--workspace <id>]
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { schema } from '@consulting/db-schema';
import {
  computeRagMetrics,
  exportFailureFixtures,
  type RetrievalFailureType,
  type RetrievalRunLabels,
} from '../src/consulting/rag-metrics.js';

const DSN = process.env.DATABASE_URL;
if (!DSN) throw new Error('DATABASE_URL required');

const workspaceArgIdx = process.argv.indexOf('--workspace');
const workspaceId = workspaceArgIdx >= 0 ? process.argv[workspaceArgIdx + 1] : undefined;
const MAX_DASHBOARD_RUNS = 1_000;

async function main() {
  const pool = new Pool({ connectionString: DSN });
  const db = drizzle(pool, { schema });

  const runWhere = [isNull(schema.retrievalRuns.deletedAt)];
  if (workspaceId) runWhere.push(eq(schema.retrievalRuns.workspaceId, workspaceId));
  const candidateRunRows = await db
    .select({
      id: schema.retrievalRuns.id,
      workspaceId: schema.retrievalRuns.workspaceId,
      threadId: schema.retrievalRuns.threadId,
    })
    .from(schema.retrievalRuns)
    .where(and(...runWhere))
    .orderBy(desc(schema.retrievalRuns.createdAt))
    .limit(MAX_DASHBOARD_RUNS + 1);

  const cohortTruncated = candidateRunRows.length > MAX_DASHBOARD_RUNS;
  const runRows = candidateRunRows.slice(0, MAX_DASHBOARD_RUNS);
  const runIds = runRows.map((row) => row.id);
  const hitWhere = [isNull(schema.retrievalHits.deletedAt), isNull(schema.retrievalRuns.deletedAt)];
  if (workspaceId) hitWhere.push(eq(schema.retrievalRuns.workspaceId, workspaceId));
  const rows = runIds.length === 0 ? [] : await db
    .select({
      retrievalRunId: schema.retrievalHits.retrievalRunId,
      rank: schema.retrievalHits.rank,
      judgedRelevant: schema.retrievalHits.judgedRelevant,
      failureType: schema.retrievalHits.failureType,
    })
    .from(schema.retrievalHits)
    .innerJoin(schema.retrievalRuns, and(
      eq(schema.retrievalHits.retrievalRunId, schema.retrievalRuns.id),
      eq(schema.retrievalHits.workspaceId, schema.retrievalRuns.workspaceId),
      sql`${schema.retrievalHits.threadId} IS NOT DISTINCT FROM ${schema.retrievalRuns.threadId}`,
    ))
    .where(and(...hitWhere, inArray(schema.retrievalHits.retrievalRunId, runIds)));

  const byRun = new Map<string, RetrievalRunLabels>(runRows.map((row) => [row.id, { runId: row.id, hits: [] }]));
  for (const row of rows) {
    const run = byRun.get(row.retrievalRunId);
    if (!run) continue;
    run.hits.push({
      rank: row.rank,
      judgedRelevant: row.judgedRelevant,
      failureType: (row.failureType as RetrievalFailureType | null) ?? null,
    });
  }

  const runs = [...byRun.values()];
  const metrics = computeRagMetrics(runs, [1, 3, 5]);
  const fixtures = exportFailureFixtures(runs);

  await pool.end();

  console.log(JSON.stringify({
    scope: workspaceId ?? '__all__',
    cohortLimit: MAX_DASHBOARD_RUNS,
    cohortTruncated,
    metrics,
    failureFixtureCount: fixtures.length,
    failureFixtures: fixtures.slice(0, 20),
  }, null, 2));
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : String(e)); process.exit(1); });
