/**
 * src/skills/pod/notices.js
 * Pod feed/notices polling. §12.7.
 */
import { getNotifications } from './client.js';
import { saveNotice, isNoticeKnown, getRecentNotices } from '../../db/repos/timetable.js';
import { config } from '../../config.js';
import { getLogger } from '../../logger.js';

const log = getLogger('skills/pod/notices');

/**
 * Poll Pod notifications and return new ones.
 * @param {string} personId – the designated account for polling
 * @param {boolean} firstRun – if true, mark existing as seen without announcing
 * @returns {Promise<object[]>} New notices
 */
export async function pollPodNotices(personId, firstRun = false) {
  let raw;
  try {
    raw = await getNotifications(personId);
  } catch (err) {
    log.warn({ err }, 'Failed to fetch Pod notifications');
    return [];
  }

  const items = extractNotices(raw);
  if (firstRun) {
    // Mark all as seen
    for (const item of items) {
      await saveNotice({ source: 'pod', sourceId: item.id, text: item.text, postedAt: item.postedAt }).catch(() => {});
    }
    return [];
  }

  const newNotices = [];
  for (const item of items) {
    const known = await isNoticeKnown('pod', item.id);
    if (!known) {
      await saveNotice({ source: 'pod', sourceId: item.id, text: item.text, postedAt: item.postedAt });
      newNotices.push(item);
    }
  }
  return newNotices;
}

function extractNotices(raw) {
  const data = raw?.data || raw || [];
  const items = Array.isArray(data) ? data : Object.values(data);
  return items
    .filter(i => i.id && (i.text || i.message || i.title || i.content))
    .map(i => ({
      id: String(i.id),
      text: i.text || i.message || i.title || i.content || '',
      postedAt: i.created_at || i.posted_at ? new Date(i.created_at || i.posted_at) : new Date(),
    }));
}

/**
 * Get recent notices from DB.
 */
export async function getLatestNotices(limit = 5) {
  return getRecentNotices(limit);
}
