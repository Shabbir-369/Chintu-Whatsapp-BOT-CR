/** Parse natural-language scheduling requests as Asia/Kolkata wall-clock times. */
const TZ = 'Asia/Kolkata';
const DAY_ALIASES = new Map([
  ['sunday', 0], ['sun', 0], ['ravivar', 0],
  ['monday', 1], ['mon', 1], ['somwar', 1], ['somvaar', 1],
  ['tuesday', 2], ['tue', 2], ['mangalwar', 2], ['mangalvaar', 2],
  ['wednesday', 3], ['wed', 3], ['budhwar', 3], ['budhvaar', 3],
  ['thursday', 4], ['thu', 4], ['gurwar', 4], ['guruvar', 4], ['brihaspativar', 4],
  ['friday', 5], ['fri', 5], ['shukrawar', 5], ['shukravar', 5],
  ['saturday', 6], ['sat', 6], ['shanivaar', 6], ['shanivar', 6],
]);
const MONTHS = new Map([
  ['jan', 1], ['january', 1], ['feb', 2], ['february', 2], ['mar', 3], ['march', 3],
  ['apr', 4], ['april', 4], ['may', 5], ['jun', 6], ['june', 6], ['jul', 7], ['july', 7],
  ['aug', 8], ['august', 8], ['sep', 9], ['sept', 9], ['september', 9], ['oct', 10], ['october', 10],
  ['nov', 11], ['november', 11], ['dec', 12], ['december', 12],
]);

function istParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long',
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value;
  return { year: Number(get('year')), month: Number(get('month')), day: Number(get('day')), weekday: get('weekday') };
}
function pad(value) { return String(value).padStart(2, '0'); }
function dateString(y, m, d) { return `${y}-${pad(m)}-${pad(d)}`; }
function addDays(dateStr, amount) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + amount);
  return d.toISOString().slice(0, 10);
}
function weekdayIndex(name) { return ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'].indexOf(name.toLowerCase()); }

export function hasScheduleTimePhrase(text) {
  const t = String(text || '').toLowerCase();
  return /\b(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*(?:baje|baj[e]?)?|\d{1,2}:\d{2}|subah|morning|dopahar|afternoon|shaam|sham|evening|raat|night|midnight|noon)\b/.test(t)
    || /\b(?:today|aaj|tomorrow|kal|parso|day after tomorrow|next\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|somwar|mangalwar|budhwar|gurwar|shukrawar|shanivar))\b/.test(t);
}

/**
 * Parse date/time phrases. Unqualified 7–11 with a tomorrow/daypart phrase uses morning;
 * an unqualified 1–6 defaults to afternoon/evening, matching common Hinglish usage.
 * Returns null when no usable future timestamp can be inferred.
 */
