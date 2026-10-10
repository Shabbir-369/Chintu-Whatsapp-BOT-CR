/**
 * src/skills/starter.js
 * Conversation initiators for enabled groups. §11.9.
 */
import { getEnabledGroups, getGroupProfile, touchGroupBotAt } from '../db/repos/groups.js';
import { isChatQuiet, getAliveStats } from '../db/repos/messages.js';
import { getDailyEventCount, recordDailyEvent, getCalendarEventsForDateRange } from '../db/repos/timetable.js';
import { generateReply } from '../brain/llm.js';
import { buildSystemPrompt } from '../brain/persona.js';
import { humanSend } from '../gateway/outbox.js';
import { toISTDateString, getISTHour, jitter, sleep } from '../util/time.js';
import { config } from '../config.js';
import { getLogger } from '../logger.js';
import { getDailyStarterWindows, isStarterWindowDue, isNearConfiguredTime } from '../util/starterPlan.js';
import { canStartConversationInMode } from '../util/schedulerPlan.js';

const log = getLogger('skills/starter');

// Ignore streak tracking
const ignoreStreaks = new Map(); // groupJid -> count
const pendingStarterReplies = new Map(); // groupJid -> send timestamp
const REPLY_WINDOW_MS = 30 * 60 * 1000;
let starterRunInProgress = false;

/**
 * Attempt to start a conversation in eligible groups.
 * @param {boolean} [force=false] - If true, bypass time/alive checks (owner manual trigger)
 */
export async function tryConversationStarters(force = false) {
  if (!config.STARTERS_ENABLED && !force) return;
  if (starterRunInProgress) return; // scheduler ticks must never duplicate a starter run

  const now = new Date();
  settleExpiredStarterReplies(now.getTime());
  const hour = getISTHour(now);

  // Only between 12:00 and 22:00 IST (unless forced by owner)
  if (!force && (hour < 12 || hour >= 22)) return;

  starterRunInProgress = true;
  try {
    const today = toISTDateString(now);
    const groups = await getEnabledGroups();

    for (const group of groups) {
      try {
        await tryStarterForGroup(group, today, now, force);
      } catch (err) {
        log.error({ err, groupJid: group.jid }, 'Starter failed');
      }
    }
  } finally {
    starterRunInProgress = false;
  }
}

async function tryStarterForGroup(group, today, now, force = false) {
  // Unsolicited starters belong to ambient groups only. A manual owner force
  // may explicitly request one in another enabled mode.
  if (!canStartConversationInMode(group, force)) return;

  // Check daily plan (max 2 starters per day)
  const startedToday = await getDailyEventCount(today, group.jid, 'starter');
  const maxStarters = config.STARTERS_PER_DAY;
  const plannedWindows = getDailyStarterWindows(today, group.jid);
  const plannedWindowDue = !force && isStarterWindowDue(now, plannedWindows);

  // Reduce to 1 if ignore streak >= 3
  const streak = ignoreStreaks.get(group.jid) || 0;
  const effectiveMax = streak >= 3 ? 1 : maxStarters;

  if (startedToday >= effectiveMax) return;

  let specialOccasion = false;
  if (!force) {
    // Never start within 30 minutes before/after the configured morning message.
    // The helper explicitly formats the current time in IST, so it has no hidden `hour` scope.
    if (isNearConfiguredTime(now, String(config.MORNING_TIME || '07:45'), 30)) return;

    // Group must be alive (5 msgs, 2 people in last 3 hours) unless a special occasion.
    const stats = await getAliveStats(group.jid, 3);
    const isAlive = Number(stats?.msg_count || 0) >= 5 && Number(stats?.person_count || 0) >= 2;

    // Check today's and tomorrow's academic events (e.g. exam tomorrow, holiday).
    const dateStr = toISTDateString(now);
    const tomorrow = toISTDateString(new Date(now.getTime() + 86400000));
    const events = await getCalendarEventsForDateRange(dateStr, tomorrow).catch(() => []);
    specialOccasion = events.some(e => ['exam', 'holiday'].includes(e.type) || /result/i.test(e.name || ''));

    if (!isAlive && !specialOccasion) return;

    // Bot hasn't spoken in last 45 min
    const lastBotAt = group.last_bot_at ? new Date(group.last_bot_at) : null;
    if (lastBotAt && Date.now() - lastBotAt.getTime() < 45 * 60 * 1000) return;

    // Either the group has been quiet for 25+ minutes or this is its planned window.
    // Planned times let an otherwise active group get a starter at a natural interval.
    const quiet = await isChatQuiet(group.jid, 25);
    if (!quiet && !plannedWindowDue) return;
  }

  // Generate a starter
  const starter = await generateStarter(group, specialOccasion);
  if (!starter) return;

  const sent = await humanSend(group.jid, starter);
  if (!sent?.key?.id) {
    log.warn({ groupJid: group.jid }, 'Conversation starter was not confirmed; it will remain eligible for retry');
    return;
  }
  await recordDailyEvent(today, group.jid, 'starter');
  pendingStarterReplies.set(group.jid, Date.now());
  await touchGroupBotAt(group.jid);

  log.info({ groupJid: group.jid, forced: force }, 'Conversation starter sent');
}

