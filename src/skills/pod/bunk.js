/**
 * src/skills/pod/bunk.js
 * Bunk calculator. Formulas from §12.4.
 */
import { getCourseAttendance } from './attendance.js';
import { config } from '../../config.js';
import { computeBunk as computeBunkMath, whatIfBunk as whatIfBunkMath } from './bunkMath.js';

/**
 * Calculate safe bunks and recovery for all courses.
 * @param {string} personId
 * @returns {Promise<object[]>}
 */
export async function getBunkData(personId) {
  const courses = await getCourseAttendance(personId);
  return courses.map(c => computeBunk(c));
}

/**
 * Compute bunk stats for a single course using live application settings.
 */
export function computeBunk(course) {
  return computeBunkMath(course, {
    requiredAttendance: config.POD_REQUIRED_ATTENDANCE,
  });
}

/**
 * What-if: what percentage after missing m classes?
 * @param {object} course
 * @param {number} m – classes to miss
 */
export function whatIfBunk(course, m) {
  return whatIfBunkMath(course, m, {
    yellowBelow: config.ZONE_YELLOW_BELOW,
    redBelow: config.ZONE_RED_BELOW,
  });
}

/**
 * Format bunk data as WhatsApp message.
 */
export function formatBunkData(bunkData) {
  if (!bunkData.length) return 'Bunk data nahi mili yaar';

  const lines = ['*Bunk Calculator:*'];
  for (const b of bunkData) {
    const zoneEmoji = b.zone === 'Green' ? '🟢' : b.zone === 'Yellow' ? '🟡' : '🔴';
    if (b.percentage >= config.POD_REQUIRED_ATTENDANCE) {
      lines.push(`${zoneEmoji} ${b.code}: ${b.percentage.toFixed(1)}% → ${b.safeBunks} class${b.safeBunks !== 1 ? 'es' : ''} chhod sakta hai`);
    } else {
      lines.push(`${zoneEmoji} ${b.code}: ${b.percentage.toFixed(1)}% → ${b.needToAttend} consecutive classes attend karne honge`);
    }
  }
  return lines.join('\n');
}
