/**
 * src/router/groupHandler.js
 * Group message handling: decision engine → brain → reply/react/ignore. §11.3.
 */
import { decide } from '../brain/decision.js';
import { generateReply, isBudgetExhausted } from '../brain/llm.js';
import { buildSystemPrompt } from '../brain/persona.js';
import { buildMemoryPack, processMemoryOps } from '../brain/memory.js';
import { guardOutput } from '../brain/guard.js';
import { getRefusalLine, getBusyLine, getDeflectLine, getFallbackLine } from '../brain/fallback.js';
import { answerTimetableQuestion } from '../skills/timetable.js';
import { runMassBunkAnalysis } from '../skills/massBunk.js';
import { humanSend, sendReaction, pickReactionEmoji } from '../gateway/outbox.js';
import { getLastBotReplies } from '../db/repos/messages.js';
import { recordReply, recordGroupReply } from '../policy/limits.js';
import { touchGroupBotAt, getGroup } from '../db/repos/groups.js';
import { writeAuditLog } from '../db/repos/timetable.js';
import { config, botAliases } from '../config.js';
import { shouldReactInsteadOfReply } from '../util/reactionFallback.js';
import { getLogger } from '../logger.js';
import { recordStarterActivity } from '../skills/starter.js';

const log = getLogger('router/groupHandler');

// Burst handling: DEFER when same person sends 2-5 messages in 8 seconds (§9.4)
const bursts = new Map(); // `chatJid:personId` → { timer, count, latestCtx }

/**
 * Handle a group message.
 * @param {object} ctx
 * @param {string} ownerChatJid
 */
export async function handleGroup(ctx, ownerChatJid) {
  const { chatJid, person, text, isOwner, rawMsg } = ctx;

  // Mute is absolute: the bot must not speak or react in a muted group,
  // including when the owner sends a message there. Manage/unmute it in DM.
  const initialGroup = await getGroup(chatJid).catch(() => null);
  if (initialGroup?.mode === 'mute' || initialGroup?.enabled === false) return;
  // A member message within 30 minutes counts as engagement with a pending starter.
  recordStarterActivity(chatJid);

  // Alert the owner when a non-owner probes for hidden/internal information.
  if (!isOwner && text && ownerChatJid) {
    const { isExtractionAttempt } = await import('../brain/guard.js');
    if (isExtractionAttempt(text)) {
      const who = person?.display_name || person?.push_name || 'unknown member';
      const excerpt = text.replace(/[\r\n]+/g, ' ').slice(0, 180);
      humanSend(ownerChatJid, `👀 internal-info probe in a group\nwho: ${who}\nmessage: “${excerpt}”\nhandled with a privacy deflection.`, { priority: true })
        .catch(err => log.warn({ err }, 'Owner security alert failed'));
    }
  }

  // Owner messages in group: skip burst, process immediately
  if (isOwner) {
    await processGroupMessage(ctx, ownerChatJid);
    return;
  }

  // If an ambient group message has no text, react instead of silently ignoring it.
  // Incoming reactions are excluded to prevent reaction loops; mute/trigger rules
  // are enforced by reactIfNoReply.
  if (!text) {
    await reactIfNoReply(ctx, initialGroup, ctx.kind === 'sticker' ? 'sticker_no_reply' : 'no_text');
    return;
  }

  // Burst handling (§9.4): 2-5 messages within 8 seconds → DEFER
  const burstKey = `${chatJid}:${ctx.senderJid}`;
  const existing = bursts.get(burstKey);

  if (existing) {
    // Another message arrived within the burst window — reset timer and update context
    clearTimeout(existing.timer);
    const newCount = existing.count + 1;

    if (newCount >= 5) {
      // Max burst reached — process now (address entire thought)
      bursts.delete(burstKey);
      await processGroupMessage({ ...ctx, burstCount: newCount }, ownerChatJid);
    } else {
      bursts.set(burstKey, {
        timer: setTimeout(() => {
          bursts.delete(burstKey);
          processGroupMessage({ ...ctx, burstCount: newCount }, ownerChatJid);
        }, 8000),
        count: newCount,
        latestCtx: ctx,
      });
      // DEFER — don't process this message yet
    }
    return;
  }

  // First message from this person — start a short burst window
  // (we wait briefly to see if they send more)
  const timer = setTimeout(() => {
    bursts.delete(burstKey);
    processGroupMessage(ctx, ownerChatJid);
  }, 1500); // 1.5s grace period for burst detection

  bursts.set(burstKey, { timer, count: 1, latestCtx: ctx });
  // Don't await — the timer will call processGroupMessage
}

