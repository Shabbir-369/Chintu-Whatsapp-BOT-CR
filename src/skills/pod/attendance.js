/**
 * src/skills/pod/attendance.js
 * Attendance fetching, status inference, bunk calculator, and caching. §12.4, §12.6.
 *
 * Blueprint §12.4 status inference:
 *   1. Per course, call getCoursesWithAttendance() → cg_attendance (reported %)
 *   2. For exact counts, cross-reference with past completed classes
 *   3. Infer present_status code: whichever status whose share ≈ cg_attendance (within 8pp)
 *   4. Once 5 users agree on a code, store in settings.pod_present_status and use directly
 *   5. Re-validate when computed % differs from cg_attendance by > 2 points
 */
import { getCoursesWithAttendance, getPastClasses } from './client.js';
import { config } from '../../config.js';
import { getSetting, setSetting } from '../../db/repos/timetable.js';
import { getLogger } from '../../logger.js';

const log = getLogger('skills/pod/attendance');

// In-memory cache per person (§12.6 TTL: 45s for courses, 5min for past classes)
const courseCache = new Map();  // personId → { data, fetchedAt }
const classesCache = new Map(); // personId → { data, fetchedAt }
const COURSE_TTL = 45 * 1000;
const CLASSES_TTL = 5 * 60 * 1000;

// Inferred present-status code (shared across users)
let inferredPresentStatus = null;
let inferredStatusVotes = 0;

/**
 * Get attendance for a person (with caching).
 * Returns array of course objects with present/total/percentage/zone.
 * @param {string} personId
 * @param {boolean} [forceRefresh]
 * @returns {Promise<object[]>}
 */
export async function getCourseAttendance(personId, forceRefresh = false) {
  const cached = courseCache.get(personId);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < COURSE_TTL) {
    return cached.data;
  }

  // Load inferred status from settings if not in memory
  if (!inferredPresentStatus) {
    const stored = await getSetting('pod_present_status').catch(() => null);
    if (stored) {
      inferredPresentStatus = parseInt(stored);
    }
  }

  // Fetch courses with cg_attendance from ERP
  const raw = await getCoursesWithAttendance(personId);
  const courseList = raw?.results || raw?.data?.results || raw?.data || raw || [];
  const courses = Array.isArray(courseList) ? courseList : [];

  // Fetch past classes for exact counts
  let pastClasses = [];
  const classesCached = classesCache.get(personId);
  if (!forceRefresh && classesCached && Date.now() - classesCached.fetchedAt < CLASSES_TTL) {
    pastClasses = classesCached.data;
  } else {
    try {
      pastClasses = await getPastClasses(personId);
      classesCache.set(personId, { data: pastClasses, fetchedAt: Date.now() });
    } catch (err) {
      log.warn({ err, personId }, 'Failed to fetch past classes, using cg_attendance only');
    }
  }

  // Group past classes by class_group_id
  const classesByCG = {};
  for (const cls of pastClasses) {
    const cgId = cls.class_group_id;
    if (!cgId) continue;
    if (!classesByCG[cgId]) classesByCG[cgId] = [];
    classesByCG[cgId].push(cls);
  }

  const result = [];
  for (const course of courses) {
    const code = course.code || course.course_code || 'Unknown';
    const name = course.name || course.course_name || course.class_group_name || code;
    const cgToken = course.external_class_group_data?.token || course.class_group_id || course.id;
    const cgAttendance = parseFloat(course.cg_attendance || course.percentage || 0);

    // Match past classes to this course
    const cg = cgToken ? (classesByCG[cgToken] || []) : [];

    let present = 0, total = cg.length, approximate = false;
    let percentage = cgAttendance;

    if (total > 0) {
      // Infer present status code
      let presentStatus = inferredPresentStatus;
      if (!presentStatus) {
        presentStatus = inferPresentStatus(cg, cgAttendance);
        if (presentStatus !== null) {
          inferredStatusVotes++;
          if (inferredStatusVotes >= 5 && !inferredPresentStatus) {
            inferredPresentStatus = presentStatus;
            setSetting('pod_present_status', presentStatus).catch(() => {});
          }
        }
      }

      if (presentStatus !== null) {
        present = cg.filter(c => c.attendance_status === presentStatus).length;
      } else {
        // Fallback: estimate present from percentage
        present = Math.round((cgAttendance / 100) * total);
        approximate = true;
      }

      const computed = total > 0 ? (present / total) * 100 : 0;

      // Re-validate: if computed differs from cg_attendance by > 2 points, mark approximate
      if (Math.abs(computed - cgAttendance) > 2) {
        approximate = true;
        percentage = cgAttendance; // trust Pod's reported value
        // Keep the estimated present count for display, but it's approximate
        // Do NOT show conflicting data — if cg_attendance is 0 but estimated 6/7, that's unreliable
        if (cgAttendance === 0 && present > 0) {
          // Pod says 0% but we estimated some present — present count is unreliable, reset
          present = 0;
        } else if (cgAttendance > 0 && present === 0) {
          // Pod says > 0% but we got 0 present — estimate from percentage
          present = Math.round((cgAttendance / 100) * total);
        }
      } else {
        percentage = computed;
      }
    }

    result.push({
      code,
      name,
      classGroupId: cgToken,
      present,
      total,
      percentage: parseFloat(percentage.toFixed(2)),
      zone: getZone(percentage),
      approximate,
      credits: course.credits || 4,
    });
  }

  // Filter out zero-total courses (no data)
  const valid = result.filter(c => c.total > 0 || c.percentage > 0);

  courseCache.set(personId, { data: valid, fetchedAt: Date.now() });
  return valid;
}

