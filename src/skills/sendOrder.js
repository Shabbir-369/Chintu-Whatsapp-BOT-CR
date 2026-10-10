/**
 * src/skills/sendOrder.js
 * Owner-ordered messaging. §11.5.
 * Compose and send messages on behalf of the owner.
 */
import { createJob } from '../db/repos/timetable.js';
import { findPeopleByName } from '../db/repos/people.js';
import { getAllGroups } from '../db/repos/groups.js';
import { fuzzyMatch } from '../util/fuzzy.js';
import { getLogger } from '../logger.js';

const log = getLogger('skills/sendOrder');

// First-contact DM cap tracking
let firstContactCount = 0;
let firstContactDate = new Date().toDateString();

function resetFirstContactIfNewDay() {
  const today = new Date().toDateString();
  if (today !== firstContactDate) {
    firstContactCount = 0;
    firstContactDate = today;
  }
}

/**
 * Schedule or send an ordered message.
 * @param {object} opts
 * @param {string} opts.targetName – person name, group name, or JID
 * @param {string} opts.message – message content
 * @param {Date|null} opts.runAt – schedule time or null for immediate
 * @param {boolean} opts.verbatim – send exactly as-is
 * @returns {Promise<{ ok: boolean, reply: string, jobId?: string }>}
 */
export async function scheduleOrderedMessage({ targetName, targetJid, message, runAt, verbatim }) {
  const target = targetJid || targetName;

  const payload = { targetJid: target, message, verbatim: !!verbatim, isOwnerOrder: true };

  if (runAt !== null && runAt !== undefined) {
    const scheduledAt = runAt instanceof Date ? runAt : new Date(runAt);
    if (Number.isNaN(scheduledAt.getTime())) {
      return { ok: false, reply: 'time samajh nahi aaya — date aur time dobara bata' };
    }
    if (scheduledAt <= new Date()) {
      return { ok: false, reply: 'ye time nikal chuka hai — future ka time bata' };
    }
    const job = await createJob({ kind: 'send_ordered', runAt: scheduledAt, payload });
    const when = scheduledAt.toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
    log.info({ jobId: job.id, runAt: scheduledAt.toISOString() }, 'Scheduled owner-ordered message');
    return { ok: true, reply: `done, ${when} IST pe bhejunga`, jobId: job.id };
  }

  return { ok: true, reply: 'bhejne ki koshish karunga', payload };
}

/**
 * Resolve a target name to a person or group.
 * @param {string} name
 * @param {object[]} people
 * @param {object[]} groups
 * @returns {{ match: object|null, ambiguous: boolean, candidates: object[], type: 'person'|'group'|null }}
 */
export function resolveTarget(name, people, groups) {
  // Try people first
  const peopleResult = fuzzyMatch(name, people.map(p => ({ ...p, name: p.display_name || p.push_name || '' })));
  if (peopleResult.match) return { ...peopleResult, type: 'person' };

  // Try groups
  const groupResult = fuzzyMatch(name, groups.map(g => ({ ...g, name: g.subject || '' })));
  if (groupResult.match) return { ...groupResult, type: 'group' };

  if (peopleResult.ambiguous) return { ...peopleResult, type: 'person' };
  if (groupResult.ambiguous) return { ...groupResult, type: 'group' };

  return { match: null, ambiguous: false, candidates: [...peopleResult.candidates, ...groupResult.candidates], type: null };
}

/**
 * Check first-contact DM cap.
 * @returns {boolean} true = can send
 */
export function canSendFirstContact() {
  resetFirstContactIfNewDay();
  return firstContactCount < 10;
}

export function recordFirstContact() {
  resetFirstContactIfNewDay();
  firstContactCount++;
}
