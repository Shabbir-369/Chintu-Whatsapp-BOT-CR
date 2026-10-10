/** Deterministic daily random starter windows (12:00–22:00 IST) per group. */
function seedOf(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash || 1;
}

/** Returns one or two minute-of-day windows, stable for a group on a given day. */
export function getDailyStarterWindows(dateStr, groupKey) {
  let seed = seedOf(`${dateStr}|${groupKey}`);
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const count = random() < 0.5 ? 1 : 2;
  const windows = [];
  for (let attempt = 0; attempt < 20 && windows.length < count; attempt++) {
    const minute = 12 * 60 + Math.floor(random() * (10 * 60));
    if (windows.every(existing => Math.abs(existing - minute) >= 90)) windows.push(minute);
  }
  if (!windows.length) windows.push(12 * 60 + Math.floor(random() * 600));
  return windows.sort((a, b) => a - b);
}


/** True when a timestamp is within `toleranceMinutes` of a daily HH:MM time in IST. */
export function isNearConfiguredTime(now, hhmm, toleranceMinutes = 30) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return false;
  const [targetHour, targetMinute] = String(hhmm || '').split(':').map(Number);
  if (!Number.isInteger(targetHour) || !Number.isInteger(targetMinute) ||
      targetHour < 0 || targetHour > 23 || targetMinute < 0 || targetMinute > 59) return false;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = type => Number(parts.find(part => part.type === type)?.value || 0);
  const currentMinute = get('hour') * 60 + get('minute');
  const target = targetHour * 60 + targetMinute;
  const difference = Math.abs(currentMinute - target);
  return Math.min(difference, 1440 - difference) <= toleranceMinutes;
}

/** True for a scheduler tick at or just after a planned window. */
export function isStarterWindowDue(now, windows, toleranceMinutes = 5) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return false;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = type => Number(parts.find(part => part.type === type)?.value || 0);
  const current = get('hour') * 60 + get('minute');
  return (windows || []).some(windowMinute => current >= windowMinute && current <= windowMinute + toleranceMinutes);
}
