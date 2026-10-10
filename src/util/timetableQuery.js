/** Pure parsing helpers for natural-language timetable requests. */

const TZ = 'Asia/Kolkata';

const WEEKDAY_ALIASES = new Map([
  ['monday', 1], ['mon', 1], ['somwar', 1], ['somvaar', 1], ['somvar', 1],
  ['tuesday', 2], ['tue', 2], ['tues', 2], ['mangalwar', 2], ['mangalvaar', 2], ['mangalvar', 2],
  ['wednesday', 3], ['wed', 3], ['budhwar', 3], ['budhvaar', 3], ['budhvar', 3],
  ['thursday', 4], ['thu', 4], ['thur', 4], ['thurs', 4], ['guruwar', 4], ['guruvaar', 4], ['gurwar', 4], ['brihaspatiwar', 4],
  ['friday', 5], ['fri', 5], ['shukrawar', 5], ['shukravar', 5], ['shukravaar', 5],
  ['saturday', 6], ['sat', 6], ['shanivar', 6], ['shanivaar', 6],
  ['sunday', 0], ['sun', 0], ['ravivar', 0], ['raviwar', 0], ['ravivaar', 0],
]);

export function normalizeTimetableText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’‘`]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isWeeklyTimetableQuestion(text) {
  const t = normalizeTimetableText(text);
  const scheduleTopic = /\b(timetable|time\s*table|schedule|classes?|periods?|labs?)\b/.test(t);
  const weekPhrase =
    /\b(?:pure|poore|pura|poora|saare|saara|full|entire|complete|is|iss|agle|agli|agla|aane wale|aane wali|next)\s+(?:hafte?|hafta|hafton?|week)\b/.test(t) ||
    /\b(?:this|whole|entire|next)\s+week\b/.test(t) ||
    /\bweekly\b/.test(t) ||
    /\b(?:hafta bhar|week bhar|saare din)\b/.test(t);
  return scheduleTopic && weekPhrase;
}

export function isTimetableQuestion(text) {
  const t = normalizeTimetableText(text);
  if (!t) return false;
  if (/\b(timetable|time\s*table|schedule|next class|agla class|classes khatam|kitni classes?)\b/.test(t)) return true;
  if (/\b(?:aaj|aj|kal|tomorrow|parso|parson|narso|narsau|day after tomorrow)\b/.test(t) && /\b(?:class|classes|period|lab|timetable|time\s*table|schedule)\b/.test(t)) return true;
  if (isWeeklyTimetableQuestion(t)) return true;
  const hasWeekday = [...WEEKDAY_ALIASES.keys()].some(alias => new RegExp(`(?:^|[^a-z0-9])${alias}(?=$|[^a-z0-9])`).test(t));
  return hasWeekday && /\b(class|classes|schedule|timetable|time\s*table|period|lab|kya hai)\b/.test(t);
}

function dateStringInIST(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function shiftDateString(dateStr, offset) {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function weekdayOfDateString(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

function nextWeekdayOffset(todayWeekday, targetWeekday) {
  return (targetWeekday - todayWeekday + 7) % 7;
}

export function resolveTimetableRequest(text, now = new Date()) {
  const t = normalizeTimetableText(text);
  const today = dateStringInIST(now);
  if (isWeeklyTimetableQuestion(t)) {
    const isNextWeek = /\b(?:next week|agle hafte|agli hafta|agla hafta|agle week)\b/.test(t);
    if (!isNextWeek) return { kind: 'week', startDate: today };
    const daysUntilMonday = (1 - weekdayOfDateString(today) + 7) % 7 || 7;
    return { kind: 'week', startDate: shiftDateString(today, daysUntilMonday) };
  }

  const relativeRules = [
    { pattern: /\b(?:narso|narsau|parso ke agle din|parso ke baad|day after day after tomorrow)\b/, offset: 3 },
    { pattern: /\b(?:parso|parson|day after tomorrow)\b/, offset: 2 },
    { pattern: /\b(?:kal|tomorrow)\b/, offset: 1 },
    { pattern: /\b(?:aaj|aj|today)\b/, offset: 0 },
  ];
  for (const rule of relativeRules) {
    if (rule.pattern.test(t)) {
      return { kind: 'day', dateStr: shiftDateString(today, rule.offset), offset: rule.offset, source: 'relative' };
    }
  }

  const aliases = [...WEEKDAY_ALIASES.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [alias, targetWeekday] of aliases) {
    const pattern = new RegExp(`(?:^|[^a-z0-9])${alias}(?=$|[^a-z0-9])`);
    if (!pattern.test(t)) continue;
    let offset = nextWeekdayOffset(weekdayOfDateString(today), targetWeekday);
    const explicitlyNext = new RegExp(`\\b(?:next|agle|agli|agla)\\s+${alias}\\b`).test(t);
    if (explicitlyNext && offset === 0) offset = 7;
    return { kind: 'day', dateStr: shiftDateString(today, offset), offset, source: 'weekday', weekday: targetWeekday };
  }

  return { kind: 'day', dateStr: today, offset: 0, source: 'today' };
}

export function dateFromISTDateString(dateStr) {
  // A fixed noon IST instant avoids crossing a date boundary during timezone conversion.
  return new Date(`${dateStr}T12:00:00+05:30`);
}

export function formatTimetableTimeRange(row) {
  const start = String(row?.start_time || '').slice(0, 5);
  const end = String(row?.end_time || '').slice(0, 5);
  if (!start && !end) return 'time unavailable';
  if (!end || end === '00:00') return start || end;
  if (!start || start === '00:00') return end;
  return `${start}–${end}`;
}
