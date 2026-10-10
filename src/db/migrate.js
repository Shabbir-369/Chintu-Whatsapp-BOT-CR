/**
 * src/db/migrate.js
 * Tiny SQL migration runner. Applies numbered SQL files in order.
 * Records applied migrations in schema_migrations table.
 */
import { readFileSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { config } from '../config.js';
import { getLogger } from '../logger.js';

const log = getLogger('db/migrate');
const __dirname = dirname(fileURLToPath(import.meta.url));

export async function runMigrations() {
  const client = new pg.Client({ connectionString: config.DATABASE_URL });
  await client.connect();

  try {
    // Ensure schema_migrations table
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const migrationsDir = resolve(__dirname, '../../migrations');
    const files = readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const version = file.replace('.sql', '');
      const existing = await client.query(
        'SELECT version FROM schema_migrations WHERE version = $1',
        [version]
      );
      if (existing.rowCount > 0) {
        log.info({ version }, 'Migration already applied, skipping');
        continue;
      }

      const sql = readFileSync(resolve(migrationsDir, file), 'utf8');
      log.info({ version }, 'Applying migration...');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version) VALUES ($1)',
          [version]
        );
        await client.query('COMMIT');
        log.info({ version }, 'Migration applied successfully');
      } catch (err) {
        await client.query('ROLLBACK');
        log.error({ version, err }, 'Migration failed');
        throw err;
      }
    }

    log.info('All migrations applied');
  } finally {
    await client.end();
  }
}
