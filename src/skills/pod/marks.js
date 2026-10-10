/**
 * src/skills/pod/marks.js
 * Grades/marks fetching. §12.3 row 4.
 */
import { getGrades } from './client.js';
import { getLogger } from '../../logger.js';

const log = getLogger('skills/pod/marks');

const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes (grades rarely change)

export async function getMarks(personId, forceRefresh = false) {
  const cached = cache.get(personId);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return cached.data;
  }
  const raw = await getGrades(personId);
  const marks = extractMarksData(raw);
  cache.set(personId, { data: marks, fetchedAt: Date.now() });
  return marks;
}

function extractMarksData(raw) {
  if (!raw) return [];
  // Blueprint §12.3 row 4: various response shapes
  const items = raw?.data?.results || raw?.results || raw?.data || [];
  const arr = Array.isArray(items) ? items : (typeof items === 'object' ? Object.values(items) : []);

  return arr
    .map(item => ({
      code: item.course_code || item.code || item.subject_code || 'Unknown',
      name: item.course_name || item.name || item.subject_name || 'Unknown',
      marks: parseFloat(item.marks_obtained || item.marks_scored || item.marks || 0),
      maxMarks: parseFloat(item.max_marks || item.total_marks || item.max_score || 0),
      grade: item.grade || item.letter_grade || null,
      component: item.component || item.exam_type || null,
    }))
    .filter(m => m.maxMarks > 0); // only show entries with a valid max
}

export function formatMarks(marks) {
  if (!marks || !marks.length) {
    return 'abhi koi marks available nahi hai pod pe. exam/MST hone ke baad dikhāyega.';
  }
  const lines = ['*Marks/Grades:*'];
  for (const m of marks) {
    const pct = m.maxMarks > 0 ? ((m.marks / m.maxMarks) * 100).toFixed(1) : '–';
    const comp = m.component ? ` [${m.component}]` : '';
    const grade = m.grade ? ` | ${m.grade}` : '';
    lines.push(`${m.code}${comp}: ${m.marks}/${m.maxMarks} (${pct}%)${grade}`);
  }
  return lines.join('\n');
}
