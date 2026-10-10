/**
 * src/skills/timetable.js
 * Timetable queries, day context assembly. §11.7.
 *
 * B1 batch = Roll No. 60–95
 * B2 batch = remaining (Roll No. < 60 or > 95)
 * Parallel (SC/DSc) = subject-based split, not batch-based
 */
import { getEntriesForDay, getCalendarEventsForDateRange, getAllCalendarEvents, getDayNotes } from '../db/repos/timetable.js';
import { readFileSync } from 'node:fs';
import { normalizeCalendarEvents, answerCalendarQuestion, isCalendarQuestion } from '../util/calendar.js';
import { toISTDateString, getISTWeekday } from '../util/time.js';
import { resolveTimetableRequest, dateFromISTDateString, formatTimetableTimeRange } from '../util/timetableQuery.js';
import { getLogger } from '../logger.js';

const log = getLogger('skills/timetable');

// Keep a local canonical copy so calendar answers still work before/without DB import.
const canonicalCalendarEvents = normalizeCalendarEvents(JSON.parse(readFileSync(new URL('../../data/academic-calendar.json', import.meta.url), 'utf8')));

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Get the timetable for a date.
 */
export async function getDayTimetable(date = new Date(), groupJid = null) {
  const weekday = getISTWeekday(date);
  const dateStr = toISTDateString(date);
  const dayName = WEEKDAY_NAMES[weekday];

  const [entries, dbEvents, notes] = await Promise.all([
    getEntriesForDay(weekday, dateStr),
    getCalendarEventsForDateRange(dateStr, dateStr),
    getDayNotes(dateStr, groupJid),
  ]);

  // Use the bundled official calendar when it knows an event, even if the DB is
  // stale or was imported from an older version. Preserve DB-only custom events.
  const canonicalTypes = new Set(canonicalCalendarEvents.map(e => `${String(e.name).toLowerCase()}|${e.type}`));
  const canonicalForDate = canonicalCalendarEvents.filter(e => e.date_from <= dateStr && e.date_to >= dateStr);
  const events = [
    ...canonicalForDate,
    ...dbEvents.filter(e => !canonicalTypes.has(`${String(e.name).toLowerCase()}|${e.type}`)),
  ];

  const holiday = events.find(e => e.type === 'holiday');
  const exams = events.filter(e => e.type === 'exam');
  const grouped = groupEntries(entries);

  return { entries: grouped, rawEntries: entries, dayName, dateStr, weekday, holiday, exams, events, notes };
}

/**
 * Get timetable by weekday number (0=Sun…6=Sat) for a specific day query.
 * Returns the NEXT occurrence of that weekday from today.
 */
export async function getDayTimetableByWeekday(targetWeekday, groupJid = null) {
  const now = new Date();
  const todayWeekday = getISTWeekday(now);
  let daysAhead = (targetWeekday - todayWeekday + 7) % 7;
  if (daysAhead === 0) daysAhead = 0; // same day = today

  const targetDate = new Date(now.getTime() + daysAhead * 86400000);
  return getDayTimetable(targetDate, groupJid);
}

/**
 * Group DB entries: batch entries → grouped by slot+time, parallel entries likewise.
 * Returns a list of "display rows".
 */
function groupEntries(entries) {
  const rows = [];
  const seen = new Set();

  for (const entry of entries) {
    if (seen.has(entry.id)) continue;

    const sameSlot = entries.filter(e =>
      e.id !== entry.id &&
      !seen.has(e.id) &&
      e.start_time === entry.start_time
    );

    if (sameSlot.length > 0) {
      // Siblings exist at this slot — it's either batch or parallel
      const allSiblings = [entry, ...sameSlot];

      const hasBatch    = allSiblings.some(e => e.batch);
      const hasParallel = allSiblings.some(e => e.parallel_group);

      const kind = hasBatch ? 'batch' : hasParallel ? 'parallel' : 'single';

      rows.push({
        ...entry,
        kind,
        options: allSiblings,
      });

      sameSlot.forEach(e => seen.add(e.id));
    } else {
      rows.push({ ...entry, kind: 'single', options: [entry] });
    }
    seen.add(entry.id);
  }

  return rows;
}

// ── Formatting helpers ───────────────────────────────────────────────────────

function formatTime(t) {
  return String(t || '').slice(0, 5);
}

