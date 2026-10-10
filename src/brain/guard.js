/**
 * src/brain/guard.js
 * Input extraction detector and output guard. §7.3, §15.5, §15.6.
 */
import { normaliseReply, isRepetitive, similarity } from '../util/text.js';

// ─── Extraction Detection (§7.3) ─────────────────────────────────
// "A fast regex pass plus a model flag detects: system prompt, instructions, what model,
//  which API, are you chatgpt/gemini/claude, how do you work, ignore previous,
//  act as, developer mode, print your rules, repeat the text above,
//  base64/translation/roleplay tricks, asking for credentials or tokens."

const EXTRACTION_PATTERNS = [
  // Direct internals probes
  /system prompt/i,
  /your instructions/i,
  /tell me your (prompt|rules|instructions)/i,
  /reveal (your|the) (prompt|instructions|rules|system)/i,
  /show (me )?(your|the) (prompt|rules|system)/i,
  /print (your|the) (rules|prompt|instructions)/i,
  /repeat (the )?text above/i,
  /repeat after me/i,
  /what (?:were|are) you (?:told|instructed|prompted) to/i,
  /(?:show|print|dump|reveal|expose|read) (?:the )?(?:source code|internal (?:config|configuration|instructions|prompt|notes)|config(?:uration)?|environment variables?|\.env|developer message|system message|hidden context)/i,
  /(?:show|list|dump) (?:all )?(?:secrets|credentials|passwords|api keys|tokens)/i,
  /what (?:is|are) (?:inside|in) (?:your )?(?:config|configuration|\.env|system prompt|hidden prompt)/i,
  /repeat everything above|print everything before this/i,
  /ignore (?:the )?(?:safety|privacy) rules/i,
  /reveal (?:the )?(?:hidden|internal|private) (?:context|messages|data|instructions)/i,

  // Model/API identification
  /what (ai |model |llm )?(are you|is this|powers you)/i,
  /what (ai|model|llm) do you use/i,
  /which (api|model|llm|ai) (do you use|are you|is this)/i,
  /are you (chatgpt|gpt|gemini|claude|openai|an? ai|a bot|a robot|artificial intelligence)/i,
  /are you (human|a person|real|a real person)/i,
  /you are (a )?bot/i,
  /how do you work/i,
  /what are you( really)?/i,
  /kaunsi (api|model|ai) hai/i,
  /tu (kaunsa|kaun sa|konsa) (ai|model|bot) hai/i,
  /kaun si api use karta hai/i,

  // Jailbreak/roleplay tricks
  /ignore (previous|all|your) instructions/i,
  /ignore (all )?(prior|previous|above) (instructions|rules|prompts)/i,
  /act as (a different|an? ai|an? assistant|yourself without|jailbreak|dan)/i,
  /developer mode/i,
  /jailbreak/i,
  /pretend (you are|to be) (a )?different/i,
  /forget (your|all) (rules|instructions|training)/i,
  /you are now (a different|an unfiltered|without restrictions)/i,

  // Roleplay identity tricks
  /rolep(l)?ay (as|a)/i,
  /play the role of/i,
  /simulate (a |an )?different/i,

  // Base64 / translation tricks
  /decode.*base64/i,
  /translate (this|the following) (to|from)/i,
  /what does .{10,50} mean in (english|hindi)/i,

  // Credential/token probing
  /api key/i,
  /auth token/i,
  /your (password|credentials|token|secret)/i,
];

/**
 * Check if the input is attempting to extract internals.
 * @param {string} text
 * @returns {boolean}
 */
export function isExtractionAttempt(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return EXTRACTION_PATTERNS.some(p => p.test(t));
}

// ─── Serious Distress Detector (§15.6) ───────────────────────────
// Regex in English, Hindi and Hinglish for distress signals.

const DISTRESS_PATTERNS = [
  // English
  /\bdepress(ed|ion)?\b/i,
  /\banxious\b|\banxiety\b|\bpanic\b/i,
  /hurt (myself|me)\b/i,
  /can'?t cope\b/i,
  /want(s)? to die\b/i,
  /wanna die\b/i,
  /feel(ing)? (so |very |really )?(bad|terrible|hopeless|worthless|empty)/i,
  /\bsuicide\b|\bsuicidal\b/i,
  /self.?harm\b/i,
  /crying (all|so much|a lot)\b/i,
  /\bcrying\b/i,
  /family (problem|issue|crisis)\b/i,

  // Hindi/Hinglish
  /mar(na)? chahta|mar(na)? chahti/i,
  /mar jana/i,
  /bahut bura lag raha/i,
  /ro raha\b|ro rahi\b/i,
  /dil nahi lag raha/i,
  /kuch nahi accha lag raha/i,
  /jina nahi chahta|jina nahi chahti/i,
  /khatam kar lun|khatam kar loon/i,

  // Sad emoji clusters (emoji + distress word nearby)
];

/**
 * Check if text contains serious distress signals.
 * @param {string} text
 * @returns {boolean}
 */
