/**
 * src/gateway/outbox.js
 * Human-like sending pipeline. §8.2, §8.3, §8.4.
 *
 * humanSend(chatId, text, opts) implements all 10 steps of §8.2:
 *  1. Budget check
 *  2. Minimum gap (1800ms groups, 1100ms DMs)
 *  3. Seen (mark read, with optional extra delay for low-priority group msgs)
 *  4. Think pause (rand 550–1800ms)
 *  5. Typing presence (scaled to text length)
 *  6. Pause presence
 *  7. Send (with quote on first part; retry without quote on failure)
 *  8. Part gap (rand 850–1600ms for second part)
 *  9. Bookkeeping
 * 10. Idle presence after 60–180s of inactivity
 */
import { sendWAMessage, sendWAReaction, sendWAPresence, markRead } from './socket.js';
import { saveMessage } from '../db/repos/messages.js';
import { config } from '../config.js';
import { getLogger } from '../logger.js';
import { sleep, jitter } from '../util/time.js';

const log = getLogger('gateway/outbox');

// ─── Global rate limiter (token bucket) §8.4 ─────────────────────
let tokensAvailable = config.GLOBAL_PER_MINUTE;
let lastRefill = Date.now();

function consumeToken(skipWait = false) {
  const now = Date.now();
  const elapsed = (now - lastRefill) / 60000; // minutes
  tokensAvailable = Math.min(config.GLOBAL_PER_MINUTE, tokensAvailable + elapsed * config.GLOBAL_PER_MINUTE);
  lastRefill = now;
  if (tokensAvailable < 1) return false;
  tokensAvailable--;
  return true;
}

// ─── Per-chat last send time (for minimum gap §8.2 step 2) ────────
const lastSentAt = new Map(); // chatJid → timestamp

// ─── Last activity tracker (for idle presence §8.2 step 10) ───────
const lastActivityAt = new Map(); // chatJid → timestamp
const idleTimers = new Map();     // chatJid → timeout

// ─── Priority queue ───────────────────────────────────────────────
const priorityQueue = [];
const normalQueue = [];
let sending = false;

async function processQueues() {
  if (sending) return;
  const queue = priorityQueue.length > 0 ? priorityQueue : normalQueue;
  if (queue.length === 0) return;

  if (!consumeToken()) {
    setTimeout(processQueues, 2000);
    return;
  }

  sending = true;
  const item = queue.shift();
  try {
    const result = await item.fn();
    item.resolve?.(result);
  } catch (err) {
    log.error({ err }, 'Error sending message');
    item.resolve?.(null);
  } finally {
    sending = false;
    // Small gap between consecutive sends
    setTimeout(processQueues, 600 + jitter(400));
  }
}

function scheduleIdle(chatJid) {
  // Clear existing idle timer
  if (idleTimers.has(chatJid)) clearTimeout(idleTimers.get(chatJid));

  // After 60–180s of no activity, send "unavailable" presence (§8.2 step 10)
  const delay = 60000 + Math.random() * 120000;
  const t = setTimeout(async () => {
    idleTimers.delete(chatJid);
    try {
      await sendWAPresence(chatJid, 'unavailable').catch(() => {});
    } catch {}
  }, delay);
  idleTimers.set(chatJid, t);
}

/**
 * Human-like send. Implements all 10 steps of §8.2.
 * @param {string} chatJid
 * @param {string} text
 * @param {object} [opts]
 * @param {object} [opts.quoted] – message to quote (first part only)
 * @param {object} [opts.sourceMessage] – raw incoming message (for marking read)
 * @param {boolean} [opts.priority] – owner priority (skips normal queue)
 * @param {boolean} [opts.isGroup] – affects minimum gap
 */
