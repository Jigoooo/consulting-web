import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

/**
 * Minimal, idempotent migration runner for Phase 0.
 * Applies each drizzle/*.sql once, tracked in _migrations table.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(__dirname, '..', 'drizzle');

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const pool = new Pool({ connectionString: url });

  await pool.query(
    `CREATE TABLE IF NOT EXISTS _migrations (
       name text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );

  const files = readdirSync(drizzleDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const done = await pool.query('SELECT 1 FROM _migrations WHERE name = $1', [file]);
    if ((done.rowCount ?? 0) > 0) {
      console.log(`skip  ${file}`);
      continue;
    }
    const sql = readFileSync(join(drizzleDir, file), 'utf8');
    // drizzle uses "--> statement-breakpoint" between statements
    const statements = sql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const stmt of statements) {
        await client.query(stmt);
      }
      await client.query('INSERT INTO _migrations(name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`apply ${file} (${statements.length} statements)`);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  await pool.end();
  console.log('migrations complete');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