function formatTimeRange(row) {
  return formatTimetableTimeRange(row);
}

function formatDisplayDate(dateStr) {
  try {
    const d = new Date(dateStr + 'T00:00:00+05:30');
    return d.toLocaleDateString('en-IN', {
      weekday: 'short', day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata',
    });
  } catch { return dateStr; }
}

function friendlyDate(dateStr) {
  try {
    const d = new Date(dateStr + 'T00:00:00+05:30');
    return d.toLocaleDateString('en-IN', {
      weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata',
    });
  } catch { return dateStr; }
}

function daysFromToday(dateStr, todayStr) {
  const a = new Date(todayStr + 'T00:00:00+05:30');
  const b = new Date(dateStr + 'T00:00:00+05:30');
  return Math.round((b - a) / 86400000);
}

function timeToMinutes(t) {
  if (!t) return 0;
  const parts = String(t).split(':');
  return parseInt(parts[0] || 0, 10) * 60 + parseInt(parts[1] || 0, 10);
}

/**
 * Format one display row as a WhatsApp line.
 * marker = '✅' | '🔵' | '⏳' | '•'
 */
function formatRow(row, marker = '•') {
  const time = formatTimeRange(row);

  if (row.kind === 'batch') {
    // Two batches side by side
    const parts = row.options.map(o => `${o.batch}: ${o.short}${o.room ? ` (${o.room})` : ''}`);
    return `${marker} ${time}  ${parts.join('  |  ')}`;
  }

  if (row.kind === 'parallel') {
    // Two subjects simultaneously (e.g. SC / DSc)
    const parts = row.options.map(o => `${o.short}${o.room ? ` (${o.room})` : ''}`);
    return `${marker} ${time}  ${parts.join(' / ')}`;
  }

  // Single entry
  const subj = `${row.subject} (${row.short})`;
  const room  = row.room ? ` | ${row.room}` : '';
  const fac   = row.faculty ? ` — ${row.faculty}` : '';
  return `${marker} ${time}  ${subj}${room}${fac}`;
}

function getISTNowInfo() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = type => Number(parts.find(part => part.type === type)?.value || 0);
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = get('hour');
  const minute = get('minute');
  return {
    minutes: hour * 60 + minute,
    dateStr: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    timeStr: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  };
}

// ── Weekly timetable ─────────────────────────────────────────────────────────

async function answerWeeklyTimetableQuestion(startDateStr, groupJid = null) {
  const first = new Date(`${startDateStr}T00:00:00Z`);
  const dateStrings = Array.from({ length: 7 }, (_, offset) => {
    const d = new Date(first);
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  });
  const days = await Promise.all(dateStrings.map(dateStr =>
    getDayTimetable(dateFromISTDateString(dateStr), groupJid)
  ));

  const firstLabel = friendlyDate(dateStrings[0]);
  const lastLabel = friendlyDate(dateStrings[dateStrings.length - 1]);
  const lines = [`📅 *Agla 7 din ka timetable*`, `_${firstLabel} – ${lastLabel}_`];
  for (const day of days) {
    lines.push('', `*${day.dayName} — ${formatDisplayDate(day.dateStr)}*`);
    if (day.holiday) {
      lines.push(`🏖️ ${day.holiday.name} — koi class nahi`);
    } else if (!day.entries.length) {
      lines.push('Koi class nahi');
    } else {
      for (const entry of day.entries) lines.push(formatRow(entry, '•'));
    }
    for (const exam of day.exams || []) lines.push(`📚 ${exam.name}`);
    for (const note of day.notes || []) lines.push(`📌 ${note.text}`);
  }
  return lines.join('\n');
}

// ── Main answer function ────────────────────────────────────────────────────

/**
 * Answer natural language timetable questions.
 * Supports:
 *   - "aaj kya class hai" / "today"
 *   - "kal kya class hai" / "tomorrow"
 *   - "monday ki class" / "tuesday schedule" / "shukravar"
 *   - "next holiday"
 *   - "mst kab hai" / "exam"
 */
