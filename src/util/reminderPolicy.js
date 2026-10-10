/** Pure permission check for private self-reminder jobs. */
export function isValidSelfReminderPayload(payload) {
  return Boolean(
    payload && payload.selfOnly === true &&
    typeof payload.targetJid === 'string' && payload.targetJid.length > 0 &&
    payload.targetJid === payload.requesterJid &&
    !payload.targetJid.endsWith('@g.us') &&
    !payload.targetJid.includes('@broadcast') &&
    typeof payload.message === 'string' && payload.message.trim().length > 0
  );
}
