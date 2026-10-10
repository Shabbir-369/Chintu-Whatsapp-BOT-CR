/**
 * src/gateway/ingress.js
 * Normalise incoming WhatsApp messages, resolve identity, dedupe, persist, per-chat queue.
 * Implements §8.1 and L2 of the layered architecture.
 */
import { findOrCreatePerson, findPersonByJid, addIdentity, mergePeople, isOwnerJid, addOwnerJid } from '../db/repos/people.js';
import { saveMessage, findMessage } from '../db/repos/messages.js';
import { upsertGroup, upsertGroupMember, getGroup, touchGroup } from '../db/repos/groups.js';
import { getLogger } from '../logger.js';
import { config, botAliases } from '../config.js';

// Bot's own JID (built once)
const BOT_JID = `${config.PAIR_NUMBER.replace(/\D/g, '')}@s.whatsapp.net`;

const log = getLogger('gateway/ingress');

// Per-chat FIFO queues
const queues = new Map(); // chatJid -> { running: bool, items: [] }

/**
 * Process an incoming message: normalise, identify, dedupe, persist, then queue.
 * @param {object} rawMsg – Baileys message object
 * @param {object} sock – Baileys socket (for reactions etc)
 * @param {function} dispatchFn – called with normalised ctx
 */
export async function processIncoming(rawMsg, sock, dispatchFn) {
  try {
    const ctx = await normaliseMessage(rawMsg, sock);
    if (!ctx) return; // filtered out

    log.info({ isGroup: ctx.isGroup, isOwner: ctx.isOwner, kind: ctx.kind }, 'Incoming message accepted');

    // Per-chat queue
    const chatJid = ctx.chatJid;
    if (!queues.has(chatJid)) {
      queues.set(chatJid, { running: false, items: [] });
    }
    const q = queues.get(chatJid);
    q.items.push({ ctx, dispatchFn });
    if (!q.running) drainQueue(chatJid);
  } catch (err) {
    log.error({ err }, 'Error in processIncoming');
  }
}

async function drainQueue(chatJid) {
  const q = queues.get(chatJid);
  if (!q) return;
  q.running = true;

  while (q.items.length > 0) {
    const { ctx, dispatchFn } = q.items.shift();
    try {
      await dispatchFn(ctx);
    } catch (err) {
      log.error({ err, chatJid }, 'Error dispatching message');
    }
  }
  q.running = false;
}

/**
 * Normalise a raw Baileys message into a context object.
 * Returns null if the message should be ignored.
 */
