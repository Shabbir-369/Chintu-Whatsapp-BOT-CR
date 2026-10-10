/**
 * src/router/dmHandler.js
 * Private DM handling: approval flow, Pod linking, chat. §11.6, §11.8.
 *
 * Order:
 *   1. Access check (pending/denied → stop or hold message)
 *   2. Pod-related queries (only for approved users)
 *   3. Free chat via LLM
 */
import { getDmAccess, upsertDmAccess, createApproval, genCode, setCardMessageId } from '../db/repos/approvals.js';
import { hasPodAccount } from '../db/repos/pod.js';
import { handleLinkFlow, handleUnlink } from '../skills/pod/link.js';
import { getCourseAttendance, formatAttendance } from '../skills/pod/attendance.js';
import { getBunkData, formatBunkData, whatIfBunk } from '../skills/pod/bunk.js';
import { getMarks, formatMarks } from '../skills/pod/marks.js';
import { getLatestNotices } from '../skills/pod/notices.js';
import { answerTimetableQuestion } from '../skills/timetable.js';
import { humanSend } from '../gateway/outbox.js';
import { generateReply, isBudgetExhausted } from '../brain/llm.js';
import { buildSystemPrompt } from '../brain/persona.js';
import { buildMemoryPack, processMemoryOps } from '../brain/memory.js';
import { guardOutput } from '../brain/guard.js';
import { getFallbackLine, getBusyLine } from '../brain/fallback.js';
import { getLastBotReplies } from '../db/repos/messages.js';
import { recordReply } from '../policy/limits.js';
import { decide } from '../brain/decision.js';
import { getLogger } from '../logger.js';
import { isCalendarQuestion } from '../util/calendar.js';

const log = getLogger('router/dmHandler');

/**
 * Handle a DM message from a non-owner person.
 * @param {object} ctx
 * @param {function} sendOwnerCard – fn(text) → sentMessageId
 */
