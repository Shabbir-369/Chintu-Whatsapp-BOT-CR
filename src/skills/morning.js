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

const log = getLogger('skills/morning');

/**
 * Send morning message to all eligible groups.
 */
export async function sendMorningMessages() {
  const now = new Date();
  const today = toISTDateString(now);
  const weekday = getISTWeekday(now);

  const groups = await getEnabledGroups();

  for (const group of groups) {
    try {
      await sendMorningToGroup(group, today, weekday, now);
    } catch (err) {
      log.error({ err, groupJid: group.jid }, 'Morning message failed for group');
    }
  }
}

/**
 * Send morning message to a specific group.
 */
async function sendMorningToGroup(group, today, weekday, now) {
  // Check if already sent today
  const count = await getDailyEventCount(today, group.jid, 'morning');
  if (count > 0) {
    log.info({ groupJid: group.jid }, 'Morning message already sent today');
    return;
  }

  // Also check last_morning_date
  if (group.last_morning_date === today) return;

  // Random jitter: 0-12 minutes so not all groups get it at the same time
  const jitterMs = jitter(12 * 60 * 1000);
  await sleep(jitterMs);

  // Assemble facts
  const dayData = await getDayTimetable(now, group.jid);
  const timetableText = formatTimetable(dayData);

  // Get group profile and recent morning messages
  const [groupProfile, recentMornings] = await Promise.all([
    getGroupProfile(group.jid),
    getLastMorningMessages(group.jid),
  ]);

  // Sunday / holiday: just a short line, no timetable
  if (weekday === 0 || dayData.holiday) {
    const msg = await generateMorningLine(timetableText, groupProfile, recentMornings, true);
    await humanSend(group.jid, msg);
    await recordDailyEvent(today, group.jid, 'morning');
    await setLastMorningDate(group.jid, today);
    return;
  }

  // Build LLM prompt for Chintu voice
  const fullMsg = await generateMorningLine(timetableText, groupProfile, recentMornings, false);
  await humanSend(group.jid, fullMsg);
  await recordDailyEvent(today, group.jid, 'morning');
  await setLastMorningDate(group.jid, today);
  log.info({ groupJid: group.jid }, 'Morning message sent');
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
  try {
    const recentLines = recentMornings.map(m => m.text).join('\n');
    const systemPrompt = buildSystemPrompt({
      toneMode: 'savage',
      memoryPack: { groupProfile, memories: [] },
      classContext: { timetableToday: timetableText },
      isGroup: true,
    });

    const userMsg = isHolidayOrSunday
      ? 'Write a short 1-line morning message for the group. It is a holiday or Sunday. No timetable. Be funny/savage. Different from these recent ones:\n' + recentLines
      : `Write the morning timetable message. Include the timetable block below EXACTLY as given (never change times/rooms/faculty), then add one savage/funny line. Be different from recent:\n${recentLines}\n\nTIMETABLE:\n${timetableText}`;

    const result = await generateReply(systemPrompt, [], userMsg);
    const parts = result.reply_parts || [];
    if (parts.length > 0) {
      // For morning messages, combine the timetable block + LLM savage line
      if (!isHolidayOrSunday) {
        return `${timetableText}\n\n${parts[0]}`;
      }
      return parts[0];
    }
  } catch (err) {
    log.warn({ err }, 'LLM morning message failed, using timetable only');
  }

  // Fallback: just the timetable
  if (isHolidayOrSunday) return 'chhutti hai aaj. enjoy 🎉';
  return timetableText;
}
