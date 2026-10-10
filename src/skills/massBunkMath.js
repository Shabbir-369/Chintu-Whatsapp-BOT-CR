/** Pure mass-bunk course matching helpers; no DB or network dependencies. */
export function matchCoursesToTimetable(courses, entries) {
  const result = [];
  const seen = new Set();
  const norm = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const course of courses || []) {
    const code = norm(course.code || course.course_code);
    const name = norm(course.name || course.course_name || course.class_group_name);
    const matchingEntries = (entries || []).filter(entry => {
      const entryCode = norm(entry.code || entry.short);
      const entryName = norm(entry.subject || entry.name);
      // Attendance must not be charged to a merely similar course. Prefer exact
      // normalized course-code matches; use exact normalized subject names as fallback.
      return Boolean((code && entryCode && code === entryCode) ||
        (name && entryName && name === entryName));
    });
    // Parallel batches/elective rows at the same time are one session, not multiple
    // absences. Rows lacking times remain separate because no safe dedupe key exists.
    const uniqueSessions = new Set();
    for (const entry of matchingEntries) {
      const start = String(entry.start_time || '').slice(0, 5);
      const end = String(entry.end_time || '').slice(0, 5);
      const slot = start && end ? `${start}-${end}` : null;
      if (slot) uniqueSessions.add(slot);
      else uniqueSessions.add(`row-${uniqueSessions.size}-${matchingEntries.indexOf(entry)}`);
    }
    const key = code || name;
    if (!matchingEntries.length || !key || seen.has(key)) continue;
    seen.add(key);
    result.push({ course, missCount: uniqueSessions.size });
  }
  return result;
}


/** Project attendance after missing a known number of upcoming sessions. */
export function calculateAttendanceAfterMiss(course, missedClasses) {
  const present = Number(course?.present);
  const total = Number(course?.total);
  const missed = Number(missedClasses);
  if (!Number.isFinite(present) || !Number.isFinite(total) || !Number.isFinite(missed) || present < 0 || total < 0 || missed < 0 || total + missed <= 0) {
    return null;
  }
  return Number(((present / (total + missed)) * 100).toFixed(2));
}
