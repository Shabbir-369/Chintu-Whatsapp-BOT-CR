/**
 * src/util/time.js
 * IST timezone helpers. All timers use Asia/Kolkata.
 */
import { config } from '../config.js';

const TZ = config.TZ_NAME || 'Asia/Kolkata';

/** Returns the current Date object (always UTC internally, but labelled for IST usage) */
export function nowIST() {
  return new Date();
}

/**
 * Format a Date as IST date string YYYY-MM-DD
 * @param {Date} [d]
 * @returns {string}
 */
export function toISTDateString(d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: TZ }); // en-CA gives YYYY-MM-DD
}

/**
 * Format a Date as IST time HH:MM
 * @param {Date} [d]
 * @returns {string}
 */
export function toISTTimeString(d = new Date()) {
  return d.toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
}

/**
 * Parse an IST "HH:MM" string and return the next occurrence of that time as a UTC Date.
 * @param {string} hhmm – e.g. "07:45"
 * @returns {Date}
 */
export function nextISTOccurrence(hhmm) {
  const [hh, mm] = hhmm.split(':').map(Number);
  const now = new Date();
  const todayIST = toISTDateString(now);
  // Build a date string in IST and parse it
  const candidate = new Date(`${todayIST}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00+05:30`);
  if (candidate <= now) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

/**
 * Get IST hour (0-23)
 * @param {Date} [d]
 * @returns {number}
 */
export function getISTHour(d = new Date()) {
  return parseInt(d.toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }));
}

/**
 * Get IST weekday (0=Sunday … 6=Saturday)
 * @param {Date} [d]
 * @returns {number}
 */
export function getISTWeekday(d = new Date()) {
  return parseInt(d.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long' }) === 'Sunday' ? 0 :
    ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].indexOf(
      d.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long' })
    ));
}

/**
 * Returns a random jitter between 0 and maxMs milliseconds.
 * @param {number} maxMs
 * @returns {number}
 */
export function jitter(maxMs) {
  return Math.floor(Math.random() * maxMs);
}

/**
 * Sleep for ms milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Returns true if current IST time is within quiet hours.
 * @param {string} quietStart – "HH:MM"
 * @param {string} quietEnd – "HH:MM"
 * @returns {boolean}
 */
export function isQuietHours(quietStart = config.QUIET_START, quietEnd = config.QUIET_END) {
  const now = new Date();
  const nowMinutes = getISTHour(now) * 60 + parseInt(
    now.toLocaleTimeString('en-GB', { timeZone: TZ, minute: '2-digit' })
  );
  const [sh, sm] = quietStart.split(':').map(Number);
  const [eh, em] = quietEnd.split(':').map(Number);
  const startMinutes = sh * 60 + sm;
  const endMinutes = eh * 60 + em;

  if (startMinutes <= endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  } else {
    // Crosses midnight
    return nowMinutes >= startMinutes || nowMinutes < endMinutes;
  }
}

/**
 * Returns a human-readable IST datetime string.
 * @param {Date} [d]
 * @returns {string}
 */
export function formatISTDateTime(d = new Date()) {
  return d.toLocaleString('en-IN', {
    timeZone: TZ,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}
