/**
 * src/db/repos/people.js
 * People, identities, and owner identity repository.
 */
import { query, withTransaction } from '../pool.js';

/**
 * Find a person by JID (phone or LID).
 * @param {string} jid
 * @returns {Promise<object|null>}
 */
export async function findPersonByJid(jid) {
  const result = await query(
    `SELECT p.* FROM people p
     JOIN person_identities pi ON pi.person_id = p.id
     WHERE pi.jid = $1`,
    [jid]
  );
  return result.rows[0] || null;
}

/**
 * Find or create a person by JID.
 * @param {string} jid
 * @param {object} [opts]
 * @param {string} [opts.pushName]
 * @param {string} [opts.kind] – 'phone' | 'lid'
 * @param {string} [opts.phone]
 * @returns {Promise<{person: object, created: boolean}>}
 */
export async function findOrCreatePerson(jid, opts = {}) {
  const { pushName, kind = jid.includes('@lid') ? 'lid' : 'phone', phone = null } = opts;

  const existing = await findPersonByJid(jid);
  const jidPhone = jid?.endsWith('@s.whatsapp.net') ? jid.split('@')[0] : null;
  const knownPhone = String(phone || jidPhone || '').replace(/\D/g, '') || null;
  if (existing) {
    const updates = [];
    const values = [];
    let n = 1;
    if (pushName && existing.push_name !== pushName) {
      updates.push(`push_name = $${n++}`); values.push(pushName); existing.push_name = pushName;
    }
    // Give every identity a stable usable label. A phone number is the fallback
    // until the owner supplies a real name; never overwrite an owner-assigned name.
    if (!existing.display_name && (pushName || knownPhone)) {
      const fallback = pushName || knownPhone;
      updates.push(`display_name = $${n++}`); values.push(fallback); existing.display_name = fallback;
    }
    updates.push('last_seen_at = NOW()');
    values.push(existing.id);
    await query(`UPDATE people SET ${updates.join(', ')} WHERE id = $${n}`, values);
    return { person: existing, created: false };
  }

  return withTransaction(async (client) => {
    const initialLabel = pushName || knownPhone;
    const personRes = await client.query(
      `INSERT INTO people (push_name, display_name, language_pref) VALUES ($1, $2, 'hinglish') RETURNING *`,
      [pushName || null, initialLabel || null]
    );
    const person = personRes.rows[0];

    await client.query(
      'INSERT INTO person_identities (person_id, jid, kind, phone) VALUES ($1, $2, $3, $4)',
      [person.id, jid, kind, knownPhone]
    );

    return { person, created: true };
  });
}

/**
 * Add a new JID/identity for an existing person.
 * @param {string} personId
 * @param {string} jid
 * @param {string} kind
 * @param {string|null} phone
 */
export async function addIdentity(personId, jid, kind = 'phone', phone = null) {
  await query(
    `INSERT INTO person_identities (person_id, jid, kind, phone) VALUES ($1, $2, $3, $4)
     ON CONFLICT (jid) DO NOTHING`,
    [personId, jid, kind, phone]
  );
}

/**
 * Merge two person records into one (keep personId1, delete personId2).
 * @param {string} personId1 – keep
 * @param {string} personId2 – merge into person1, then conceptually remove
 */
export async function mergePeople(personId1, personId2) {
  await withTransaction(async (client) => {
    // Move identities
    await client.query(
      'UPDATE person_identities SET person_id = $1 WHERE person_id = $2',
      [personId1, personId2]
    );
    // Move messages
    await client.query(
      'UPDATE messages SET sender_person_id = $1 WHERE sender_person_id = $2',
      [personId1, personId2]
    );
    // Move memories
    await client.query(
      'UPDATE memories SET person_id = $1 WHERE person_id = $2',
      [personId1, personId2]
    );
    // Move person_facts
    await client.query(
      'UPDATE person_facts SET person_id = $1 WHERE person_id = $2',
      [personId1, personId2]
    );
    // Keep approval cards linked to the surviving identity. This is vital for
    // LID/phone reconciliation, where an approval may be waiting on either.
    await client.query(
      'UPDATE approvals SET subject_person_id = $1 WHERE subject_person_id = $2',
      [personId1, personId2]
    );
    // Prefer the surviving person's access decision. If it has no access row,
    // retain the duplicate's state rather than losing it to the cascade.
    const primaryAccess = await client.query(
      'SELECT 1 FROM dm_access WHERE person_id = $1 FOR UPDATE',
      [personId1]
    );
    if (primaryAccess.rowCount > 0) {
      await client.query('DELETE FROM dm_access WHERE person_id = $1', [personId2]);
    } else {
      await client.query(
        'UPDATE dm_access SET person_id = $1 WHERE person_id = $2',
        [personId1, personId2]
      );
    }
    // Delete old person (cascades will handle the rest)
    await client.query('DELETE FROM people WHERE id = $1', [personId2]);
  });
}

