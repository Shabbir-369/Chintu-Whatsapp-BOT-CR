/**
 * src/brain/decision.js
 * Decision engine: returns the action for each incoming message. §9.
 * Actions: REPLY | REACT | REPLY_AND_REACT | IGNORE | DEFER
 *
 * Order of evaluation (§9.2, first match wins):
 *   1. Hard blocks (group disabled, denied, quiet hours, cap, flood)
 *   2. Owner → always REPLY
 *   3. Non-owner admin attempt → REPLY savage refusal
 *   4. Extraction attempt → REPLY deflect
 *   5. Serious distress → REPLY serious
 *   6. Owner attack → REPLY defender
 *   7. Direct trigger (mention, name, reply-to-bot) → REPLY
 *   8. Pod/data question in group → REPLY helpful (redirect personal to DM)
 *   9. Mass-bunk talk → silent analysis + one neutral line
 *   10. Small talk (greeting/farewell/thanks) → probabilistic
 *   11. Ambient scoring → REPLY | REACT | IGNORE
 */
import { isExtractionAttempt, isDistressSignal } from './guard.js';
import { isFloodPenalised, checkFlood, isOnCooldown, isGroupOverCap, exceedsPersonFairness } from '../policy/limits.js';
import { inQuietHours } from '../policy/quietHours.js';
import { isGroupEnabled, getGroupMode } from '../policy/access.js';
import { botAliases, config } from '../config.js';
import { classifySmallTalk, isLowValue } from '../util/text.js';
import { getLogger } from '../logger.js';
import { isCalendarQuestion } from '../util/calendar.js';
import { isTimetableQuestion } from '../util/timetableQuery.js';

const log = getLogger('brain/decision');

// Mass-bunk keywords (§11.10)
const BUNK_KEYWORDS = [
  'mass bunk', 'sab bunk', 'kal koi nahi aayega', 'kal class mat jao',
  'kal ki class skip', 'sab ghar jao', 'bunk plan', 'kal 8:30 koi nahi',
  'chhuti lelo', 'koi nahi aayega', 'bunk kar lo', 'sab bunk karte hain',
  'kal sab bunk', 'sab kal bunk', 'mass-bunk', 'collective bunk', 'class skip karte', 'koi class nahi aayega',
];

// Individual Pod information is never answered in a group, even if a member asks about someone else.
const PERSONAL_POD_DATA_PATTERN = /\b(attendance|bunk|marks|grades?|internals|pod account|present percentage|absent percentage)\b/i;

// Owner-attack keywords (§9.2 block 6)
const OWNER_ATTACK_KEYWORDS = [
  'cr useless', 'cr hatao', 'owner ko hata do', 'cr ko nikalo',
  'cr nahi chahiye', 'tumhara cr', 'ye cr kuch nahi karta', 'cr kuch kaam nahi karta',
];

// Admin command patterns — non-owner trying to control bot (§9.2 block 3, §11.3)
const ADMIN_COMMAND_PATTERNS = [
  /ab se sirf (mere|mujhe)/i,
  /owner ko ignore/i,
  /bot band/i,
  /tu ye command/i,
  /^!enable\b/i,
  /^!disable\b/i,
  /^!setmode\b/i,
  /^!forget\b/i,
  /turn (off|on) (the )?bot/i,
  /ignore the owner/i,
];

/**
 * Run the decision engine for a message.
 * @param {object} ctx – normalised message context from ingress
 * @returns {Promise<{ action: string, toneMode: string, reason: string }>}
 */
