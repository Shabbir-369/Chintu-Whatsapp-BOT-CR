/**
 * src/skills/naming.js
 * Name approval flow. §11.4.
 * Proposals sent to owner, approved names stored in people.display_name.
 */
import { createApproval, genCode, decideApproval, createNameClaim, decideNameClaim } from '../db/repos/approvals.js';
import { setDisplayName, findPeopleByName } from '../db/repos/people.js';
import { getLogger } from '../logger.js';

const log = getLogger('skills/naming');

// Batching: at most 5 name cards per hour
let nameCardsThisHour = 0;
let nameCardHourReset = Date.now();

/**
 * Propose a name for a person to the owner.
 * @param {string} personId
 * @param {string} claimedName
 * @param {string} source – 'pushname'|'context'|'self_claim'
 * @param {object} evidence
 * @returns {Promise<{ code: string, cardText: string }|null>}
 */
export async function proposeName(personId, claimedName, source = 'self_claim', evidence = {}) {
  // Rate limit: 5 cards per hour
  const now = Date.now();
  if (now - nameCardHourReset > 3600000) {
    nameCardsThisHour = 0;
    nameCardHourReset = now;
  }
  if (nameCardsThisHour >= 5) {
    log.info({ personId, claimedName }, 'Name card rate limit reached, queued');
    return null;
  }

  nameCardsThisHour++;

  // Create name claim
  const claim = await createNameClaim({ personId, source, claimedName, evidence });

  // Create approval card
  const code = await genCode('N');
  const approval = await createApproval({
    code,
    kind: 'name',
    subjectPersonId: personId,
    payload: { claimedName, source, claimId: claim.id, evidence },
  });

  const cardText = `*${code}  name proposal*\nperson: ${personId.slice(0, 8)}...\nclaimed name: ${claimedName}\nsource: ${source}\nreply: "${code} yes" / "${code} no"`;

  log.info({ code, personId, claimedName }, 'Name proposal sent to owner');
  return { code, cardText, approvalId: approval.id, claimId: claim.id };
}

/**
 * Execute a name approval decision.
 * @param {object} approval
 * @param {string} decision – 'approved'|'rejected'
 * @returns {Promise<{ displayName: string|null, wasApproved: boolean }>}
 */
export async function executeNameDecision(approval, decision) {
  const { payload, id: approvalId } = approval;
  const { claimedName, claimId } = payload;

  await decideApproval(approvalId, decision);
  if (claimId) await decideNameClaim(claimId, decision);

  if (decision === 'approved') {
    await setDisplayName(approval.subject_person_id, claimedName);
    log.info({ claimedName, personId: approval.subject_person_id }, 'Name approved');
    return { displayName: claimedName, wasApproved: true };
  }
  return { displayName: null, wasApproved: false };
}

/**
 * Owner directly assigns a name.
 * @param {string} personId
 * @param {string} name
 */
export async function assignNameDirectly(personId, name) {
  await setDisplayName(personId, name);
  log.info({ personId, name }, 'Owner directly assigned name');
}

/**
 * Get display name or neutral address for a person.
 * @param {object} person
 * @returns {string}
 */
export function getAddressableName(person) {
  if (person?.display_name) return person.display_name;
  // Neutral: don't use raw WhatsApp push_name until owner-approved
  const neutrals = ['bhai', 'tu', 'yaar', 'tum'];
  return neutrals[Math.floor(Math.random() * neutrals.length)];
}
