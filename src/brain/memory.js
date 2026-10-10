/**
 * src/brain/memory.js
 * Memory write, read, decay, and consolidation. §10.
 */
import {
  writeMemory, findSimilarMemories, updateMemory,
  retrieveMemoryPack, applyMemoryDecay,
  getLastDailySummary, getPersonProfile, getPersonFacts,
  updatePersonProfile,
} from '../db/repos/memory.js';
import { getGroupProfile } from '../db/repos/groups.js';
import { getLogger } from '../logger.js';

const log = getLogger('brain/memory');

/**
 * Process memory_ops returned by the LLM (§10.2 turn extraction).
 * @param {object[]} ops – [{ type, person, text, importance, confidence }]
 * @param {string} personId
 * @param {string} groupJid
 * @param {boolean} isGroup
 */
export async function processMemoryOps(ops, personId, groupJid, isGroup) {
  if (!ops || ops.length === 0) return;

  for (const op of ops.slice(0, 3)) {
    try {
      // Validate
      if (!op.text || op.confidence < 0.5) continue;
      if (!op.text || op.text.length < 3) continue;

      const scope = isGroup ? 'group' : 'person';
      const visibility = isGroup ? 'public' : 'dm';

      // Dedupe/merge check
      const similar = await findSimilarMemories(op.text, personId, groupJid || null, 0.6);
      if (similar.length > 0) {
        await updateMemory(similar[0].id, {
          importance: op.importance || 3,
          confidence: op.confidence || 1.0,
        });
        continue;
      }

      await writeMemory({
        scope: personId ? 'person' : scope,
        personId,
        groupJid: groupJid || null,
        kind: op.type || 'episode',
        text: op.text,
        importance: op.importance || 3,
        confidence: op.confidence || 1.0,
        emotionalWeight: 0.0,
        visibility,
      });
    } catch (err) {
      log.warn({ err, op }, 'Failed to write memory op');
    }
  }
}

/**
 * Build the memory pack for a model call (§10.3).
 * @param {object} opts
 * @param {string} opts.personId
 * @param {string} opts.groupJid
 * @param {string} opts.messageText
 * @param {boolean} opts.isGroup
 * @returns {Promise<object>} Memory pack with personProfile, groupProfile, memories, recentJoke
 */
export async function buildMemoryPack({ personId, groupJid, messageText, isGroup }) {
  try {
    const [personProfile, groupProfile, memories, facts] = await Promise.all([
      personId ? getPersonProfile(personId).catch(() => null) : null,
      groupJid ? getGroupProfile(groupJid).catch(() => null) : null,
      retrieveMemoryPack({ personId, groupJid, messageText, limit: 6 }).catch(() => []),
      personId ? getPersonFacts(personId, 5).catch(() => []) : [],
    ]);

    // Recent joke detection
    const recentJoke = personProfile?.last_joke || null;

    return {
      personProfile: personProfile ? {
        name: personProfile.display_name || 'unknown',
        familiarity: personProfile.familiarity,
        humourStyle: personProfile.humour_style,
        teasingTolerance: personProfile.teasing_tolerance,
        habits: personProfile.habits || [],
        interests: personProfile.interests || [],
        lastRoastedAt: personProfile.last_roasted_at,
        fakeNameCount: personProfile.fake_name_count,
      } : null,
      groupProfile: groupProfile ? {
        running_jokes: groupProfile.running_jokes || [],
        mood: groupProfile.mood || 'calm',
        rules: groupProfile.rules || {},
      } : null,
      memories: memories.slice(0, 6),
      facts: isGroup ? [] : facts.slice(0, 5).map(f => f.fact),
      recentJoke,
    };
  } catch (err) {
    log.warn({ err }, 'Failed to build memory pack');
    return {};
  }
}

/**
 * Run nightly memory operations (decay + archive + consolidation).
 * Called by the scheduler at 03:00 IST.
 */
export async function runNightlyMemory() {
  try {
    log.info('Running nightly memory decay...');
    await applyMemoryDecay();
    log.info('Memory decay complete');
  } catch (err) {
    log.error({ err }, 'Nightly memory failed');
  }
}

/**
 * Detect simple memory-worthy events from raw message text (§10.2 cheap rule pass).
 * @param {string} text
 * @param {string} personId
 * @param {string} groupJid
 * @returns {object[]} Candidate memory ops
 */
export function cheapRulePass(text, personId, groupJid) {
  if (!text) return [];
  const candidates = [];

  // Name claim: "mera naam X hai"
  const nameMatch = text.match(/mera naam (.+?) hai/i) || text.match(/my name is (.+)/i);
  if (nameMatch) {
    candidates.push({
      type: 'fact',
      text: `Claims name is "${nameMatch[1].trim()}"`,
      importance: 3,
      confidence: 0.8,
      isNameClaim: true,
      claimedName: nameMatch[1].trim(),
    });
  }

  // Promise: "kal bataunga"
  if (/kal (bataunga|kar dunga|bolunga|bhejna|dena)|will (tell|send|give) (you )?(tomorrow|later)/i.test(text)) {
    candidates.push({
      type: 'promise',
      text: `Said: "${text.slice(0, 100)}"`,
      importance: 2,
      confidence: 0.7,
    });
  }

  // Strong emotion
  if (/bahut bura|bahut acha|loving this|hate this|best day|worst day/.test(text)) {
    candidates.push({
      type: 'episode',
      text: `Expressed strong emotion: "${text.slice(0, 100)}"`,
      importance: 2,
      confidence: 0.6,
    });
  }

  return candidates;
}
