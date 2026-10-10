/**
 * src/db/repos/timetable.js
 * Timetable entries, calendar events, day notes, notices, jobs, stats, settings, audit.
 */
import { query, withTransaction } from '../pool.js';

// ─── Timetable ───────────────────────────────────────────────────

export async function getEntriesForDay(weekday, dateStr = new Date().toISOString().slice(0, 10)) {
  const result = await query(
    `SELECT * FROM timetable_entries
     WHERE weekday = $1
       AND effective_from <= $2::date
       AND (effective_to IS NULL OR effective_to >= $2::date)
     ORDER BY start_time`,
    [weekday, dateStr]
  );
  return result.rows;
}

export async function upsertTimetableEntry(entry) {
  const { weekday, slot, start_time, end_time, code, subject, short, faculty, room, batch, parallel_group, effective_from } = entry;
  await query(
    `INSERT INTO timetable_entries
       (weekday, slot, start_time, end_time, code, subject, short, faculty, room, batch, parallel_group, effective_from)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [weekday, slot, start_time, end_time, code, subject, short, faculty, room, batch || null, parallel_group || null, effective_from]
  );
}

export async function clearTimetableFromDate(effectiveFrom) {
  await query('DELETE FROM timetable_entries WHERE effective_from = $1', [effectiveFrom]);
}

// ─── Calendar Events ─────────────────────────────────────────────

export async function getAllCalendarEvents() {
  const result = await query('SELECT * FROM calendar_events ORDER BY date_from, name');
  return result.rows;
}

export async function getCalendarEventsForDateRange(from, to) {
  const result = await query(
    `SELECT * FROM calendar_events
     WHERE date_from <= $2 AND date_to >= $1
     ORDER BY date_from`,
    [from, to]
  );
  return result.rows;
}

export async function upsertCalendarEvent(event) {
  const { date_from, date_to, name, type, notes } = event;
  await query(
    `INSERT INTO calendar_events (date_from, date_to, name, type, notes)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [date_from, date_to, name, type, notes || null]
  );
}

export async function clearCalendarEvents() {
  await query('DELETE FROM calendar_events');
}

// ─── Day Notes ───────────────────────────────────────────────────

export async function getDayNotes(date, groupJid = null) {
  const result = await query(
    `SELECT * FROM day_notes
     WHERE date = $1 AND (group_jid = $2 OR group_jid IS NULL)
     ORDER BY created_at`,
    [date, groupJid || null]
  );
  return result.rows;
}

export async function addDayNote({ date, groupJid, text }) {
  await query(
    'INSERT INTO day_notes (date, group_jid, text) VALUES ($1, $2, $3)',
    [date, groupJid || null, text]
  );
}

// ─── Notices ─────────────────────────────────────────────────────

export async function saveNotice({ source, sourceId, text, postedAt }) {
  await query(
    `INSERT INTO notices (source, source_id, text, posted_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (source, source_id) DO NOTHING`,
    [source, sourceId || null, text, postedAt || new Date()]
  );
}

export async function getRecentNotices(limit = 10) {
  const result = await query(
    'SELECT * FROM notices ORDER BY posted_at DESC LIMIT $1',
    [limit]
  );
  return result.rows;
}

export async function getNoticeById(id) {
  const result = await query('SELECT * FROM notices WHERE id = $1', [id]);
  return result.rows[0] || null;
}

export async function isNoticeKnown(source, sourceId) {
  const result = await query(
    'SELECT 1 FROM notices WHERE source = $1 AND source_id = $2',
    [source, sourceId]
  );
  return result.rowCount > 0;
}

// ─── Jobs ────────────────────────────────────────────────────────

export async function createJob({ kind, runAt, payload }) {
  const result = await query(
    `INSERT INTO jobs (kind, run_at, payload) VALUES ($1, $2, $3) RETURNING *`,
    [kind, runAt, JSON.stringify(payload || {})]
  );
  return result.rows[0];
}

export async function getDueJobs() {
  const result = await query(
    `SELECT * FROM jobs
     WHERE status = 'pending' AND run_at <= NOW()
     ORDER BY run_at
     LIMIT 50`
  );
  return result.rows;
}

export async function markJobDone(id) {
  await query("UPDATE jobs SET status = 'done' WHERE id = $1", [id]);
}

export async function retryJob(id, delaySeconds = 30) {
  await query(
    `UPDATE jobs SET status = 'pending', attempts = attempts + 1,
       run_at = NOW() + ($2 * INTERVAL '1 second')
     WHERE id = $1 AND attempts < 2`,
    [id, delaySeconds]
  );
}

