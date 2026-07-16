import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient } from 'pg';

const legacyOuterTransactionFiles = new Set(['0055_retrieval_label_pair_null_hardening.sql']);
const migrationLockSql = "hashtextextended('consulting.schema-migrations.v1', 0)";

function normalizeMigrationSql(file: string, sql: string): string {
  let normalized = sql;
  if (legacyOuterTransactionFiles.has(file)) {
    normalized = normalized
      .replace(/^\s*BEGIN;\s*/iu, '')
      .replace(/\s*COMMIT;\s*$/iu, '');
  }
  if (/^\s*(BEGIN|COMMIT|ROLLBACK);\s*$/imu.test(normalized)) {
    throw new Error(`migration contains forbidden transaction control: ${file}`);
  }
  return normalized;
}

function migrationLockTimeoutMs(raw: string | undefined): number {
  const parsed = Number(raw ?? '30000');
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 300_000) {
    throw new Error('MIGRATION_LOCK_TIMEOUT_MS must be an integer between 1 and 300000');
  }
  return parsed;
}

async function acquireMigrationLock(client: PoolClient, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (true) {
    const result = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(${migrationLockSql}) AS locked`,
    );
    if (result.rows[0]?.locked === true) return;
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      throw new Error(`migration advisory lock timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, remainingMs)));
  }
}

/**
 * Minimal, idempotent migration runner for Phase 0.
 * Applies each drizzle/*.sql once, tracked in _migrations table.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(__dirname, '..', 'drizzle');
const checksumManifest = JSON.parse(readFileSync(join(drizzleDir, 'checksums.json'), 'utf8')) as {
  schema_version: string;
  algorithm: string;
  migrations: Record<string, string>;
};
if (checksumManifest.schema_version !== '1.0' || checksumManifest.algorithm !== 'sha256') {
  throw new Error('invalid migration checksum manifest');
}

function loadVerifiedMigrations(): Array<{ file: string; sql: string; checksum: string }> {
  return readdirSync(drizzleDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => {
      const sql = readFileSync(join(drizzleDir, file), 'utf8');
      const checksum = createHash('sha256').update(sql, 'utf8').digest('hex');
      if (checksumManifest.migrations[file] !== checksum) {
        throw new Error(`migration checksum manifest missing or mismatched for ${file}`);
      }
      return { file, sql, checksum };
    });
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  // Verify the candidate image before waiting on or mutating any database.
  const migrations = loadVerifiedMigrations();
  const lockTimeoutMs = migrationLockTimeoutMs(process.env.MIGRATION_LOCK_TIMEOUT_MS);
  const pool = new Pool({ connectionString: url });
  const lockClient = await pool.connect();
  let lockAcquired = false;
  try {
    await acquireMigrationLock(lockClient, lockTimeoutMs);
    lockAcquired = true;

    await pool.query(
      `CREATE TABLE IF NOT EXISTS _migrations (
      name text PRIMARY KEY,
      checksum text,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`,
    );
    await pool.query('ALTER TABLE _migrations ADD COLUMN IF NOT EXISTS checksum text');

    const pendingSeals: Array<{ file: string; checksum: string }> = [];

    for (const { file, sql, checksum } of migrations) {
      const done = await pool.query<{ checksum: string | null }>(
        'SELECT checksum FROM _migrations WHERE name = $1',
        [file],
      );
      if ((done.rowCount ?? 0) > 0) {
        const recorded = done.rows[0]?.checksum ?? null;
        if (recorded === null) {
          pendingSeals.push({ file, checksum });
          console.log(`defer ${file}`);
          continue;
        } else if (recorded !== checksum) {
          throw new Error(
            `migration checksum mismatch for ${file}: recorded=${recorded} current=${checksum}`,
          );
        }
        console.log(`skip  ${file}`);
        continue;
      }
      // drizzle uses "--> statement-breakpoint" between statements
      const statements = normalizeMigrationSql(file, sql)
        .split('--> statement-breakpoint')
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const statement of statements) {
          await client.query(statement);
        }
        await client.query('INSERT INTO _migrations(name, checksum) VALUES ($1, $2)', [
          file,
          checksum,
        ]);
        await client.query('COMMIT');
        console.log(`apply ${file} (${statements.length} statements)`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }

    for (const { file, checksum } of pendingSeals) {
      const baseline = await pool.query<{ checksum: string }>(
        'SELECT checksum FROM migration_checksum_baselines WHERE name = $1',
        [file],
      );
      if (baseline.rowCount !== 1 || baseline.rows[0]?.checksum !== checksum) {
        throw new Error(`migration checksum DB baseline missing or mismatched for ${file}`);
      }
      const sealed = await pool.query<{ checksum: string }>(
        'UPDATE _migrations SET checksum = $2 WHERE name = $1 AND checksum IS NULL RETURNING checksum',
        [file, checksum],
      );
      if (sealed.rowCount === 1) {
        console.log(`seal  ${file} ${checksum}`);
      } else {
        const current = await pool.query<{ checksum: string | null }>(
          'SELECT checksum FROM _migrations WHERE name = $1',
          [file],
        );
        if (current.rows[0]?.checksum !== checksum) {
          throw new Error(
            `migration checksum mismatch for ${file}: recorded=${current.rows[0]?.checksum ?? 'null'} current=${checksum}`,
          );
        }
      }
    }

    console.log('migrations complete');
  } finally {
    if (lockAcquired) {
      await lockClient
        .query(`SELECT pg_advisory_unlock(${migrationLockSql})`)
        .catch(() => undefined);
    }
    lockClient.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