export function isDistressSignal(text) {
  if (!text) return false;
  const t = text.toLowerCase();

  // Pattern match
  if (DISTRESS_PATTERNS.some(p => p.test(t))) return true;

  // Sad emoji combined with related words (§15.6)
  const hasSadEmoji = /😢|😭|💔/.test(text);
  const hasDistressWord = /bad|bura|sad|dukh|hurt|pain|cry|rona|problem|help/.test(t);
  if (hasSadEmoji && hasDistressWord) return true;

  return false;
}

// ─── Output Guard (§15.5) ────────────────────────────────────────

// Banned bot-like phrases (§3.3)
const BANNED_BOT_PHRASES = [
  /\bas an ai\b/i,
  /\bi am designed to\b/i,
  /\bmy purpose is\b/i,
  /\bi'?m a language model\b/i,
  /\bi cannot assist with\b/i,
  /\bi don'?t have personal opinions\b/i,
  /^sure[!,.]?\s/i,
  /^absolutely[!,.]?\s/i,
  /^of course[!,.]?\s/i,
  /^certainly[!,.]?\s/i,
  /^i understand[.!,]?\s/i,
  /\bhow can i help you today\b/i,
  /^great question[!,.]?/i,
  /\blet me know if you need\b/i,
  /\bfeel free to (ask|let me know)\b/i,
  /\bi apologize\b|\bi'm sorry for\b/i,
  /\bthank you for (your|the)\b/i,
];

// Technical terms that must NOT leak into chat (§7.3)
const BANNED_TECHNICAL_TERMS = [
  /\bgemini\b/i,
  /\bgoogle ai\b/i,
  /\bopenai\b/i,
  /\bchatgpt\b/i,
  /\bclaude\b/i,
  /\bbaileys\b/i,
  /\bpostgres(ql)?\b/i,
  /\bnode\.?js\b/i,
  /\bjavascript\b/i,
  /\bapi key\b/i,
  /\bendpoint\b/i,
  /\bsystem prompt\b/i,
  /\bllm\b/i,
  /\bdatabase\b/i,
  /\bfirebase\b/i,
  /\bprompt\b/i,
  /\benv var\b|\b\.env\b/i,
  /\bauth token\b/i,
];

/**
 * Guard a reply before sending. Normalises and checks for banned content.
 * @param {string} text
 * @param {string[]} recentBotReplies
 * @param {boolean} isDataReply – if true, allow longer text and WhatsApp *bold*
 * @returns {{ ok: boolean, cleaned: string, reason: string|null }}
 */
export function guardOutput(text, recentBotReplies = [], isDataReply = false) {
  if (!text) return { ok: false, cleaned: '', reason: 'empty' };

  // Normalise (§15.5)
  let cleaned = normaliseReply(text, isDataReply);

  if (!cleaned) return { ok: false, cleaned: '', reason: 'empty_after_normalise' };

  // Length check (§15.5): >400 chars rejected unless data reply
  if (!isDataReply && cleaned.length > 400) {
    return { ok: false, cleaned, reason: 'too_long' };
  }

  // Banned bot phrases (§3.3, §15.5)
  for (const pat of BANNED_BOT_PHRASES) {
    if (pat.test(cleaned)) {
      return { ok: false, cleaned, reason: 'bot_phrase' };
    }
  }

  // Technical term leak (§7.3, §15.5)
  for (const pat of BANNED_TECHNICAL_TERMS) {
    if (pat.test(cleaned)) {
      return { ok: false, cleaned, reason: 'technical_leak' };
    }
  }

  // Repetition check (§15.5): reject if first 3 words + last word match any of last 8 replies
  if (recentBotReplies.length > 0 && isRepetitive(cleaned, recentBotReplies)) {
    return { ok: false, cleaned, reason: 'repetitive' };
  }

  // Never emit an actual configured credential, even in long data replies.
  const sensitiveEnvValues = Object.entries(process.env || {})
    .filter(([key, value]) => /(?:SECRET|API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|PRIVATE_KEY|DATABASE_URL|CREDENTIAL)/i.test(key) && typeof value === 'string' && value.length >= 8)
    .map(([, value]) => value);
  if (sensitiveEnvValues.some(value => cleaned.includes(value))) {
    return { ok: false, cleaned, reason: 'secret_leak' };
  }

  // Token-like string leak (§15.5): 20+ alphanumeric chars that look like a key
  if (!isDataReply && /[A-Za-z0-9]{20,}/.test(cleaned)) {
    return { ok: false, cleaned, reason: 'token_leak' };
  }

  return { ok: true, cleaned, reason: null };
}

/**
 * Check if a group reply contains DM-scoped content (privacy guard §15.5).
 * @param {string} text
 * @returns {boolean}
 */
export function hasDmScopedContent(text) {
  // Look for percentage patterns (attendance numbers) that shouldn't appear in groups
  if (/\b\d{1,3}\.\d%\b/.test(text)) return true;
  if (/\battendance\b.*\b\d+\/\d+\b/i.test(text)) return true;
  return false;
}