async function processGroupMessage(ctx, ownerChatJid) {
  const { chatJid, person, text, rawMsg, isOwner } = ctx;

  try {
    // Attach last bot send time for ambient scoring
    const grpRow = await getGroup(chatJid).catch(() => null);
    ctx.lastBotAt = grpRow?.last_bot_at || null;

    // Trigger mode means no unsolicited group replies: only process messages
    // that mention the bot, use its alias, or reply to one of its messages.
    if (grpRow?.mode === 'trigger') {
      if (!isExplicitlyTriggered(ctx)) return;
    }

    // Deterministic group privacy guard: never let the LLM receive attendance
    // questions alongside live timetable context. Individual attendance/marks
    // requests are redirected to DM before any data lookup or generation.
    const lowerText = String(text || '').toLowerCase();

    // Mass-bunk is handled before attendance privacy matching and can never
    // trigger a timetable reply or expose per-person calculations in the group.
    const massBunkAsk = /mass[ -]?bunk|sab(?:hi)?\s+bunk|bunk\s+plan|koi\s+class\s+nahi\s+aayega|sab\s+class\s+skip|kal\s+koi\s+nahi\s+aayega|collective\s+bunk/i.test(lowerText);
    if (massBunkAsk) {
      const targetDate = new Date();
      if (/\b(kal|tomorrow)\b/i.test(lowerText)) targetDate.setDate(targetDate.getDate() + 1);
      else if (/\b(parso|day after)\b/i.test(lowerText)) targetDate.setDate(targetDate.getDate() + 2);
      else if (/\b(narso|narsō|day after tomorrow)\b/i.test(lowerText)) targetDate.setDate(targetDate.getDate() + 3);
      runMassBunkAnalysis(chatJid, targetDate, ownerChatJid).catch(err => log.warn({ err }, 'Mass bunk analysis failed'));
      await humanSend(chatJid, 'bunk ka plan group mein, personal attendance ka hisaab DM mein 😏', { sourceMessage: rawMsg });
      recordGroupReply(chatJid);
      await touchGroupBotAt(chatJid);
      return;
    }

    // Never answer attendance/marks/bunk/Pod queries in a group, even if the
    // requester is the owner or asks without a pronoun. Do not look up data.
    const personalPodAsk = /\b(attendance|bunk|marks?|grades?|internals?|pod account|present percentage|absent percentage)\b/i.test(lowerText);
    if (personalPodAsk) {
      await humanSend(chatJid, 'Personal attendance yahan nahi dikhata — DM mein pooch lo 👀', { sourceMessage: rawMsg });
      recordGroupReply(chatJid);
      await touchGroupBotAt(chatJid);
      return;
    }

    // Run decision engine
    const decision = await decide(ctx);
    log.info({ chatJid: chatJid.slice(0, 12), action: decision.action, reason: decision.reason }, 'Decision');

    switch (decision.action) {
      case 'IGNORE':
        await reactIfNoReply(ctx, grpRow, decision.reason);
        return;

      case 'REACT': {
        const emoji = pickReactionEmoji(text);
        await sendReaction(chatJid, emoji, rawMsg.key);
        return;
      }

      case 'REPLY_AND_REACT': {
        const emoji = pickReactionEmoji(text);
        await sendReaction(chatJid, emoji, rawMsg.key);
        // Fall through to REPLY handling below
        await generateGroupReply(ctx, decision.toneMode, decision, ownerChatJid);
        return;
      }

      case 'REPLY': {
        if (decision.reason === 'extraction_attempt') {
          await humanSend(chatJid, getDeflectLine(chatJid), { sourceMessage: rawMsg, priority: !!isOwner });
          return;
        }

        // Voice note brush-off (§7.5)
        if (decision.isAudioBrushOff) {
          await humanSend(chatJid, 'kaan kharab hai abhi, likh ke bhej', { sourceMessage: rawMsg });
          recordGroupReply(chatJid);
          await touchGroupBotAt(chatJid);
          return;
        }

        // Non-owner admin command refusal
        if (decision.forceRefusal) {
          await writeAuditLog({ actorPersonId: person?.id, action: 'non_owner_admin_attempt', detail: { text: text.slice(0, 200) } });
          await humanSend(chatJid, getRefusalLine(chatJid), { sourceMessage: rawMsg });
          recordGroupReply(chatJid);
          await touchGroupBotAt(chatJid);
          return;
        }

        // Personal Pod data asked in group → redirect to DM (§11.3, §11.10)
        if (decision.redirectToDm) {
          await humanSend(chatJid, 'DM mein bol, yahan sabko nahi dikhana 👀', { sourceMessage: rawMsg });
          recordGroupReply(chatJid);
          await touchGroupBotAt(chatJid);
          return;
        }

        // Timetable/calendar/notice questions (public data, no LLM needed) (§11.7)
        if (decision.reason === 'data_question') {
          const answer = await answerTimetableQuestion(text, chatJid).catch(() => null);
          if (answer) {
            await humanSend(chatJid, answer, { sourceMessage: rawMsg });
            if (person?.id) recordReply(person.id, chatJid);
            recordGroupReply(chatJid);
            await touchGroupBotAt(chatJid);
            return;
          }
          // Fall through to LLM if timetable had no answer
        }

        // Mass-bunk: run silent analysis, post one neutral line (§11.10)
        if (decision.massBunkDetected) {
          const targetDate = new Date();
          if (/kal|tomorrow/.test(text.toLowerCase())) {
            targetDate.setDate(targetDate.getDate() + 1);
          } else if (/parso|day after/.test(text.toLowerCase())) {
            targetDate.setDate(targetDate.getDate() + 2);
          }
          // Run analysis in background (don't await — it sends private DMs)
          runMassBunkAnalysis(chatJid, targetDate, ownerChatJid).catch(err =>
            log.warn({ err }, 'Mass bunk analysis failed')
          );
          // Fixed group-safe line; never pass private/timetable context to the LLM.
          await humanSend(chatJid, 'plan banane se pehle calculator bhi nikal lo, bas keh raha hoon 👀', { sourceMessage: rawMsg });
          recordGroupReply(chatJid);
          await touchGroupBotAt(chatJid);
          return;
        }

        // Generate LLM reply
        await generateGroupReply(ctx, decision.toneMode, decision, ownerChatJid);
        return;
      }

      default:
        return;
    }
  } catch (err) {
    log.error({ err, chatJid: chatJid.slice(0, 12) }, 'Group handler error');
  }
}

