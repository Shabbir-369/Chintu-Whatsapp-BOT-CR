/**
 * src/skills/morning.js
 * Morning timetable message. §11.7.
 * Assembles facts in code, calls LLM for Chintu voice.
 */
import { getDayTimetable, formatTimetable } from './timetable.js';
import { getEnabledGroups, getGroupProfile, setLastMorningDate } from '../db/repos/groups.js';
import { getLastMorningMessages } from '../db/repos/memory.js';
import { getDailyEventCount, recordDailyEvent } from '../db/repos/timetable.js';
import { generateReply } from '../brain/llm.js';
import { buildSystemPrompt } from '../brain/persona.js';
import { humanSend } from '../gateway/outbox.js';
import { toISTDateString, getISTWeekday, jitter, sleep } from '../util/time.js';
import { config } from '../config.js';
import { getLogger } from '../logger.js';
import { composeMorningMessage, extractSavageLine, pickMorningFallbackLine } from '../util/schedulerPlan.js';

const log = getLogger('skills/morning');

/**
 * Send morning message to all eligible groups.
 */
export async function sendMorningMessages() {
  const now = new Date();
  const today = toISTDateString(now);
  const weekday = getISTWeekday(now);
  const groups = await getEnabledGroups();

  // Jitter is per group, not sequential across all groups. Parallelising the
  // independent work keeps a large group list from drifting hours past morning.
  const outcomes = await Promise.all(groups.map(async group => {
    try {
      return { groupJid: group.jid, status: await sendMorningToGroup(group, today, weekday, now) };
    } catch (err) {
      log.error({ err, groupJid: group.jid }, 'Morning message failed for group');
      return { groupJid: group.jid, status: 'failed' };
    }
  }));

  const summary = {
    total: groups.length,
    sent: outcomes.filter(result => result.status === 'sent').length,
    skipped: outcomes.filter(result => result.status === 'skipped').length,
    failed: outcomes.filter(result => result.status === 'failed').length,
  };
  log.info(summary, 'Morning messages run finished');
  return summary;
}

/** Send a morning message once to one group; throw on send/persistence errors so scheduler can retry. */
async function sendMorningToGroup(group, today, weekday, now) {
  const count = await getDailyEventCount(today, group.jid, 'morning');
  if (count > 0 || group.last_morning_date === today) {
    log.info({ groupJid: group.jid }, 'Morning message already sent today');
    return 'skipped';
  }

  // Per-group jitter within the configured twelve-minute window.
  await sleep(jitter(12 * 60 * 1000));

  const dayData = await getDayTimetable(now, group.jid);
  const timetableText = formatTimetable(dayData);
  const [groupProfile, recentMornings] = await Promise.all([
    getGroupProfile(group.jid),
    getLastMorningMessages(group.jid),
  ]);

  const isHolidayOrSunday = weekday === 0 || !!dayData.holiday;
  const fullMsg = await generateMorningLine(timetableText, groupProfile, recentMornings, isHolidayOrSunday);
  const sent = await humanSend(group.jid, fullMsg);
  if (!sent?.key?.id) throw new Error('WhatsApp did not confirm morning message delivery');

  await recordDailyEvent(today, group.jid, 'morning');
  await setLastMorningDate(group.jid, today);
  log.info({ groupJid: group.jid }, 'Morning message sent');
  return 'sent';
}

/**
 * Generate morning message via LLM.
 * @param {string} timetableText
 * @param {object} groupProfile
 * @param {object[]} recentMornings
 * @param {boolean} isHolidayOrSunday
 * @returns {Promise<string>}
 */
async function generateMorningLine(timetableText, groupProfile, recentMornings, isHolidayOrSunday) {
  const fallbackLine = pickMorningFallbackLine(recentMornings);
  try {
    const recentLines = recentMornings.map(m => m.text).join('\n');
    const systemPrompt = buildSystemPrompt({
      toneMode: 'savage',
      memoryPack: { groupProfile, memories: [] },
      classContext: { timetableToday: timetableText },
      isGroup: true,
    });

    // The schedule is formatted by code and never delegated to the model.
    // Ask for exactly one line so a model response cannot duplicate/change facts.
    const userMsg = isHolidayOrSunday
      ? `Write exactly ONE short, fresh, witty/deep savage morning line for a college group. It is a Sunday or holiday; do not invent events or mention a timetable. No heading, no list. Avoid these recent messages:\n${recentLines}`
      : `Write exactly ONE short, fresh, witty and slightly deep savage line to append under an already-formatted timetable. Do NOT repeat, rewrite, summarize, or output any timetable/date/class/room/faculty. No heading, no list. Context only (never repeat it):\n${timetableText}\n\nAvoid repeating these recent messages:\n${recentLines}`;

    const result = await generateReply(systemPrompt, [], userMsg);
    const raw = (result.reply_parts || []).join('\n');
    const line = extractSavageLine(raw, timetableText);
    if (line) return composeMorningMessage(timetableText, line, isHolidayOrSunday);
  } catch (err) {
    log.warn({ err }, 'LLM morning line failed; using unique fallback line');
  }
  return composeMorningMessage(timetableText, fallbackLine, isHolidayOrSunday);
}
