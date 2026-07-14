import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { schema } from '@consulting/db-schema';

describe('artifact version verification ledger schema', () => {
  it('binds verification runs to artifact version, tenant scope, and content hash', () => {
    const table = (schema as any).artifactVersionVerifications;
    expect(table).toBeDefined();
    expect(getTableName(table)).toBe('artifact_version_verifications');
    expect(Object.keys(getTableColumns(table))).toEqual(expect.arrayContaining([
      'workspaceId',
      'projectId',
      'artifactId',
      'artifactVersionId',
      'sequenceNo',
      'contentHash',
      'sourceThreadId',
      'sourceMessageId',
      'exactness',
      'verdicts',
      'gate',
      'verifier',
      'evidenceCount',
      'verifiedByUserId',
      'createdAt',
      'deletedAt',
    ]));
  });

  it('uses monotonic ordering and enforces status/gate consistency in migration 0027', () => {
    const sql = readFileSync(resolve(process.cwd(), '../../packages/db-schema/drizzle/0027_artifact_version_verification_ledger.sql'), 'utf8');
    expect(sql).toContain('sequence_no bigint GENERATED ALWAYS AS IDENTITY');
    expect(sql).toContain('artifact_verifications_gate_status_check');
  });

  it('makes human review decisions an immutable exact-tuple hash chain', () => {
    const table = (schema as any).artifactReviewDecisions;
    expect(Object.keys(getTableColumns(table))).toEqual(expect.arrayContaining([
      'sequenceNo', 'actorKind', 'previousHash', 'eventHash',
    ]));
    expect(table.decidedByUserId.notNull).toBe(false);
    const sql = readFileSync(resolve(process.cwd(), '../../packages/db-schema/drizzle/0056_artifact_review_decision_integrity.sql'), 'utf8');
    const traceServiceSource = readFileSync(resolve(process.cwd(), 'src/consulting/consulting-run-trace.service.ts'), 'utf8');
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT);\s*$/gmu);
    expect(sql).toContain('ADD COLUMN sequence_no bigint');
    expect(sql).not.toContain('sequence_no bigint GENERATED ALWAYS AS IDENTITY');
    expect(sql).toContain('pg_advisory_xact_lock');
    expect(sql).toContain('NEW.sequence_no := COALESCE(latest_sequence_no, 0) + 1');
    expect(sql).toContain("WHEN decided_by_user_id IS NULL THEN 'legacy_unknown'");
    expect(sql).toContain("actor_kind = 'user' AND decided_by_user_id IS NOT NULL");
    expect(sql).toContain('new artifact review decisions require a user actor');
    expect(sql).toContain("coalesce(row_item.decided_by_user_id::text, '')");
    expect(sql).not.toContain('ALTER COLUMN decided_by_user_id SET NOT NULL');
    expect(sql).toContain('trace_spans_report_workflow_parity_key_uq');
    expect(sql).toContain("metadata ->> 'parityKey'");
    expect(sql).toContain("metadata ? 'parityKey'");
    expect(sql).toContain("WHERE name = 'report_workflow.parity'");
    expect(sql).toContain('deleted_at IS NULL');
    expect(traceServiceSource).toContain('.onConflictDoNothing()');
    expect(sql).toContain('existing artifact review decision tenant tuple mismatch');
    expect(sql.indexOf('existing artifact review decision tenant tuple mismatch')).toBeLessThan(sql.indexOf('calculated_hash := encode'));
    expect(sql.match(/artifact_review_decision_v2/gu)).toHaveLength(3);
    expect(sql.match(/actor_kind,/gu)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(sql.indexOf('pg_advisory_xact_lock')).toBeLessThan(sql.indexOf('NEW.sequence_no := COALESCE(latest_sequence_no, 0) + 1'));
    expect(sql).toContain('artifact_review_decisions_exact_tuple_guard');
    expect(sql).toContain('artifact_review_decisions_hash_chain_guard');
    expect(sql).toContain('artifact_review_decisions_no_update_delete');
    expect(sql).toContain('artifact_review_decisions_no_truncate');
    expect(sql).toContain('artifact_review_decisions_note_length_check');
    expect(sql.match(/ON DELETE RESTRICT/gu)?.length ?? 0).toBeGreaterThanOrEqual(5);

    for (const runner of [
      '../../apps/api/docker-migrate.mjs',
      '../../packages/db-schema/scripts/migrate.ts',
    ]) {
      const source = readFileSync(resolve(process.cwd(), runner), 'utf8');
      expect(source).toContain('normalizeMigrationSql');
      expect(source).toContain('migration contains forbidden transaction control');
    }
  });

  it('binds append-only red-team runs to tenant, artifact version, and exact content hash', () => {
    const jobs = (schema as any).artifactRedTeamJobs;
    expect(jobs).toBeDefined();
    expect(getTableName(jobs)).toBe('artifact_red_team_jobs');
    expect(Object.keys(getTableColumns(jobs))).toEqual(expect.arrayContaining([
      'sequenceNo',
      'workspaceId', 'projectId', 'artifactId', 'artifactVersionId', 'contentHash',
      'mode', 'policyVersion', 'requestedByUserId', 'status', 'leaseToken',
      'leaseExpiresAt', 'attemptCount', 'recoveryCount', 'lastError', 'nextAttemptAt',
    ]));
    const table = (schema as any).artifactRedTeamRuns;
    expect(table).toBeDefined();
    expect(getTableName(table)).toBe('artifact_red_team_runs');
    expect(Object.keys(getTableColumns(table))).toEqual(expect.arrayContaining([
      'jobId',
      'sequenceNo',
      'workspaceId',
      'projectId',
      'artifactId',
      'artifactVersionId',
      'contentHash',
      'mode',
      'status',
      'policyVersion',
      'personas',
      'attacks',
      'defenses',
      'verdict',
      'reviewerRunId',
      'errorMessage',
      'reviewedByUserId',
      'createdAt',
    ]));
    expect(table.jobId.notNull).toBe(true);

    const sql = readFileSync(resolve(process.cwd(), '../../packages/db-schema/drizzle/0036_artifact_red_team_runs.sql'), 'utf8');
    expect(sql).toContain('sequence_no bigint GENERATED ALWAYS AS IDENTITY');
    expect(sql).toContain('job_id uuid NOT NULL REFERENCES artifact_red_team_jobs');
    expect(sql).toContain('job_id uuid NOT NULL REFERENCES artifact_red_team_jobs(id) ON DELETE RESTRICT');
    expect(sql).toContain('reviewed_by_user_id uuid,');
    expect(sql).not.toContain('reviewed_by_user_id uuid REFERENCES users');
    expect(sql).toContain('artifact_red_team_runs_content_hash_check');
    expect(sql).toContain('artifact_red_team_runs_mode_check');
    expect(sql).toContain('artifact_red_team_runs_status_check');
    expect(sql).toContain('artifact_red_team_runs_payload_check');
    expect(sql).toContain('jsonb_array_length(personas) = 3');
    expect(sql).toContain('j.status = NEW.status');
    expect(sql.match(/SET search_path = public, pg_temp/gu)).toHaveLength(3);
    expect(sql).toContain('artifact_red_team_runs_outcome_check');
    expect(sql).toContain('artifact_red_team_jobs_active_unique');
    expect(sql).toContain('artifact_red_team_jobs_status_lease_idx');
    expect(sql).toContain('artifact_red_team_runs_append_only_guard');
    expect(sql).not.toContain("IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1");
  });
});
