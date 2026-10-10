/**
 * src/util/timeContext.js
 * Builds a rich, time-aware class context from local data files.
 * Used to inject smart timetable/holiday awareness into every LLM call.
 *
 * Answers: What classes are done today? What's next? Next holiday? Next exam?
 * All data comes from data/classinfo.json + data/academic-calendar.json.
 * No DB required — pure file-based, fast, always fresh.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../../data');

// Cache the parsed JSON — these files don't change at runtime
let _classInfo = null;
let _calendar = null;

function getClassInfo() {
  if (!_classInfo) {
    _classInfo = JSON.parse(readFileSync(resolve(ROOT, 'classinfo.json'), 'utf8'));
  }
  return _classInfo;
}

function getCalendar() {
  if (!_calendar) {
    _calendar = JSON.parse(readFileSync(resolve(ROOT, 'academic-calendar.json'), 'utf8'));
  }
  return _calendar;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Get current IST time details.
 */
export function getISTNow() {
  const now = new Date();
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  return {
    date: ist,
    dayName: DAY_NAMES[ist.getDay()],
    dayIndex: ist.getDay(),
    hours: ist.getHours(),
    minutes: ist.getMinutes(),
    timeStr: `${String(ist.getHours()).padStart(2, '0')}:${String(ist.getMinutes()).padStart(2, '0')}`,
    dateStr: `${ist.getFullYear()}-${String(ist.getMonth() + 1).padStart(2, '0')}-${String(ist.getDate()).padStart(2, '0')}`,
  };
}

/**
 * Parse "HH:MM" to total minutes from midnight.
 */
