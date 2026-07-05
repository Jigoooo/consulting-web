import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const { Pool } = pg;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL not set');

const migrationsDir = process.env.MIGRATIONS_DIR ?? join(process.cwd(), 'drizzle-migrations');
const pool = new Pool({ connectionString: databaseUrl });

try {
  await pool.query(`CREATE TABLE IF NOT EXISTS _migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const done = await pool.query('SELECT 1 FROM _migrations WHERE name = $1', [file]);
    if ((done.rowCount ?? 0) > 0) {
      console.log(`skip  ${file}`);
      continue;
    }

    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    const statements = sql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const statement of statements) await client.query(statement);
      await client.query('INSERT INTO _migrations(name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`apply ${file} (${statements.length} statements)`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  console.log('migrations complete');
} finally {
  await pool.end();
}
