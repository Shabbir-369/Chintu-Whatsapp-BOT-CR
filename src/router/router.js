/**
 * src/router/router.js
 * Main router: owner | DM | group handler. §5.2 L3.
 */
import { handleOwnerMessage } from './ownerConsole.js';
import { handleDm } from './dmHandler.js';
import { handleGroup } from './groupHandler.js';
import { humanSend } from '../gateway/outbox.js';
import { addOwnerJid } from '../db/repos/people.js';
import { config } from '../config.js';
import { getLogger } from '../logger.js';
import { isExtractionAttempt, guardOutput } from '../brain/guard.js';
import { getDeflectLine } from '../brain/fallback.js';
import { requestOwnerNameForUnknownPerson } from '../skills/naming.js';

const log = getLogger('router/router');

let ownerChatJid = null;

/**
 * Set the owner's private chat JID.
 * @param {string} jid
 */
export function setOwnerChatJid(jid) {
  ownerChatJid = jid;
}

export function getOwnerChatJid() {
  return ownerChatJid;
}

/**
 * Route a normalised message context to the appropriate handler.
 * @param {object} ctx
 */
export async function route(ctx) {
  let { isGroup, isOwner, chatJid, senderJid, person, text } = ctx;

  try {
    // ── !claim: works BEFORE isOwner gate (breaks chicken-and-egg) ───
    // Any DM with !claim <secret> is checked here first. This lets the
    // owner claim themselves on first boot before their JID is seeded.
    if (!isGroup && text?.trim().startsWith('!claim ')) {
      const secret = text.trim().slice(7).trim();
      if (secret === config.OWNER_SECRET) {
        // Register this JID as owner
        await addOwnerJid(senderJid);
        // Also seed the phone-format JID from OWNER_NUMBER in case it differs
        await addOwnerJid(`${config.OWNER_NUMBER}@s.whatsapp.net`).catch(() => {});
        ownerChatJid = chatJid;
        isOwner = true; // promote for this request
        log.info({ senderJid }, 'Owner claimed via !claim command');
        // Delete the message containing the secret if possible
        try {
          const { deleteMessage } = await import('../gateway/socket.js');
          await deleteMessage(chatJid, ctx.rawMsg.key);
        } catch {}
        await humanSend(chatJid, 'claimed. ab tu boss hai 😎', { sourceMessage: ctx.rawMsg, priority: true });
        return;
      }
      // Wrong secret — fall through silently (treat as normal DM)
    }

    if (isOwner && !isGroup) {
      // Owner private chat
      ownerChatJid = chatJid;
      const reply = await handleOwnerMessage(ctx, chatJid);
      if (reply) {
        await humanSend(chatJid, reply, { sourceMessage: ctx.rawMsg, priority: true });
      } else {
        // Not a command: generate in-character reply
        await handleDmAsOwner(ctx);
      }
      return;
    }

    if (isOwner && isGroup) {
      // Owner message in group: treat as group message (might be a group order)
      await handleGroup(ctx, ownerChatJid || chatJid);
      return;
    }

    if (!isGroup) {
      // DM from non-owner
      await handleDm(ctx, async (text) => {
        // ownerChatJid is normally seeded at boot. The config fallback also
        // protects approvals if a caller routes a DM before boot completes.
        const approvalChatJid = ownerChatJid || `${config.OWNER_NUMBER}@s.whatsapp.net`;
        const sent = await humanSend(approvalChatJid, text, { priority: true });
        return sent?.key?.id || null;
      });
      return;
    }

    // If a group member has no known name, keep their phone number as the
    // stable label and ask the owner once. This does not expose private data.
    if (isGroup && person && !isOwner) {
      await requestOwnerNameForUnknownPerson({
        person,
        ownerChatJid,
        send: async (jid, message) => humanSend(jid, message, { priority: true }),
      }).catch(err => log.warn({ err }, 'Unknown-person name prompt failed'));
    }

    // Group message from non-owner
    await handleGroup(ctx, ownerChatJid || chatJid);

  } catch (err) {
    log.error({ err, chatJid: chatJid?.slice(0, 12) }, 'Router error');
  }
}

/**
 * Generate in-character reply for owner's non-command DM messages.
 */
async function handleDmAsOwner(ctx) {
  const { chatJid, text, rawMsg } = ctx;
  if (isExtractionAttempt(text)) {
    await humanSend(chatJid, getDeflectLine(chatJid), { sourceMessage: rawMsg, priority: true });
    return;
  }
  try {
    const { generateReply } = await import('../brain/llm.js');
    const { buildSystemPrompt } = await import('../brain/persona.js');
    const { getFallbackLine } = await import('../brain/fallback.js');
    const { buildMemoryPack } = await import('../brain/memory.js');

    const memoryPack = await buildMemoryPack({ personId: ctx.person?.id, messageText: text, isGroup: false });
    const { getRecentMessages } = await import('../db/repos/messages.js');
    const { buildConversationHistory } = await import('../util/conversationContext.js');
    const recentRows = await getRecentMessages(chatJid, 16).catch(() => []);
    const history = buildConversationHistory(recentRows, { currentWaId: rawMsg?.key?.id, isGroup: false, limit: 12 });
    const systemPrompt = buildSystemPrompt({ toneMode: 'playful', memoryPack, isGroup: false, isOwnerMessage: true });
    const result = await generateReply(systemPrompt, history, text, true);
    const parts = result.reply_parts || [];
    const candidate = parts[0] || getFallbackLine('casual', chatJid);
    const guarded = guardOutput(candidate, [], false);
    if (guarded.ok && guarded.cleaned) {
      await humanSend(chatJid, guarded.cleaned, { sourceMessage: rawMsg, priority: true });
    } else {
      await humanSend(chatJid, getDeflectLine(chatJid), { sourceMessage: rawMsg, priority: true });
    }
  } catch (err) {
    log.warn({ err }, 'Owner chat reply failed');
    const { getBusyLine } = await import('../brain/fallback.js');
    await humanSend(chatJid, getBusyLine(chatJid), { sourceMessage: rawMsg, priority: true }).catch(() => {});
  }
}
