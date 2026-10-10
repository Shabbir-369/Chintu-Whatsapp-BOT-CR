/** Parse owner-only natural-language commands that silence one WhatsApp group. */
export function parseDisableGroupCommand(text) {
  const raw = String(text || '').trim();
  const lower = raw.toLowerCase();
  const commandText = lower.replace(/^please\s+/, '');
  const isCommand = /^(disable|band kar|mute|chup)\b/.test(commandText) ||
    /\b(stop|band|chup)\b.*\b(talking|replying|bolna|reply|replies|messages?)\b.*\b(group|mein|me)\b/.test(commandText) ||
    /\b(is|iss)\s+group\s+(mein\s+)?(bolna|reply|baat)\s+band\s+kar\b/.test(commandText) ||
    /\b(group|mein)\b.*\b(baat|bolna|reply)\s+band\s+kar\b/.test(commandText);
  if (!isCommand) return null;

  const target = lower
    .replace(/^please\s+/i, '')
    .replace(/^(disable|band kar|mute|chup)\s*/i, '')
    .replace(/^stop\s+(?:talking|replying|sending messages?)\s+(?:in|to)\s+/i, '')
    .replace(/^stop\s+(?:talking|replying)\s+in\s+/i, '')
    .replace(/^please\s+/i, '')
    .replace(/^the\s+/i, '')
    .replace(/^(?:is|iss)\s+group\s+mein\s+(?:bolna|reply|baat)\s+band\s+kar$/i, '')
    .replace(/\s+group\s*$/i, '')
    .replace(/\s+mein\s+(?:bolna|reply|baat)\s+band\s+kar\s*$/i, '')
    .replace(/\s+(?:mein|me)\s+chup\s+ho\s*$/i, '')
    .trim();
  return target;
}
