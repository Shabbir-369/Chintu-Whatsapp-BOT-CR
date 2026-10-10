/**
 * src/db/pool.js
 * PostgreSQL connection pool (pg). Max 8 connections per blueprint §5.4.
 */
import pg from 'pg';
import { config } from '../config.js';
import { getLogger } from '../logger.js';

const log = getLogger('db/pool');

const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 8,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  log.error({ err }, 'Unexpected pg pool error');
});

/**
 * Run a SQL query.
 * @param {string} text
 * @param {any[]} [params]
 * @returns {Promise<pg.QueryResult>}
 */
export async function query(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

/**
 * Run a function inside a transaction.
 * @param {function(pg.PoolClient): Promise<any>} fn
 * @returns {Promise<any>}
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export { pool };
