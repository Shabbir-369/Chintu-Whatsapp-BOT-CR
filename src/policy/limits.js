/**
 * src/policy/limits.js
 * Rate limiting: per-user cooldown, group hourly cap, flood detection.
 * All in-memory (resets on restart). Per §7.5 and §8.5.
 */
import { config } from '../config.js';

// Map: chatJid+personId -> last reply timestamp
const lastReplyTime = new Map();
// Map: groupJid -> { hour: number, count: number }
const hourlyGroupCount = new Map();
// Map: personId -> { until: timestamp } (flood penalty)
const floodPenalty = new Map();
// Map: chatJid+personId -> { count, firstAt }
const floodWindow = new Map();
// Map: personId -> { chatJid -> count } (per-person fairness)
const personReplyCount = new Map();

/**
 * Check if the user is in cooldown.
 * @param {string} personId
 * @param {string} chatJid
 * @param {boolean} isGroup
 * @returns {boolean} true = on cooldown (should not reply)
 */
export function isOnCooldown(personId, chatJid, isGroup) {
  const key = `${chatJid}:${personId}`;
  const lastTime = lastReplyTime.get(key) || 0;
  const cooldown = isGroup ? config.USER_COOLDOWN_MS_GROUP : config.USER_COOLDOWN_MS_DM;
  return Date.now() - lastTime < cooldown;
}

/**
 * Record that we replied to this person in this chat.
 */
export function recordReply(personId, chatJid) {
  const key = `${chatJid}:${personId}`;
  lastReplyTime.set(key, Date.now());

  // Per-person fairness counter (reset every minute)
  if (!personReplyCount.has(personId)) {
    personReplyCount.set(personId, { count: 0, resetAt: Date.now() + 60000 });
  }
  const pr = personReplyCount.get(personId);
  if (Date.now() > pr.resetAt) {
    pr.count = 0;
    pr.resetAt = Date.now() + 60000;
  }
  pr.count++;
}

/**
 * Check per-person fairness: max 5 replies/minute to same person (unless direct trigger).
 */
export function exceedsPersonFairness(personId) {
  const pr = personReplyCount.get(personId);
  if (!pr) return false;
  if (Date.now() > pr.resetAt) return false;
  return pr.count >= 5;
}

/**
 * Check if group has exceeded hourly cap.
 */
export function isGroupOverCap(groupJid) {
  const now = Date.now();
  const hour = Math.floor(now / 3600000);
  const entry = hourlyGroupCount.get(groupJid);
  if (!entry || entry.hour !== hour) return false;
  return entry.count >= config.GROUP_HOURLY_CAP;
}

/**
 * Record a group reply.
 */
export function recordGroupReply(groupJid) {
  const now = Date.now();
  const hour = Math.floor(now / 3600000);
  const entry = hourlyGroupCount.get(groupJid);
  if (!entry || entry.hour !== hour) {
    hourlyGroupCount.set(groupJid, { hour, count: 1 });
  } else {
    entry.count++;
  }
}

/**
 * Check and update flood detection.
 * Returns true if person should be penalised (8 msgs in 20s).
 */
export function checkFlood(personId, chatJid) {
  // Check existing penalty
  const penalty = floodPenalty.get(personId);
  if (penalty && penalty.until > Date.now()) return true;

  const key = `${chatJid}:${personId}:flood`;
  const now = Date.now();
  const fw = floodWindow.get(key);
  if (!fw) {
    floodWindow.set(key, { count: 1, firstAt: now });
    return false;
  }
  if (now - fw.firstAt > 20000) {
    floodWindow.set(key, { count: 1, firstAt: now });
    return false;
  }
  fw.count++;
  if (fw.count > 8) {
    floodPenalty.set(personId, { until: now + 120000 });
    return true;
  }
  return false;
}

/**
 * Reset flood penalty for a person.
 */
export function clearFloodPenalty(personId) {
  floodPenalty.delete(personId);
}

/**
 * Check if person is under flood penalty.
 */
export function isFloodPenalised(personId) {
  const penalty = floodPenalty.get(personId);
  return penalty && penalty.until > Date.now();
}