export async function decide(ctx) {
  const { chatJid, isGroup, senderJid, person, isOwner, text, kind, mentions, quoted } = ctx;

  // Normalised lower-case text for pattern matching
  const t = (text || '').toLowerCase();

  // Owner is evaluated ahead of group-off, quiet-hours and non-owner throttles.
  // Internal-information requests are the deliberate exception and are deflected.
  if (isOwner) {
    if (isExtractionAttempt(text)) return { action: 'REPLY', toneMode: 'deflect', reason: 'extraction_attempt', priority: true };
    const dataQuestion = isCalendarQuestion(text) || /\b(timetable|time table|class kab|aaj kya|kal kya|schedule|attendance|bunk|notice)\b/i.test(t);
    return { action: 'REPLY', toneMode: isDistressSignal(text) ? 'serious' : 'playful', reason: isGroup && dataQuestion ? 'data_question' : 'owner', priority: true };
  }

  // ── Block 1: Hard blocks ──────────────────────────────────────────

  // Group must be enabled (groups are OFF by default §11.2)
  if (isGroup) {
    const enabled = await isGroupEnabled(chatJid);
    if (!enabled) return { action: 'IGNORE', toneMode: 'savage', reason: 'group_disabled' };
  }

  // Flood penalty: sender sent > 8 msgs in 20s → ignore for 2 min
  if (!isOwner && person?.id && checkFlood(person.id, chatJid)) {
    return { action: 'IGNORE', toneMode: 'savage', reason: 'flood_penalty' };
  }

  // Group hourly cap exceeded
  if (isGroup && !isOwner && isGroupOverCap(chatJid)) {
    return { action: 'IGNORE', toneMode: 'savage', reason: 'hourly_cap' };
  }

  // Quiet hours (00:30–07:30 IST) — non-owner only (§8.5)
  if (!isOwner && inQuietHours()) {
    return { action: 'IGNORE', toneMode: 'savage', reason: 'quiet_hours' };
  }

  // Media handling: voice note → reply with brush-off; sticker/image → maybe react
  if (kind === 'audio') {
    // In-character brush-off for voice notes (§7.5)
    return { action: 'REPLY', toneMode: 'playful', reason: 'audio_brush_off', isAudioBrushOff: true };
  }
  if (kind === 'sticker' || kind === 'image') {
    if (Math.random() < config.REACTION_CHANCE * 2) {
      return { action: 'REACT', toneMode: 'playful', reason: 'sticker_image' };
    }
    return { action: 'IGNORE', toneMode: 'savage', reason: 'sticker_no_reply' };
  }

  // Unknown / protocol messages: skip
  if (!text && kind !== 'text') {
    return { action: 'IGNORE', toneMode: 'savage', reason: 'no_text' };
  }

  // ── Block 3: Non-owner admin attempt ─────────────────────────────
  if (ADMIN_COMMAND_PATTERNS.some(p => p.test(t))) {
    return { action: 'REPLY', toneMode: 'savage', reason: 'non_owner_admin', forceRefusal: true };
  }

  // ── Block 4: Extraction/jailbreak attempt ─────────────────────────
  if (isExtractionAttempt(text)) {
    return { action: 'REPLY', toneMode: 'deflect', reason: 'extraction_attempt' };
  }

  // ── Block 5: Serious distress (§15.6) ────────────────────────────
  if (isDistressSignal(text)) {
    return { action: 'REPLY', toneMode: 'serious', reason: 'distress' };
  }

  // ── Block 6: Attack on owner/CR ──────────────────────────────────
  if (isGroup && OWNER_ATTACK_KEYWORDS.some(k => t.includes(k))) {
    return { action: 'REPLY', toneMode: 'defender', reason: 'owner_attack' };
  }

  // Group mode is checked before general data routing. In trigger mode,
  // only an explicit mention/name/reply-to-bot should receive a normal reply.
  const groupMode = isGroup ? await getGroupMode(chatJid) : null;

  // ── Block 8: Mass-bunk talk BEFORE generic data routing ──────────
  // A mass-bunk message is an analysis trigger, never a timetable request.
  if (isGroup && BUNK_KEYWORDS.some(k => t.includes(k))) {
    const botNumberForBunk = config.PAIR_NUMBER.replace(/\D/g, '');
    const explicitlyTriggered = (mentions || []).some(m => m.replace(/\D/g, '').includes(botNumberForBunk))
      || botAliases.some(a => t.includes(a)) || !!ctx.quotedFromBot;
    if (groupMode === 'trigger' && !explicitlyTriggered) return { action: 'IGNORE', toneMode: 'savage', reason: 'trigger_mode_no_trigger' };
    return { action: 'REPLY', toneMode: 'savage', reason: 'mass_bunk', massBunkDetected: true };
  }

  // ── Block 7: Direct trigger (§9.2) ───────────────────────────────
  // @mention: message has a mention that includes the bot's number
  const botNumber = config.PAIR_NUMBER.replace(/\D/g, '');
  const isMentioned = (mentions || []).some(m => m.replace(/\D/g, '').includes(botNumber));

  // Name in text
  const nameInText = botAliases.some(a => t.includes(a));

  // Reply to a bot message: ingress sets quotedFromBot=true when the quoted
  // message's sender JID matches the bot's own PAIR_NUMBER (§9.2 block 7).
  const isReplyToBot = !!ctx.quotedFromBot;

  if (isMentioned || nameInText || isReplyToBot) {
    // Even on direct trigger, check if it is a data/Pod question
    const isDataQ = /attendance|bunk|exam|notice|kitni class|kya class/i.test(text) || isTimetableQuestion(text) || isCalendarQuestion(text);
    if (isGroup && (PERSONAL_POD_DATA_PATTERN.test(t) || (isDataQ && /meri|mera|my|main|mai|uski|uska|iski|iska/.test(t)))) {
      // Personal Pod data asked in group → redirect
      return { action: 'REPLY', toneMode: 'helpful', reason: 'data_in_group_trigger', redirectToDm: true };
    }
    return { action: 'REPLY', toneMode: 'savage', reason: 'direct_trigger' };
  }

  // ── Block 9: Pod/data question in group ──────────────────────────
  const TIMETABLE_PATTERN = /\b(attendance|bunk|exam|notice|kitni class|kya class)\b/i;
  if (isGroup && (TIMETABLE_PATTERN.test(text) || isTimetableQuestion(text) || isCalendarQuestion(text))) {
    // Any individual Pod data is private in groups, even when the message names another student.
    if (PERSONAL_POD_DATA_PATTERN.test(t) || /\b(meri|mera|my\b|maine|apni|apna|uski|uska|iski|iska)\b/.test(t)) {
      return { action: 'REPLY', toneMode: 'helpful', reason: 'personal_data_in_group', redirectToDm: true };
    }
    // Trigger mode stays silent unless the bot was explicitly addressed.
    if (groupMode === 'trigger') return { action: 'IGNORE', toneMode: 'savage', reason: 'trigger_mode_no_trigger' };
    // General timetable/exam/notice → answer publicly
    return { action: 'REPLY', toneMode: 'helpful', reason: 'data_question' };
  }

  // ── Block 10: Small talk (§9.4) ──────────────────────────────────
  // §9.4: "greetings and farewells addressed to the bot or replying to the bot"
  // Only trigger this block if the person is specifically talking to the bot.
  const smallTalkType = classifySmallTalk(text);
  if (smallTalkType && (isMentioned || nameInText || isReplyToBot || !isGroup)) {
    // Always get something: text 50%, react 30%, text+react 20% (§9.4)
    const pick = Math.random();
    if (pick < 0.5) return { action: 'REPLY', toneMode: 'playful', reason: `small_talk_${smallTalkType}` };
    if (pick < 0.8) return { action: 'REACT', toneMode: 'playful', reason: `small_talk_${smallTalkType}` };
    return { action: 'REPLY_AND_REACT', toneMode: 'playful', reason: `small_talk_${smallTalkType}` };
  }

  // ── Block 11: DM (non-owner) always gets reply if approved ───────
  if (!isGroup) {
    return { action: 'REPLY', toneMode: 'savage', reason: 'dm' };
  }

  // ── Block 12: Ambient evaluation (groups) ─────────────────────────
  if (groupMode === 'mute') return { action: 'IGNORE', toneMode: 'savage', reason: 'mute_mode' };
  if (groupMode === 'trigger') return { action: 'IGNORE', toneMode: 'savage', reason: 'trigger_mode_no_trigger' };

  // Per-user cooldown (applies to ambient replies, not to triggers above)
  if (person?.id && isOnCooldown(person.id, chatJid, true)) {
    // High-score message can still get a REACT
    const score = computeAmbientScore(ctx);
    if (score >= 80 && Math.random() < 0.3) {
      return { action: 'REACT', toneMode: 'savage', reason: 'ambient_react_on_cooldown' };
    }
    return { action: 'IGNORE', toneMode: 'savage', reason: 'cooldown' };
  }

  // Per-person fairness: max 5 replies per minute to same person (§9.4)
  if (person?.id && exceedsPersonFairness(person.id)) {
    return { action: 'IGNORE', toneMode: 'savage', reason: 'fairness' };
  }

  // Ambient mode is deliberately conversational: after hard safety/rate limits,
  // reply to most substantive messages rather than requiring a high score.
  if (groupMode === 'ambient' && t.trim().length >= 3) {
    return { action: 'REPLY', toneMode: 'savage', reason: 'ambient_default_reply' };
  }

  // Global ambient reply chance gate (tunable)
  const ambientReplyChance = groupMode === 'ambient' ? Math.max(0.85, config.GROUP_AMBIENT_REPLY_CHANCE) : config.GROUP_AMBIENT_REPLY_CHANCE;
  if (Math.random() > ambientReplyChance) {
    return { action: 'IGNORE', toneMode: 'savage', reason: 'ambient_chance' };
  }

  // Ambient score → action (§9.3 exact thresholds)
  const score = computeAmbientScore(ctx);

  if (score >= 60) {
    // Occasionally do REPLY_AND_REACT for very high scores (§9.4)
    if (Math.random() < 0.15) {
      return { action: 'REPLY_AND_REACT', toneMode: 'savage', reason: 'ambient_high' };
    }
    return { action: 'REPLY', toneMode: 'savage', reason: 'ambient_reply' };
  }
  if (score >= 40) {
    // REPLY with 45% probability, else REACT (§9.3)
    if (Math.random() < 0.45) {
      return { action: 'REPLY', toneMode: 'savage', reason: 'ambient_mid_reply' };
    }
    return { action: 'REACT', toneMode: 'savage', reason: 'ambient_mid_react' };
  }
  if (score >= 25) {
    // REACT with 35% probability, else IGNORE (§9.3)
    if (Math.random() < 0.35) {
      return { action: 'REACT', toneMode: 'savage', reason: 'ambient_low_react' };
    }
  }

  return { action: 'IGNORE', toneMode: 'savage', reason: 'ambient_below_threshold' };
}

