/**
 * src/db/repos/messages.js
 * Messages repository.
 */
import { query } from '../pool.js';

/**
 * Persist a message.
 */
export async function saveMessage({ waId, chatJid, senderPersonId, fromBot, text, quotedWaId, mentions, kind, sentAt }) {
  try {
    await query(
      `INSERT INTO messages (wa_id, chat_jid, sender_person_id, from_bot, text, quoted_wa_id, mentions, kind, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (chat_jid, wa_id) DO NOTHING`,
      [waId, chatJid, senderPersonId || null, fromBot || false,
       text || null, quotedWaId || null, JSON.stringify(mentions || []),
       kind || 'text', sentAt || new Date()]
    );
  } catch (err) {
    // Silently ignore duplicate message errors
  }
}

/**
 * Get recent messages in a chat.
 * @param {string} chatJid
 * @param {number} [limit=20]
 * @returns {Promise<object[]>}
 */
export async function getRecentMessages(chatJid, limit = 20) {
  const result = await query(
    `SELECT m.*, p.display_name, p.push_name
     FROM messages m
     LEFT JOIN people p ON p.id = m.sender_person_id
     WHERE m.chat_jid = $1
     ORDER BY m.sent_at DESC
     LIMIT $2`,
    [chatJid, limit]
  );
  return result.rows.reverse();
}

/**
 * Find a message by wa_id in a chat.
 */
export async function findMessage(chatJid, waId) {
  const result = await query(
    'SELECT * FROM messages WHERE chat_jid = $1 AND wa_id = $2',
    [chatJid, waId]
  );
  return result.rows[0] || null;
}

/**
 * Get the last N bot replies in a chat (for repetition check).
 * @param {string} chatJid
 * @param {number} [n=8]
 */
export async function getLastBotReplies(chatJid, n = 8) {
  const result = await query(
    `SELECT text FROM messages
     WHERE chat_jid = $1 AND from_bot = TRUE AND kind = 'text' AND text IS NOT NULL
     ORDER BY sent_at DESC
     LIMIT $2`,
    [chatJid, n]
  );
  return result.rows.map(r => r.text);
}

/**
 * Delete messages older than retentionDays (for nightly cleanup).
 */
export async function deleteOldMessages(retentionDays = 30) {
  await query(
    `DELETE FROM messages WHERE sent_at < NOW() - ($1 || ' days')::interval`,
    [retentionDays]
  );
}

/**
 * Count messages in a chat from a person in last N seconds (flood detection).
 */
export async function countRecentFrom(chatJid, personId, windowSeconds = 20) {
  const result = await query(
    `SELECT COUNT(*) AS cnt FROM messages
     WHERE chat_jid = $1 AND sender_person_id = $2
       AND sent_at > NOW() - ($3 || ' seconds')::interval`,
    [chatJid, personId, windowSeconds]
  );
  return parseInt(result.rows[0].cnt);
}

/**
 * Check if a chat has been quiet (no messages) for a given number of minutes.
 */
export async function isChatQuiet(chatJid, minutes = 25) {
  const result = await query(
    `SELECT COUNT(*) AS cnt FROM messages
     WHERE chat_jid = $1 AND sent_at > NOW() - ($2 || ' minutes')::interval`,
    [chatJid, minutes]
  );
  return parseInt(result.rows[0].cnt) === 0;
}

/**
 * Count messages from at least N distinct people in last hours (alive check).
 */
export async function getAliveStats(chatJid, hours = 3) {
  const result = await query(
    `SELECT COUNT(*) AS msg_count,
            COUNT(DISTINCT sender_person_id) AS person_count
     FROM messages
     WHERE chat_jid = $1
       AND from_bot = FALSE
       AND sent_at > NOW() - ($2 || ' hours')::interval`,
    [chatJid, hours]
  );
  return result.rows[0];
}

/**
 * Get last 10 messages in a chat with reply info (for ambient scoring).
 */
export async function getLast10Messages(chatJid) {
  const result = await query(
    `SELECT m.*, p.display_name, p.push_name
     FROM messages m
     LEFT JOIN people p ON p.id = m.sender_person_id
     WHERE m.chat_jid = $1
     ORDER BY m.sent_at DESC
     LIMIT 10`,
    [chatJid]
  );
  return result.rows.reverse();
}
