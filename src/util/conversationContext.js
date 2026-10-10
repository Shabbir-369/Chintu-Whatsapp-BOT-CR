/** Build recent chat history for the model without exposing Pod/private-data content in groups. */
const PRIVATE_POD_RE = /\b(attendance|present|absent|bunk|marks?|grades?|result|pod account|password|credential|token|percentage|percent)\b/i;

export function buildConversationHistory(rows = [], { currentWaId = null, isGroup = false, limit = 12 } = {}) {
  const recent = rows
    .filter(row => row && row.text && row.wa_id !== currentWaId)
    .slice(-Math.max(1, limit));
  const history = [];
  for (const row of recent) {
    const text = String(row.text || '').trim();
    if (!text) continue;
    // Do not feed personal Pod/attendance messages back into a group prompt.
    if (isGroup && PRIVATE_POD_RE.test(text)) continue;
    const role = row.from_bot ? 'model' : 'user';
    const name = row.from_bot ? 'Chintu' : (row.display_name || row.push_name || 'member');
    const part = { text: `${name}: ${text.slice(0, 1200)}` };
    const last = history.at(-1);
    if (last?.role === role) last.parts[0].text += `\n${part.text}`;
    else history.push({ role, parts: [part] });
  }
  // Gemini history must begin with a user turn, not a model turn.
  while (history.length && history[0].role !== 'user') history.shift();
  return history.slice(-6);
}

export function phoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

export function isPhoneFallbackName(value) {
  const digits = phoneDigits(value);
  return digits.length >= 7 && digits.length <= 15 && digits === String(value || '').replace(/[+\s()-]/g, '');
}
