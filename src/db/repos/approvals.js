/**
 * src/db/repos/approvals.js
 * Approval cards management (DM, name, group, message approvals).
 */
import { query } from '../pool.js';

const latestGeneratedByPrefix = new Map();
let codeGenerationQueue = Promise.resolve();

/**
 * Generate a unique approval code (e.g. D4, N7, G2, M3).
 * @param {string} prefix – 'D' | 'N' | 'G' | 'M'
 * Uses the database's current highest code so a process restart never reuses
 * D1/N1 and accidentally attaches a new request to an older person.
 * @returns {Promise<string>}
 */
export function genCode(prefix) {
  if (!/^[DNGM]$/.test(prefix)) {
    throw new Error(`Unsupported approval prefix: ${prefix}`);
  }

  // Two chats can request a code concurrently. Serialize reservations inside
  // this process; the database unique constraint remains the final safeguard.
  const reservation = codeGenerationQueue.then(async () => {
    const result = await query(
      `SELECT COALESCE(MAX(SUBSTRING(code FROM 2)::BIGINT), 0) AS latest
       FROM approvals
       WHERE code ~ $1`,
      [`^${prefix}[0-9]+$`]
    );
    const databaseNext = Number(result.rows[0].latest) + 1;
    const memoryNext = (latestGeneratedByPrefix.get(prefix) || 0) + 1;
    const number = Math.max(databaseNext, memoryNext);
    latestGeneratedByPrefix.set(prefix, number);
    return `${prefix}${number}`;
  });

  codeGenerationQueue = reservation.catch(() => {});
  return reservation;
}

/**
 * Create an approval card.
 * @param {object} opts
 * @returns {Promise<object>} The approval row
 */
export async function createApproval({ code, kind, subjectPersonId, payload, cardMessageId }) {
  const result = await query(
    `INSERT INTO approvals (code, kind, subject_person_id, payload, card_message_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [code, kind, subjectPersonId || null, JSON.stringify(payload || {}), cardMessageId || null]
  );
  return result.rows[0];
}

/**
 * Find an open approval by code.
 * @param {string} code
 * @returns {Promise<object|null>}
 */
export async function findOpenApproval(code) {
  const result = await query(
    "SELECT * FROM approvals WHERE code = $1 AND status = 'open'",
    [code]
  );
  return result.rows[0] || null;
}

/**
 * Find an open approval by card_message_id (for quote-reply resolution).
 * @param {string} cardMessageId
 * @returns {Promise<object|null>}
 */
export async function findApprovalByMessageId(cardMessageId) {
  const result = await query(
    "SELECT * FROM approvals WHERE card_message_id = $1 AND status = 'open'",
    [cardMessageId]
  );
  return result.rows[0] || null;
}

/**
 * Decide an approval.
 * @param {string} id
 * @param {string} status – 'approved' | 'rejected'
 * @param {string} [decidedValue]
 */
export async function decideApproval(id, status, decidedValue = null) {
  await query(
    `UPDATE approvals SET status = $2, decided_at = NOW(), decided_value = $3
     WHERE id = $1`,
    [id, status, decidedValue]
  );
}

/**
 * Get all open approvals of a given kind.
 * @param {string} kind
 * @returns {Promise<object[]>}
 */
export async function getOpenApprovals(kind = null) {
  // Join person_identities to get the phone number for each approval subject
  const base = `
    SELECT a.*,
           pi.jid,
           pi.phone,
           p.push_name,
           p.display_name
    FROM approvals a
    LEFT JOIN people p ON p.id = a.subject_person_id
    LEFT JOIN person_identities pi ON pi.person_id = a.subject_person_id AND pi.kind = 'phone'
    WHERE a.status = 'open'
  `;
  const result = kind
    ? await query(base + " AND a.kind = $1 ORDER BY a.created_at", [kind])
    : await query(base + " ORDER BY a.created_at");
  return result.rows;
}

/**
 * Update card_message_id after sending the approval card.
 * @param {string} id
 * @param {string} cardMessageId
 */
export async function setCardMessageId(id, cardMessageId) {
  await query(
    'UPDATE approvals SET card_message_id = $2 WHERE id = $1',
    [id, cardMessageId]
  );
}

/**
 * Expire old open approvals (older than 7 days).
 */
export async function expireOldApprovals() {
  await query(
    `UPDATE approvals SET status = 'expired'
     WHERE status = 'open' AND created_at < NOW() - INTERVAL '7 days'`
  );
}

// ─── Name Claims ─────────────────────────────────────────────────

/**
 * Create a name claim.
 * @param {object} claim
 * @returns {Promise<object>}
 */
export async function createNameClaim({ personId, source, claimedName, evidence }) {
  const result = await query(
    `INSERT INTO name_claims (person_id, source, claimed_name, evidence)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [personId, source, claimedName, JSON.stringify(evidence || {})]
  );
  return result.rows[0];
}

/**
 * Decide a name claim.
 * @param {string} id
 * @param {string} status
 */
export async function decideNameClaim(id, status) {
  await query(
    'UPDATE name_claims SET status = $2, decided_at = NOW() WHERE id = $1',
    [id, status]
  );
}

/**
 * Get pending name claims for a person.
 * @param {string} personId
 * @returns {Promise<object[]>}
 */
export async function getPendingNameClaims(personId) {
  const result = await query(
    "SELECT * FROM name_claims WHERE person_id = $1 AND status = 'proposed' ORDER BY created_at",
    [personId]
  );
  return result.rows;
}

// ─── DM Access ───────────────────────────────────────────────────

/**
 * Get DM access status for a person.
 * @param {string} personId
 * @returns {Promise<object|null>}
 */
export async function getDmAccess(personId) {
  const result = await query('SELECT * FROM dm_access WHERE person_id = $1', [personId]);
  return result.rows[0] || null;
}

/**
 * Create or update DM access status.
 * @param {string} personId
 * @param {string} status
 * @param {string} [firstMsgPreview]
 */
export async function upsertDmAccess(personId, status, firstMsgPreview = null) {
  await query(
    `INSERT INTO dm_access (person_id, status, first_message_preview, owner_notified_at)
     VALUES ($1, $2, $3, NULL)
     ON CONFLICT (person_id) DO UPDATE SET status = EXCLUDED.status`,
    [personId, status, firstMsgPreview]
  );
}

/**
 * Set DM access decision.
 * @param {string} personId
 * @param {string} status
 */
export async function setDmAccess(personId, status) {
  await query(
    `UPDATE dm_access SET status = $2, decided_at = NOW() WHERE person_id = $1`,
    [personId, status]
  );
}

/**
 * Get all pending DM access requests.
 * @returns {Promise<object[]>}
 */
export async function getPendingDmRequests() {
  const result = await query(
    `SELECT da.*, p.push_name, p.display_name
     FROM dm_access da
     JOIN people p ON p.id = da.person_id
     WHERE da.status = 'pending'
     ORDER BY da.requested_at`
  );
  return result.rows;
}
