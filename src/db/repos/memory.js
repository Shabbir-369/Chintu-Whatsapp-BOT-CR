/**
 * src/db/repos/memory.js
 * Memory system repository (memories, person_profiles, person_facts).
 */
import { query, withTransaction } from '../pool.js';

// ─── Memories ────────────────────────────────────────────────────

/**
 * Write a memory entry.
 * @param {object} mem
 * @returns {Promise<object>}
 */
export async function writeMemory({ scope, personId, groupJid, kind, text, importance, confidence, emotionalWeight, visibility }) {
  const result = await query(
    `INSERT INTO memories
       (scope, person_id, group_jid, kind, text, importance, confidence, emotional_weight, visibility)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [scope, personId || null, groupJid || null, kind, text,
     importance || 3, confidence || 1.0, emotionalWeight || 0.0, visibility || 'public']
  );
  return result.rows[0];
}

/**
 * Find similar memories (for dedupe/merge).
 * @param {string} text
 * @param {string|null} personId
 * @param {string|null} groupJid
 * @param {number} [threshold=0.6]
 * @returns {Promise<object[]>}
 */
export async function findSimilarMemories(text, personId, groupJid, threshold = 0.6) {
  const result = await query(
    `SELECT *, similarity(text, $1) as sim
     FROM memories
     WHERE archived_at IS NULL
       AND ($2::uuid IS NULL OR person_id = $2)
       AND ($3::text IS NULL OR group_jid = $3)
       AND similarity(text, $1) > $4
     ORDER BY sim DESC
     LIMIT 5`,
    [text, personId || null, groupJid || null, threshold]
  );
  return result.rows;
}

/**
 * Update an existing memory (dedupe merge).
 * @param {string} id
 * @param {object} updates
 */
export async function updateMemory(id, updates) {
  const { importance, confidence, last_confirmed_at, strength } = updates;
  await query(
    `UPDATE memories SET
       importance = GREATEST(importance, $2),
       confidence = GREATEST(confidence, $3),
       strength = LEAST(1.0, COALESCE($4, strength) + 0.1),
       last_confirmed_at = NOW(),
       last_used_at = NOW()
     WHERE id = $1`,
    [id, importance || 3, confidence || 1.0, strength || null]
  );
}

/**
 * Retrieve the memory pack for a model call (§10.3).
 * @param {object} opts
 * @param {string} [opts.personId]
 * @param {string} [opts.groupJid]
 * @param {string} [opts.messageText]
 * @param {number} [opts.limit=6]
 * @returns {Promise<object[]>}
 */
export async function retrieveMemoryPack({ personId, groupJid, messageText, limit = 6 }) {
  // Rank score = 0.45*ts_rank + 0.25*recency + 0.20*importance/5 + 0.10*emotional_weight
  const result = await query(
    `SELECT m.*,
       (0.45 * COALESCE(ts_rank(m.tsv, plainto_tsquery('english', $3)), 0)
        + 0.25 * EXP(-EXTRACT(EPOCH FROM (NOW() - m.created_at)) / (14 * 86400))
        + 0.20 * (m.importance::float / 5)
        + 0.10 * m.emotional_weight) AS rank_score
     FROM memories m
     WHERE m.archived_at IS NULL
       AND m.created_at > NOW() - INTERVAL '90 days'
       AND (
         ($2 IS NOT NULL AND m.group_jid = $2)
         OR ($2 IS NOT NULL AND m.person_id = $1 AND m.visibility = 'dm'
             AND m.text !~* '(attendance|bunk calculator|present_status|pod account|marks|grade|token|password|credential)')
         OR ($2 IS NULL AND $1 IS NOT NULL AND m.person_id = $1)
         OR ($1 IS NULL AND $2 IS NULL)
       )
     ORDER BY rank_score DESC
     LIMIT $4`,
    [personId || null, groupJid || null, messageText || 'general', limit]
  );
  // Refresh strength on retrieval
  if (result.rows.length > 0) {
    const ids = result.rows.map(r => r.id);
    await query(
      `UPDATE memories SET last_used_at = NOW(), strength = LEAST(1.0, strength + 0.05)
       WHERE id = ANY($1)`,
      [ids]
    );
  }
  return result.rows;
}

/**
 * Apply nightly strength decay.
 * importance 1: -8%/day, 3: -3%/day, 5: -0.5%/day
 */
export async function applyMemoryDecay() {
  await query(`
    UPDATE memories SET strength = GREATEST(0, strength * CASE
      WHEN importance = 1 THEN 0.92
      WHEN importance = 2 THEN 0.95
      WHEN importance = 3 THEN 0.97
      WHEN importance = 4 THEN 0.985
      WHEN importance = 5 THEN 0.995
      ELSE 0.97
    END)
    WHERE archived_at IS NULL
  `);

  // Archive weak memories
  await query(`
    UPDATE memories SET archived_at = NOW()
    WHERE strength < 0.1 AND importance <= 2 AND archived_at IS NULL
  `);
}

/**
 * Get the last daily_summary for a group.
 * @param {string} groupJid
 * @returns {Promise<object|null>}
 */
export async function getLastDailySummary(groupJid) {
  const result = await query(
    `SELECT * FROM memories
     WHERE group_jid = $1 AND kind = 'daily_summary' AND archived_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [groupJid]
  );
  return result.rows[0] || null;
}