export async function handleDm(ctx, sendOwnerCard) {
  const { chatJid, person, text, rawMsg } = ctx;
  if (!person) return;

  const t = (text || '').toLowerCase().trim();

  // Notify owner privately if an approved DM probes for hidden/internal information.
  // Do not interrupt the normal access/approval flow or expose secrets in the group.
  if (text) {
    const { isExtractionAttempt } = await import('../brain/guard.js');
    if (isExtractionAttempt(text)) {
      const who = person.display_name || person.push_name || ctx.pushName || 'unknown contact';
      const excerpt = text.replace(/[\r\n]+/g, ' ').slice(0, 180);
      Promise.resolve(sendOwnerCard(`👀 internal-info probe in DM\nwho: ${who}\nmessage: “${excerpt}”`))
        .catch(err => log.warn({ err }, 'Owner DM security alert failed'));
    }
  }

  // ── Step 1: Access check ──────────────────────────────────────────
  const access = await getDmAccess(person.id);

  if (!access) {
    // First message: create pending, send owner card, send holding line (§11.6)
    await upsertDmAccess(person.id, 'pending', text.slice(0, 100));

    const code = await genCode('D');
    const approval = await createApproval({
      code,
      kind: 'dm',
      subjectPersonId: person.id,
      // Keep the exact inbound chat JID. A person can have both phone and LID
      // identities, and choosing an arbitrary identity on approval can send
      // the opening line to the wrong destination.
      payload: { firstMessage: text.slice(0, 100), pushName: ctx.pushName, requestChatJid: chatJid },
    });

    const cardText = `*${code}  new DM request*\nname: ${ctx.pushName || 'unknown'}\nnumber: ${chatJid.replace('@s.whatsapp.net', '')}\nfirst msg: "${text.slice(0, 60)}"\nreply: "${code} yes" / "${code} no"`;

    const sentId = await sendOwnerCard(cardText);
    if (sentId && approval?.id) {
      await setCardMessageId(approval.id, sentId).catch(() => {});
    }
    log.info({ code, personId: person.id, cardSent: Boolean(sentId) }, 'DM approval requested');

    // One holding line to the person (§11.6 — exactly one, no more while pending)
    await humanSend(chatJid, `chintu ne tumhara DM dekh liya 👀 pehle owner se green signal chahiye`, {
      sourceMessage: rawMsg,
    });
    return;
  }

  if (access.status === 'pending') {
    // Already notified owner, don't spam (§11.6)
    log.info({ personId: person.id }, 'DM ignored while approval is pending');
    return;
  }

  if (access.status === 'denied' || access.status === 'revoked') {
    // Silent — blocked user gets nothing (§4.1)
    log.info({ personId: person.id, status: access.status }, 'DM ignored due to access status');
    return;
  }

  // ── Step 2: Approved user — Pod linking: explicit trigger or active session ──
  if (access.status === 'approved') {
    // Only route to link flow if there's an active session OR explicit link command
    const isExplicitLink = t === '!link' || t === 'link pod' ||
      /\b(pod link|link account|connect pod|pod connect)\b/.test(t);
    const podLinkResult = await handleLinkFlow(person.id, text);

    if (podLinkResult.handled) {
      if (podLinkResult.reply) {
        await humanSend(chatJid, podLinkResult.reply, { sourceMessage: rawMsg });
        recordReply(person.id, chatJid);
      }
      return;
    }

    // ── Pod data queries (only if linked) ────────────────────────────
    const podLinked = await hasPodAccount(person.id).catch(() => false);

    // Not linked but asking for data → suggest linking
    if (!podLinked) {
      const wantsData = /\b(attendance|bunk|marks|grade|result|kitni class|chhod sakta|safe.*class)\b/.test(t);
      if (wantsData) {
        await humanSend(chatJid, 'pod account link nahi hai abhi. \"link pod\" bol, main set kar deta hoon', { sourceMessage: rawMsg });
        recordReply(person.id, chatJid);
        return;
      }
    }

    if (podLinked) {
      // Attendance (§11.8)
      if (/\b(attendance|present|absent|kitna percent|kitni class|meri attendance)\b/.test(t)) {
        try {
          const courses = await getCourseAttendance(person.id);
          await humanSend(chatJid, formatAttendance(courses), { sourceMessage: rawMsg });
        } catch (err) {
          log.warn({ err }, 'Attendance fetch failed');
          await humanSend(chatJid, 'pod ne abhi dhoka diya, thodi der baad', { sourceMessage: rawMsg });
        }
        recordReply(person.id, chatJid);
        return;
      }

      // Bunk calculator (§11.8)
      if (/\b(bunk|chhod|skip|safe.*class|kitni.*bunk|bunk.*kar)\b/.test(t)) {
        // What-if check
        const whatIfMatch = text.match(/(\d+)\s*(class|bunk)/i) || text.match(/(kal|aaj).*(bunk|skip)/i);
        try {
          const bunkData = await getBunkData(person.id);

          if (whatIfMatch && !isNaN(parseInt(whatIfMatch[1]))) {
            const m = parseInt(whatIfMatch[1]);
            // Show what-if for each course
            const lines = ['*What-if bunk:*'];
            for (const b of bunkData) {
              const { pctAfter, zoneAfter } = whatIfBunk(b, m);
              const emoji = zoneAfter === 'Green' ? '🟢' : zoneAfter === 'Yellow' ? '🟡' : '🔴';
              if (b.zone !== zoneAfter) {
                lines.push(`${emoji} ${b.code}: ${b.percentage.toFixed(1)}% → ${pctAfter.toFixed(1)}% (${b.zone} → ${zoneAfter})`);
              } else {
                lines.push(`${emoji} ${b.code}: ${pctAfter.toFixed(1)}% (no zone change)`);
              }
            }
            await humanSend(chatJid, lines.join('\n'), { sourceMessage: rawMsg });
          } else {
            await humanSend(chatJid, formatBunkData(bunkData), { sourceMessage: rawMsg });
          }
        } catch (err) {
          log.warn({ err }, 'Bunk fetch failed');
          await humanSend(chatJid, 'pod ne abhi dhoka diya, thodi der baad', { sourceMessage: rawMsg });
        }
        recordReply(person.id, chatJid);
        return;
      }

      // Marks/grades (§11.8)
      if (/\b(marks|grade|result|number|internals|score)\b/.test(t)) {
        try {
          const marks = await getMarks(person.id);
          await humanSend(chatJid, formatMarks(marks), { sourceMessage: rawMsg });
        } catch (err) {
          log.warn({ err }, 'Marks fetch failed');
          await humanSend(chatJid, 'pod ne abhi dhoka diya, thodi der baad', { sourceMessage: rawMsg });
        }
        recordReply(person.id, chatJid);
        return;
      }

      // Notices (§11.8)
      if (/\b(notification|notice|koi notice|announcement)\b/.test(t)) {
        try {
          const notices = await getLatestNotices(5);
          if (!notices.length) {
            await humanSend(chatJid, 'abhi koi naya notice nahi hai', { sourceMessage: rawMsg });
          } else {
            const text = notices.map(n => `• ${n.text.slice(0, 120)}`).join('\n');
            await humanSend(chatJid, text, { sourceMessage: rawMsg });
          }
        } catch (err) {
          await humanSend(chatJid, 'notices nahi mil rahe abhi', { sourceMessage: rawMsg });
        }
        recordReply(person.id, chatJid);
        return;
      }

      // Unlink (§11.8)
      if (/\b(unlink|disconnect pod|pod unlink|remove pod)\b/.test(t)) {
        const reply = await handleUnlink(person.id);
        await humanSend(chatJid, reply, { sourceMessage: rawMsg });
        recordReply(person.id, chatJid);
        return;
      }
    }

    // Timetable questions (no pod needed)
    if (isCalendarQuestion(text) || /\b(timetable|time table|aaj kya|kal kya|class kab|schedule)\b/.test(t)) {
      try {
        const answer = await answerTimetableQuestion(text, null);
        await humanSend(chatJid, answer, { sourceMessage: rawMsg });
      } catch {
        await humanSend(chatJid, 'timetable data nahi mila', { sourceMessage: rawMsg });
      }
      recordReply(person.id, chatJid);
      return;
    }

    // ── Step 3: Free chat via LLM ─────────────────────────────────
    await generateDmReply(ctx);
  }
}

