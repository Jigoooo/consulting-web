import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import pg from 'pg';

const { Pool } = pg;
const legacyOuterTransactionFiles = new Set(['0055_retrieval_label_pair_null_hardening.sql']);

function normalizeMigrationSql(file, sql) {
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

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL not set');

const migrationsDir = process.env.MIGRATIONS_DIR ?? join(process.cwd(), 'drizzle-migrations');
const checksumManifest = JSON.parse(readFileSync(join(migrationsDir, 'checksums.json'), 'utf8'));
if (checksumManifest.schema_version !== '1.0' || checksumManifest.algorithm !== 'sha256') {
  throw new Error('invalid migration checksum manifest');
}
const pool = new Pool({ connectionString: databaseUrl });
const lockClient = await pool.connect();

try {
  await lockClient.query(
    "SELECT pg_advisory_lock(hashtextextended('consulting.schema-migrations.v1', 0))",
  );
  await pool.query(`CREATE TABLE IF NOT EXISTS _migrations (
    name text PRIMARY KEY,
    checksum text,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query('ALTER TABLE _migrations ADD COLUMN IF NOT EXISTS checksum text');

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const migrations = files.map((file) => {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    const checksum = createHash('sha256').update(sql, 'utf8').digest('hex');
    if (checksumManifest.migrations[file] !== checksum) {
      throw new Error(`migration checksum manifest missing or mismatched for ${file}`);
    }
    return { file, sql, checksum };
  });
  const pendingSeals = [];

  for (const { file, sql, checksum } of migrations) {
    const done = await pool.query('SELECT checksum FROM _migrations WHERE name = $1', [file]);
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
    const statements = normalizeMigrationSql(file, sql)
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const statement of statements) await client.query(statement);
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
    const baseline = await pool.query(
      'SELECT checksum FROM migration_checksum_baselines WHERE name = $1',
      [file],
    );
    if (baseline.rowCount !== 1 || baseline.rows[0]?.checksum !== checksum) {
      throw new Error(`migration checksum DB baseline missing or mismatched for ${file}`);
    }
    const sealed = await pool.query(
      'UPDATE _migrations SET checksum = $2 WHERE name = $1 AND checksum IS NULL RETURNING checksum',
      [file, checksum],
    );
    if (sealed.rowCount === 1) {
      console.log(`seal  ${file} ${checksum}`);
    } else {
      const current = await pool.query('SELECT checksum FROM _migrations WHERE name = $1', [file]);
      if (current.rows[0]?.checksum !== checksum) {
        throw new Error(
          `migration checksum mismatch for ${file}: recorded=${current.rows[0]?.checksum ?? 'null'} current=${checksum}`,
        );
      }
    }
  }

  console.log('migrations complete');
} finally {
  await lockClient
    .query("SELECT pg_advisory_unlock(hashtextextended('consulting.schema-migrations.v1', 0))")
    .catch(() => undefined);
  lockClient.release();
  await pool.end();
}
