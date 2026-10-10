const TZ = 'Asia/Kolkata';

const FALLBACK_MORNING_LINES = [
  'talent ka trailer sab dikhate hain; discipline ki full movie bahut kam log banate hain. 💀',
  'apna future un decisions se banta hai jo applause ke bina liye jaate hain.',
  'mood ka wait karoge toh goals bhi seen-zoned rahenge. 😮‍💨',
  'confidence se entry milti hai, consistency se jagah banti hai.',
  'kal ka version tujhe thank kare, aaj bas itna kaam kar.',
  'har kisi ko shortcut chahiye; phir result sabko long-term wala chahiye. 💀',
  'potential bolna easy hai, proof roz dena padta hai.',
  'excuses temporary comfort hain, permanent progress nahi.',
  'comparison chhod; tera competition woh version hai jo kal bhi postpone kar raha tha.',
  'life ka plot twist chahiye toh routine ka script badal.',
  'log luck ka screenshot daalte hain, boring effort ka nahi.',
  'consistency glamorous nahi hoti, isliye uske results sabko surprise karte hain.',
];

function istParts(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = key => parts.find(part => part.type === key)?.value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')),
    minute: Number(get('minute')),
  };
}

/**
 * Decide whether a morning message should run today. Allows a bounded catch-up
 * after restarts, but never sends it before its configured IST time or twice
 * after the scheduler has recorded today's successful run.
 */
export function shouldRunMorningWindow(now, lastRunDate, hhmm = '07:45', catchUpMinutes = 180) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return false;
  const [hour, minute] = String(hhmm || '').split(':').map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return false;
  const local = istParts(now);
  if (lastRunDate === local.date) return false;
  const currentMinutes = local.hour * 60 + local.minute;
  const targetMinutes = hour * 60 + minute;
  const elapsed = currentMinutes - targetMinutes;
  return elapsed >= 0 && elapsed <= Math.max(0, Number(catchUpMinutes) || 0);
}

/** Ambient mode can initiate conversation; trigger mode only replies when called. */
export function canStartConversationInMode(group, force = false) {
  if (!group || group.enabled === false || group.mode === 'mute') return false;
  return force || group.mode === 'ambient';
}

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Choose a thoughtful savage fallback and avoid lines present in recent messages. */
export function pickMorningFallbackLine(recentMornings = [], random = Math.random) {
  const recent = recentMornings.map(row => normalizeText(row?.text ?? row));
  const candidates = FALLBACK_MORNING_LINES.filter(line => {
    const normalized = normalizeText(line);
    return normalized && !recent.some(text => text.includes(normalized));
  });
  const pool = candidates.length ? candidates : FALLBACK_MORNING_LINES;
  const index = Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)));
  return pool[index];
}

/** Keep timetable facts assembled in code; append exactly one authored line. */
export function composeMorningMessage(timetableText, savageLine, isHolidayOrSunday = false) {
  const line = String(savageLine || '').trim() || 'aaj ka kaam aaj, warna kal bhi wahi excuses repeat honge. 💀';
  if (isHolidayOrSunday) return line;
  const timetable = String(timetableText || '').trim();
  return timetable ? `${timetable}\n\n${line}` : line;
}

/** Remove accidental timetable/header repetition if the model ignores the line-only prompt. */
export function extractSavageLine(modelText, timetableText = '') {
  const source = String(modelText || '').trim();
  if (!source) return '';
  const lines = source.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const timetableLines = new Set(String(timetableText || '').split(/\r?\n/).map(normalizeText));
  const safe = lines.filter(line => {
    const normalized = normalizeText(line);
    if (!normalized || timetableLines.has(normalized)) return false;
    if (/^\d{1,2}:\d{2}\b/.test(line)) return false;
    if (/^(aaj ka scene|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(line)) return false;
    return true;
  });
  const selected = safe.at(-1) || '';
  return selected.replace(/^[>*•\-\s]+/, '').replace(/^['“”"]|['“”"]$/g, '').trim().slice(0, 220);
}
