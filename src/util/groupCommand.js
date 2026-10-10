/** Parse owner-only natural-language group controls. Pure helper: safe to unit-test. */

const MODE_WORDS = new Set(['ambient', 'trigger', 'mute']);

function cleanTarget(value) {
  return String(value || '')
    .trim()
    .replace(/[.!?,;:]+$/g, '')
    .replace(/^(?:(?:please|bhai|chintu|bot)\s+)+/i, '')
    .replace(/^(?:the|this|that|iss|is)\s+/i, '')
    .replace(/^(?:group\s+)(?:named\s+|called\s+)?/i, '')
    .replace(/\s+ko\s*$/i, '')
    .replace(/\s+(?:whatsapp\s+)?group\s*$/i, '')
    .replace(/\s+(?:mein|me|par)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse group control commands to a single intent shape:
 * { intent: 'ENABLE_GROUP'|'DISABLE_GROUP'|'SET_MODE', entities: {group, mode} }.
 * An empty group is intentional: caller should present a numbered list.
 */
export function parseGroupControlCommand(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const t = raw.toLowerCase().replace(/[’‘]/g, "'").replace(/[.!?]+$/g, '').replace(/\s+/g, ' ').trim();

  // If the mode is clear but the target is omitted, let the owner choose a group.
  const modeOnly = t.match(/^(?:(?:please\s+)?(?:set|switch|change|put|turn)\s+(?:(?:to|as)\s+)?)?(?:the\s+)?(?:group\s+)?(?:mode\s+(?:to|as)\s+)?(ambient|trigger|mute)(?:\s+mode)?$/i)
    || t.match(/^(?:set|switch|change)\s+(?:the\s+)?mode\s+(?:to|as)\s+(ambient|trigger|mute)$/i);
  if (modeOnly) return { intent: 'SET_MODE', entities: { group: '', mode: (modeOnly[1] || modeOnly[2]).toLowerCase() }, confidence: 0.95 };

  // Mode changes: accept direct, imperative, and Hinglish forms.
  let modeMatch = t.match(/^(?:please\s+)?(?:set|switch|change|make|put)\s+(?:the\s+)?(?:mode\s+(?:of|for)\s+)?(.+?)\s+(?:to|as|mein|pe)\s+(ambient|trigger|mute)(?:\s+mode)?$/i);
  if (modeMatch) {
    const group = cleanTarget(modeMatch[1].replace(/\b(?:ka|ki|ke)\s+mode$/i, ''));
    return { intent: modeMatch[2].toLowerCase() === 'mute' ? 'SET_MODE' : 'SET_MODE', entities: { group, mode: modeMatch[2].toLowerCase() }, confidence: 0.98 };
  }

  modeMatch = t.match(/^(.+?)\s+(?:group\s+)?(?:ka\s+)?mode\s+(?:to\s+|mein\s+|pe\s+)?(ambient|trigger|mute)(?:\s+mode)?(?:\s+(?:kar(?:\s+do|\s+de)?|set\s+kar(?:\s+do)?|laga\s+(?:do|de)))?$/i)
    || t.match(/^(.+?)\s+(ambient|trigger|mute)\s+mode(?:\s+mein)?\s+(?:kar(?:\s+do|\s+de)?|set\s+kar(?:\s+do)?|laga\s+(?:do|de))$/i)
    || t.match(/^(.+?)\s+ko\s+(ambient|trigger|mute)(?:\s+mode)?\s+(?:mein\s+)?(?:kar(?:\s+do|\s+de)?|set\s+kar(?:\s+do)?|laga\s+(?:do|de))$/i);
  if (modeMatch) {
    const first = modeMatch[1];
    const mode = modeMatch[2] || modeMatch[3];
    if (MODE_WORDS.has(String(mode).toLowerCase())) {
      return { intent: 'SET_MODE', entities: { group: cleanTarget(first), mode: String(mode).toLowerCase() }, confidence: 0.97 };
    }
  }

  modeMatch = t.match(/^(ambient|trigger|mute)\s+mode\s+(?:for|of|in)\s+(.+)$/i);
  if (modeMatch) {
    return { intent: 'SET_MODE', entities: { mode: modeMatch[1].toLowerCase(), group: cleanTarget(modeMatch[2]) }, confidence: 0.97 };
  }

  // Unmute/enable/resume takes priority over the substring "mute".
  const enablePatterns = [
    /^(?:please\s+)?(?:unmute|un-mute|unsilence|enable|activate|resume|turn\s+on|switch\s+on|start\s+talking\s+in)\s*(.*)$/i,
    /^(.+?)\s+(?:group\s+)?(?:ko\s+)?(?:unmute|enable|chalu\s+kar|wapis\s+chalu\s+kar|bolna\s+shuru\s+kar)(?:\s+(?:kar\s+do|kar\s+de|please))?$/i,
  ];
  for (let i = 0; i < enablePatterns.length; i++) {
    const m = t.match(enablePatterns[i]);
    if (!m) continue;
    let target = i === 0 ? m[1] : m[1];
    target = cleanTarget(target.replace(/\b(?:please|kar do|kar de|now)\b/gi, ' '));
    // Do not classify bare "start" or unrelated text as a group command.
    if (i === 0 && !target && !/^(?:unmute|enable|activate|resume|turn on|switch on)$/i.test(t)) continue;
    return { intent: 'ENABLE_GROUP', entities: { group: target, mode: 'ambient' }, confidence: 0.96 };
  }

  // Mute/disable or explicit stop-talking requests.
  const disableTarget = parseDisableGroupCommand(raw);
  if (disableTarget !== null) {
    return { intent: 'DISABLE_GROUP', entities: { group: cleanTarget(disableTarget), mode: 'mute' }, confidence: 0.96 };
  }

  // Generic mode syntax such as "Photography group trigger mode".
  modeMatch = t.match(/^(.+?)\s+(?:group\s+)?(ambient|trigger|mute)\s+mode$/i)
    || t.match(/^(.+?)\s+group\s+(ambient|trigger|mute)$/i);
  if (modeMatch && /\b(group|mode)\b/.test(t)) {
    return { intent: 'SET_MODE', entities: { group: cleanTarget(modeMatch[1]), mode: modeMatch[2].toLowerCase() }, confidence: 0.9 };
  }

  return null;
}

/** Parse owner-only natural-language commands that silence one WhatsApp group. */
export function parseDisableGroupCommand(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase().replace(/[’‘]/g, "'").replace(/[.!?]+$/g, '').replace(/\s+/g, ' ');
  const isCommand =
    /^(?:(?:please|bhai|chintu|bot)\s+)*(?:disable|mute|silence|shut\s+up|chup|band\s+kar|mute\s+kar)\b/.test(lower) ||
    /^(?:(?:please|bhai|chintu|bot)\s+)*(?:stop\s+(?:talking|replying|responding|speaking|sending\s+messages?)\s+(?:in|to)|don't\s+(?:talk|reply|respond|speak)\s+(?:in|to)|dont\s+(?:talk|reply|respond|speak)\s+(?:in|to)|do\s+not\s+(?:talk|reply|respond|speak)\s+(?:in|to))\b/.test(lower) ||
    /\b(?:group|mein|me)\b.*\b(?:baat|bolna|reply|respond)\s+(?:mat\s+kar|band\s+kar)\b/.test(lower) ||
    /\b(?:is|iss)\s+group\s+(?:mein\s+)?(?:bolna|reply|baat)\s+band\s+kar\b/.test(lower) ||
    /^(.+?)\s+(?:group\s+)?ko\s+(?:mute|disable|silence)\s+(?:kar(?:\s+do|\s+de)?)$/i.test(lower) ||
    /^(.+?)\s+(?:group\s+)?(?:mein|me)\s+(?:mat\s+bol|reply\s+mat\s+kar|baat\s+band\s+kar|bolna\s+band\s+kar)$/i.test(lower);
  if (!isCommand) return null;

  let target = lower
    .replace(/^(?:(?:please|bhai|chintu|bot)\s+)+/i, '')
    .replace(/^(?:disable|mute|silence|shut\s+up|chup|band\s+kar|mute\s+kar)\s*/i, '')
    .replace(/^stop\s+(?:talking|replying|responding|sending\s+messages?)\s+(?:in|to)\s+/i, '')
    .replace(/^(?:don't|dont|do\s+not)\s+(?:talk|reply|respond)\s+(?:in|to)\s+/i, '')
    .replace(/^(?:the|this|that)\s+/i, '')
    .replace(/^(?:is|iss)\s+group\s+(?:mein\s+)?(?:bolna|reply|baat)\s+band\s+kar$/i, '')
    .replace(/^(.+?)\s+(?:group\s+)?ko\s+(?:mute|disable|silence)\s+(?:kar(?:\s+do|\s+de)?)$/i, '$1')
    .replace(/^(.+?)\s+(?:group\s+)?(?:mein|me)\s+(?:mat\s+bol|reply\s+mat\s+kar|baat\s+band\s+kar|bolna\s+band\s+kar)$/i, '$1')
    .replace(/\s+group\s*$/i, '')
    .replace(/\s+(?:mein|me|par)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Avoid interpreting a discussion topic as a group name.
  if (/^(?:about|ke baare mein|regarding)\b/.test(target)) return null;
  return target;
}