export function parseScheduleDateTime(text, { now = new Date(), explicitTime, explicitDate } = {}) {
  const originalText = String(text || '').trim();
  if (!explicitDate && !explicitTime) {
    const isoDateTime = originalText.match(/\b20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})\b/i);
    if (isoDateTime) {
      const exact = new Date(isoDateTime[0]);
      return Number.isFinite(exact.getTime()) && exact > now ? exact : null;
    }
  }
  const raw = String([explicitDate, explicitTime, text].filter(Boolean).join(' ')).trim();
  if (!raw) return null;
  const t = raw.toLowerCase().replace(/[–—]/g, '-');
  const base = istParts(now);
  let date = dateString(base.year, base.month, base.day);
  let explicitDay = false;

  const iso = t.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) {
    const y = Number(iso[1]), m = Number(iso[2]), d = Number(iso[3]);
    const candidate = new Date(`${dateString(y, m, d)}T12:00:00Z`);
    if (candidate.getUTCFullYear() !== y || candidate.getUTCMonth() + 1 !== m || candidate.getUTCDate() !== d) return null;
    date = dateString(y, m, d); explicitDay = true;
  } else {
    const monthMatch = t.match(/\b(\d{1,2})\s*(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i)
      || t.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s*(\d{1,2})\b/i);
    if (monthMatch) {
      const monthWord = (monthMatch[2] && Number(monthMatch[1]) ? monthMatch[2] : monthMatch[1]).toLowerCase();
      const day = Number(monthMatch[2] && !Number(monthMatch[1]) ? monthMatch[2] : monthMatch[1]);
      const month = MONTHS.get(monthWord) || MONTHS.get(monthWord.slice(0, 3));
      if (month && day >= 1 && day <= 31) {
        let year = base.year;
        const candidate = new Date(`${dateString(year, month, day)}T12:00:00Z`);
        if (candidate.getUTCMonth() + 1 !== month || candidate.getUTCDate() !== day) return null;
        if (dateString(year, month, day) < date) year++;
        date = dateString(year, month, day); explicitDay = true;
      }
    } else if (/\bday after tomorrow\b|\bparso\b|\bparson\b/.test(t)) {
      date = addDays(date, 2); explicitDay = true;
    } else if (/\btomorrow\b|\bkal\b/.test(t)) {
      date = addDays(date, 1); explicitDay = true;
    } else if (/\btoday\b|\baaj\b/.test(t)) {
      explicitDay = true;
    } else {
      const weekdayWord = [...DAY_ALIASES.keys()].sort((a, b) => b.length - a.length).find(day => new RegExp(`\\b${day}\\b`, 'i').test(t));
      if (weekdayWord) {
        const target = DAY_ALIASES.get(weekdayWord);
        const current = weekdayIndex(base.weekday);
        let days = (target - current + 7) % 7;
        if (/\bnext\b|\bagle\b|\baane wale\b/.test(t) && days === 0) days = 7;
        date = addDays(date, days); explicitDay = true;
      }
    }
  }

  const dayPart = /\b(subah|morning)\b/.test(t) ? 'morning'
    : /\b(dopahar|afternoon|noon)\b/.test(t) ? 'afternoon'
    : /\b(shaam|sham|evening|raat|night)\b/.test(t) ? 'evening'
    : /\b(midnight)\b/.test(t) ? 'midnight' : null;
  let hour, minute = 0, explicitClock = false;
  const clock24 = t.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  const clock12 = t.match(/\b(1[0-2]|0?[1-9])(?:\s*:\s*([0-5]\d))?\s*(am|pm)\b/);
  const baje = t.match(/\b(2[0-3]|1[0-9]|0?[1-9])(?:\s*:\s*([0-5]\d))?\s*(?:baje|baj[e]?)\b/);
  const bareHour = t.match(/\b(1[0-2]|0?[1-9])\s*(?:o'?clock)\b/);
  if (clock24) { hour = Number(clock24[1]); minute = Number(clock24[2]); explicitClock = true; }
  else if (clock12) { hour = Number(clock12[1]) % 12 + (clock12[3] === 'pm' ? 12 : 0); minute = Number(clock12[2] || 0); explicitClock = true; }
  else if (baje || bareHour) {
    const m = baje || bareHour;
    hour = Number(m[1]); minute = Number(m[2] || 0); explicitClock = true;
    if (hour >= 13) { /* 24-hour wording already unambiguous */ }
    else if (dayPart === 'morning') hour = hour % 12;
    else if (dayPart === 'afternoon') hour = hour % 12 + 12;
    else if (dayPart === 'evening') hour = hour % 12 + 12;
    else if (hour >= 1 && hour <= 6) hour += 12;
    else if (explicitDay && hour >= 7 && hour <= 11) hour = hour % 12;
    else if (!explicitDay) {
      const amCandidate = new Date(`${date}T${pad(hour)}:${pad(minute)}:00+05:30`);
      const pmHour = hour < 12 ? hour + 12 : hour;
      const pmCandidate = new Date(`${date}T${pad(pmHour)}:${pad(minute)}:00+05:30`);
      if (amCandidate <= now && pmCandidate > now) hour = pmHour;
    }
  } else if (dayPart) {
    if (dayPart === 'morning') { hour = 8; minute = 10; }
    else if (dayPart === 'afternoon') { hour = 13; minute = 0; }
    else if (dayPart === 'evening') { hour = 18; minute = 0; }
    else { hour = 20; minute = 0; }
  } else {
    return null;
  }
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  let result = new Date(`${date}T${pad(hour)}:${pad(minute)}:00+05:30`);
  if (!Number.isFinite(result.getTime())) return null;
  if (!explicitDay && result <= now) result = new Date(`${addDays(date, 1)}T${pad(hour)}:${pad(minute)}:00+05:30`);
  if (result <= now) return null;
  return result;
}

export function formatScheduledIST(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  return `${date.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ })} ${date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: TZ })} IST`;
}

/** Scheduler command grammar shared by owner orders and private self-reminders. */
const REMINDER_ACTION_SOURCE = '(?:yaad\\s+dila(?:na|ne|do|\\s+de(?:na)?|\\s+dena)?|yaad\\s+kara(?:na|ne|do|\\s+de(?:na)?|\\s+dena)?|remind\\s+me|remind|reminder)';
const MESSAGE_ACTION_SOURCE = '(?:message\\s+(?:kar|bhej)|bol\\s+de|bhej\\s+de|send)';
const SCHEDULE_ACTION_SOURCE = `(?:${REMINDER_ACTION_SOURCE}|${MESSAGE_ACTION_SOURCE})`;

function isReminderAction(action) {
  return /yaad|remind|reminder/i.test(String(action || ''));
}

function hasClockOrDayPart(text) {
  return /\b(?:\d{1,2}(?::\d{2})?\s*(?:am|pm|baje|baj[e]?|o'?clock)|\d{1,2}:\d{2}|subah|morning|dopahar|afternoon|shaam|sham|evening|raat|night|midnight|noon)\b/i.test(String(text || ''));
}

function stripReminderConnective(value) {
  return String(value || '').trim()
    .replace(/^(?:(?:ki|ke|that|to|about)\s+)+/i, '')
    .replace(/^[:,-]\s*/, '')
    .replace(/^['"“”]|['"“”]$/g, '')
    .trim();
}

/** Extract a scheduling phrase at the start of a clause, preserving it verbatim for IST parsing. */
function extractLeadingSchedulePrefix(value) {
  const raw = String(value || '').trim().replace(/^(?:ki|to|about|at|on)\s+/i, '');
  if (!raw) return null;
  const date = '(?:day after tomorrow|tomorrow|today|kal|aaj|parso|parson|next\\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|monday|tuesday|wednesday|thursday|friday|saturday|sunday|20\\d{2}-\\d{1,2}-\\d{1,2})';
  const clock = "(?:\\d{1,2}(?::\\d{2})?\\s*(?:am|pm|baje|baj[e]?|o[’\']?clock)|\\d{1,2}:\\d{2})";
  const dayPart = '(?:subah|morning|dopahar|afternoon|shaam|sham|evening|raat|night|midnight|noon)';
  const phrase = `(?:${date}(?:\\s+(?:at\\s*)?(?:${clock}|${dayPart}))?|(?:at\\s+)?${clock}(?:\\s+${date})?|${dayPart})`;
  const match = raw.match(new RegExp(`^(${phrase})(?:\\s+)(.+)$`, 'i'));
  if (!match) return null;
  return { timePhrase: match[1].trim(), rest: match[2].trim() };
}

/** Find an explicit time clause at the end of a reminder, e.g. "call mom tomorrow at 8pm". */
function extractTrailingSchedulePhrase(value) {
  const raw = String(value || '').trim();
  const date = '(?:day after tomorrow|tomorrow|today|kal|aaj|parso|parson|next\\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|monday|tuesday|wednesday|thursday|friday|saturday|sunday)';
  const clock = "(?:\\d{1,2}(?::\\d{2})?\\s*(?:am|pm|baje|baj[e]?|o[’\']?clock)|\\d{1,2}:\\d{2})";
  const dayPart = '(?:subah|morning|dopahar|afternoon|shaam|sham|evening|raat|night|midnight|noon)';
  const timeClause = `(?:${date}(?:\\s+(?:at\\s*)?(?:${clock}|${dayPart}))?|(?:at\\s+)?${clock}(?:\\s+${date})?|${dayPart})`;
  const match = raw.match(new RegExp(`^(.+?)\\s+(${timeClause})$`, 'i'));
  if (!match || !hasScheduleTimePhrase(match[2])) return null;
  return { message: stripReminderConnective(match[1]), timePhrase: match[2].trim() };
}

function parseNamedScheduleCore(raw, fallbackTime = '') {
  // Form: "Rohan ko kal 8 baje yaad dilana ki ..." or "group ko 6 pm message kar ...".
  const beforeAction = raw.match(new RegExp(`^(.+?)\\s+ko\\s+(.+?)\\s+(${SCHEDULE_ACTION_SOURCE})\\s+(?:ki\\s+)?(.+)$`, 'i'));
  if (beforeAction) {
    const [, target, timePhrase, action, content] = beforeAction;
    if (hasScheduleTimePhrase(timePhrase) && (isReminderAction(action) || hasClockOrDayPart(timePhrase))) {
      return { target: target.trim(), timePhrase: timePhrase.trim(), message: stripReminderConnective(content) };
    }
    if (isReminderAction(action)) {
      return { target: target.trim(), timePhrase: fallbackTime, message: stripReminderConnective(content) };
    }
  }

  // Form: "Rohan ko yaad dilana kal 8 baje ki ..." or "Rohan ko message kar kal 8 baje ...".
  const afterAction = raw.match(new RegExp(`^(.+?)\\s+ko\\s+(${SCHEDULE_ACTION_SOURCE})(?:\\s+(.*))?$`, 'i'));
  if (!afterAction) return null;
  const [, target, action, afterRaw = ''] = afterAction;
  const after = stripReminderConnective(afterRaw);
  const leading = extractLeadingSchedulePrefix(after);
  if (leading && (isReminderAction(action) || hasClockOrDayPart(leading.timePhrase))) {
    return { target: target.trim(), timePhrase: leading.timePhrase, message: stripReminderConnective(leading.rest) };
  }
  const trailing = extractTrailingSchedulePhrase(after);
  if (trailing && (isReminderAction(action) || hasClockOrDayPart(trailing.timePhrase))) {
    return { target: target.trim(), timePhrase: trailing.timePhrase, message: trailing.message };
  }
  if (isReminderAction(action)) {
    return { target: target.trim(), timePhrase: fallbackTime, message: after };
  }
  if (fallbackTime && hasClockOrDayPart(fallbackTime)) {
    return { target: target.trim(), timePhrase: fallbackTime, message: after };
  }
  return null;
}

/**
 * Parse owner-ordered scheduled messages/reminders. The target may be a known person
 * or a WhatsApp group; resolution and ambiguity confirmation happen in ownerConsole.
 */
export function parseScheduledMessageCommand(text) {
  const raw = String(text || '').trim().replace(/\s+/g, ' ');
  if (!raw) return null;

  // Support time-first phrasing: "kal 8 baje Rohan ko message kar ki ...".
  const leading = extractLeadingSchedulePrefix(raw);
  if (leading) {
    const nested = parseNamedScheduleCore(leading.rest, leading.timePhrase);
    if (nested && (isReminderAction(raw) || hasClockOrDayPart(leading.timePhrase))) {
      return { ...nested, timePhrase: leading.timePhrase };
    }
  }
  return parseNamedScheduleCore(raw, '');
}

/**
 * Parse a reminder that should go to the requesting user's own DM.
 * Supports Hinglish and English, with the time before/after the reminder action.
 * An incomplete reminder is still returned so callers can ask for only the missing field.
 */
export function parseSelfReminderCommand(text) {
  const raw = String(text || '').trim().replace(/\s+/g, ' ');
  if (!raw) return null;
  const explicitSelfStart = /^(?:(?:please|can you|could you)\s+)*(?:mujhe|mujhko|me\b|remind me\b|yaad\s+dila|yaad\s+kara|reminder\b)/i.test(raw);
  const englishReminder = raw.match(/^(?:(?:please|can you|could you)\s+)*remind me\b(.*)$/i);
  if (englishReminder && !/^(?:\s*(?:to|about|at|on|today|aaj|tomorrow|kal|parso|parson|day after tomorrow|next\s+|\d|subah|morning|dopahar|afternoon|shaam|sham|evening|raat|night|midnight|noon))/i.test(englishReminder[1])) return null;
  const leadingClause = extractLeadingSchedulePrefix(raw);
  const startsAfterTime = Boolean(leadingClause && /^(?:mujhe|mujhko|me\b|yaad\s+dila|yaad\s+kara|remind me\b)/i.test(leadingClause.rest));
  if (!explicitSelfStart && !startsAfterTime) return null;
  const actionRx = new RegExp(`\\b${REMINDER_ACTION_SOURCE}\\b`, 'i');
  const actionMatch = actionRx.exec(raw);
  if (!actionMatch) return null;

  // A named person/group command is handled by parseScheduledMessageCommand, never as self.
  const beforeRaw = raw.slice(0, actionMatch.index).trim();
  if (/\b.+\s+ko\s*$/i.test(beforeRaw) && !/^(?:mujhe|mujhko|me)\b/i.test(beforeRaw)) return null;

  let before = beforeRaw
    .replace(/^(?:please\s+)?(?:mujhe|mujhko|me)\b\s*/i, '')
    .replace(/\s+(?:mujhe|mujhko|me)\s*$/i, '')
    .trim();
  let after = stripReminderConnective(raw.slice(actionMatch.index + actionMatch[0].length));
  let timePhrase = '';
  let message = '';

  // If the task text comes before the action and the time is the final clause,
  // retain both instead of treating the whole sentence as the time.
  const trailingBefore = extractTrailingSchedulePhrase(before);
  if (trailingBefore) {
    const dateOnlyPrefix = /^(?:day after tomorrow|tomorrow|today|kal|aaj|parso|parson|next\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i.test(trailingBefore.message);
    timePhrase = dateOnlyPrefix ? `${trailingBefore.message} ${trailingBefore.timePhrase}` : trailingBefore.timePhrase;
    message = dateOnlyPrefix ? '' : trailingBefore.message;
  } else if (before && hasScheduleTimePhrase(before)) {
    timePhrase = before;
  }

  const leadingAfter = extractLeadingSchedulePrefix(after);
  if (!timePhrase && leadingAfter) {
    timePhrase = leadingAfter.timePhrase;
    message = [message, stripReminderConnective(leadingAfter.rest)].filter(Boolean).join(' ').trim();
  } else {
    const trailingAfter = extractTrailingSchedulePhrase(after);
    if (!timePhrase && trailingAfter) {
      timePhrase = trailingAfter.timePhrase;
      message = [message, trailingAfter.message].filter(Boolean).join(' ').trim();
    } else if (after) {
      message = [message, after].filter(Boolean).join(' ').trim();
    }
  }

  // English: "remind me to submit the form tomorrow at 8am".
  if (!timePhrase && before && !hasScheduleTimePhrase(before)) {
    message = [before, message].filter(Boolean).join(' ').trim();
  }
  message = stripReminderConnective(message);

  // If time appeared after the action but before the message, it has already been split.
  // If the action itself is at the beginning and no task text follows, let the caller ask.
  return { target: 'mujhe', timePhrase, message, selfReminder: true };
}
