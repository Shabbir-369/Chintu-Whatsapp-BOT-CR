/**
 * Pure attendance/bunk calculations.
 *
 * Keep this module free of app configuration, database, and network imports so
 * the calculator's unit tests can run without a live bot environment or .env.
 */
export function getAttendanceZone(pct, { yellowBelow = 75, redBelow = 60 } = {}) {
  if (pct >= yellowBelow) return 'Green';
  if (pct >= redBelow) return 'Yellow';
  return 'Red';
}

/**
 * Calculate safe bunks and recovery for a single course.
 * @param {{present:number,total:number,percentage:number,code?:string,name?:string,zone?:string}} course
 * @param {{requiredAttendance?:number}} options
 */
export function computeBunk(course, { requiredAttendance = 75 } = {}) {
  const { present, total, percentage, code, name, zone } = course;
  const req = requiredAttendance / 100;

  // Safe bunks (stay at or above the required attendance percentage).
  const safeBunks = Math.max(0, Math.floor(present / req - total));

  // Classes needed to recover when the current percentage is below required.
  let needToAttend = 0;
  if (percentage < requiredAttendance) {
    needToAttend = Math.ceil((req * total - present) / (1 - req));
  }

  return {
    code,
    name,
    present,
    total,
    percentage,
    zone,
    safeBunks,
    needToAttend,
    required: requiredAttendance,
  };
}

/**
 * What-if calculation: attendance after missing `missedClasses` classes.
 * @param {{present:number,total:number}} course
 * @param {number} missedClasses
 * @param {{yellowBelow?:number,redBelow?:number}} zoneThresholds
 */
export function whatIfBunk(course, missedClasses, zoneThresholds = {}) {
  const { present, total } = course;
  const pctAfter = total + missedClasses > 0
    ? (present / (total + missedClasses)) * 100
    : 0;

  return {
    pctAfter: parseFloat(pctAfter.toFixed(2)),
    zoneAfter: getAttendanceZone(pctAfter, zoneThresholds),
  };
}
