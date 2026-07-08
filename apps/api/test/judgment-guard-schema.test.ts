import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { schema } from '@consulting/db-schema';

describe('judgment guard Postgres schema', () => {
  it('exports a durable judgment_guard_runs table for cross-project correction patterns', () => {
    expect(schema.judgmentGuardRuns).toBeDefined();
    expect(schema.judgmentGuardRuns.issueSummary).toBeDefined();
    expect(schema.judgmentGuardRuns.promptRules).toBeDefined();
    expect(schema.judgmentGuardRuns.currentTimeIso).toBeDefined();
  });

  it('ships an idempotent migration with issue code and status constraints', () => {
    const migration = readFileSync('../../packages/db-schema/drizzle/0021_judgment_guard_runs.sql', 'utf8');

    expect(migration).toContain('CREATE TABLE IF NOT EXISTS judgment_guard_runs');
    expect(migration).toContain('source_intake_parse_failure');
    expect(migration).toContain('applicability_map_required');
    expect(migration).toContain('comparator_consistency_required');
    expect(migration).toContain('user_correction_pattern');
    expect(migration).toContain('judgment_guard_runs_status_chk');
  });
});