async function normaliseMessage(rawMsg, sock) {
  const { key, message, messageTimestamp, pushName, verifiedBizName } = rawMsg;
  if (!key || !message) return null;

  // Ignore own messages
  if (key.fromMe) return null;

  // Ignore status broadcast
  if (key.remoteJid === 'status@broadcast') return null;

  // Ignore messages older than 180 seconds
  const now = Math.floor(Date.now() / 1000);
  const ts = Number(messageTimestamp);
  if (ts && now - ts > 180) return null;

  // Determine chat type
  const isGroup = key.remoteJid?.endsWith('@g.us');
  const chatJid = key.remoteJid;

  // Determine sender JID
  const senderJid = isGroup ? (key.participant || key.participantAlt) : key.remoteJid;
  if (!senderJid) return null;

  // Extract text content
  const text = extractText(message);
  const kind = detectKind(message);

  // Extract quoted message
  const quoted = extractQuoted(message);

  // Detect if this message is a reply to a bot message:
  // The bot's own messages have key.fromMe=true when sent by the bot.
  // In group: contextInfo.participant is the sender of the quoted msg.
  // In DM:    contextInfo.participant is empty; quoted participant === bot JID.
  const quotedCtxInfo = message?.extendedTextMessage?.contextInfo;
  const quotedParticipant = quotedCtxInfo?.participant || quotedCtxInfo?.remoteJid || null;
  // A reply to the bot if: quoted message's sender is the bot JID, or
  // the stanzaId is in our sent-message tracking (handled in decision.js via quotedFromBot).
  const quotedFromBot = !!quotedParticipant && (
    quotedParticipant === BOT_JID ||
    quotedParticipant.replace(/\D/g, '') === config.PAIR_NUMBER.replace(/\D/g, '')
  );

  // Extract mentions
  const mentions = message?.extendedTextMessage?.contextInfo?.mentionedJid || [];

  // Dedupe: check if we've already processed this wa_id
  const existingMsg = await findMessage(chatJid, key.id);
  if (existingMsg) return null;

  // Resolve identity
  let person = null;
  let isOwner = false;

  try {
    // Check owner by JID lookup in DB (fast path after first recognition)
    isOwner = await isOwnerJid(senderJid);

    // For LID-based JIDs: check if senderPn matches OWNER_NUMBER
    if (!isOwner && senderJid.includes('@lid') && rawMsg.senderPn) {
      if (rawMsg.senderPn === config.OWNER_NUMBER) {
        isOwner = true;
        // Seed both the phone JID and LID so future lookups hit DB
        await addOwnerJid(`${config.OWNER_NUMBER}@s.whatsapp.net`).catch(() => {});
        await addOwnerJid(senderJid).catch(() => {});
        log.info({ senderJid, senderPn: rawMsg.senderPn }, 'Owner auto-claimed via LID+senderPn match');
      }
    }

    // For phone-based JIDs: strip @s.whatsapp.net and compare to OWNER_NUMBER
    if (!isOwner && senderJid.endsWith('@s.whatsapp.net')) {
      const senderNumber = senderJid.replace('@s.whatsapp.net', '');
      if (senderNumber === config.OWNER_NUMBER) {
        isOwner = true;
        await addOwnerJid(senderJid).catch(() => {});
        log.info({ senderJid }, 'Owner auto-claimed by OWNER_NUMBER phone match');
      }
    }

    const isLid = senderJid.includes('@lid');
    // Baileys supplies senderPn (or the phone-format alternate JID) for LID
    // messages. Link both identities to one person so an approval granted to
    // the phone identity also applies when WhatsApp later uses the LID.
    const phoneNumber = isLid
      ? String(rawMsg.senderPn || key.remoteJidAlt || '').replace(/\D/g, '')
      : '';
    const phoneJid = phoneNumber ? `${phoneNumber}@s.whatsapp.net` : null;

    if (isLid && !phoneJid) {
      // Keep this diagnostic free of message text and phone numbers. It tells
      // us exactly why a future LID cannot be reconciled automatically.
      log.warn({ isLid: true }, 'LID message has no phone identity hint');
    }

    if (isLid && phoneJid) {
      const [phonePerson, lidPerson] = await Promise.all([
        findPersonByJid(phoneJid),
        findPersonByJid(senderJid),
      ]);

      if (phonePerson && lidPerson && phonePerson.id !== lidPerson.id) {
        // The phone record is authoritative for approvals. Merging removes a
        // stale pending LID record created before the mapping was known.
        await mergePeople(phonePerson.id, lidPerson.id);
        log.info({ personId: phonePerson.id }, 'Merged LID identity into phone identity');
      }

      if (phonePerson) {
        await addIdentity(phonePerson.id, senderJid, 'lid', phoneNumber);
        const { person: p } = await findOrCreatePerson(senderJid, {
          pushName: pushName || verifiedBizName || null,
          kind: 'lid',
          phone: phoneNumber,
        });
        person = p;
      } else {
        const { person: p } = await findOrCreatePerson(senderJid, {
          pushName: pushName || verifiedBizName || null,
          kind: 'lid',
          phone: phoneNumber,
        });
        await addIdentity(p.id, phoneJid, 'phone', phoneNumber);
        person = p;
      }
    } else {
      const { person: p } = await findOrCreatePerson(senderJid, {
        pushName: pushName || verifiedBizName || null,
        kind: isLid ? 'lid' : 'phone',
      });
      person = p;
    }

    // The resolved person is available across all identity branches above.
    // Do not reference a branch-local variable here: that would make every
    // inbound message fail during identity resolution.
    if (isOwner && person && !person.is_owner) {
      // just mark known
    }
  } catch (err) {
    log.error({ err, senderJid }, 'Identity resolution failed');
    return null;
  }

  // Group discovery: upsert group and member if needed
  if (isGroup) {
    try {
      const grp = await getGroup(chatJid);
      if (!grp) {
        // New group – upsert with minimal info
        let subject = chatJid;
        try {
          const metadata = await sock.groupMetadata(chatJid);
          subject = metadata.subject || chatJid;
          await upsertGroup({ jid: chatJid, subject, member_count: metadata.participants?.length || 0, last_activity_at: new Date() });
          // Upsert all members
          for (const p of (metadata.participants || [])) {
            try {
              const { person: mp } = await findOrCreatePerson(p.id, { kind: p.id.includes('@lid') ? 'lid' : 'phone' });
              await upsertGroupMember(chatJid, mp.id, p.admin ? 'admin' : 'member');
            } catch (e) { /* skip */ }
          }
        } catch (e) {
          await upsertGroup({ jid: chatJid, subject, member_count: 0, last_activity_at: new Date() });
        }
      } else {
        await touchGroup(chatJid);
      }
      if (person) {
        await upsertGroupMember(chatJid, person.id, 'member').catch(() => {});
      }
    } catch (err) {
      log.warn({ err }, 'Group upsert failed');
    }
  }

  // Persist the message
  try {
    await saveMessage({
      waId: key.id,
      chatJid,
      senderPersonId: person?.id || null,
      fromBot: false,
      text: text || null,
      quotedWaId: quoted?.id || null,
      mentions: mentions,
      kind,
      sentAt: ts ? new Date(ts * 1000) : new Date(),
    });
  } catch (err) {
    log.warn({ err }, 'Message persist failed');
  }

  return {
    rawMsg,
    key,
    chatJid,
    isGroup,
    senderJid,
    person,
    isOwner,
    text: text || '',
    kind,
    quoted,
    quotedFromBot,
    mentions,
    timestamp: ts ? new Date(ts * 1000) : new Date(),
    pushName: pushName || verifiedBizName || null,
    sock,
  };
}