/**
 * Infer which attendance_status value means "present" for this course's class list.
 * Picks the status whose share is closest to cgAttendance (within 8 percentage points).
 * Blueprint §12.4: "the status whose share of classes is closest to cg_attendance (accepted if within 8pp)"
 * Observed codes: 1, 2, 3 (3 most common).
 */
function inferPresentStatus(classes, cgAttendance) {
  if (!classes.length) return null;

  const statusCounts = {};
  for (const cls of classes) {
    const s = cls.attendance_status;
    if (s !== undefined && s !== null) {
      statusCounts[s] = (statusCounts[s] || 0) + 1;
    }
  }

  let best = null, bestDiff = Infinity;
  for (const [status, count] of Object.entries(statusCounts)) {
    const share = (count / classes.length) * 100;
    const diff = Math.abs(share - cgAttendance);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = parseInt(status);
    }
  }

  return bestDiff <= 8 ? best : null;
}

/**
 * Clear cache for a person.
 */
export function clearAttendanceCache(personId) {
  courseCache.delete(personId);
  classesCache.delete(personId);
}

/**
 * Get zone for a percentage. (§12.4)
 */
export function getZone(pct) {
  if (pct >= config.ZONE_YELLOW_BELOW) return 'Green';
  if (pct >= config.ZONE_RED_BELOW) return 'Yellow';
  return 'Red';
}

/**
 * Format attendance as a readable WhatsApp message.
 * @param {object[]} courses
 * @returns {string}
 */
export function formatAttendance(courses, opts = {}) {
  if (!courses || !courses.length) return 'attendance data nahi mili abhi. pod check kar';

  const lines = ['*Attendance:*'];
  for (const c of courses) {
    const zoneEmoji = c.zone === 'Green' ? '🟢' : c.zone === 'Yellow' ? '🟡' : '🔴';
    const approx = c.approximate ? ' ~' : '';
    // Always show subject name alongside code (owner asked for this)
    const label = c.name && c.name !== c.code
      ? `${c.name} (${c.code})`
      : c.code;
    const countStr = c.total > 0 ? ` (${c.present}/${c.total})` : '';
    lines.push(`${zoneEmoji} ${label}: ${c.percentage.toFixed(1)}%${approx}${countStr}`);
  }

  // Weighted overall (§12.4)
  const totalCredits = courses.reduce((acc, c) => acc + (c.credits || 4), 0);
  const weighted = totalCredits > 0
    ? courses.reduce((acc, c) => acc + c.percentage * (c.credits || 4), 0) / totalCredits
    : courses.reduce((acc, c) => acc + c.percentage, 0) / courses.length;

  lines.push(`\n*Overall (weighted): ${weighted.toFixed(1)}%*`);
  return lines.join('\n');
}
