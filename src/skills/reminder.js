/**
 * Shared, permission-safe reminder helpers.
 * Non-owner reminders are always bound to the requester's own private DM.
 */
import { createJob } from '../db/repos/timetable.js';
import { formatScheduledIST } from '../util/scheduleTime.js';
import { isValidSelfReminderPayload } from '../util/reminderPolicy.js';
export { isValidSelfReminderPayload } from '../util/reminderPolicy.js';

const pendingDrafts = new Map();
const DRAFT_TTL_MS = 15 * 60 * 1000;

export function isSelfTargetName(value) {
  return /^(?:me|myself|mujhe|mujhko|khud|khud ko|mere liye|myself)$/i.test(String(value || '').trim());
}

export function setPendingReminderDraft(key, draft) {
  if (!key || !draft || typeof draft !== 'object') return;
  pendingDrafts.set(key, { ...draft, updatedAt: Date.now() });
}

export function getPendingReminderDraft(key) {
  const draft = pendingDrafts.get(key);
  if (!draft) return null;
  if (Date.now() - Number(draft.updatedAt || 0) > DRAFT_TTL_MS) {
    pendingDrafts.delete(key);
    return null;
  }
  return draft;
}

export function clearPendingReminderDraft(key) {
  pendingDrafts.delete(key);
}

/**
 * Persist a private reminder whose only possible recipient is its requester.
 * Group JIDs and mismatched requester/recipient JIDs are rejected here and again
 * by the scheduler at execution time.
 */
export async function scheduleSelfReminder({ requesterJid, requesterPersonId = null, message, runAt }) {
  const body = String(message || '').trim();
  if (!requesterJid || requesterJid.endsWith('@g.us') || requesterJid.includes('@broadcast')) {
    return { ok: false, reply: 'reminder sirf private DM mein set kar sakta hoon' };
  }
  if (!body) return { ok: false, missing: 'message', reply: 'kis baat ka reminder chahiye?' };
  const scheduledAt = runAt instanceof Date ? runAt : new Date(runAt);
  if (!Number.isFinite(scheduledAt.getTime()) || scheduledAt <= new Date()) {
    return { ok: false, missing: 'time', reply: 'kab yaad dilau? future ka time bata, jaise kal subah 8 baje' };
  }

  const payload = {
    targetJid: requesterJid,
    requesterJid,
    requesterPersonId,
    message: body,
    selfOnly: true,
  };
  const job = await createJob({ kind: 'self_reminder', runAt: scheduledAt, payload });
  return {
    ok: true,
    jobId: job.id,
    reply: `✅ yaad rakh liya — ${formatScheduledIST(scheduledAt)} pe isi DM mein yaad dilaunga.`,
  };
}

