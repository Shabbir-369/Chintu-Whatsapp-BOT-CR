/**
 * Pure helpers for the academic calendar.  The JSON file is the canonical
 * source: explicit `dates` arrays stay explicit, while continuous periods are
 * represented as a single date range.
 */
const TZ = 'Asia/Kolkata';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_LOOKUP = new Map(MONTHS.flatMap((m, i) => [[m.toLowerCase(), i], [m.slice(0, 3).toLowerCase(), i]]));
const FILLER = new Set([
  'when', 'is', 'was', 'will', 'be', 'the', 'date', 'dates', 'of', 'on', 'for', 'my', 'me',
  'please', 'tell', 'show', 'what', 'which', 'next', 'upcoming', 'calendar', 'academic',
  'kab', 'hai', 'tha', 'thi', 'hoga', 'hogi', 'batao', 'bata', 'dikha', 'dikhao', 'mujhe',
  'ki', 'ka', 'ke', 'ko', 'mein', 'me', 'par', 'tak', 'exact', 'exactly', 'is', 'are',
]);

function dateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function dateFromIST(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function normaliseName(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\bmst\s*[- ]*1\b/g, 'mst i')
    .replace(/\bmst\s*[- ]*2\b/g, 'mst ii')
    .replace(/\bmst\s*[- ]*i\b/g, 'mst i')
    .replace(/\bmst\s*[- ]*ii\b/g, 'mst ii')
    .replace(/\bsemester\b/g, 'sem')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function makeEvent(dateFrom, dateTo, name, type, notes = null) {
  if (!dateFrom || !name) return null;
  const from = dateOnly(dateFrom);
  const to = dateOnly(dateTo || dateFrom);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) return null;
  return { date_from: from, date_to: to, name: String(name), type, notes: notes || null };
}