async function generateStarter(group, specialOccasion) {
  try {
    const groupProfile = await getGroupProfile(group.jid);
    const systemPrompt = buildSystemPrompt({
      toneMode: 'playful',
      memoryPack: { groupProfile, memories: [] },
      isGroup: true,
    });

    const topics = [
      'a funny, low-stakes hot take about music, movies, memes, or internet culture',
      'canteen food, weekend plans, or the most overrated thing on campus',
      'a playful would-you-rather about college life, friendships, or everyday habits',
      'a short savage observation about a relatable student habit, without making up facts about members',
      'a harmless debate starter about tech, placements, phones, games, or pop culture',
      'a light, non-invasive question about weekend plans or comfort food',
      'a fresh callback to a group running joke only if the group memory clearly supports it',
      'college chaos or class timing only if it is relevant today; do not default to attendance',
    ];
    if (specialOccasion) topics.unshift('upcoming academic event, exam, holiday, or result day; mention it casually only when relevant');

    const topic = topics[Math.floor(Math.random() * topics.length)];
    const result = await generateReply(
      systemPrompt,
      [],
      `Start a group conversation. Topic hint: ${topic}. Keep it to 1-2 short lines. Natural, not forced.`
    );

    const parts = result.reply_parts || [];
    return parts[0] || null;
  } catch (err) {
    log.warn({ err }, 'Starter generation failed');
    return null;
  }
}

/**
 * Record that a starter was ignored (no response in 30 min).
 */
export function recordStarterIgnored(groupJid) {
  const current = ignoreStreaks.get(groupJid) || 0;
  ignoreStreaks.set(groupJid, current + 1);
}

/** Track a real group message as a response when it arrives within 30 minutes. */
export function recordStarterActivity(groupJid, at = Date.now()) {
  const sentAt = pendingStarterReplies.get(groupJid);
  if (sentAt == null) return false;
  pendingStarterReplies.delete(groupJid);
  if (at - sentAt <= REPLY_WINDOW_MS) {
    resetStarterStreak(groupJid);
    return true;
  }
  recordStarterIgnored(groupJid);
  return false;
}

function settleExpiredStarterReplies(now = Date.now()) {
  for (const [groupJid, sentAt] of pendingStarterReplies) {
    if (now - sentAt >= REPLY_WINDOW_MS) {
      pendingStarterReplies.delete(groupJid);
      recordStarterIgnored(groupJid);
    }
  }
}

/** Reset ignore streak after the group responds to a starter. */
export function resetStarterStreak(groupJid) {
  ignoreStreaks.set(groupJid, 0);
}