/**
 * Delete memories for a person (forget command).
 * @param {string} personId
 */
export async function forgetPerson(personId) {
  await withTransaction(async (client) => {
    await client.query('DELETE FROM memories WHERE person_id = $1', [personId]);
    await client.query('DELETE FROM person_facts WHERE person_id = $1', [personId]);
    await client.query('DELETE FROM person_profiles WHERE person_id = $1', [personId]);
  });
}

// ─── Person Profiles ─────────────────────────────────────────────

/**
 * Get or create a person profile.
 * @param {string} personId
 * @returns {Promise<object>}
 */
export async function getPersonProfile(personId) {
  const result = await query('SELECT * FROM person_profiles WHERE person_id = $1', [personId]);
  if (result.rows[0]) return result.rows[0];
  await query(
    'INSERT INTO person_profiles (person_id) VALUES ($1) ON CONFLICT DO NOTHING',
    [personId]
  );
  const created = await query('SELECT * FROM person_profiles WHERE person_id = $1', [personId]);
  return created.rows[0];
}

/**
 * Update person profile fields.
 * @param {string} personId
 * @param {object} updates
 */
export async function updatePersonProfile(personId, updates) {
  const fields = [];
  const values = [personId];
  let i = 2;
  for (const [k, v] of Object.entries(updates)) {
    fields.push(`${k} = $${i++}`);
    values.push(typeof v === 'object' && v !== null ? JSON.stringify(v) : v);
  }
  if (fields.length === 0) return;
  fields.push('updated_at = NOW()');
  await query(
    `INSERT INTO person_profiles (person_id) VALUES ($1) ON CONFLICT (person_id) DO UPDATE SET ${fields.join(', ')}`,
    values
  );
}

// ─── Person Facts ─────────────────────────────────────────────────

/**
 * Write a person fact.
 * @param {object} fact
 */
export async function writePersonFact({ personId, fact, confidence, scope }) {
  await query(
    `INSERT INTO person_facts (person_id, fact, confidence, scope)
     VALUES ($1, $2, $3, $4)`,
    [personId, fact, confidence || 1.0, scope || 'public']
  );
}

/**
 * Get top facts for a person.
 * @param {string} personId
 * @param {number} [limit=5]
 * @returns {Promise<object[]>}
 */
export async function getPersonFacts(personId, limit = 5) {
  const result = await query(
    `SELECT * FROM person_facts
     WHERE person_id = $1 AND superseded_by IS NULL
     ORDER BY confidence DESC, last_confirmed_at DESC
     LIMIT $2`,
    [personId, limit]
  );
  return result.rows;
}

/**
 * Get last 7 morning messages for a group (for "don't repeat" rule).
 * @param {string} groupJid
 * @returns {Promise<object[]>}
 */
export async function getLastMorningMessages(groupJid) {
  const result = await query(
    `SELECT text FROM memories
     WHERE group_jid = $1 AND kind = 'daily_summary' AND archived_at IS NULL
     ORDER BY created_at DESC
     LIMIT 7`,
    [groupJid]
  );
  return result.rows;
}