function isExplicitlyTriggered(ctx) {
  const lower = String(ctx.text || '').toLowerCase();
  const botNumber = config.PAIR_NUMBER.replace(/\D/g, '');
  const mentioned = (ctx.mentions || []).some(m => String(m).replace(/\D/g, '').includes(botNumber));
  const named = botAliases.some(alias => alias && lower.includes(alias));
  return mentioned || named || !!ctx.quotedFromBot;
}

async function reactIfNoReply(ctx, groupRow, reason) {
  if (!shouldReactInsteadOfReply({
    ctx,
    groupRow,
    reason,
    explicitlyTriggered: isExplicitlyTriggered(ctx),
  })) return false;

  try {
    await sendReaction(ctx.chatJid, pickReactionEmoji(ctx.text || ''), ctx.rawMsg.key);
    return true;
  } catch (err) {
    log.warn({ err, chatJid: ctx.chatJid?.slice(0, 12) }, 'Silent-message reaction failed');
    return false;
  }
}

async function generateGroupReply(ctx, toneMode, decision, ownerChatJid) {
  const { chatJid, person, text, rawMsg, isOwner } = ctx;

  try {
    // Check AI budget
    const exhausted = await isBudgetExhausted();
    if (exhausted && !isOwner) {
      const fallback = getFallbackLine('casual', chatJid);
      await humanSend(chatJid, fallback, { sourceMessage: rawMsg });
      recordGroupReply(chatJid);
      await touchGroupBotAt(chatJid);
      return;
    }

    // Build memory pack
    const memoryPack = await buildMemoryPack({
      personId: person?.id,
      groupJid: chatJid,
      messageText: text,
      isGroup: true,
    });

    const recentReplies = await getLastBotReplies(chatJid, 8);

    // Group LLM receives conversation memory only. Never inject live timetable,
    // attendance, calendar, or Pod data into an ordinary group conversation.
    const systemPrompt = buildSystemPrompt({
      toneMode,
      memoryPack,
      isGroup: true,
      isOwnerMessage: isOwner,
    });

    // Generate reply
    const result = await generateReply(systemPrompt, [], text, isOwner);

    // Handle LLM-detected flags that override tone (§15.3)
    if (result.flags?.serious_distress) {
      const seriousResult = await generateReply(
        buildSystemPrompt({ toneMode: 'serious', memoryPack, isGroup: true }),
        [], text
      );
      const parts = seriousResult.reply_parts || [];
      if (parts[0]) {
        const { ok, cleaned } = guardOutput(parts[0], recentReplies, false);
        await humanSend(chatJid, ok ? cleaned : getFallbackLine('casual', chatJid), { sourceMessage: rawMsg });
        recordGroupReply(chatJid);
        await touchGroupBotAt(chatJid);
      } else {
        await reactIfNoReply(ctx, await getGroup(chatJid).catch(() => null), 'llm_silence');
      }
      return;
    }

    if (result.flags?.attack_on_owner) {
      const defResult = await generateReply(
        buildSystemPrompt({ toneMode: 'defender', memoryPack, isGroup: true }),
        [], text
      );
      const parts = defResult.reply_parts || [];
      if (parts[0]) {
        const { ok, cleaned } = guardOutput(parts[0], recentReplies, false);
        await humanSend(chatJid, ok ? cleaned : getFallbackLine('defender', chatJid), { sourceMessage: rawMsg });
        recordGroupReply(chatJid);
        await touchGroupBotAt(chatJid);
      } else {
        await reactIfNoReply(ctx, await getGroup(chatJid).catch(() => null), 'llm_silence');
      }
      return;
    }

    // Personal Pod data check from LLM
    if (result.flags?.wants_dm_topic) {
      await humanSend(chatJid, 'DM mein bol, yahan sabko nahi dikhana 👀', { sourceMessage: rawMsg });
      recordGroupReply(chatJid);
      await touchGroupBotAt(chatJid);
      return;
    }

    // Guard and send each part (§15.5)
    const parts = result.reply_parts || [];
    if (parts.length === 0) {
      await reactIfNoReply(ctx, await getGroup(chatJid).catch(() => null), 'llm_silence');
      return; // LLM chose silence; acknowledge with a reaction when permitted
    }

    let sent = false;
    for (const part of parts.slice(0, 2)) {
      if (!part || !part.trim()) continue;
      const { ok, cleaned } = guardOutput(part, recentReplies, false);

      if (ok && cleaned) {
        await humanSend(chatJid, cleaned, {
          sourceMessage: rawMsg,
          quoted: result.quote && !sent ? rawMsg : undefined,
        });
        sent = true;
      } else {
        // Regenerate once with stricter instruction — just use fallback if still bad (§15.5)
        log.warn({ reason: ok ? 'empty' : 'guard_fail', part: part.slice(0, 30) }, 'Guard rejected part');
      }
    }

    // If all parts were rejected, use fallback
    if (!sent) {
      const category = toneMode === 'deflect' ? 'deflect' : 'casual';
      await humanSend(chatJid, getFallbackLine(category, chatJid), { sourceMessage: rawMsg });
    }

    // React if LLM requested it (§8.3)
    if (result.reaction) {
      await sendReaction(chatJid, result.reaction, rawMsg.key);
    }

    // Record reply for rate limiting
    if (person?.id) recordReply(person.id, chatJid);
    recordGroupReply(chatJid);
    await touchGroupBotAt(chatJid);

    // Process memory ops (§10.2 turn extraction)
    await processMemoryOps(result.memory_ops, person?.id, chatJid, true);

    // Name hint from LLM
    if (result.name_hint && person?.id) {
      const { proposeName } = await import('../skills/naming.js');
      await proposeName(person.id, result.name_hint.name, 'context', {
        text,
        evidence: result.name_hint.evidence,
      }).catch(() => {});
    }

  } catch (err) {
    log.error({ err, chatJid: chatJid.slice(0, 12) }, 'Group reply generation failed');
    const category = toneMode === 'deflect' ? 'deflect' : 'busy';
    await humanSend(chatJid, getFallbackLine(category, chatJid), { sourceMessage: rawMsg }).catch(() => {});
  }
}