/**
 * Compute ambient engagement score for a message (§9.3).
 * Score = sum of weights, clamped 0..100.
 */
function computeAmbientScore(ctx) {
  const { text, lastBotAt, person, chatJid } = ctx;
  if (!text) return 0;

  let score = 0;
  const t = text.toLowerCase();

  // Question to the group (§9.3 +30)
  if (text.includes('?') || /koi bata sakta hai|can anyone|kaun bata/.test(t)) score += 30;

  // Chintu-hook topics (§9.3 +25)
  if (/\b(attendance|bunk|8:30|mst|assignment|deadline|mass bunk|teacher|professor)\b/.test(t)) score += 25;

  // Heated / funny conversation: many messages in last min, laughter (§9.3 +10)
  if (/lol|lmao|haha|💀|😂|😭|xd/.test(t)) score += 10;
  if (ctx.recentGroupActivity) score += 10; // passed in from groupHandler

  // Last bot message > 10 min ago (§9.3 +10)
  if (!lastBotAt || (Date.now() - new Date(lastBotAt).getTime() > 10 * 60 * 1000)) score += 10;

  // Last bot message < 2 min ago (§9.3 -25)
  if (lastBotAt && (Date.now() - new Date(lastBotAt).getTime() < 2 * 60 * 1000)) score -= 25;

  // Bot sent > 6 msgs in this group in last 30 min (§9.3 -30)
  if (ctx.recentBotMsgCount && ctx.recentBotMsgCount > 6) score -= 30;

  // Low value message penalty (§9.3 -30)
  if (isLowValue(text)) score -= 30;

  // Private-looking exchange: reply between two other people (§9.3 -20)
  if (ctx.quoted && ctx.quoted.participant && ctx.quoted.participant !== ctx.senderJid) score -= 20;

  if (ctx.senderOnCooldown) score -= 40;

  // Clamp
  return Math.max(0, Math.min(100, score));
}