export async function humanSend(chatJid, text, opts = {}) {
  const { quoted, sourceMessage, priority = false, isGroup = chatJid.endsWith('@g.us') } = opts;

  const fn = async () => {
    try {
      let lastSent = null;
      // Step 2: Minimum gap
      const minGap = isGroup ? 1800 : 1100;
      const last = lastSentAt.get(chatJid) || 0;
      const sinceLast = Date.now() - last;
      if (sinceLast < minGap) {
        await sleep(minGap - sinceLast);
      }

      // Step 3: Mark source as read (blue ticks)
      if (sourceMessage?.key) {
        const isLowPriority = isGroup && !priority;
        if (isLowPriority && Math.random() < 0.25) {
          // 25% chance: extra 2–20s delay before "seen" (§8.2)
          await sleep(2000 + Math.random() * 18000);
        }
        await markRead([sourceMessage.key]);
      }

      // Split text into 1–2 parts
      const parts = splitIntoParts(text);

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];

        // Step 4: Think pause (rand(max(550, 900-350), 900+900) = 550–1800ms §8.2)
        const thinkMs = 550 + Math.random() * (1800 - 550);
        await sleep(thinkMs);

        // Step 5: Typing indicator (scaled to text length)
        await sendWAPresence(chatJid, 'composing').catch(() => {});
        const typingMs = Math.max(
          config.HUMAN_MIN_TYPING_MS,
          Math.min(
            config.HUMAN_MAX_TYPING_MS,
            2200 + part.length * 20 + jitter(900)
          )
        );
        await sleep(typingMs);

        // Step 6: Pause presence
        await sendWAPresence(chatJid, 'paused').catch(() => {});

        // Step 7: Send
        const msgOpts = {};
        if (i === 0 && quoted) msgOpts.quoted = quoted;

        let sent;
        try {
          sent = await sendWAMessage(chatJid, { text: part }, msgOpts);
        } catch (sendErr) {
          // Retry once without quote if quoted send fails (§8.2 step 7)
          if (msgOpts.quoted) {
            log.warn({ err: sendErr }, 'Quoted send failed, retrying without quote');
            sent = await sendWAMessage(chatJid, { text: part }, {});
          } else {
            throw sendErr;
          }
        }
        lastSent = sent;

        // Step 9: Bookkeeping
        lastSentAt.set(chatJid, Date.now());
        lastActivityAt.set(chatJid, Date.now());

        if (sent?.key?.id) {
          await saveMessage({
            waId: sent.key.id,
            chatJid,
            senderPersonId: null,
            fromBot: true,
            text: part,
            kind: 'text',
            sentAt: new Date(),
          }).catch(() => {});
        }

        log.info({ chatJid: chatJid.slice(0, 12), len: part.length, part: i + 1 }, 'Sent');

        // Step 8: Part gap before second part (rand 850–1600ms §8.2)
        if (i < parts.length - 1) {
          await sleep(850 + Math.random() * 750);
        }
      }

      // Step 10: Schedule idle presence
      scheduleIdle(chatJid);
      return lastSent;

    } catch (err) {
      log.error({ err, chatJid: chatJid.slice(0, 12) }, 'humanSend failed');
      return null;
    }
  };

  // Step 1: Budget check (§8.2 step 1) — enforcement is in the token bucket
  // Owner-priority sends skip the normal queue but not the human pipeline (§8.4)
  return new Promise((resolve) => {
    if (priority) {
      priorityQueue.push({ fn, resolve });
    } else {
      normalQueue.push({ fn, resolve });
    }
    setTimeout(processQueues, 0);
  });
}

/**
 * Send a reaction (§8.3). No typing indicator, 1–6s random delay.
 * Emoji chosen from message sentiment.
 */
export async function sendReaction(chatJid, emoji, messageKey) {
  const fn = async () => {
    const delay = 1000 + Math.random() * 5000; // 1–6s §8.3
    await sleep(delay);
    await sendWAReaction(chatJid, emoji, messageKey);
    log.info({ chatJid: chatJid.slice(0, 12), emoji }, 'Sent reaction');
  };
  normalQueue.push({ fn });
  setTimeout(processQueues, 0);
}

/**
 * Split text into at most 2 parts (§8.2).
 * Only splits if HUMAN_SPLIT_CHANCE applies and text has a natural break.
 */
function splitIntoParts(text) {
  if (!text) return [''];
  const t = text.trim();
  if (t.length <= 60) return [t];

  if (Math.random() < config.HUMAN_SPLIT_CHANCE) {
    const breakPoints = ['\n', '. ', '! ', '? '];
    const mid = Math.floor(t.length * 0.45);
    for (const bp of breakPoints) {
      const idx = t.indexOf(bp, mid - 20);
      if (idx > 0 && idx < t.length - 10) {
        const p1 = t.slice(0, idx + 1).trim();
        const p2 = t.slice(idx + bp.length - 1).trim();
        if (p1 && p2) return [p1, p2];
      }
    }
  }
  return [t];
}

/**
 * Pick a reaction emoji based on message sentiment (§8.3).
 * @param {string} text
 * @returns {string}
 */
export function pickReactionEmoji(text) {
  if (!text) return '💀';
  const t = text.toLowerCase();
  if (/lol|lmao|haha|😂|funny|hehe/.test(t)) return '😂';
  if (/wtf|kya yaar|seriously|bhai re/.test(t)) return Math.random() > 0.5 ? '💀' : '😭';
  if (/\b(ok|haan|yes|agreed|sahi hai|bilkul)\b/.test(t)) return Math.random() > 0.5 ? '🤝' : '😮‍💨';
  if (/😢|💔|bura lag/.test(t)) return '😭';
  const pool = ['💀', '😭', '😂', '👀', '🤨'];
  return pool[Math.floor(Math.random() * pool.length)];
}
