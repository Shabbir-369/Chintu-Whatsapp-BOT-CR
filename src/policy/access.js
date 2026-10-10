/**
 * src/policy/access.js
 * Access control: DM approval, owner check, group enabled check.
 */
import { isOwnerJid } from '../db/repos/people.js';
import { getDmAccess } from '../db/repos/approvals.js';
import { getGroup } from '../db/repos/groups.js';

/**
 * Check if the sender has approved DM access or is the owner.
 */
export async function canReplyToDm(personId, isOwner) {
  if (isOwner) return true;
  const access = await getDmAccess(personId);
  return access?.status === 'approved';
}

/**
 * Check if the group is enabled.
 */
export async function isGroupEnabled(groupJid) {
  const group = await getGroup(groupJid);
  return group?.enabled === true;
}

/**
 * Get group mode.
 */
export async function getGroupMode(groupJid) {
  const group = await getGroup(groupJid);
  return group?.mode || 'ambient';
}
