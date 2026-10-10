/**
 * src/scheduler/tick.js
 * Scheduler tick every 30 seconds. §16.
 * Runs: morning messages, conversation starters, Pod feed, nightly memory, cleanup.
 */
import { processDueJobs } from './jobs.js';
import { sendMorningMessages } from '../skills/morning.js';
import { tryConversationStarters } from '../skills/starter.js';
import { runNightlyMemory } from '../brain/memory.js';
import { expireOldApprovals } from '../db/repos/approvals.js';
import { deleteOldMessages } from '../db/repos/messages.js';
import { cleanOldJobs, cleanOldMassBunkResults, createJob, getDailyEventCount } from '../db/repos/timetable.js';
import { toISTDateString, getISTHour, isQuietHours } from '../util/time.js';
import { config } from '../config.js';
import { getLogger } from '../logger.js';

const log = getLogger('scheduler/tick');

let morningScheduled = false;
let tickRunning = false;
let lastMorningDate = '';
let lastNightlyDate = '';
let lastPodFeedPoll = 0;
let lastHealthLog = 0;
let tickCount = 0;

const POD_FEED_INTERVAL_MS = config.POD_FEED_POLL_MINUTES * 60 * 1000;
const HEALTH_LOG_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Start the scheduler. Runs a tick every 30 seconds.
 */
export function startScheduler() {
  log.info('Scheduler started');
  setInterval(tick, 30000);
  tick(); // run immediately
}

async function tick() {
  if (tickRunning) return;
  tickRunning = true;
  tickCount++;
  const now = new Date();
  const today = toISTDateString(now);
  const hour = getISTHour(now);
  const minute = parseInt(now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', minute: '2-digit' }));

  try {
    // ── Morning message check ─────────────────────────────────────────
    const [mh, mm] = config.MORNING_TIME.split(':').map(Number);
    if (hour === mh && minute >= mm && minute <= mm + 15 && lastMorningDate !== today) {
      lastMorningDate = today;
      sendMorningMessages().catch(err => log.error({ err }, 'Morning messages failed'));
    }

    // ── Process due jobs ──────────────────────────────────────────────
    await processDueJobs();

    // ── Conversation starters (every 5 ticks = ~2.5 min) ─────────────
    if (tickCount % 5 === 0) {
      tryConversationStarters().catch(err => log.warn({ err }, 'Starters failed'));
    }

    // ── Pod feed poll ─────────────────────────────────────────────────
    if (Date.now() - lastPodFeedPoll > POD_FEED_INTERVAL_MS) {
      lastPodFeedPoll = Date.now();
      schedulePodFeedPoll();
    }

    // ── Nightly tasks (03:00 IST) ─────────────────────────────────────
    if (hour === 3 && minute <= 1 && lastNightlyDate !== today) {
      lastNightlyDate = today;
      runNightlyTasks().catch(err => log.error({ err }, 'Nightly tasks failed'));
    }

    // ── Health log (every 5 min) ──────────────────────────────────────
    if (Date.now() - lastHealthLog > HEALTH_LOG_INTERVAL_MS) {
      lastHealthLog = Date.now();
      logHealth();
    }

  } catch (err) {
    log.error({ err: err?.message }, 'Scheduler tick error');
  } finally {
    tickRunning = false;
  }
}

async function runNightlyTasks() {
  log.info('Running nightly tasks...');
  await runNightlyMemory();
  await expireOldApprovals();
  await deleteOldMessages(config.MESSAGE_RETENTION_DAYS);
  await cleanOldJobs();
  await cleanOldMassBunkResults();
  log.info('Nightly tasks complete');
}

function schedulePodFeedPoll() {
  createJob({
    kind: 'pod_feed_poll',
    runAt: new Date(),
    payload: {},
  }).catch(err => log.warn({ err }, 'Failed to schedule Pod feed poll'));
}

async function logHealth() {
  try {
    const { getUsageToday } = await import('../db/repos/timetable.js');
    const { getSocketState } = await import('../gateway/socket.js');
    const aiCalls = await getUsageToday('ai_calls');
    const state = getSocketState();
    log.info({ aiCalls, connected: state.connected }, 'Health check');
  } catch {}
}
