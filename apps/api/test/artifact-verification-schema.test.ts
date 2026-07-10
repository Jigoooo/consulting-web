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
});
