/**
 * src/skills/pod/link.js
 * Pod account linking flow. §11.8.
 * State machine: consent → email → password → done
 */
import {
  getPodLinkSession, upsertPodLinkSession, deletePodLinkSession,
  savePodCredentials, hasPodAccount, getLinkAttempts, recordLinkAttempt,
} from '../../db/repos/pod.js';
import { podLogin } from './client.js';
import { getLogger } from '../../logger.js';
import { isPodDataRequest, isPodLinkCommand } from '../../util/podIntent.js';

const log = getLogger('skills/pod/link');

const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@medicaps\.ac\.in$/i;

// Cancellation signals — any of these words/phrases abort the flow
const CANCEL_PATTERNS = [
  /^(cancel|stop|quit|exit|nahi|na|no)$/i,
  /\b(stop linking|band kar|bnd kar|bnd hoja|band hoja|rehne de|reh jane de|chod de|chhod de|mat kar|nahi chahiye|cancel karo|link mat karo|link nahi|unlink|bye)\b/i,
  /^(ok stop|forget it|never mind|abey yaar|abey|chod|chhod|bas kar|bas|enough)$/i,
];

// Messages that are clearly NOT email attempts — should auto-cancel
// (greetings, random words, single words without @, sentences)
function isObviouslyNotEmail(text) {
  const t = text.trim();
  // Has no @ → definitely not an email attempt
  if (!t.includes('@')) return true;
  // Very short random strings without proper email structure
  if (t.length < 8) return true;
  return false;
}

// Is this message clearly conversational (not an email)?
function isConversational(text) {
  const t = text.trim().toLowerCase();
  // Greetings, questions, sentences
  if (/^(hi|hello|hey|hii|helo|kya|kese|kaise|kya chal|bhai|yaar|main|mujhe|mera|tera|ek|ok|haan|ha|nahi|na|theek|accha|bas|aur|sun|bata|dekh|suno|bol|karo|help)\b/.test(t)) return true;
  if (t.split(' ').length >= 3 && !t.includes('@')) return true; // multi-word sentence without @
  return false;
}

/**
 * Handle Pod linking flow for a message.
 * @param {string} personId
 * @param {string} text – user's message
 * @returns {Promise<{ handled: boolean, reply: string|null }>}
 */
