import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('P3 RAG evaluation hardening contracts', () => {
  it('hardens the retrieval label pair check against SQL NULL truth tables', () => {
    const sql = source('../../packages/db-schema/drizzle/0055_retrieval_label_pair_null_hardening.sql');
    expect(sql).toContain('judged_relevant IS TRUE');
    expect(sql).toContain('judged_relevant IS FALSE');
    expect(sql).not.toMatch(/judged_relevant\s*=\s*(?:true|false)/iu);
  });

  it('loads a bounded parent-run cohort before composite-joining retrieval hits', () => {
    const dashboard = source('scripts/rag_eval_dashboard.ts');
    expect(dashboard).toContain('const MAX_DASHBOARD_RUNS = 1_000');
    expect(dashboard).toContain('.from(schema.retrievalRuns)');
    expect(dashboard).toContain('.limit(MAX_DASHBOARD_RUNS + 1)');
    expect(dashboard).toContain('.innerJoin(schema.retrievalRuns, and(');
    expect(dashboard).toContain('IS NOT DISTINCT FROM');
    expect(dashboard).toContain('runRows.map((row) => [row.id, { runId: row.id, hits: [] }])');
    expect(dashboard).toContain('cohortTruncated');
  });
});
