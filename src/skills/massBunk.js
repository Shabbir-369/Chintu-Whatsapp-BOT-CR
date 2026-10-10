/**
 * src/skills/massBunk.js
 * Mass-bunk intelligence: detection, per-person warnings, owner report. §11.10.
 */
import { getLinkedMembers, getGroup } from '../db/repos/groups.js';
import { matchCoursesToTimetable, calculateAttendanceAfterMiss } from './massBunkMath.js';
import { getDayTimetable } from './timetable.js';
import { getCourseAttendance, getZone } from './pod/attendance.js';
import { getPersonById, getIdentities } from '../db/repos/people.js';
import { config } from '../config.js';
import {
  createMassBunkRun, updateMassBunkRun, saveMassBunkResult,
  markMassBunkWarned, getRecentMassBunkRun,
} from '../db/repos/timetable.js';
import { humanSend } from '../gateway/outbox.js';
import { toISTDateString } from '../util/time.js';
import { sleep, jitter } from '../util/time.js';
import { getLogger } from '../logger.js';

const log = getLogger('skills/massBunk');

/**
 * Run mass-bunk analysis for a group and date.
 * @param {string} groupJid
 * @param {Date} targetDate
 * @param {string} ownerChatJid – to send owner report
 * @returns {Promise<string>} Group-safe reply (no names/numbers)
 */
export async function runMassBunkAnalysis(groupJid, targetDate, ownerChatJid) {
  const targetDateStr = toISTDateString(targetDate);

  // Rate limit: once per 3 hours per group+date
  const existing = await getRecentMassBunkRun(groupJid, targetDateStr);
  if (existing) {
    log.info({ groupJid, targetDateStr }, 'Mass bunk already analysed recently');
    return null;
  }

  // Create run record
  const run = await createMassBunkRun({ groupJid, targetDate: targetDateStr });

  // Get timetable for target date
  const dayData = await getDayTimetable(targetDate, groupJid);
  if (dayData.holiday || dayData.rawEntries.length === 0) {
    log.info({ groupJid, targetDateStr }, 'No classes on target date, skipping mass bunk analysis');
    return null;
  }

  // Get linked members of the group
  const linkedMembers = await getLinkedMembers(groupJid);
  const linkedCount = linkedMembers.length;
  const groupInfo = await getGroup(groupJid).catch(() => null);
  const unknownCount = Math.max(0, Number(groupInfo?.member_count || linkedCount) - linkedCount);

  let yellowCount = 0;
  let redCount = 0;
  const results = [];

  // Process each linked member
  for (const member of linkedMembers) {
    try {
      // Spread requests: 1-3 seconds apart
      await sleep(1000 + jitter(2000));

      const courses = await getCourseAttendance(member.person_id);
      const relevantCourses = matchCoursesToTimetable(courses, dayData.rawEntries)
        .filter(({ course, missCount }) => Number.isFinite(Number(course.present)) && Number.isFinite(Number(course.total)) && Number(course.total) >= 0 && Number(course.present) >= 0 && Number(course.total) + missCount > 0);

      if (relevantCourses.length === 0) continue;

      let worstCourse = null;
      let lowestPctAfter = 101;
      let zoneAfter = 'Green';
      let affected = false;

      for (const { course, missCount } of relevantCourses) {
        const pctAfter = calculateAttendanceAfterMiss(course, missCount);
        if (pctAfter === null) continue;
        const zoneBefore = getZone(course.percentage);
        const newZone = getZone(pctAfter);

        if (newZone === 'Yellow' || newZone === 'Red') {
          affected = true;
        }
        // Track worst
        if (pctAfter < lowestPctAfter) {
          lowestPctAfter = pctAfter;
          worstCourse = course.code;
          zoneAfter = newZone;
        }
      }

      if (affected) {
        if (zoneAfter === 'Yellow') yellowCount++;
        if (zoneAfter === 'Red') redCount++;

        results.push({
          personId: member.person_id,
          worstCourse,
          beforePct: (() => { const c = relevantCourses.find(x => x.course.code === worstCourse)?.course; return c && Number(c.total) > 0 ? Number(((Number(c.present) / Number(c.total)) * 100).toFixed(2)) : null; })(),
          afterPct: parseFloat(lowestPctAfter.toFixed(2)),
          zone: zoneAfter,
          relevantCourses,
        });
      }
    } catch (err) {
      log.warn({ err, personId: member.person_id }, 'Mass bunk calc failed for member');
    }
  }

  // Update run with stats
  await updateMassBunkRun(run.id, {
    linkedCount,
    unknownCount,
    yellowCount,
    redCount,
    summary: { classCount: dayData.rawEntries.length },
  });

  // Save individual results
  for (const r of results) {
    await saveMassBunkResult({
      runId: run.id,
      personId: r.personId,
      worstCourse: r.worstCourse,
      beforePct: r.beforePct,
      afterPct: r.afterPct,
      zone: r.zone,
    });
  }

  // Send warnings to affected people (private, staggered 1-15 min)
  for (const r of results) {
    const delay = 60000 + jitter(14 * 60 * 1000); // 1-15 minutes
    setTimeout(async () => {
      try {
        const person = await getPersonById(r.personId);
        const identities = await getIdentities(r.personId);
        const jid = identities.find(i => i.kind === 'phone')?.jid || identities[0]?.jid;
        if (!jid) return;

        const warning = buildPersonWarning(r);
        await humanSend(jid, warning);
        await markMassBunkWarned(run.id, r.personId);
      } catch (err) {
        log.warn({ err }, 'Failed to send mass bunk warning');
      }
    }, delay);
  }

  // Send owner report
  if (ownerChatJid) {
    const ownerReport = buildOwnerReport({ linkedCount, unknownCount, yellowCount, redCount, results, dayData });
    setTimeout(async () => {
      try {
        await humanSend(ownerChatJid, ownerReport, { priority: true });
      } catch (err) {
        log.warn({ err }, 'Failed to send owner mass bunk report');
      }
    }, 5000);
  }

  // Group reply: neutral, no names/numbers
  return `plan banane se pehle calculator bhi nikalna chahiye, bas keh raha hoon`;
}