export async function handleLinkFlow(personId, text) {
  const t = text.trim().toLowerCase();

  // ── Cancellation check (works at ANY step, before session load) ──
  const isCancellation = CANCEL_PATTERNS.some(p => p.test(t));
  if (isCancellation) {
    const session = await getPodLinkSession(personId).catch(() => null);
    if (session) {
      await deletePodLinkSession(personId);
      return { handled: true, reply: 'chhod diya. jab chahiye tab "link pod" bol' };
    }
    // No active session + cancel word = treat as normal chat
    return { handled: false, reply: null };
  }

  // ── Load current session ──────────────────────────────────────────
  const session = await getPodLinkSession(personId).catch(() => null);

  // ── Start linking from either an explicit request or an actual Pod-data request.
  // Asking for attendance/bunk/marks is treated as intent to link; don't make the
  // person send a second command or answer a redundant yes/no confirmation.
  const isExplicitLinkTrigger = isPodLinkCommand(t);
  const wantsPodData = isPodDataRequest(t);

  if (!session && (isExplicitLinkTrigger || wantsPodData)) {
    const linked = await hasPodAccount(personId).catch(() => false);
    if (linked) {
      if (isExplicitLinkTrigger) return { handled: true, reply: 'pod pehle se linked hai. attendance, bunk ya marks jo chahiye pooch le.' };
      return { handled: false, reply: null };
    }
    await upsertPodLinkSession(personId, 'email', { attempts: 0 });
    return {
      handled: true,
      reply: `attendance nikalne ke liye pehle Pod link karte hain. Apna Medi-Caps login email bhej (en...@medicaps.ac.in). Credentials encrypted save honge taaki baar-baar na maangna pade. Rukna ho toh \"cancel\" bol.`,
    };
  }

  // No active session and no trigger — not our message
  if (!session) return { handled: false, reply: null };

  // ── Session is active — check if it has expired (30 min) ─────────
  if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
    await deletePodLinkSession(personId);
    return { handled: true, reply: 'link session expire ho gaya. dobara "link pod" bol' };
  }

  // ── Legacy consent step ───────────────────────────────────────────
  // Older builds stored a yes/no state. Upgrade it silently so the user only
  // needs to provide their email/password once they requested Pod data/linking.
  if (session.step === 'consent') {
    if (CANCEL_PATTERNS.some(p => p.test(t))) {
      await deletePodLinkSession(personId);
      return { handled: true, reply: 'theek hai, linking cancel kar di. jab chahiye bol dena.' };
    }
    await upsertPodLinkSession(personId, 'email', { attempts: 0 });
    if (EMAIL_REGEX.test(text.trim())) return handleLinkFlow(personId, text);
    return { handled: true, reply: 'apna Medi-Caps Pod login email bhej (en...@medicaps.ac.in). Credentials encrypted save honge; cancel bolke ruk sakta hai.' };
  }

  // ── Email step ───────────────────────────────────────────────────
  if (session.step === 'email') {
    const email = text.trim();
    const partial = session.partial || {};
    const attempts = (partial.attempts || 0);

    if (isPodDataRequest(t)) {
      return { handled: true, reply: 'haan attendance/bunk dekh dunga — bas pehle apna Medi-Caps login email bhej (en...@medicaps.ac.in). Rukna ho toh cancel bol.' };
    }

    // If this looks conversational, NOT an email attempt → cancel flow
    if (isConversational(email)) {
      await deletePodLinkSession(personId);
      // Return NOT handled so normal chat takes over with this message
      return { handled: false, reply: null };
    }

    if (!EMAIL_REGEX.test(email)) {
      // After 2 invalid attempts, cancel and let them know
      if (attempts >= 2) {
        await deletePodLinkSession(personId);
        return {
          handled: true,
          reply: 'arey yaar, 3 baar galat. dobara try karna ho toh "link pod" bol',
        };
      }
      await upsertPodLinkSession(personId, 'email', { attempts: attempts + 1 });
      return {
        handled: true,
        reply: attempts === 0
          ? 'ye email format sahi nahi hai. medicaps wala email chahiye (en24...@medicaps.ac.in)'
          : 'abhi bhi galat hai. ek aur chance — medicaps wala email chahiye (en24...@medicaps.ac.in), nahi chahiye toh "cancel" bol',
      };
    }

    // Valid email — move to password step
    await upsertPodLinkSession(personId, 'password', { email, attempts: 0 });
    return { handled: true, reply: 'ab Pod password bhej. Is DM mein hi use hoga aur database mein encrypted save hoga; kisi group mein password mat bhejna. cancel bolke ruk sakta hai.' };
  }

  // ── Password step ─────────────────────────────────────────────────
  if (session.step === 'password') {
    const { email } = session.partial || {};
    if (!email) {
      await deletePodLinkSession(personId);
      return { handled: true, reply: 'kuch gadbad ho gayi, dobara try kar: "link pod"' };
    }

    // Conversational message in password step = cancel
    if (isConversational(text.trim())) {
      await deletePodLinkSession(personId);
      return { handled: false, reply: null };
    }

    // Check attempts
    const attempts = await getLinkAttempts(personId).catch(() => 0);
    if (attempts >= 3) {
      await deletePodLinkSession(personId);
      return { handled: true, reply: 'zyada galat attempts ho gaye. 1 ghante baad try karna' };
    }

    const password = text.trim();
    await recordLinkAttempt(personId);

    try {
      const newSession = await podLogin({ email, password });
      await savePodCredentials(personId, { email, password });
      const { savePodSession } = await import('../../db/repos/pod.js');
      await savePodSession(personId, newSession);
      await deletePodLinkSession(personId);

      return {
        handled: true,
        reply: 'link ho gaya 🤝 ab attendance, bunk calculator, marks sab puch sakta hai. attendance dekhni hai?',
      };
    } catch (err) {
      log.warn({ err }, 'Pod login failed during link');
      const { message } = err;
      if (message?.includes('401') || message?.includes('403')) {
        return { handled: true, reply: 'password galat hai. ek baar aur try kar ya "cancel" bol' };
      }
      return { handled: true, reply: 'pod server ne abhi dhoka diya. thodi der baad "link pod" try kar' };
    }
  }

  return { handled: false, reply: null };
}

/**
 * Handle unlink request.
 */
export async function handleUnlink(personId) {
  const { deletePodAccount } = await import('../../db/repos/pod.js');
  await deletePodAccount(personId);
  await deletePodLinkSession(personId).catch(() => {});
  return 'pod unlink ho gaya. teri attendance abhi se nahi dekhunga';
}
