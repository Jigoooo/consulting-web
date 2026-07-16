import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const d = databaseUrl ? describe : describe.skip;
const packageRoot = process.cwd();

function runMigrationRunner(databaseUrl: string): Promise<{
  code: number | null;
  stderr: string;
  killedByHarness: boolean;
}> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/migrate.ts'], {
      cwd: packageRoot,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        MIGRATION_LOCK_TIMEOUT_MS: '250',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let killedByHarness = false;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    const timer = setTimeout(() => {
      killedByHarness = true;
      child.kill('SIGKILL');
    }, 2_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveResult({ code, stderr, killedByHarness });
    });
  });
}

d('migration runner advisory lock deadline', () => {
  it('fails within its configured deadline when another runner holds the lock', async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const lockClient = await pool.connect();
    try {
      await lockClient.query(
        "SELECT pg_advisory_lock(hashtextextended('consulting.schema-migrations.v1', 0))",
      );
      const startedAt = Date.now();
      const result = await runMigrationRunner(databaseUrl!);

      expect(result.killedByHarness).toBe(false);
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('migration advisory lock timed out after 250ms');
    } finally {
      await lockClient.query(
        "SELECT pg_advisory_unlock(hashtextextended('consulting.schema-migrations.v1', 0))",
      );
      lockClient.release();
      await pool.end();
    }
  }, 10_000);
});
