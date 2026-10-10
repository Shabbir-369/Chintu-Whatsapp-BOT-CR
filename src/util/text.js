/**
 * src/util/text.js
 * Text normalisation, truncation, similarity helpers.
 */

/**
 * Normalise text for fuzzy matching: lowercase, strip punctuation/emoji/spaces.
 * @param {string} text
 * @returns {string}
 */
export function normalise(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    // Remove emoji (basic unicode ranges)
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
    .replace(/[\u2600-\u27BF]/g, '')
    // Remove punctuation
    .replace(/[^\w\s]/g, '')
    // Collapse spaces
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Truncate text to maxLen characters, appending '…' if truncated.
 * @param {string} text
 * @param {number} maxLen
 * @returns {string}
 */
export function truncate(text, maxLen = 300) {
  if (!text || text.length <= maxLen) return text || '';
  return text.slice(0, maxLen - 1) + '…';
}

/**
 * Simple bigram-based similarity score (0-1) between two strings.
 * Used as fallback when pg_trgm is not available.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const na = normalise(a);
  const nb = normalise(b);
  if (na === nb) return 1;
  const bigramsA = bigrams(na);
  const bigramsB = bigrams(nb);
  if (bigramsA.size === 0 || bigramsB.size === 0) return 0;
  let intersection = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) intersection++;
  }
  return (2 * intersection) / (bigramsA.size + bigramsB.size);
}

function bigrams(str) {
  const result = new Set();
  for (let i = 0; i < str.length - 1; i++) {
    result.add(str.slice(i, i + 2));
  }
  return result;
}

/**
 * Extract mentioned phone numbers from text.
 * @param {string} text
 * @returns {string[]}
 */
export function extractPhoneNumbers(text) {
  const matches = text.match(/\b91\d{10}\b|\b\d{10}\b/g) || [];
  return [...new Set(matches)];
}

/**
 * Check if text is a low-value one-word message.
 * @param {string} text
 * @returns {boolean}
 */
export function isLowValue(text) {
  const LOW_VALUE = new Set([
    'ok', 'k', 'okay', 'hmm', 'hm', 'yes', 'no', 'yep', 'nope',
    'haan', 'nahi', 'lol', 'lmao', 'xd', 'ha', 'haha', 'hehe',
    'bye', 'hi', 'hello', 'ok', 'thanks', 'ty', 'thx', '👍', '😂',
    '😭', '💀', '😎', 'sure', 'fine', 'done', 'noted', 'seen',
  ]);
  const words = text.trim().toLowerCase().split(/\s+/);
  return words.length <= 2 && words.every(w => LOW_VALUE.has(w));
}

/**
 * Check if a message is a greeting/farewell directed at someone.
 * @param {string} text
 * @returns {'greeting'|'farewell'|'thanks'|null}
 */
export function classifySmallTalk(text) {
  const t = text.toLowerCase().trim();
  if (/\b(bye|alvida|chal|good night|gn|nikal|tata)\b/.test(t)) return 'farewell';
  if (/\b(good morning|subah|morning|gm)\b/.test(t)) return 'greeting';
  if (/\b(hi|hello|hey|hola|howdy)\b/.test(t)) return 'greeting';
  if (/\b(thanks|thank you|shukriya|dhanyawad|ty|thx)\b/.test(t)) return 'thanks';
  return null;
}

/**
 * Strip markdown headings/code fences; convert **bold** to WhatsApp *bold*.
 * @param {string} text
 * @param {boolean} [dataReply] – if true, allow bold conversion
 * @returns {string}
 */
export function normaliseReply(text, dataReply = false) {
  if (!text) return '';
  let t = text
    // Remove code fences
    .replace(/```[\s\S]*?```/g, '')
    // Remove markdown headings
    .replace(/^#{1,6}\s+/gm, '')
    // Remove leading "Chintu:" or "Assistant:"
    .replace(/^(Chintu|Assistant):\s*/i, '')
    // Trim surrounding quotes
    .replace(/^["'](.+)["']$/s, '$1')
    .trim();
  if (dataReply) {
    t = t.replace(/\*\*(.*?)\*\*/g, '*$1*');
  } else {
    // Remove all bold markdown in banter
    t = t.replace(/\*\*(.*?)\*\*/g, '$1');
  }
  return t;
}

/**
 * Check if two reply strings are repetitively similar (first 3 words + last word match).
 * @param {string} newReply
 * @param {string[]} recent – recent bot replies
 * @returns {boolean}
 */
export function isRepetitive(newReply, recent = []) {
  if (!newReply || recent.length === 0) return false;
  const nWords = newReply.toLowerCase().split(/\s+/);
  const nPrefix = nWords.slice(0, 3).join(' ');
  const nLast = nWords[nWords.length - 1];

  for (const prev of recent) {
    const pWords = prev.toLowerCase().split(/\s+/);
    const pPrefix = pWords.slice(0, 3).join(' ');
    const pLast = pWords[pWords.length - 1];
    if (nPrefix === pPrefix && nLast === pLast) return true;
    if (similarity(newReply, prev) > 0.7) return true;
  }
  return false;
}