export async function markJobFailed(id) {
  await query(
    "UPDATE jobs SET status = 'failed', attempts = attempts + 1 WHERE id = $1",
    [id]
  );
}

export async function cancelJob(id) {
  await query("UPDATE jobs SET status = 'cancelled' WHERE id = $1", [id]);
}

export async function cleanOldJobs() {
  await query(
    "DELETE FROM jobs WHERE status IN ('done','failed','cancelled') AND created_at < NOW() - INTERVAL '7 days'"
  );
}

// ─── Daily Events ────────────────────────────────────────────────

export async function recordDailyEvent(date, groupJid, kind) {
  await query(
    `INSERT INTO daily_events (date, group_jid, kind, count)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (date, group_jid, kind) DO UPDATE SET count = daily_events.count + 1`,
    [date, groupJid, kind]
  );
}

export async function getDailyEventCount(date, groupJid, kind) {
  const result = await query(
    'SELECT count FROM daily_events WHERE date = $1 AND group_jid = $2 AND kind = $3',
    [date, groupJid, kind]
  );
  return result.rows[0]?.count || 0;
}

// ─── Settings ────────────────────────────────────────────────────

export async function getSetting(key, defaultValue = null) {
  const result = await query('SELECT value FROM settings WHERE key = $1', [key]);
  if (!result.rows[0]) return defaultValue;
  return result.rows[0].value;
}

export async function setSetting(key, value) {
  await query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(value)]
  );
}

// ─── Usage Counters ──────────────────────────────────────────────

export async function incrementUsage(key, amount = 1) {
  const today = new Date().toISOString().slice(0, 10);
  await query(
    `INSERT INTO usage_counters (date, key, value) VALUES ($1, $2, $3)
     ON CONFLICT (date, key) DO UPDATE SET value = usage_counters.value + $3`,
    [today, key, amount]
  );
}

export async function getUsageToday(key) {
  const today = new Date().toISOString().slice(0, 10);
  const result = await query(
    'SELECT value FROM usage_counters WHERE date = $1 AND key = $2',
    [today, key]
  );
  return result.rows[0]?.value || 0;
}

// ─── Audit Log ───────────────────────────────────────────────────

export async function writeAuditLog({ actorPersonId, action, detail }) {
  await query(
    'INSERT INTO audit_log (actor_person_id, action, detail) VALUES ($1, $2, $3)',
    [actorPersonId || null, action, JSON.stringify(detail || {})]
  );
}

// ─── Mass Bunk ───────────────────────────────────────────────────

export async function createMassBunkRun({ groupJid, targetDate }) {
  const result = await query(
    `INSERT INTO mass_bunk_runs (group_jid, target_date) VALUES ($1, $2) RETURNING *`,
    [groupJid, targetDate]
  );
  return result.rows[0];
}

export async function updateMassBunkRun(id, { linkedCount, unknownCount, yellowCount, redCount, summary }) {
  await query(
    `UPDATE mass_bunk_runs SET
       linked_count = $2, unknown_count = $3, yellow_count = $4, red_count = $5, summary = $6
     WHERE id = $1`,
    [id, linkedCount, unknownCount, yellowCount, redCount, JSON.stringify(summary || {})]
  );
}

export async function saveMassBunkResult({ runId, personId, worstCourse, beforePct, afterPct, zone }) {
  await query(
    `INSERT INTO mass_bunk_results (run_id, person_id, worst_course, before_pct, after_pct, zone)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (run_id, person_id) DO UPDATE SET zone = EXCLUDED.zone, after_pct = EXCLUDED.after_pct`,
    [runId, personId, worstCourse || null, beforePct || null, afterPct || null, zone]
  );
}

export async function markMassBunkWarned(runId, personId) {
  await query(
    'UPDATE mass_bunk_results SET warned_at = NOW() WHERE run_id = $1 AND person_id = $2',
    [runId, personId]
  );
}

export async function getRecentMassBunkRun(groupJid, targetDate) {
  const result = await query(
    `SELECT * FROM mass_bunk_runs
     WHERE group_jid = $1 AND target_date = $2
       AND created_at > NOW() - INTERVAL '3 hours'
     ORDER BY created_at DESC
     LIMIT 1`,
    [groupJid, targetDate]
  );
  return result.rows[0] || null;
}

export async function cleanOldMassBunkResults() {
  await query(
    `DELETE FROM mass_bunk_results
     WHERE run_id IN (
       SELECT id FROM mass_bunk_runs WHERE target_date < CURRENT_DATE - 7
     )`
  );
}
