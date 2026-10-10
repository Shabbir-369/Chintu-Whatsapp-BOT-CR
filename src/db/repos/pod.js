/**
 * src/db/repos/pod.js
 * Pod accounts, sessions, and link sessions repository.
 */
import { query } from '../pool.js';
import { encrypt, decrypt } from '../../util/crypto.js';

/**
 * Save Pod credentials for a person (encrypted).
 * @param {string} personId
 * @param {{ email: string, password: string }} credentials
 */
export async function savePodCredentials(personId, credentials) {
  const enc = encrypt(credentials, personId);
  await query(
    `INSERT INTO pod_accounts (person_id, enc_credentials)
     VALUES ($1, $2)
     ON CONFLICT (person_id) DO UPDATE SET enc_credentials = EXCLUDED.enc_credentials, linked_at = NOW()`,
    [personId, JSON.stringify(enc)]
  );
}

/**
 * Get decrypted Pod credentials for a person.
 * @param {string} personId
 * @returns {Promise<{ email: string, password: string }|null>}
 */
export async function getPodCredentials(personId) {
  const result = await query('SELECT enc_credentials FROM pod_accounts WHERE person_id = $1', [personId]);
  if (!result.rows[0]) return null;
  return decrypt(result.rows[0].enc_credentials, personId);
}

/**
 * Check if a person has a linked Pod account.
 * @param {string} personId
 * @returns {Promise<boolean>}
 */
export async function hasPodAccount(personId) {
  const result = await query('SELECT 1 FROM pod_accounts WHERE person_id = $1', [personId]);
  return result.rowCount > 0;
}

/**
 * Delete Pod account (unlink).
 * @param {string} personId
 */
export async function deletePodAccount(personId) {
  await query('DELETE FROM pod_accounts WHERE person_id = $1', [personId]);
  await query('DELETE FROM pod_sessions WHERE person_id = $1', [personId]);
}

/**
 * Save Pod session (encrypted).
 * @param {string} personId
 * @param {object} session
 */
export async function savePodSession(personId, session) {
  const enc = encrypt(session, personId);
  await query(
    `INSERT INTO pod_sessions (person_id, enc_session, expires_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (person_id) DO UPDATE SET enc_session = EXCLUDED.enc_session, expires_at = EXCLUDED.expires_at`,
    [personId, JSON.stringify(enc), new Date(session.expiresAt)]
  );
}

/**
 * Get valid Pod session for a person (if not expired).
 * @param {string} personId
 * @returns {Promise<object|null>}
 */
export async function getPodSession(personId) {
  const result = await query(
    'SELECT * FROM pod_sessions WHERE person_id = $1 AND expires_at > NOW() + INTERVAL \'60 seconds\'',
    [personId]
  );
  if (!result.rows[0]) return null;
  return decrypt(result.rows[0].enc_session, personId);
}

/**
 * Delete Pod session.
 * @param {string} personId
 */
export async function deletePodSession(personId) {
  await query('DELETE FROM pod_sessions WHERE person_id = $1', [personId]);
}

/**
 * Update Pod account success/fail stats.
 * @param {string} personId
 * @param {boolean} success
 */
export async function recordPodAttempt(personId, success) {
  if (success) {
    await query(
      'UPDATE pod_accounts SET last_ok_at = NOW(), fail_count = 0 WHERE person_id = $1',
      [personId]
    );
  } else {
    await query(
      'UPDATE pod_accounts SET fail_count = fail_count + 1 WHERE person_id = $1',
      [personId]
    );
  }
}

/**
 * Get/set the link flow session.
 * @param {string} personId
 * @returns {Promise<object|null>}
 */
export async function getPodLinkSession(personId) {
  const result = await query(
    'SELECT * FROM pod_link_sessions WHERE person_id = $1 AND expires_at > NOW()',
    [personId]
  );
  if (!result.rows[0]) return null;
  const row = result.rows[0];
  return {
    step: row.step,
    partial: row.enc_partial ? decrypt(row.enc_partial, personId) : null,
    expiresAt: row.expires_at,
  };
}

/**
 * Upsert a link session.
 * @param {string} personId
 * @param {string} step
 * @param {object|null} partial
 */
export async function upsertPodLinkSession(personId, step, partial = null) {
  const enc = partial ? encrypt(partial, personId) : null;
  await query(
    `INSERT INTO pod_link_sessions (person_id, step, enc_partial, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '1 hour')
     ON CONFLICT (person_id) DO UPDATE SET step = EXCLUDED.step, enc_partial = EXCLUDED.enc_partial, expires_at = EXCLUDED.expires_at`,
    [personId, step, enc ? JSON.stringify(enc) : null]
  );
}

/**
 * Delete link session.
 * @param {string} personId
 */
export async function deletePodLinkSession(personId) {
  await query('DELETE FROM pod_link_sessions WHERE person_id = $1', [personId]);
}

/**
 * Check attempts in window (max 3/hour for linking).
 * @param {string} personId
 * @returns {Promise<number>} Number of attempts in current hour
 */
export async function getLinkAttempts(personId) {
  const result = await query(
    `SELECT attempts_in_window, attempts_window_start FROM pod_accounts WHERE person_id = $1`,
    [personId]
  );
  if (!result.rows[0]) return 0;
  const row = result.rows[0];
  const windowStart = row.attempts_window_start;
  const hourAgo = new Date(Date.now() - 3600000);
  if (!windowStart || new Date(windowStart) < hourAgo) return 0;
  return row.attempts_in_window || 0;
}

/**
 * Increment link attempt count.
 * @param {string} personId
 */
export async function recordLinkAttempt(personId) {
  await query(
    `UPDATE pod_accounts SET
       attempts_in_window = CASE
         WHEN attempts_window_start IS NULL OR attempts_window_start < NOW() - INTERVAL '1 hour'
           THEN 1
         ELSE attempts_in_window + 1
       END,
       attempts_window_start = CASE
         WHEN attempts_window_start IS NULL OR attempts_window_start < NOW() - INTERVAL '1 hour'
           THEN NOW()
         ELSE attempts_window_start
       END
     WHERE person_id = $1`,
    [personId]
  );
}