function toMinutes(timeStr) {
  if (!timeStr) return 0;
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Get today's schedule with done/upcoming/ongoing markers.
 */
export function getTodaySchedule() {
  const { dayName, dayIndex, hours, minutes, dateStr } = getISTNow();
  const nowMinutes = hours * 60 + minutes;

  const ci = getClassInfo();
  const cal = getCalendar();

  // Check if today is a holiday
  const holiday = cal.holidays.find(h => {
    if (h.date === dateStr) return true;
    if (h.endDate && h.date <= dateStr && h.endDate >= dateStr) return true;
    return false;
  });

  // Check if today is an exam day
  const exam = cal.examAndAcademicEvents.find(e => {
    if (e.date === dateStr) return true;
    if (e.dates && e.dates.includes(dateStr)) return true;
    if (e.endDate && e.date <= dateStr && e.endDate >= dateStr) return true;
    return false;
  });

  // No classes on Sunday
  if (dayIndex === 0) {
    return { isHoliday: false, isSunday: true, isExamDay: false, holiday: null, exam: null, entries: [], done: [], upcoming: [], current: null };
  }

  if (holiday) {
    return { isHoliday: true, isSunday: false, isExamDay: false, holiday, exam: null, entries: [], done: [], upcoming: [], current: null };
  }

  // Get today's timetable
  const rawEntries = ci.timetable[dayName] || [];

  // Flatten parallel entries
  const entries = [];
  for (const entry of rawEntries) {
    if (entry.parallel) {
      for (const p of entry.parallel) {
        entries.push({
          slot: entry.slot,
          time: entry.time,
          startTime: entry.time?.split('-')[0],
          endTime: entry.time?.split('-')[1],
          ...p,
          isParallel: true,
        });
      }
    } else {
      entries.push({
        ...entry,
        startTime: entry.time?.split('-')[0],
        endTime: entry.time?.split('-')[1],
        isParallel: false,
      });
    }
  }

  // Deduplicate by slot+code
  const seen = new Set();
  const uniqueEntries = entries.filter(e => {
    const key = `${e.slot}:${e.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Classify: done, current, upcoming
  const done = [];
  const upcoming = [];
  let current = null;

  for (const e of uniqueEntries) {
    const startMin = toMinutes(e.startTime);
    const endMin = toMinutes(e.endTime);

    if (endMin <= nowMinutes) {
      done.push(e);
    } else if (startMin <= nowMinutes && nowMinutes < endMin) {
      current = e;
    } else {
      upcoming.push(e);
    }
  }

  const allDone = upcoming.length === 0 && current === null && done.length > 0;
  const notStarted = done.length === 0 && current === null && upcoming.length > 0;

  return {
    isHoliday: false,
    isSunday: false,
    isExamDay: !!exam,
    holiday: null,
    exam: exam || null,
    entries: uniqueEntries,
    done,
    upcoming,
    current,
    allDone,
    notStarted,
    dayName,
    dateStr,
  };
}

/**
 * Get the next upcoming holiday (on or after today).
 */
export function getNextHoliday() {
  const { dateStr } = getISTNow();
  const cal = getCalendar();

  const future = cal.holidays
    .filter(h => (h.endDate || h.date) >= dateStr)
    .sort((a, b) => a.date.localeCompare(b.date));

  return future[0] || null;
}

/**
 * Get the next upcoming exam (on or after today).
 */
export function getNextExam() {
  const { dateStr } = getISTNow();
  const cal = getCalendar();

  const future = cal.examAndAcademicEvents
    .filter(e => e.type === 'exam' && (e.endDate || e.date) >= dateStr)
    .sort((a, b) => a.date.localeCompare(b.date));

  return future[0] || null;
}

/**
 * Get tomorrow's schedule summary.
 */
export function getTomorrowSchedule() {
  const { date } = getISTNow();
  const tomorrow = new Date(date);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tDayName = DAY_NAMES[tomorrow.getDay()];
  const tDateStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;

  const ci = getClassInfo();
  const cal = getCalendar();

  const holiday = cal.holidays.find(h => {
    if (h.date === tDateStr) return true;
    if (h.endDate && h.date <= tDateStr && h.endDate >= tDateStr) return true;
    return false;
  });

  if (tomorrow.getDay() === 0) return { dayName: tDayName, isSunday: true, isHoliday: false, entries: [] };
  if (holiday) return { dayName: tDayName, isSunday: false, isHoliday: true, holiday, entries: [] };

  const rawEntries = ci.timetable[tDayName] || [];
  return { dayName: tDayName, dateStr: tDateStr, isSunday: false, isHoliday: false, holiday: null, entries: rawEntries };
}

/**
 * Build the full class context string for injection into the LLM system prompt.
 * This is the key function that makes Chintu time-aware.
 */
export function buildLiveClassContext() {
  try {
    const today = getTodaySchedule();
    const nextHoliday = getNextHoliday();
    const nextExam = getNextExam();
    const tomorrow = getTomorrowSchedule();
    const { timeStr, dayName, dateStr } = getISTNow();

    const lines = [`[Live Context — IST ${timeStr}, ${dayName} ${formatDate(dateStr)}]`];

    if (today.isSunday) {
      lines.push('Today: Sunday — no classes.');
    } else if (today.isHoliday) {
      lines.push(`Today: Holiday — ${today.holiday.name}. No classes.`);
    } else if (today.isExamDay && today.exam) {
      lines.push(`Today: ${today.exam.name} exam day.`);
    } else if (today.allDone) {
      const doneList = today.done.map(e => `${e.short || e.code} (${e.startTime}–${e.endTime})`).join(', ');
      lines.push(`Today's classes ALL DONE. Completed: ${doneList}.`);
    } else if (today.notStarted) {
      const first = today.upcoming[0];
      lines.push(`No classes started yet. First class: ${first.subject} (${first.short}) at ${first.startTime} in ${first.room}.`);
    } else {
      // Some done, some upcoming
      if (today.current) {
        lines.push(`Currently in: ${today.current.subject} (${today.current.short}) till ${today.current.endTime}, ${today.current.room}.`);
      }
      if (today.upcoming.length > 0) {
        const next = today.upcoming[0];
        lines.push(`Next class: ${next.subject} (${next.short}) at ${next.startTime} in ${next.room || 'B-007'}.`);
        lines.push(`Remaining today: ${today.upcoming.map(e => `${e.short}@${e.startTime}`).join(', ')}.`);
      }
      if (today.done.length > 0) {
        lines.push(`Done today: ${today.done.map(e => `${e.short}(${e.startTime})`).join(', ')}.`);
      }
    }

    // Tomorrow
    if (tomorrow.isSunday) {
      lines.push('Tomorrow: Sunday.');
    } else if (tomorrow.isHoliday) {
      lines.push(`Tomorrow: Holiday — ${tomorrow.holiday.name}! No classes.`);
    } else if (tomorrow.entries.length > 0) {
      const slots = tomorrow.entries
        .map(e => e.parallel
          ? `${e.time}: ${e.parallel.map(p => p.short).join('/')} (parallel)`
          : `${e.time}: ${e.short || e.subject}`)
        .join(', ');
      lines.push(`Tomorrow (${tomorrow.dayName}): ${slots}.`);
    }

    // Next holiday
    if (nextHoliday) {
      const daysUntil = daysBetween(dateStr, nextHoliday.date);
      if (daysUntil === 0) {
        // already shown above
      } else if (daysUntil === 1) {
        lines.push(`Next holiday: ${nextHoliday.name} TOMORROW!`);
      } else if (daysUntil <= 30) {
        lines.push(`Next holiday: ${nextHoliday.name} in ${daysUntil} days (${formatDate(nextHoliday.date)}).`);
      }
    }

    // Next exam
    if (nextExam) {
      const daysUntil = daysBetween(dateStr, nextExam.date);
      if (daysUntil > 0 && daysUntil <= 45) {
        lines.push(`Upcoming: ${nextExam.name} in ${daysUntil} days (${formatDate(nextExam.date)}${nextExam.endDate ? '–' + formatDate(nextExam.endDate) : ''}).`);
      }
    }

    return lines.join('\n');
  } catch (err) {
    return ''; // Non-fatal: LLM works without this context
  }
}

/**
 * Answer a timetable/calendar question directly without LLM.
 * Returns a formatted string or null if not handled.
 */
export function answerFromLocalData(text) {
  const t = text.toLowerCase();

  const today = getTodaySchedule();
  const { dayName, timeStr } = getISTNow();

  // "classes khatam ho gaye / ho gayi"
  if (/khatam ho ga|class.*over|aaj.*class|sab khatam/.test(t)) {
    if (today.isSunday) return 'sunday hai aaj, class thi hi nahi';
    if (today.isHoliday) return `${today.holiday.name} ki chhutti thi aaj`;
    if (today.allDone) {
      return `haan, aaj ki saari classes ho gayi. ${today.done.map(e => `${e.short}(${e.startTime})`).join(', ')} tha aaj ka scene`;
    }
    if (today.upcoming.length > 0) {
      return `nahi abhi, ${today.upcoming.length} class${today.upcoming.length > 1 ? 'es' : ''} bachi hain. next: ${today.upcoming[0].subject} at ${today.upcoming[0].startTime}`;
    }
  }

  // "next class / agla class"
  if (/next class|agla class|next kya|abhi kya|kya hai abhi|class kab/.test(t)) {
    if (today.isSunday) return 'sunday hai bhai, koi class nahi';
    if (today.isHoliday) return `aaj ${today.holiday.name} ki chhutti hai`;
    if (today.allDone) return 'aaj ki saari classes ho gayi';
    if (today.current) return `abhi ${today.current.subject} chal raha hai, ${today.current.endTime} tak. phir ${today.upcoming[0] ? today.upcoming[0].subject + ' at ' + today.upcoming[0].startTime : 'kuch nahi'}`;
    if (today.upcoming.length > 0) {
      const next = today.upcoming[0];
      return `next class: ${next.subject} (${next.short}) at ${next.startTime}, ${next.room || 'B-007'}. ${next.faculty ? 'faculty: ' + next.faculty : ''}`;
    }
  }

  // "aaj ka timetable / aaj kya hai"
  if (/aaj.*timetable|aaj kya|today.*class|schedule aaj/.test(t)) {
    if (today.isSunday) return 'sunday — koi class nahi, enjoy kar';
    if (today.isHoliday) return `aaj ${today.holiday.name} ki chhutti! enjoy`;
    if (!today.entries.length) return 'aaj koi class nahi hai';

    const lines = [`*${dayName} ka timetable:*`];
    for (const e of today.entries) {
      const done = today.done.some(d => d.code === e.code && d.slot === e.slot);
      const current = today.current?.code === e.code && today.current?.slot === e.slot;
      const marker = done ? '✅' : current ? '🔵' : '⏳';
      lines.push(`${marker} ${e.startTime} ${e.subject} — ${e.room || 'B-007'}`);
    }
    return lines.join('\n');
  }

  // "next holiday / agli chhutti"
  if (/next holiday|agli chhutti|kab holiday|holiday kab|chhutti kab/.test(t)) {
    const nh = getNextHoliday();
    if (!nh) return 'koi holiday abhi nahi dikh raha agle 2 mahine mein';
    const days = daysBetween(getISTNow().dateStr, nh.date);
    if (days === 0) return `aaj hi holiday hai — ${nh.name}!`;
    if (days === 1) return `kal holiday hai — ${nh.name}! kal koi class nahi`;
    return `agli chhutti ${nh.name} — ${formatDate(nh.date)} mein, ${days} din baad`;
  }

  // "kal kya hai / kal timetable"
  if (/kal.*class|kal.*timetable|kal kya|tomorrow.*class/.test(t)) {
    const tom = getTomorrowSchedule();
    if (tom.isSunday) return 'kal sunday hai, koi class nahi';
    if (tom.isHoliday) return `kal ${tom.holiday.name} ki chhutti! 🎉`;
    if (!tom.entries.length) return `kal ${tom.dayName} — koi class nahi dikh raha`;
    const slots = tom.entries
      .filter(e => !e.parallel)
      .map(e => `${e.time}: ${e.short || e.subject}`)
      .join('\n');
    return `*kal ${tom.dayName} ka schedule:*\n${slots}`;
  }

  // "MST / exam kab hai"
  if (/mst|exam kab|test kab|exam hai kab/.test(t)) {
    const ne = getNextExam();
    if (!ne) return 'koi exam schedule nahi dikh raha abhi';
    const days = daysBetween(getISTNow().dateStr, ne.date);
    if (days === 0) return `aaj hi ${ne.name} hai! all the best 💀`;
    if (days <= 3) return `${ne.name} aane wala hai — ${formatDate(ne.date)}, sirf ${days} din baad. padh le yaar`;
    return `${ne.name}: ${formatDate(ne.date)}${ne.endDate ? ' to ' + formatDate(ne.endDate) : ''} — ${days} din baad`;
  }

  return null; // Not handled by local data
}

// ─── Helpers ──────────────────────────────────────────────────────

function formatDate(dateStr) {
  try {
    const d = new Date(dateStr + 'T00:00:00+05:30');
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
  } catch { return dateStr; }
}

function daysBetween(from, to) {
  const a = new Date(from + 'T00:00:00+05:30');
  const b = new Date(to + 'T00:00:00+05:30');
  return Math.round((b - a) / 86400000);
}
