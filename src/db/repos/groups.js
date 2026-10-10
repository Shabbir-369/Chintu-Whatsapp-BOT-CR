/**
 * src/db/repos/groups.js
 * Groups repository.
 */
import { query } from '../pool.js';

/**
 * Upsert a group (from WhatsApp group metadata).
 * @param {object} group
 */
export async function upsertGroup({ jid, subject, member_count, last_activity_at }) {
  await query(
    `INSERT INTO groups (jid, subject, member_count, last_activity_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (jid) DO UPDATE SET
       subject = EXCLUDED.subject,
       member_count = EXCLUDED.member_count,
       last_activity_at = EXCLUDED.last_activity_at`,
    [jid, subject, member_count, last_activity_at || new Date()]
  );
}

/**
 * Get all known groups.
 * @returns {Promise<object[]>}
 */
export async function getAllGroups() {
  const result = await query('SELECT * FROM groups ORDER BY subject');
  return result.rows;
}

/**
 * Get all enabled groups.
 * @returns {Promise<object[]>}
 */
export async function getEnabledGroups() {
  const result = await query("SELECT * FROM groups WHERE enabled = TRUE AND mode != 'mute'");
  return result.rows;
}

/**
 * Get a group by JID.
 * @param {string} jid
 * @returns {Promise<object|null>}
 */
export async function getGroup(jid) {
  const result = await query('SELECT * FROM groups WHERE jid = $1', [jid]);
  return result.rows[0] || null;
}

/**
 * Enable a group.
 * @param {string} jid
 * @param {string} [mode='ambient']
 */
export async function enableGroup(jid, mode = 'ambient') {
  await query(
    `UPDATE groups SET enabled = TRUE, mode = $2, enabled_at = NOW() WHERE jid = $1`,
    [jid, mode]
  );
}

/**
 * Disable a group.
 * @param {string} jid
 */
export async function disableGroup(jid) {
  await query('UPDATE groups SET enabled = FALSE WHERE jid = $1', [jid]);
}

/**
 * Set group mode.
 * @param {string} jid
 * @param {string} mode – 'ambient' | 'trigger' | 'mute'
 */
export async function setGroupMode(jid, mode) {
  await query('UPDATE groups SET mode = $2 WHERE jid = $1', [jid, mode]);
}

/**
 * Update last_activity_at for a group.
 * @param {string} jid
 */
export async function touchGroup(jid) {
  await query(
    'UPDATE groups SET last_activity_at = NOW() WHERE jid = $1',
    [jid]
  );
}

/**
 * Update last_bot_at for a group.
 * @param {string} jid
 */
export async function touchGroupBotAt(jid) {
  await query(
    'UPDATE groups SET last_bot_at = NOW() WHERE jid = $1',
    [jid]
  );
}

/**
 * Set last_morning_date for a group.
 * @param {string} jid
 * @param {string} date – YYYY-MM-DD
 */
export async function setLastMorningDate(jid, date) {
  await query(
    'UPDATE groups SET last_morning_date = $2 WHERE jid = $1',
    [jid, date]
  );
}

/**
 * Get or create a group profile.
 * @param {string} groupJid
 * @returns {Promise<object>}
 */
export async function getGroupProfile(groupJid) {
  const result = await query('SELECT * FROM group_profiles WHERE group_jid = $1', [groupJid]);
  if (result.rows[0]) return result.rows[0];
  // Create default
  await query(
    `INSERT INTO group_profiles (group_jid) VALUES ($1) ON CONFLICT DO NOTHING`,
    [groupJid]
  );
  const created = await query('SELECT * FROM group_profiles WHERE group_jid = $1', [groupJid]);
  return created.rows[0];
}

/**
 * Update group profile fields.
 * @param {string} groupJid
 * @param {object} updates
 */
export async function updateGroupProfile(groupJid, updates) {
  const fields = [];
  const values = [groupJid];
  let i = 2;
  for (const [k, v] of Object.entries(updates)) {
    fields.push(`${k} = $${i++}`);
    values.push(typeof v === 'object' ? JSON.stringify(v) : v);
  }
  if (fields.length === 0) return;
  fields.push('updated_at = NOW()');
  await query(
    `UPDATE group_profiles SET ${fields.join(', ')} WHERE group_jid = $1`,
    values
  );
}

/**
 * Upsert a group member.
 * @param {string} groupJid
 * @param {string} personId
 * @param {string} [role='member']
 */
export async function upsertGroupMember(groupJid, personId, role = 'member') {
  await query(
    `INSERT INTO group_members (group_jid, person_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (group_jid, person_id) DO UPDATE SET role = EXCLUDED.role`,
    [groupJid, personId, role]
  );
}

/**
 * Get members of a group who have linked Pod accounts.
 * @param {string} groupJid
 * @returns {Promise<Array<{person_id, display_name}>>}
 */
export async function getLinkedMembers(groupJid) {
  const result = await query(
    `SELECT gm.person_id, p.display_name
     FROM group_members gm
     JOIN people p ON p.id = gm.person_id
     JOIN pod_accounts pa ON pa.person_id = gm.person_id
     WHERE gm.group_jid = $1`,
    [groupJid]
  );
  return result.rows;
}

/**
 * Update group settings JSON field.
 * @param {string} jid
 * @param {object} settings
 */
export async function updateGroupSettings(jid, settings) {
  await query(
    `UPDATE groups SET settings = settings || $2::jsonb WHERE jid = $1`,
    [jid, JSON.stringify(settings)]
  );
}