async function generateDmReply(ctx) {
  const { chatJid, person, text, rawMsg, isOwner } = ctx;

  try {
    // Build memory pack
    const memoryPack = await buildMemoryPack({
      personId: person.id,
      groupJid: null,
      messageText: text,
      isGroup: false,
    });
    const recentReplies = await getLastBotReplies(chatJid, 8);

    // Check budget
    const exhausted = await isBudgetExhausted();
    if (exhausted) {
      await humanSend(chatJid, getBusyLine(chatJid), { sourceMessage: rawMsg });
      return;
    }

    // Use decision engine to pick tone mode (handles distress, deflect, etc.)
    const decision = await decide(ctx);
    const toneMode = decision.toneMode || 'savage';
    if (decision.reason === 'extraction_attempt') {
      const { getDeflectLine } = await import('../brain/fallback.js');
      await humanSend(chatJid, getDeflectLine(chatJid), { sourceMessage: rawMsg, priority: !!isOwner });
      return;
    }

    // Live class context from DB
    let liveContext = '';
    try {
      const { getDayTimetable } = await import('../skills/timetable.js');
      const { toISTDateString } = await import('../util/time.js');
      const dayData = await getDayTimetable(new Date());
      liveContext = `Today: ${dayData.dayName} ${toISTDateString(new Date())}. Classes: ${dayData.rawEntries.map(e => `${e.short}@${String(e.start_time).slice(0,5)}`).join(', ') || 'none'}. Holiday: ${dayData.holiday ? dayData.holiday.name : 'none'}.`;
    } catch { /* non-fatal */ }

    const systemPrompt = buildSystemPrompt({
      toneMode,
      memoryPack,
      classContext: liveContext ? { liveContext } : undefined,
      isGroup: false,
      isOwnerMessage: false,
    });

    const result = await generateReply(systemPrompt, [], text, false);

    // Guard output
    const parts = result.reply_parts || [];
    if (parts.length === 0) return;

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
      }
    }

    if (!sent) {
      await humanSend(chatJid, getFallbackLine('casual', chatJid), { sourceMessage: rawMsg });
    }

    // React if LLM says so
    if (result.reaction) {
      const { sendReaction } = await import('../gateway/outbox.js');
      await sendReaction(chatJid, result.reaction, rawMsg.key);
    }

    recordReply(person.id, chatJid);

    // Memory ops
    await processMemoryOps(result.memory_ops, person.id, null, false);

  } catch (err) {
    log.error({ err }, 'DM reply generation failed');
    await humanSend(chatJid, getBusyLine(chatJid), { sourceMessage: rawMsg }).catch(() => {});
  }
}