function buildPersonWarning(r) {
  const lines = [`kal ka bunk plan sun raha tha. heads up:`];
  for (const { course, missCount } of r.relevantCourses) {
    const pctAfter = calculateAttendanceAfterMiss(course, missCount);
    if (pctAfter === null) continue;
    const zone = getZone(pctAfter);
    const zoneEmoji = zone === 'Green' ? '🟢' : zone === 'Yellow' ? '🟡' : '🔴';
    const beforePct = Number(course.total) > 0 ? (Number(course.present) / Number(course.total)) * 100 : Number(course.percentage || 0);
    lines.push(`${zoneEmoji} ${course.code}: ${beforePct.toFixed(1)}% → ${pctAfter.toFixed(1)}% (${zone.toLowerCase()})`);
    if (zone === 'Red') lines.push(`  ⚠️ 60% se neeche aa jaayegi`);
  }
  lines.push(`soch le`);
  return lines.join('\n');
}

function buildOwnerReport({ linkedCount, unknownCount, yellowCount, redCount, results, dayData }) {
  const lines = [
    `*mass bunk analysis:*`,
    `linked: ${linkedCount} | unknown: ${unknownCount}`,
    `yellow mein jaane wale: ${yellowCount}`,
    `red mein jaane wale: ${redCount}`,
  ];

  // Red zone people (approved names only)
  const redPeople = results.filter(r => r.zone === 'Red');
  if (redPeople.length > 0) {
    lines.push(`\nRed cases: ${redPeople.map(r => r.worstCourse || 'unknown').join(', ')}`);
  }

  return lines.join('\n');
}