/**
 * Set display_name for a person (owner-approved).
 * @param {string} personId
 * @param {string} displayName
 */
export async function setDisplayName(personId, displayName) {
  await query(
    'UPDATE people SET display_name = $1 WHERE id = $2',
    [displayName, personId]
  );
}

/**
 * Check if a JID is in owner_identities.
 * @param {string} jid
 * @returns {Promise<boolean>}
 */
export async function isOwnerJid(jid) {
  const result = await query('SELECT 1 FROM owner_identities WHERE jid = $1', [jid]);
  return result.rowCount > 0;
}

/**
 * Add a JID to owner_identities.
 * @param {string} jid
 */
export async function addOwnerJid(jid) {
  await query(
    'INSERT INTO owner_identities (jid) VALUES ($1) ON CONFLICT DO NOTHING',
    [jid]
  );
}

/**
 * Get all owner JIDs.
 * @returns {Promise<string[]>}
 */
export async function getOwnerJids() {
  const result = await query('SELECT jid FROM owner_identities');
  return result.rows.map(r => r.jid);
}

/**
 * Get person by ID.
 * @param {string} personId
 * @returns {Promise<object|null>}
 */
export async function getPersonById(personId) {
  const result = await query('SELECT * FROM people WHERE id = $1', [personId]);
  return result.rows[0] || null;
}

/**
 * Get all identities for a person.
 * @param {string} personId
 * @returns {Promise<object[]>}
 */
export async function getIdentities(personId) {
  const result = await query(
    'SELECT * FROM person_identities WHERE person_id = $1',
    [personId]
  );
  return result.rows;
}

/**
 * Find person by display_name or approved name (fuzzy).
 * @param {string} name
 * @returns {Promise<object[]>}
 */
export async function findPeopleByName(name) {
  const result = await query(
    `SELECT * FROM people
     WHERE display_name ILIKE $1
     ORDER BY last_seen_at DESC
     LIMIT 10`,
    [`%${name}%`]
  );
  return result.rows;
}

/**
 * Recent people used only to offer safe owner-side name suggestions when a
 * command has no exact or strong match. Never used to expose data to groups.
 */
export async function getRecentPeopleForResolution(limit = 50) {
  const safeLimit = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 50));
  const result = await query(
    `SELECT p.*,
            COALESCE((SELECT array_agg(DISTINCT regexp_replace(COALESCE(pi.phone, split_part(pi.jid, '@', 1)), '\\D', '', 'g'))
                      FROM person_identities pi
                      WHERE pi.person_id = p.id AND pi.kind = 'phone'), ARRAY[]::text[]) AS phone_numbers
     FROM people p
     ORDER BY p.last_seen_at DESC NULLS LAST
     LIMIT $1`,
    [safeLimit]
  );
  return result.rows;
}

/** Mark a person as having received the one-time owner name prompt. */
export async function claimNamePrompt(personId) {
  const result = await query(
    `UPDATE people SET name_prompted_at = NOW()
     WHERE id = $1 AND name_prompted_at IS NULL
       AND (display_name ~ '^[+0-9() -]{7,20}$' OR display_name IS NULL)
     RETURNING id`,
    [personId]
  );
  return result.rowCount > 0;
}

/** Return the best available phone number for a person. */
export async function getPersonPhone(personId) {
  const result = await query(
    `SELECT COALESCE(NULLIF(pi.phone, ''), split_part(pi.jid, '@', 1)) AS phone
     FROM person_identities pi
     WHERE pi.person_id = $1 AND pi.kind = 'phone'
     ORDER BY CASE WHEN pi.phone IS NOT NULL AND pi.phone <> '' THEN 0 ELSE 1 END
     LIMIT 1`,
    [personId]
  );
  return result.rows[0]?.phone ? String(result.rows[0].phone).replace(/\D/g, '') : null;
}
