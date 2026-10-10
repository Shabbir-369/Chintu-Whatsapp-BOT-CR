/**
 * src/scheduler/jobs.js
 * Job execution: process due jobs from the jobs table. §16.
 */
import { getDueJobs, markJobDone, markJobFailed, retryJob } from '../db/repos/timetable.js';
import { humanSend } from '../gateway/outbox.js';
import { getLogger } from '../logger.js';
import { isValidSelfReminderPayload } from '../util/reminderPolicy.js';

const log = getLogger('scheduler/jobs');
let processingDueJobs = false;

/**
 * Process all due jobs.
 */
export async function processDueJobs() {
  if (processingDueJobs) return;
  processingDueJobs = true;
  let jobs;
  try {
    jobs = await getDueJobs();
  } catch (err) {
    log.error({ err: err?.message }, 'Failed to fetch due jobs');
    processingDueJobs = false;
    return;
  }

  try {
  for (const job of jobs) {
    try {
      await executeJob(job);
      await markJobDone(job.id);
    } catch (err) {
      log.error({ err: err?.message, jobId: job.id, kind: job.kind }, 'Job execution failed');
      if (Number(job.attempts || 0) < 2) {
        try {
          await retryJob(job.id, 30 * (Number(job.attempts || 0) + 1));
        } catch (retryErr) {
          log.error({ err: retryErr?.message, jobId: job.id }, 'Job retry scheduling failed');
          await markJobFailed(job.id).catch(() => {});
        }
      } else {
        await markJobFailed(job.id);
      }
    }
  }
  } finally {
    processingDueJobs = false;
  }
}

async function executeJob(job) {
  log.info({ kind: job.kind, jobId: job.id }, 'Executing job');

  switch (job.kind) {
    case 'send_ordered': {
      const { targetJid, message } = job.payload;
      if (!targetJid || !message) throw new Error('Missing targetJid or message');
      const sent = await humanSend(targetJid, message, { priority: true });
      if (!sent?.key?.id) throw new Error('WhatsApp send did not confirm delivery');
      break;
    }

    case 'self_reminder': {
      const payload = job.payload || {};
      // Defence in depth: a self-reminder may only ever reach the requester in a private DM.
      if (!isValidSelfReminderPayload(payload)) throw new Error('Rejected invalid self-reminder recipient');
      const sent = await humanSend(payload.targetJid, `⏰ *Reminder*\n${payload.message}`, { priority: true });
      if (!sent?.key?.id) throw new Error('WhatsApp reminder send did not confirm delivery');
      break;
    }

    case 'pod_feed_poll': {
      const { pollPodNotices } = await import('../skills/pod/notices.js');
      const { config } = await import('../config.js');
      const { getOwnerChatJid } = await import('../router/router.js');

      const ownerJid = getOwnerChatJid();
      if (!ownerJid) break;

      // Get owner's personId
      const { findPersonByJid } = await import('../db/repos/people.js');
      const ownerPerson = await findPersonByJid(ownerJid.replace('@s.whatsapp.net', '') + '@s.whatsapp.net').catch(() => null);

      let pollPersonId = null;
      if (config.POD_FEED_USE_OWNER_LINK && ownerPerson) {
        const { hasPodAccount } = await import('../db/repos/pod.js');
        if (await hasPodAccount(ownerPerson.id)) {
          pollPersonId = ownerPerson.id;
        }
      }

      if (!pollPersonId) break;

      const newNotices = await pollPodNotices(pollPersonId, false);
      for (const notice of newNotices) {
        await humanSend(ownerJid, `*Pod notice:* ${notice.text.slice(0, 200)}`, { priority: true });
      }
      break;
    }

    default:
      throw new Error(`Unknown job kind: ${job.kind}`);
  }
}
