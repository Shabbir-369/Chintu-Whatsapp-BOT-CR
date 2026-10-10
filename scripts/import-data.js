/**
 * scripts/import-data.js
 * Import classinfo.json and academic-calendar.json into the database.
 * Run: npm run import:data
 *
 * Handles all 3 entry types from classinfo.json:
 *   1. Regular:  { slot, time, code, subject, short, faculty, room }
 *   2. Parallel: { slot, time, parallel: [{code, subject, short, faculty, room}, ...] }
 *   3. Batches:  { slot, time, batches: [{batch, code, subject, short, faculty, room}, ...] }
 *
 * Always does a full TRUNCATE of timetable_entries and calendar_events before inserting,
 * so stale data is never left behind.
 */
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { normalizeCalendarEvents } from '../src/util/calendar.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const WEEKDAY_MAP = {
  Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3,
  Thursday: 4, Friday: 5, Saturday: 6,
};

// ── Helpers ────────────────────────────────────────────────────────

function normaliseTime(t) {
  if (!t) return '00:00:00';
  const parts = String(t).trim().split(':');
  const hh = String(parseInt(parts[0] || '0', 10)).padStart(2, '0');
  const mm = String(parseInt(parts[1] || '0', 10)).padStart(2, '0');
  const ss = String(parseInt(parts[2] || '0', 10)).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function parseTimeRange(timeStr) {
  if (!timeStr) return ['00:00:00', '00:00:00'];
  // "11:10-12:00" → split on LAST occurrence of '-' after the first colon
  // Simple approach: find the '-' that is NOT part of HH:MM
  const match = timeStr.match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
  if (match) {
    return [normaliseTime(match[1]), normaliseTime(match[2])];
  }
  // Fallback: split on first '-'
  const idx = timeStr.indexOf('-');
  if (idx === -1) return [normaliseTime(timeStr), '00:00:00'];
  return [normaliseTime(timeStr.slice(0, idx)), normaliseTime(timeStr.slice(idx + 1))];
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  const { runMigrations } = await import('../src/db/migrate.js');
  const { withTransaction } = await import('../src/db/pool.js');

  await runMigrations();

  const classinfoPath = resolve(__dirname, '../data/classinfo.json');
  const calendarPath  = resolve(__dirname, '../data/academic-calendar.json');

  if (!existsSync(classinfoPath)) {
    throw new Error('data/classinfo.json not found');
  }
  if (!existsSync(calendarPath)) {
    throw new Error('data/academic-calendar.json not found');
  }

  const classinfo = JSON.parse(readFileSync(classinfoPath, 'utf8'));
  const calendar  = JSON.parse(readFileSync(calendarPath,  'utf8'));

  // Replace the timetable and calendar atomically on a single PostgreSQL client.
  await withTransaction(async (client) => {
    const txQuery = (sql, params) => client.query(sql, params);
    // ── Step 1: Wipe all existing data ────────────────────────────────
    console.log('🗑️  Clearing all timetable_entries...');
    await txQuery('TRUNCATE TABLE timetable_entries RESTART IDENTITY CASCADE');

    console.log('🗑️  Clearing all calendar_events...');
    await txQuery('TRUNCATE TABLE calendar_events RESTART IDENTITY CASCADE');


    // ── Step 2: Import timetable ──────────────────────────────────────
    const effectiveFrom = classinfo.effectiveFrom || new Date().toISOString().slice(0, 10);
    let entryCount = 0;

    for (const [dayName, entries] of Object.entries(classinfo.timetable || {})) {
      const weekday = WEEKDAY_MAP[dayName];
      if (weekday === undefined) {
        console.warn(`  ⚠️  Unknown day name: ${dayName}, skipping`);
        continue;
      }

      for (const entry of (entries || [])) {
        if (!entry) continue;

        // Get slot time — can be on entry or on the sub-item
        const slotStr = String(entry.slot || '');

        // ── Type 1: parallel entries ──────────────────────────────────
        if (Array.isArray(entry.parallel) && entry.parallel.length > 0) {
          const [start, end] = parseTimeRange(entry.time || '00:00-00:00');
          for (const p of entry.parallel) {
            await insertEntry(txQuery, {
              weekday,
              slot: slotStr,
              start_time: start,
              end_time: end,
              code: p.code || '',
              subject: p.subject || '',
              short: p.short || p.code || '',
              faculty: p.faculty || '',
              room: p.room || '',
              batch: p.batch || null,
              parallel_group: 'parallel',
              effective_from: effectiveFrom,
            });
            entryCount++;
          }
          continue;
        }

        // ── Type 2: batch entries ─────────────────────────────────────
        if (Array.isArray(entry.batches) && entry.batches.length > 0) {
          const [start, end] = parseTimeRange(entry.time || '00:00-00:00');
          for (const b of entry.batches) {
            await insertEntry(txQuery, {
              weekday,
              slot: slotStr,
              start_time: start,
              end_time: end,
              code: b.code || '',
              subject: b.subject || '',
              short: b.short || b.code || '',
              faculty: b.faculty || '',
              room: b.room || '',
              batch: b.batch || null,
              parallel_group: null,
              effective_from: effectiveFrom,
            });
            entryCount++;
          }
          continue;
        }

        // ── Type 3: regular entry ─────────────────────────────────────
        const [start, end] = parseTimeRange(entry.time || '00:00-00:00');
        await insertEntry(txQuery, {
          weekday,
          slot: slotStr,
          start_time: start,
          end_time: end,
          code: entry.code || '',
          subject: entry.subject || '',
          short: entry.short || entry.code || '',
          faculty: entry.faculty || '',
          room: entry.room || '',
          batch: entry.batch || null,
          parallel_group: entry.parallel_group || null,
          effective_from: effectiveFrom,
        });
        entryCount++;
      }
    }

    console.log(`✅ Imported ${entryCount} timetable entries`);
    console.log('\n📋 Timetable summary:');
    for (const [day, entries] of Object.entries(classinfo.timetable || {})) {
      const count = countEntries(entries);
      if (count > 0) console.log(`   ${day.padEnd(10)}: ${count} entries`);
    }

    // ── Step 3: Import calendar ───────────────────────────────────────
    // Preserve explicit non-consecutive dates (e.g. MST-I excludes Gandhi Jayanti)
    // and represent continuous holidays/breaks as date ranges.
    const calendarRows = normalizeCalendarEvents(calendar);
    for (const event of calendarRows) {
      await txQuery(
        `INSERT INTO calendar_events (date_from, date_to, name, type, notes)
         VALUES ($1, $2, $3, $4, $5)`,
        [event.date_from, event.date_to, event.name, event.type, event.notes || null]
      );
    }
    const eventCount = calendarRows.length;
    console.log(`\n✅ Imported ${eventCount} calendar date rows (explicit exam dates preserved)`);
    console.log('\n📅 Calendar summary:');
    for (const event of calendarRows) {
      console.log(`   [${event.type}] ${event.date_from}${event.date_to !== event.date_from ? ` → ${event.date_to}` : ''}: ${event.name}`);
    }

    console.log('\n✅ Data import complete!');
  });
}

export default main;

async function insertEntry(query, e) {
  await query(
    `INSERT INTO timetable_entries
       (weekday, slot, start_time, end_time, code, subject, short, faculty, room, batch, parallel_group, effective_from)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [e.weekday, e.slot, e.start_time, e.end_time, e.code, e.subject, e.short,
     e.faculty, e.room, e.batch || null, e.parallel_group || null, e.effective_from]
  );
}

function countEntries(entries) {
  if (!Array.isArray(entries)) return 0;
  let n = 0;
  for (const e of entries) {
    if (!e) continue;
    if (Array.isArray(e.parallel)) n += e.parallel.length;
    else if (Array.isArray(e.batches)) n += e.batches.length;
    else n += 1;
  }
  return n;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch(err => {
    console.error('❌ Import failed:', err?.message || 'unknown error');
    process.exitCode = 1;
  });
}
