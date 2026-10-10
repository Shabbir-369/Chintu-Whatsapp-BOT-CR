/**
 * scripts/fix-jobs-table.mjs
 * One-time script: create jobs table if missing (migration already applied flag prevents re-run).
 */
import { query } from '../src/db/pool.js';

try {
  await query(`
    CREATE TABLE IF NOT EXISTS jobs (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      kind        TEXT NOT NULL,
      run_at      TIMESTAMPTZ NOT NULL,
      payload     JSONB NOT NULL DEFAULT '{}',
      status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed','cancelled')),
      attempts    INT NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_jobs_run_at ON jobs (run_at) WHERE status = 'pending'`);
  console.log('✅ jobs table ready');
  process.exit(0);
} catch (err) {
  console.error('❌ Error:', err.message);
  process.exit(1);
}