export async function answerTimetableQuestion(text, groupJid = null) {
  const now = new Date();
  const t   = String(text || '').toLowerCase().trim();
  const { minutes: nowMin, dateStr: todayStr } = getISTNowInfo();

  // Calendar answers use the whole semester, including past named dates and
  // explicit non-consecutive exam dates. Canonical JSON wins over stale DB rows.
  if (isCalendarQuestion(t)) {
    let dbEvents = [];
    try { dbEvents = await getAllCalendarEvents(); } catch (err) { log.warn({ err: err?.message }, 'Calendar DB unavailable; using bundled academic calendar'); }
    const canonicalKeys = new Set(canonicalCalendarEvents.map(e => `${String(e.name).toLowerCase()}|${e.type}`));
    const merged = [
      ...canonicalCalendarEvents,
      ...dbEvents.filter(e => !canonicalKeys.has(`${String(e.name).toLowerCase()}|${e.type}`)),
    ];
    const answer = answerCalendarQuestion(merged, t, now);
    if (answer) return answer;
  }

  // Full-week queries are handled before single-day resolution.
  const timetableRequest = resolveTimetableRequest(t, now);
  if (timetableRequest.kind === 'week') {
    return await answerWeeklyTimetableQuestion(timetableRequest.startDate, groupJid);
  }

  // ── Next holiday ────────────────────────────────────────────────
  if (/next holiday|agli chhutti|kab holiday|holiday kab|chhutti kab/.test(t)) {
    const futureEnd = toISTDateString(new Date(now.getTime() + 90 * 86400000));
    const events    = await getCalendarEventsForDateRange(todayStr, futureEnd);
    const holiday   = events.find(e => e.type === 'holiday' && e.date_from >= todayStr);
    if (!holiday) return 'koi holiday abhi 3 mahine mein nahi dikh raha';
    const days = daysFromToday(holiday.date_from, todayStr);
    if (days === 0) return `aaj hi holiday hai — *${holiday.name}* 🎉`;
    if (days === 1) return `kal holiday hai — *${holiday.name}* 🎉 koi class nahi`;
    return `agli chhutti: *${holiday.name}* — ${friendlyDate(holiday.date_from)} (${days} din baad)`;
  }

  // ── MST / exam ──────────────────────────────────────────────────
  if (/\b(mst|exam|test|mst-ii|mst2)\b/.test(t)) {
    const futureEnd = toISTDateString(new Date(now.getTime() + 120 * 86400000));
    const events    = await getCalendarEventsForDateRange(todayStr, futureEnd);
    const exams     = events.filter(e => e.type === 'exam' && e.date_from >= todayStr);
    if (!exams.length) return 'koi exam schedule nahi dikh raha abhi';
    const lines = exams.slice(0, 5).map(e => {
      const days  = daysFromToday(e.date_from, todayStr);
      const range = e.date_to !== e.date_from
        ? `${friendlyDate(e.date_from)} – ${friendlyDate(e.date_to)}`
        : friendlyDate(e.date_from);
      const urgency = days <= 3 ? ' ⚠️ jaldi padh' : days <= 7 ? ' 📚' : '';
      return `*${e.name}*: ${range} (${days} din baad)${urgency}`;
    });
    return lines.join('\n');
  }

  // ── Detect target date using IST calendar dates ────────────────────
  const request = resolveTimetableRequest(t, now);
  const targetDate = dateFromISTDateString(request.dateStr);
  const dayData = await getDayTimetable(targetDate, groupJid);
  const isToday = toISTDateString(targetDate) === todayStr;

  // ── Holiday that day ─────────────────────────────────────────────
  if (dayData.holiday) {
    return `*${dayData.dayName} — ${formatDisplayDate(dayData.dateStr)}*\n🏖️ ${dayData.holiday.name} — koi class nahi`;
  }

  // ── Weekend / no classes ─────────────────────────────────────────
  if (dayData.entries.length === 0) {
    const label = isToday ? 'Aaj' : dayData.dayName;
    return `*${dayData.dayName} — ${formatDisplayDate(dayData.dateStr)}*\n${label} koi class nahi — enjoy 😎`;
  }

  // ── Header ───────────────────────────────────────────────────────
  const relativeLabel = request.source === 'relative' ? ({ 1: 'Kal', 2: 'Parso', 3: 'Narso' }[request.offset] || dayData.dayName) : dayData.dayName;
  const headerLabel = isToday ? 'Aaj' : relativeLabel;
  const lines = [`*${headerLabel} — ${dayData.dayName}, ${formatDisplayDate(dayData.dateStr)}*`];

  // ── Batch info note ──────────────────────────────────────────────
  const hasBatchEntry = dayData.entries.some(e => e.kind === 'batch');
  if (hasBatchEntry) {
    lines.push(`_(B1 = Roll 60–95 | B2 = baaki)_`);
  }

  // ── Entries ──────────────────────────────────────────────────────
  let allDone    = true;
  let noneStarted = true;
  let nextClass   = null;

  for (const entry of dayData.entries) {
    const startMin = timeToMinutes(entry.start_time);
    const endMin   = timeToMinutes(entry.end_time);

    let marker = '•';

    if (isToday) {
      if (endMin <= nowMin) {
        marker = '✅';
        noneStarted = false;
      } else if (startMin <= nowMin && nowMin < endMin) {
        marker = '🔵';
        allDone = false;
        noneStarted = false;
      } else {
        marker = '⏳';
        allDone = false;
        if (!nextClass) nextClass = entry;
      }
    }

    lines.push(formatRow(entry, marker));
  }

  // ── Smart context summary ────────────────────────────────────────
  if (isToday) {
    lines.push('');
    if (allDone && dayData.entries.length > 0) {
      lines.push('Saari classes khatam 🎉 chill kar');
    } else if (noneStarted) {
      const first    = dayData.entries[0];
      const startMin = timeToMinutes(first.start_time);
      const minsLeft = startMin - nowMin;
      const timeLabel = minsLeft > 60
        ? `${Math.floor(minsLeft / 60)}h ${minsLeft % 60}m`
        : `${minsLeft} min`;
      const firstLabel = first.kind === 'batch'
        ? first.options.map(o => o.short).join(' / ')
        : first.kind === 'parallel'
        ? first.options.map(o => o.short).join(' / ')
        : first.subject;
      lines.push(`Pehli class: ${firstLabel} — ${timeLabel} mein`);
    } else if (nextClass) {
      const t = formatTime(nextClass.start_time);
      const label = nextClass.kind === 'batch'
        ? nextClass.options.map(o => `${o.batch}: ${o.short}`).join(' / ')
        : nextClass.kind === 'parallel'
        ? nextClass.options.map(o => o.short).join(' / ')
        : nextClass.subject;
      const minsLeft = timeToMinutes(nextClass.start_time) - nowMin;
      const tLabel   = minsLeft > 60
        ? `${Math.floor(minsLeft / 60)}h ${minsLeft % 60}m`
        : `${minsLeft} min`;
      lines.push(`Next: *${label}* at ${t} (${tLabel} mein)`);
    }
  } else {
    // Non-today day: show first class and total count
    lines.push('');
    const first = dayData.entries[0];
    const firstLabel = first.kind === 'batch'
      ? first.options.map(o => `${o.batch}: ${o.short}`).join(' / ')
      : first.kind === 'parallel'
      ? first.options.map(o => o.short).join(' / ')
      : first.subject;
    const count = dayData.entries.length;
    lines.push(`Pehli class: *${firstLabel}* at ${formatTimeRange(first)} | Total: ${count} periods`);
  }

  // ── Exam warnings ─────────────────────────────────────────────────
  for (const exam of (dayData.exams || [])) {
    lines.push(`⚠️ ${exam.name} — aaj!`);
  }

  // ── Day notes ─────────────────────────────────────────────────────
  for (const note of (dayData.notes || [])) {
    lines.push(`📌 ${note.text}`);
  }

  return lines.join('\n');
}

/**
 * Format timetable (used by non-question formatTimetable callers).
 */
export function formatTimetable({ entries, dayName, dateStr, holiday, exams, notes }) {
  if (holiday) {
    return `*${dayName} — ${formatDisplayDate(dateStr)}*\n🏖️ ${holiday.name}`;
  }
  if (!entries || entries.length === 0) {
    return `*${dayName} — ${formatDisplayDate(dateStr)}*\nKoi class nahi`;
  }

  const lines = [`*${dayName} — ${formatDisplayDate(dateStr)}*`];
  for (const entry of entries) {
    lines.push(formatRow(entry, '•'));
  }
  for (const exam of (exams || [])) {
    lines.push(`⚠️ ${exam.name}`);
  }
  for (const note of (notes || [])) {
    lines.push(`📌 ${note.text}`);
  }
  return lines.join('\n');
}
