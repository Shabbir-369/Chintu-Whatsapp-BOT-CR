/**
 * Decide when a silent group outcome should be replaced with a reaction.
 * Keep explicit mute, trigger-only, and hard rate/safety gates intact.
 */
const NO_REACTION_REASONS = new Set([
  'group_disabled',
  'flood_penalty',
  'hourly_cap',
  'quiet_hours',
  'mute_mode',
  'trigger_mode_no_trigger',
]);

export function shouldReactInsteadOfReply({ ctx, groupRow, reason, explicitlyTriggered = false }) {
  if (!ctx?.isGroup || !ctx?.rawMsg?.key) return false;
  // Never react to a reaction; doing so can create reaction loops.
  if (ctx.kind === 'reaction') return false;
  if (!groupRow || groupRow.enabled === false || groupRow.mode === 'mute') return false;
  if (NO_REACTION_REASONS.has(reason)) return false;

  if (groupRow.mode === 'ambient') return true;
  // Trigger mode can react only after the user has addressed the bot.
  if (groupRow.mode === 'trigger') return explicitlyTriggered;
  return false;
}
