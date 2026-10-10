/**
 * src/brain/fallback.js
 * Canned fallback line bank. Used when AI cap reached or model fails twice. §15.7.
 * Lines are loaded from data/fallback-lines.json.
 */
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getLogger } from '../logger.js';

const log = getLogger('brain/fallback');
const __dirname = dirname(fileURLToPath(import.meta.url));

const FALLBACK_FILE = resolve(__dirname, '../../data/fallback-lines.json');

// Recent picks per chat (avoid repeating last 5)
const recentPicks = new Map();

let lines = null;

function loadLines() {
  if (lines) return lines;
  if (existsSync(FALLBACK_FILE)) {
    try {
      lines = JSON.parse(readFileSync(FALLBACK_FILE, 'utf8'));
      return lines;
    } catch (err) {
      log.warn({ err }, 'Failed to load fallback-lines.json, using defaults');
    }
  }
  // Built-in defaults
  lines = {
    casual: [
      'bhai thoda ruk', 'baad mein baat karte hain', 'abhi busy hoon yaar',
      'hmm', 'sahi hai', 'theek hai', 'kal dekh lena', 'pata nahi honestly',
      'interesting point hai', 'dekha jaayega', 'phir kabhie',
    ],
    savage: [
      'bhai teri attendance mat dekha aisi baatein mat kar',
      'confidence toh dekho', 'kuch toh likha hoga lab record mein bhi',
      'itne confident mat reh yaar', 'sahi baat hai magar galat bhi',
      'pehle apna dekhle', 'teri bhi aukaad hai toh baat kar',
      'bhai sun raha hoon magar samajh nahi aa raha',
    ],
    deflect: [
      'yeh mujhe nahi pata', 'aisa kuch nahi hai yaar',
      'ye topic chhod', 'kuch aur baat kar',
      'nahi pata bhai honestly', 'ye toh bata nahi paunga',
      'chhod yaar ye sab', 'aur kuch', 'next question please',
    ],
    defender: [
      'arey bhai sahi baat hai teri', 'CR sahi bol raha tha',
      'pehle facts check kar phir bol', 'itna toh hoga',
      'tere ko pata hai kya', 'aise nahi chalta bhai',
    ],
    greeting: [
      'haan bhai', 'kya scene hai', 'kya ho raha hai',
      'bolo', 'kya chal raha', 'sunaao',
    ],
    farewell: [
      'chal', 'bye', 'haan chal', 'theek hai bye',
      'nikal', '👋', 'gn bhai',
    ],
    thanks: [
      '🤝', '😮‍💨', 'koi nahi', 'theek hai yaar',
      'chhod bhai', 'haan haan',
    ],
    busy: [
      'network ne dhoka diya, thodi der baad try kar',
      'abhi signal nahi hai, baad mein',
      'thoda ruk, system slow hai',
      'pod ne abhi dhoka diya, thodi der baad',
      'nahi hua abhi, phir koshish kar',
    ],
    refusal: [
      'bhai ye toh nahi hoga',
      'tu CR nahi hai yaar',
      'yeh command sirf CR ke liye hai',
      'itna authority toh nahi hai tere paas',
      'pehle permission le phir bol',
    ],
  };
  return lines;
}

/**
 * Pick a random fallback line for a category, avoiding last 5 used in this chat.
 * @param {string} category
 * @param {string} [chatJid]
 * @returns {string}
 */
export function getFallbackLine(category = 'casual', chatJid = 'global') {
  const all = loadLines();
  const pool = all[category] || all.casual;
  const key = `${chatJid}:${category}`;
  const recent = recentPicks.get(key) || [];

  const available = pool.filter(l => !recent.includes(l));
  const pick = available.length > 0
    ? available[Math.floor(Math.random() * available.length)]
    : pool[Math.floor(Math.random() * pool.length)];

  recent.push(pick);
  if (recent.length > 5) recent.shift();
  recentPicks.set(key, recent);
  return pick;
}

/**
 * Get a random deflect line.
 */
export function getDeflectLine(chatJid) {
  return getFallbackLine('deflect', chatJid);
}

/**
 * Get a random busy/error line.
 */
export function getBusyLine(chatJid) {
  return getFallbackLine('busy', chatJid);
}

/**
 * Get a savage refusal for non-owner admin attempts.
 */
export function getRefusalLine(chatJid) {
  return getFallbackLine('refusal', chatJid);
}