/** Convert the supplied JSON calendar into DB-style event rows. */
export function normalizeCalendarEvents(calendar) {
  const events = [];
  for (const item of calendar?.examAndAcademicEvents || []) {
    const rawType = item.type || 'event';
    const type = rawType === 'academic-break' ? 'break'
      : rawType === 'academic' ? 'event'
      : ['exam', 'holiday', 'break', 'event'].includes(rawType) ? rawType
      : 'event';
    if (Array.isArray(item.dates) && item.dates.length) {
      for (const date of item.dates) {
        const row = makeEvent(date, date, item.name || 'Event', type, item.notes);
        if (row) events.push(row);
      }
    } else {
      const row = makeEvent(item.date || item.startDate, item.endDate || item.date || item.startDate, item.name || 'Event', type, item.notes);
      if (row) events.push(row);
    }
  }

  for (const item of calendar?.holidays || []) {
    if (Array.isArray(item.dates) && item.dates.length) {
      for (const date of item.dates) {
        const row = makeEvent(date, date, item.name || 'Holiday', 'holiday', item.notes);
        if (row) events.push(row);
      }
    } else {
      const row = makeEvent(item.date || item.startDate, item.endDate || item.date || item.startDate, item.name || 'Holiday', 'holiday', item.notes);
      if (row) events.push(row);
    }
  }

  for (const item of calendar?.otherCalendarItems || []) {
    const row = makeEvent(item.date || item.startDate, item.endDate || item.date || item.startDate, item.name || 'Event', 'event', item.notes);
    if (row) events.push(row);
  }

  const seen = new Set();
  return events.filter(event => {
    const key = `${event.date_from}|${event.date_to}|${event.name.toLowerCase()}|${event.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.date_from.localeCompare(b.date_from) || a.name.localeCompare(b.name));
}

/** Is this message asking about the calendar rather than an ordinary chat? */
export function isCalendarQuestion(text) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return false;
  if (/\b(calendar|calender|holiday|holidays|chhutti|chutti|mst(?:[- ]?(?:1|2|i{1,2}))?|mid[ -]?sem|exam|exams|test kab|convocation|registration|shlamcat|svar|preparatory leave|end semester|teaching ends|teaching end|academic break|semester start|semester end|course start|course registration|result day|orientation|mock interview)\b/i.test(t)) return true;

  // Specific month/day questions such as “what is on 2 October?” and “2 Oct ko kya hai?”
  const monthNames = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  const hasNamedDate = new RegExp(`\\b(?:\\d{1,2}\\s*${monthNames}|${monthNames}\\s*\\d{1,2})\\b`, 'i').test(t);
  if (hasNamedDate && /\b(when|kab|date|what|kya|event|holiday|exam|on|ko|hoga|hai)\b/i.test(t)) return true;

  // Questions phrased as “when does teaching/semester start/end?”
  return /\b(when|kab|date|what|kya)\b/i.test(t) && /\b(semester|teaching|classes|course|registration|exam|holiday|break|leave|orientation|interview|convocation|result|term|classes start|classes end)\b/i.test(t);
}

function toDate(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`);
}

function shiftDate(dateStr, days) {
  const date = toDate(dateStr);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dayDiff(from, to) {
  return Math.round((toDate(to) - toDate(from)) / 86400000);
}

function formatDate(dateStr, { includeWeekday = false, includeYear = true } = {}) {
  const date = new Date(`${dateStr}T00:00:00+05:30`);
  return date.toLocaleDateString('en-IN', {
    ...(includeWeekday ? { weekday: 'long' } : {}),
    day: 'numeric', month: 'short', ...(includeYear ? { year: 'numeric' } : {}),
    timeZone: TZ,
  });
}

function formatRange(from, to) {
  if (!from || !to || from === to) return formatDate(from || to);
  const a = new Date(`${from}T00:00:00+05:30`);
  const b = new Date(`${to}T00:00:00+05:30`);
  const aMonth = a.toLocaleDateString('en-IN', { month: 'short', timeZone: TZ });
  const bMonth = b.toLocaleDateString('en-IN', { month: 'short', timeZone: TZ });
  const aYear = a.toLocaleDateString('en-IN', { year: 'numeric', timeZone: TZ });
  const bYear = b.toLocaleDateString('en-IN', { year: 'numeric', timeZone: TZ });
  const aDay = a.toLocaleDateString('en-IN', { day: 'numeric', timeZone: TZ });
  const bDay = b.toLocaleDateString('en-IN', { day: 'numeric', timeZone: TZ });
  if (aMonth === bMonth && aYear === bYear) return `${aDay}–${bDay} ${bMonth} ${bYear}`;
  return `${aDay} ${aMonth} ${aYear === bYear ? '' : aYear}–${bDay} ${bMonth} ${bYear}`.replace(/\s+/g, ' ').trim();
}

function formatDaySet(days) {
  const sorted = [...new Set(days)].sort();
  if (!sorted.length) return '';
  const clusters = [];
  let start = sorted[0];
  let end = sorted[0];
  for (const day of sorted.slice(1)) {
    if (dayDiff(end, day) === 1) end = day;
    else {
      clusters.push([start, end]);
      start = end = day;
    }
  }
  clusters.push([start, end]);
  return clusters.map(([from, to]) => formatRange(from, to)).join(', ');
}

function formatEventDates(events) {
  const intervalRows = events.filter(e => e.date_to > e.date_from);
  const singleDays = events.filter(e => e.date_to === e.date_from).map(e => e.date_from);
  const labels = intervalRows.map(e => formatRange(e.date_from, e.date_to));
  if (singleDays.length) labels.push(formatDaySet(singleDays));
  return [...new Set(labels)].join(', ');
}

function groupEvents(events) {
  const groups = new Map();
  for (const event of events) {
    const key = `${event.type}|${String(event.name).toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, { name: event.name, type: event.type, notes: event.notes, rows: [] });
    groups.get(key).rows.push(event);
  }
  return [...groups.values()].map(group => ({
    ...group,
    rows: group.rows.sort((a, b) => a.date_from.localeCompare(b.date_from)),
    date_from: group.rows.reduce((min, e) => e.date_from < min ? e.date_from : min, group.rows[0].date_from),
    date_to: group.rows.reduce((max, e) => e.date_to > max ? e.date_to : max, group.rows[0].date_to),
    displayDates: formatEventDates(group.rows),
  })).sort((a, b) => a.date_from.localeCompare(b.date_from) || a.name.localeCompare(b.name));
}

function isPast(event, today) { return event.date_to < today; }
function isOngoing(event, today) { return event.date_from <= today && event.date_to >= today; }
function isFuture(event, today) { return event.date_to >= today; }

function specificMst(text) {
  const t = String(text || '').toLowerCase().replace(/[–—]/g, '-');
  if (/\bmst\s*[- ]*(?:1|i)\b|\b(?:first|1st)\s+mst\b/.test(t)) return 'mst i';
  if (/\bmst\s*[- ]*(?:2|ii)\b|\b(?:second|2nd)\s+mst\b/.test(t)) return 'mst ii';
  return null;
}

function formatStatus(event, today) {
  if (isPast(event, today)) return 'ho chuka hai';
  if (isOngoing(event, today)) return 'abhi chal raha hai';
  const days = dayDiff(today, event.date_from);
  if (days === 0) return 'aaj';
  if (days === 1) return 'kal';
  return `${days} din baad`;
}

function normaliseRows(events) {
  const seen = new Set();
  const rows = [];
  for (const event of events || []) {
    const from = dateOnly(event.date_from || event.date);
    const to = dateOnly(event.date_to || event.endDate || from);
    if (!from || !to || !event.name) continue;
    const type = ['exam', 'holiday', 'break', 'event'].includes(event.type) ? event.type : 'event';
    const row = { date_from: from, date_to: to, name: String(event.name), type, notes: event.notes || null };
    const key = `${from}|${to}|${row.name.toLowerCase()}|${type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  return rows.sort((a, b) => a.date_from.localeCompare(b.date_from) || a.name.localeCompare(b.name));
}

/**
 * Answer a natural-language question from the entire supplied calendar.
 * Returns null only when the message does not look like a calendar question.
 */
export function answerCalendarQuestion(inputEvents, text, now = new Date()) {
  if (!isCalendarQuestion(text)) return null;
  const events = groupEvents(normaliseRows(inputEvents));
  const t = String(text || '').toLowerCase();
  const today = dateFromIST(now);
  if (!events.length) return 'academic calendar ka data abhi nahi mila.';

  // Next holiday, including a holiday already in progress.
  if (/next holiday|next chhutti|next chutti|agli chhutti|agli chutti|agla holiday|holiday kab|chhutti kab|chutti kab|kab hai chhutti|kab hai chutti|kab chhutti|kab chutti|upcoming holidays?|aane wali chhutti|aane wali chutti/i.test(t)) {
    const holidays = events.filter(e => e.type === 'holiday');
    const holiday = holidays.find(e => isOngoing(e, today)) || holidays.find(e => e.date_from >= today);
    if (!holiday) return 'calendar mein aage ki chhutti listed nahi hai.';
    if (isOngoing(holiday, today)) return `🏖️ *${holiday.name}* — ${holiday.displayDates}. aaj chhutti hai.`;
    const days = dayDiff(today, holiday.date_from);
    const relative = days === 1 ? 'kal' : `${days} din baad`;
    return `🏖️ agli chhutti: *${holiday.name}* — ${formatDate(holiday.date_from, { includeWeekday: true })} (${relative}).`;
  }

  // Specific MST-I/MST-II queries must be answered even after their dates pass.
  const mstName = specificMst(t);
  if (mstName) {
    const match = events.find(e => normaliseName(e.name) === mstName && e.type === 'exam');
    if (!match) return `${mstName.toUpperCase().replace(' ', '-')} ki date calendar mein nahi mili.`;
    const notes = match.notes ? `\n_${String(match.notes).slice(0, 220)}_` : '';
    return `📚 *${match.name}*: ${match.displayDates} — ${formatStatus(match, today)}.${notes}`;
  }

  // If the question is explicitly about semester/classes starting, avoid matching the
  // similarly-worded course-registration event.
  if (/\b(semester|classes|class)\b/.test(t) && /\b(start|starting|begin|begins|commence|shuru)\b/.test(t)) {
    const startEvent = events.find(e => /higher sem classes|sem classes/.test(normaliseName(e.name)));
    if (startEvent) return `📅 *${startEvent.name}* — ${startEvent.displayDates} (${formatStatus(startEvent, today)}).`;
  }

  // Generic MST means the next upcoming scheduled MST, regardless of its number.
  if (/\bmst\b|mid[ -]?sem/.test(t)) {
    const candidates = events.filter(e => e.type === 'exam' && e.name.toLowerCase().includes('mst') && isFuture(e, today));
    const next = candidates.sort((a, b) => a.date_from.localeCompare(b.date_from))[0];
    if (!next) return 'calendar mein aage ka MST listed nahi hai.';
    return `📚 next MST: *${next.name}* — ${next.displayDates} (${formatStatus(next, today)}).`;
  }

  // Generic next/upcoming exam query.
  if (/\b(next|upcoming|agla|agli|aane wala|aane wali)\b/.test(t) && /\b(exam|test|paper|pariksha)\b/.test(t)) {
    const next = events.filter(e => e.type === 'exam' && isFuture(e, today)).sort((a, b) => a.date_from.localeCompare(b.date_from))[0];
    if (!next) return 'calendar mein aage ka exam listed nahi hai.';
    return `📚 next exam: *${next.name}* — ${next.displayDates} (${formatStatus(next, today)}).`;
  }

  // If a specific event name is present, return its full dates, even for past events.
  const tokens = normaliseName(t).split(' ').filter(token => !FILLER.has(token) && token.length > 1);
  const namedMatches = events
    .map(event => ({ event, name: normaliseName(event.name) }))
    .filter(({ name }) => {
      if (!name) return false;
      if (normaliseName(t).includes(name)) return true;
      const eventTokens = name.split(' ').filter(token => token.length > 2 && !FILLER.has(token));
      const overlap = eventTokens.filter(token => tokens.includes(token)).length;
      const queryTokens = tokens.filter(token => token.length > 2 && !FILLER.has(token));
      return eventTokens.length > 0 && overlap >= Math.min(2, Math.min(eventTokens.length, queryTokens.length));
    })
    .sort((a, b) => b.name.length - a.name.length);
  if (namedMatches.length) {
    const match = namedMatches[0].event;
    const typeLabel = match.type === 'holiday' ? '🏖️' : match.type === 'exam' ? '📚' : match.type === 'break' ? '🌿' : '📅';
    const notes = match.notes ? `\n_${String(match.notes).slice(0, 220)}_` : '';
    return `${typeLabel} *${match.name}* — ${match.displayDates} (${formatStatus(match, today)}).${notes}`;
  }

  // Questions that ask for a calendar overview or all forthcoming events.
  if (/\b(academic calendar|calendar|calender|schedule|important dates|all events|upcoming events|what events|kya kya hai)\b/.test(t)) {
    const upcoming = events.filter(e => isFuture(e, today)).sort((a, b) => a.date_from.localeCompare(b.date_from)).slice(0, 8);
    if (!upcoming.length) return 'calendar mein aage ke events listed nahi hain.';
    return `📅 *Aane wale academic events*\n${upcoming.map(e => `• ${formatRange(e.date_from, e.date_to)} — ${e.name}`).join('\n')}`;
  }

  // Date-specific queries (e.g. "2 October ko kya hai?").
  const dateMatch = t.match(/\b(\d{1,2})\s*(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+(20\d{2}))?\b/i)
    || t.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s*(\d{1,2})(?:,?\s+(20\d{2}))?\b/i);
  if (dateMatch && /\b(what|kya|event|holiday|exam|date|kab|on|ko|hoga|hai)\b/.test(t)) {
    const dayFirst = /^\d/.test(dateMatch[1]);
    const day = Number(dayFirst ? dateMatch[1] : dateMatch[2]);
    const monthText = String(dayFirst ? dateMatch[2] : dateMatch[1]).toLowerCase();
    const explicitYear = Number(dateMatch[3]) || null;
    const month = MONTH_LOOKUP.get(monthText) ?? MONTH_LOOKUP.get(monthText.slice(0, 3));
    if (Number.isInteger(month) && day >= 1 && day <= 31) {
      const currentYear = Number(today.slice(0, 4));
      const years = explicitYear ? [explicitYear] : [currentYear - 1, currentYear, currentYear + 1, currentYear + 2];
      const candidates = [];
      for (const year of years) {
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const check = toDate(dateStr);
        if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month || check.getUTCDate() !== day) continue;
        // Check original rows, not only the grouped min/max span: explicit date lists
        // may contain gaps (MST-I skips 2 Oct for Gandhi Jayanti).
        for (const event of events.filter(e => e.rows.some(row => row.date_from <= dateStr && row.date_to >= dateStr))) {
          candidates.push({ dateStr, event, distance: Math.abs(dayDiff(today, dateStr)) });
        }
      }
      candidates.sort((a, b) => a.distance - b.distance || a.dateStr.localeCompare(b.dateStr));
      if (candidates.length) {
        const chosenDate = candidates[0].dateStr;
        const onDate = candidates.filter(c => c.dateStr === chosenDate).map(c => c.event);
        return `📅 ${formatDate(chosenDate)} par: ${[...new Map(onDate.map(e => [e.name, e])).values()].map(e => `*${e.name}*`).join(', ')}.`;
      }
      return `📅 ${formatDate(`${explicitYear || currentYear}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`)} ke liye academic calendar mein koi event listed nahi hai.`;
    }
  }

  // Last-resort academic question: list relevant upcoming events rather than guessing.
  const relevantType = /holiday|chhutti|chutti/.test(t) ? 'holiday'
    : /exam|test|paper/.test(t) ? 'exam'
    : /break|leave/.test(t) ? 'break' : null;
  const relevant = events.filter(e => (!relevantType || e.type === relevantType) && isFuture(e, today)).slice(0, 5);
  if (relevant.length) return `📅 Calendar mein ye upcoming dates hain:\n${relevant.map(e => `• *${e.name}* — ${e.displayDates}`).join('\n')}`;
  return 'is calendar question ke liye exact event nahi mila. Event ka naam ya month bata de.';
}