function extractText(message) {
  if (!message) return '';
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.buttonsResponseMessage?.selectedDisplayText ||
    message.listResponseMessage?.title ||
    ''
  );
}

function detectKind(message) {
  if (!message) return 'other';
  if (message.conversation || message.extendedTextMessage) return 'text';
  if (message.stickerMessage) return 'sticker';
  if (message.imageMessage) return 'image';
  if (message.audioMessage) return 'audio';
  if (message.reactionMessage) return 'reaction';
  return 'other';
}

function extractQuoted(message) {
  const ctx = message?.extendedTextMessage?.contextInfo;
  if (!ctx?.quotedMessage) return null;
  return {
    id: ctx.stanzaId,
    participant: ctx.participant,
    text: extractText(ctx.quotedMessage),
  };
}

/**
 * Check if the bot is mentioned in the message.
 */
export function isBotMentioned(ctx) {
  const { text, mentions } = ctx;
  const t = text.toLowerCase();
  // Check text aliases
  if (botAliases.some(a => t.includes(a))) return true;
  // Check @mentions (we don't know our own JID easily here, rely on text)
  return false;
}

/**
 * Inject a message into a chat's queue (for scheduled/ordered messages).
 * @param {string} chatJid
 * @param {object} ctx – synthetic ctx
 * @param {function} dispatchFn
 */
export function injectSynthetic(chatJid, ctx, dispatchFn) {
  if (!queues.has(chatJid)) {
    queues.set(chatJid, { running: false, items: [] });
  }
  const q = queues.get(chatJid);
  q.items.push({ ctx, dispatchFn });
  if (!q.running) drainQueue(chatJid);
}
