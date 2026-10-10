/**
 * src/router/ownerConsole.js
 * Owner intent parsing and command execution. §11.1, §11.2, §11.4, §11.5.
 * Intent parsing: first regex rules, then model fallback.
 */
import { getAllGroups, enableGroup, disableGroup, setGroupMode } from '../db/repos/groups.js';
import { getRecentPeopleForResolution, getIdentities, addOwnerJid } from '../db/repos/people.js';
import {
  findOpenApproval, findApprovalByMessageId, decideApproval,
  getOpenApprovals, createApproval, genCode, setCardMessageId,
  getDmAccess, setDmAccess,
} from '../db/repos/approvals.js';
import { executeNameDecision, assignNameDirectly } from '../skills/naming.js';
import { addDayNote, setSetting } from '../db/repos/timetable.js';
import { scheduleOrderedMessage, resolveTarget } from '../skills/sendOrder.js';
import { buildIntentParserPrompt } from '../brain/persona.js';
import { parseOwnerIntent } from '../brain/llm.js';
import { fuzzyMatch, resolveDisambigChoice } from '../util/fuzzy.js';
import { runMassBunkAnalysis } from '../skills/massBunk.js';
import { config } from '../config.js';
import { getLogger } from '../logger.js';
import { isExtractionAttempt } from '../brain/guard.js';
import { getDeflectLine } from '../brain/fallback.js';
import { parseScheduledMessageCommand, parseSelfReminderCommand, parseScheduleDateTime, formatScheduledIST } from '../util/scheduleTime.js';
import { isSelfTargetName, scheduleSelfReminder, setPendingReminderDraft, getPendingReminderDraft, clearPendingReminderDraft } from '../skills/reminder.js';
import { toISTDateString } from '../util/time.js';
import { isCalendarQuestion } from '../util/calendar.js';
import { isTimetableQuestion } from '../util/timetableQuery.js';
import { parseGroupControlCommand } from '../util/groupCommand.js';
import { findGroupTarget } from '../util/groupResolver.js';
import { findPersonTarget } from '../util/personResolver.js';
import { isPodDataRequest, isPodLinkCommand } from '../util/podIntent.js';

const log = getLogger('router/ownerConsole');

// Pending disambiguation states per owner session
const pendingDisambig = new Map(); // ownerJid -> { type, candidates, originalIntent }

/**
 * Handle an owner message. Returns a reply string.
 * @param {object} ctx
 * @param {string} ownerChatJid – the chat JID for sending replies
 * @returns {Promise<string|null>} reply to send
 */
export async function handleOwnerMessage(ctx, ownerChatJid) {
  const { text, senderJid, rawMsg } = ctx;
  const t = text.trim();
  const tl = t.toLowerCase();

  // ── !claim flow ───────────────────────────────────────────────────
  if (t.startsWith('!claim ')) {
    const secret = t.slice(7).trim();
    if (secret === config.OWNER_SECRET) {
      await addOwnerJid(senderJid);
      try {
        const { deleteMessage } = await import('../gateway/socket.js');
        await deleteMessage(ctx.chatJid, rawMsg.key);
      } catch {}
      return 'claimed. ab tu boss hai 😎';
    }
    return null;
  }

  // Keep internal prompts, configuration and secrets private, even from prompt-extraction requests.
  if (isExtractionAttempt(t)) return getDeflectLine(ownerChatJid);

  // ── Pod link session continuation (MUST be before intent engine) ──
  // An active session continues; explicit link commands and unlinked Pod-data
  // requests such as "attendance bata" start directly at the email step.
  {
    const { handleLinkFlow } = await import('../skills/pod/link.js');
    const { getPodLinkSession } = await import('../db/repos/pod.js');
    const linkSession = await getPodLinkSession(ctx.person?.id).catch(() => null);

    const isExplicitLinkTrigger = isPodLinkCommand(tl);
    const isDataRequest = isPodDataRequest(tl);

    if (linkSession || isExplicitLinkTrigger || isDataRequest) {
      const res = await handleLinkFlow(ctx.person?.id, text);
      if (res.handled) {
        return res.reply || null;
      }
      // res.handled=false means link.js determined message is conversational → fall through to normal chat
    }
  }

  // ── Pod data queries (owner asking for their own data) ────────────
  {
    const { hasPodAccount } = await import('../db/repos/pod.js');
    const linked = await hasPodAccount(ctx.person?.id).catch(() => false);

    if (linked) {
      if (/\b(meri attendance|attendance bata|attendance dikhao|attendance check|kitni attendance|attendance dekh)\b/i.test(tl)) {
        try {
          const { getCourseAttendance, formatAttendance } = await import('../skills/pod/attendance.js');
          const courses = await getCourseAttendance(ctx.person.id);
          return formatAttendance(courses);
        } catch (err) {
          log.warn({ err }, 'Owner attendance fetch failed');
          return 'pod ne abhi dhoka diya, thodi der baad try kar';
        }
      }

      if (/\b(bunk|kitna bunk|safe bunk|bunk calculator|chhod sakta)\b/i.test(tl)) {
        try {
          const { getBunkData, formatBunkData } = await import('../skills/pod/bunk.js');
          const bunkData = await getBunkData(ctx.person.id);
          return formatBunkData(bunkData);
        } catch (err) {
          log.warn({ err }, 'Owner bunk fetch failed');
          return 'pod ne abhi dhoka diya, thodi der baad try kar';
        }
      }

      if (/\b(marks|grade|result|number|internals)\b/i.test(tl)) {
        try {
          const { getMarks, formatMarks } = await import('../skills/pod/marks.js');
          const marks = await getMarks(ctx.person.id);
          return formatMarks(marks);
        } catch (err) {
          log.warn({ err }, 'Owner marks fetch failed');
          return 'pod ne abhi dhoka diya, thodi der baad try kar';
        }
      }
    } else {
      // Normally the automatic-link path above handles this before reaching the fallback.
      if (isPodDataRequest(tl) && !/status|group|message|send|schedule|notice|holiday|timetable/i.test(tl)) {
        return 'apna Medi-Caps Pod login email bhej — linking wahi se start karte hain. Agar link flow active nahi hua toh ek baar “link pod” bhej.';
      }
    }
  }

  // ── Check pending disambiguation ──────────────────────────────────
  const pending = pendingDisambig.get(senderJid);
  if (pending) {
    if (/^(?:cancel|stop|rehne de|chhod de|forget it)$/i.test(t)) {
      pendingDisambig.delete(senderJid);
      return 'theek hai, selection cancel kar di.';
    }
    // A fresh command takes priority over a pending choice; don't accidentally
    // interpret it as a group/person name and execute the wrong action.
    if (!parseGroupControlCommand(t)) {
      return handleDisambigReply(senderJid, t, pending, ownerChatJid, ctx);
    }
    pendingDisambig.delete(senderJid);
  }

  // ── Incomplete schedule follow-up: ask only for the missing field ──
  const scheduleDraft = getPendingReminderDraft(senderJid);
  if (scheduleDraft?.source === 'owner-schedule') {
    if (/^(?:cancel|stop|rehne de|chhod de|cancel reminder)$/i.test(t)) {
      clearPendingReminderDraft(senderJid);
      return 'theek hai, scheduling cancel kar di.';
    }
    // Explicit new actions should not be swallowed as a missing field.
    if (parseScheduledMessageCommand(t) || parseSelfReminderCommand(t) || parseGroupControlCommand(t) || isTimetableQuestion(t) || /^(?:status|groups dikha|help)$/i.test(t)) {
      clearPendingReminderDraft(senderJid);
    } else {
      const entities = { ...(scheduleDraft.entities || {}) };
      if (scheduleDraft.missing === 'target') entities.person = t;
      else if (scheduleDraft.missing === 'message') entities.text = t;
      else if (scheduleDraft.missing === 'time') entities.scheduleAtPhrase = t;
      clearPendingReminderDraft(senderJid);
      return executeIntent({ intent: 'SCHEDULE_MESSAGE', entities, confidence: 1 }, ctx, ownerChatJid);
    }
  }

  // ── Approval shortcuts: "D4 yes", "N7 no", etc. ──────────────────
  const approvalMatch = t.match(/^([DNGM]\d+)\s+(yes|no|approve|reject|haan|nahi)(.*)$/i);
  if (approvalMatch) {
    const code = approvalMatch[1].toUpperCase();
    const decision = /yes|approve|haan/i.test(approvalMatch[2]) ? 'approved' : 'rejected';
    const extra = approvalMatch[3].trim();
    return handleApprovalCode(code, decision, extra, ctx);
  }

  // ── Quote-reply approval resolution ──────────────────────────────
  const quotedId = rawMsg?.message?.extendedTextMessage?.contextInfo?.stanzaId;
  if (quotedId) {
    const approval = await findApprovalByMessageId(quotedId);
    if (approval) {
      const decision = /yes|approve|haan/i.test(t) ? 'approved' : 'rejected';
      return handleApprovalCode(approval.code, decision, '', ctx);
    }

    // Cards created before the delivery-result fix have no card_message_id.
    // If the owner quote-replies to a pending summary and there is exactly one
    // open request, resolve it without guessing between multiple people.
    if (/^(yes|no|approve|reject|haan|nahi)$/i.test(t)) {
      const openApprovals = await getOpenApprovals();
      if (openApprovals.length === 1) {
        const decision = /yes|approve|haan/i.test(t) ? 'approved' : 'rejected';
        return handleApprovalCode(openApprovals[0].code, decision, '', ctx);
      }
    }
  }

  // ── Rule-based intent detection ───────────────────────────────────
  const ruleIntent = detectIntentByRules(text);
  if (ruleIntent && ruleIntent.confidence >= 0.85) {
    return executeIntent(ruleIntent, ctx, ownerChatJid);
  }

  // ── Model fallback ────────────────────────────────────────────────
  try {
    const prompt = buildIntentParserPrompt(t);
    const parsed = await parseOwnerIntent(prompt, t);
    if (parsed.confidence >= 0.7) {
      return executeIntent({ ...parsed, entities: parsed.entities || {} }, ctx, ownerChatJid);
    }
  } catch (err) {
    log.warn({ err }, 'Intent parser model failed');
  }

  // Not a command: return null (let brain handle as normal chat)
  return null;
}

/**
 * Rule-based intent detection.
 */
function detectIntentByRules(text) {
  const t = text.toLowerCase().trim();

  // One parser handles enable/unmute, mute/stop-talking, and every mode change.
  // Missing or uncertain targets are resolved through the same numbered-choice flow.
  const groupControl = parseGroupControlCommand(text);
  if (groupControl) return groupControl;

  // Status
  if (/^status$|^kya chal raha|^sab theek/.test(t)) {
    return { intent: 'GET_STATUS', entities: {}, confidence: 0.95 };
  }

  // Timetable reload
  if (/reload|import data|data reload/.test(t)) {
    return { intent: 'RELOAD_DATA', entities: {}, confidence: 0.9 };
  }

  // Scheduled send/reminder patterns must be detected before ordinary send rules.
  const scheduled = parseScheduledMessageCommand(text);
  if (scheduled) {
    return {
      intent: 'SCHEDULE_MESSAGE',
      entities: { person: scheduled.target, text: scheduled.message, scheduleAtPhrase: scheduled.timePhrase },
      confidence: 0.98,
    };
  }
  const selfReminder = parseSelfReminderCommand(text);
  if (selfReminder) {
    return {
      intent: 'SCHEDULE_MESSAGE',
      entities: { person: 'mujhe', text: selfReminder.message, scheduleAtPhrase: selfReminder.timePhrase, selfReminder: true },
      confidence: 0.98,
    };
  }

  // Send message — multiple natural patterns:
  // "Rahul ko bol class mein aa"
  // "Rahul ko message kar 'text'"
  // "message bhej Rahul ko 'text'"
  const sendMatch =
    text.match(/^(.+?)\s+ko\s+(?:bol|bata|bhej|message kar|message bhej)\s+["']?(.+?)["']?$/i) ||
    text.match(/^(?:message (?:kar|bhej))\s+(.+?)\s+ko\s+["']?(.+?)["']?$/i);
  if (sendMatch) {
    // Swap groups depending on which pattern matched
    const isSwapped = sendMatch[0].match(/^(?:message)/i);
    const person = isSwapped ? sendMatch[1]?.trim() : sendMatch[1]?.trim();
    const msgText = sendMatch[2]?.trim();
    if (person && msgText) {
      return {
        intent: 'SEND_MESSAGE',
        entities: { person, text: msgText },
        confidence: 0.85,
      };
    }
  }

  // Timetable / schedule queries, including two-word spelling and weekly requests.
  if (isTimetableQuestion(t)) {
    return { intent: 'GET_TIMETABLE', entities: {}, confidence: 0.95 };
  }

  // Complete academic-calendar lookup, not just MST and holiday keywords.
  if (isCalendarQuestion(text) || /\b(holiday|chhutti|mst|exam kab|test kab|agli chhutti|next holiday)\b/i.test(t)) {
    return { intent: 'GET_TIMETABLE', entities: {}, confidence: 0.92 };
  }

  // Day note
  if (/kal|aaj|parso|monday|tuesday|wednesday|thursday|friday/.test(t) &&
      /cancel|holiday|seminar|class nahi|class hai|band hai|schedule/.test(t)) {
    return { intent: 'ADD_DAY_NOTE', entities: { text: text }, confidence: 0.8 };
  }

  // Forget
  if (/^bhul ja|^forget/.test(t)) {
    const name = t.replace(/^(bhul ja|forget)\s*/i, '').trim();
    return { intent: 'FORGET_PERSON', entities: { person: name }, confidence: 0.85 };
  }

  // List groups
  if (/groups dikha|kaun kaun se groups/.test(t)) {
    return { intent: 'LIST_GROUPS', entities: {}, confidence: 0.95 };
  }

  // Stats / Mass bunk
  if (/stats|mass bunk.*stats|kitno ki attendance/.test(t)) {
    return { intent: 'MASS_BUNK_STATS', entities: {}, confidence: 0.85 };
  }

  // Conversation starter
  if (/conversation start|group me kuch bol|mahaul bana|starter/.test(t)) {
    return { intent: 'CONVERSATION_STARTER', entities: {}, confidence: 0.85 };
  }

  // Attendance format preference
  if (/\b(subject.*naam|naam.*saath|full name|subject name|naam bhi|poora naam)\b/i.test(t) &&
      /\b(attendance|bhej|dikhao)\b/i.test(t)) {
    return { intent: 'GET_ATTENDANCE', entities: {}, confidence: 0.95 };
  }

  // Approve pending DMs / open approvals
  if (/\b(pending|approval|ginti|sahi kar|approve kar|kitne log|kitne pending|open approvals|DM requests?)\b/i.test(t)) {
    return { intent: 'LIST_APPROVALS', entities: {}, confidence: 0.88 };
  }

  // How many people / groups
  if (/kitne (log|group|member|band)|kaun kaun (log|hai)|list.*members/i.test(t)) {
    return { intent: 'LIST_GROUPS', entities: {}, confidence: 0.85 };
  }

  return null;
}

function formatGroupChoices(candidates) {
  return candidates.map((c, i) => {
    const item = c.item || {};
    const label = item.subject || item.display_name || item.push_name || item.name || 'unknown';
    return item.subject ? `${i + 1}. ${label} (${item.member_count || '?'} members)` : `${i + 1}. ${label}`;
  }).join('\n');
}

function formatTargetChoices(candidates) {
  return candidates.map((c, i) => {
    const item = c.item || {};
    const isGroup = item.__targetType === 'group' || (!!item.subject && !item.display_name);
    const label = item.subject || item.display_name || item.push_name || item.name || 'unknown';
    return `${i + 1}. [${isGroup ? 'group' : 'person'}] ${label}`;
  }).join('\n');
}

function formatPersonChoices(candidates) {
  return candidates.map((c, i) => {
    const item = c.item || {};
    return `${i + 1}. ${item.display_name || item.push_name || item.name || 'unknown person'}`;
  }).join('\n');
}

async function applyGroupControl(type, group, requestedMode) {
  if (!group?.jid) return 'group select nahi ho paya';
  if (type === 'DISABLE_GROUP') {
    await setGroupMode(group.jid, 'mute');
    await disableGroup(group.jid);
    return `${group.subject} mein ab bilkul chup — mute kar diya.`;
  }
  if (type === 'SET_MODE') {
    const mode = ['ambient', 'trigger', 'mute'].includes(requestedMode) ? requestedMode : 'ambient';
    if (mode === 'mute') {
      await setGroupMode(group.jid, 'mute');
      await disableGroup(group.jid);
      return `${group.subject} ko mute kar diya. ab wahan reply nahi karega.`;
    }
    // Switching to a speaking mode should also re-enable groups previously disabled.
    await enableGroup(group.jid, mode);
    return `${group.subject} ka mode ${mode} kar diya.`;
  }
  await enableGroup(group.jid, 'ambient');
  return `${group.subject} unmute/enable ho gaya — ambient mode mein ab bolega.`;
}

async function executeGroupControl(parsed, ctx) {
  const { intent, entities = {} } = parsed;
  const groups = await getAllGroups();
  if (!groups.length) return 'koi WhatsApp group nahi mila. pehle group list sync karwa.';

  const { match, candidates } = findGroupTarget(entities.group, groups);
  if (match) return applyGroupControl(intent, match, entities.mode);

  const usable = candidates.length ? candidates : groups.map(item => ({ item, score: 0 }));
  pendingDisambig.set(ctx.senderJid, { type: intent, candidates: usable, originalIntent: parsed });
  const actionLabel = intent === 'ENABLE_GROUP' ? 'unmute/enable' : intent === 'DISABLE_GROUP' ? 'mute' : `${entities.mode || 'ambient'} mode set`;
  return `${entities.group ? `“${entities.group}” ka exact group match clear nahi hua` : `kis group mein ${actionLabel} karna hai?`}\n${formatGroupChoices(usable)}\nnumber ya exact naam reply kar de.`;
}

/**
 * Execute a parsed intent.
 */
async function executeIntent(parsed, ctx, ownerChatJid) {
  const { intent, entities } = parsed;
  const { senderJid } = ctx;

  switch (intent) {
    case 'ENABLE_GROUP':
    case 'DISABLE_GROUP':
    case 'SET_MODE':
      return executeGroupControl(parsed, ctx);

    case 'GET_STATUS': {
      const { getSocketState } = await import('../gateway/socket.js');
      const { getUsageToday } = await import('../db/repos/timetable.js');
      const state = getSocketState();
      const aiCalls = await getUsageToday('ai_calls');
      const openApprovals = await getOpenApprovals();
      const groups = await getAllGroups();
      const enabled = groups.filter(g => g.enabled).length;

      let statusLines = [
        `*Status:*`,
        `🔗 WhatsApp: ${state.connected ? 'connected' : 'disconnected'}`,
        `🤖 AI calls today: ${aiCalls}/${config.DAILY_AI_CAP}`,
        `👥 Enabled groups: ${enabled}`,
        `📋 Pending approvals: ${openApprovals.length}`,
      ];

      // Show pending approvals if any
      if (openApprovals.length > 0) {
        statusLines.push('');
        for (const a of openApprovals.slice(0, 5)) {
          const payload = a.payload || {};
          const name = payload.pushName || 'unknown';
          const msg = payload.firstMessage ? `"${String(payload.firstMessage).slice(0, 40)}"` : '';
          statusLines.push(`  ${a.code}: ${name} ${msg}`);
        }
        if (openApprovals.length > 5) statusLines.push(`  ...aur ${openApprovals.length - 5} aur`);
      }

      return statusLines.join('\n');
    }

    case 'LIST_APPROVALS': {
      const openApprovals = await getOpenApprovals();
      if (!openApprovals.length) return 'koi pending approval nahi hai abhi';
      const lines = openApprovals.map(a => {
        const payload = a.payload || {};
        // Use DB-joined fields first, fall back to payload
        const name = a.push_name || a.display_name || payload.pushName || 'unknown';
        const phone = a.phone || (a.jid ? a.jid.replace('@s.whatsapp.net', '') : null) || 'no number';
        const msg = payload.firstMessage ? ` — "${String(payload.firstMessage).slice(0, 50)}"` : '';
        return `${a.code}: *${name}* (+${phone})${msg}\n  → "${a.code} yes" ya "${a.code} no"`;
      });
      return `*${openApprovals.length} pending approvals:*\n\n${lines.join('\n\n')}`;
    }

    case 'RELOAD_DATA': {
      try {
        const { default: importData } = await import('../../scripts/import-data.js').catch(() => ({ default: null }));
        if (importData) await importData();
        return 'data reload ho gaya';
      } catch (err) {
        log.warn({ err }, 'Reload data failed');
        return 'data reload nahi hua, manually run: npm run import:data';
      }
    }

    case 'SEND_MESSAGE': {
      if (!entities.person || !entities.text) return 'kisko bhejunga aur kya bhejunga?';
      const people = await getRecentPeopleForResolution();
      const groups = await getAllGroups();
      const target = entities.resolvedTarget
        ? { match: entities.resolvedTarget.item, type: entities.resolvedTarget.type, ambiguous: false }
        : resolveTarget(entities.person, people, groups);

      if (target.match) {
        const jid = target.type === 'group' ? target.match.jid :
          (await import('../db/repos/people.js').then(m => m.getIdentities(target.match.id)).catch(() => []))[0]?.jid;
        if (!jid) return `${entities.person} ka JID nahi mila`;
        const { payload } = await scheduleOrderedMessage({
          targetJid: jid, message: entities.text, runAt: null, verbatim: entities.verbatim,
        });
        // Send immediately
        const { humanSend } = await import('../gateway/outbox.js');
        await humanSend(jid, entities.text, { priority: false });
        return `bhej diya: "${entities.text.slice(0, 50)}..."`;
      }
      if (target.ambiguous) {
        pendingDisambig.set(senderJid, { type: 'SEND_MESSAGE', candidates: target.candidates, originalIntent: { ...parsed, entities } });
        return `kaun?\n${formatTargetChoices(target.candidates)}\nnumber ya naam reply kar de`;
      }
      return `${entities.person} ka clear match nahi mila. naam dobara likh ya target list mein se choose kar.`;
    }

    case 'ADD_DAY_NOTE': {
      await addDayNote({ date: toISTDateString(new Date()), groupJid: ctx.isGroup ? ctx.chatJid : null, text: entities.text || ctx.text });
      return 'note add kar diya';
    }

    case 'GET_ATTENDANCE': {
      const { getCourseAttendance, formatAttendance } = await import('../skills/pod/attendance.js');
      try {
        const courses = await getCourseAttendance(ctx.person?.id);
        return formatAttendance(courses);
      } catch (err) {
        return 'pod ne abhi dhoka diya, ya account link nahi hai';
      }
    }

    case 'GET_BUNK': {
      const { getBunkData, formatBunkData } = await import('../skills/pod/bunk.js');
      try {
        const bunkData = await getBunkData(ctx.person?.id);
        return formatBunkData(bunkData);
      } catch (err) {
        return 'pod ne abhi dhoka diya, ya account link nahi hai';
      }
    }

    case 'GET_TIMETABLE': {
      const { answerTimetableQuestion } = await import('../skills/timetable.js');
      return answerTimetableQuestion(ctx.text);
    }

    case 'GET_NOTICES': {
      const { getLatestNotices } = await import('../skills/pod/notices.js');
      const notices = await getLatestNotices(5);
      if (!notices.length) return 'koi notice nahi abhi';
      return notices.map(n => `• ${n.text.slice(0, 100)}`).join('\n');
    }

    case 'SET_SETTING': {
      if (entities.setting_key && entities.setting_value !== undefined) {
        await setSetting(entities.setting_key, entities.setting_value);
        // If it's attendance format, immediately resend attendance with new format
        if (entities.setting_key === 'attendance_format') {
          const { getCourseAttendance, formatAttendance } = await import('../skills/pod/attendance.js');
          try {
            const courses = await getCourseAttendance(ctx.person?.id);
            return formatAttendance(courses);
          } catch {
            return `setting save ho gaya (${entities.setting_key} = ${entities.setting_value}). attendance dobara fetch karte hain...`;
          }
        }
        return `${entities.setting_key} = ${entities.setting_value} ✓`;
      }
      return 'setting key aur value dono chahiye';
    }

    case 'CONVERSATION_STARTER': {
      const { tryConversationStarters } = await import('../skills/starter.js');
      await tryConversationStarters(true); // force=true: bypass time/alive checks
      return 'conversation starter bhej diya enabled groups mein';
    }

    case 'LIST_GROUPS': {
      const groups = await getAllGroups();
      if (!groups.length) return 'koi group nahi hai';
      const lines = groups.map(g => `- ${g.subject}: ${g.member_count || 0} members, ${g.enabled ? `ON (${g.mode})` : 'OFF'}`);
      return `*Groups:*\n${lines.join('\n')}`;
    }

    case 'MASS_BUNK_STATS': {
      const groups = await getAllGroups();
      if (!groups.length) return 'koi WhatsApp group nahi mila. pehle group list sync karwa.';

      // Use the same strict resolver as mute/unmute/mode changes: never guess a
      // weak match for analysis that triggers a group-facing workflow.
      let targetGroup = null;
      if (entities.group) {
        const resolution = findGroupTarget(entities.group, groups);
        targetGroup = resolution.match;
        if (!targetGroup) {
          const candidates = resolution.candidates.length
            ? resolution.candidates
            : groups.map(item => ({ item, score: 0 }));
          pendingDisambig.set(senderJid, { type: 'MASS_BUNK_STATS', candidates, originalIntent: parsed });
          return `“${entities.group}” ka exact group match clear nahi hua. kis group ka mass-bunk analysis karun?\n${formatGroupChoices(candidates)}\nnumber ya exact naam reply kar de.`;
        }
      } else {
        targetGroup = groups.find(g => g.enabled);
      }

      if (!targetGroup) return 'mass-bunk analysis ke liye group select nahi ho paya. group ka naam bata.';
      // entities.date is a string like '2026-10-08'; convert to a proper Date
      const targetDate = entities.date
        ? new Date(entities.date + 'T00:00:00+05:30')
        : new Date();
      await runMassBunkAnalysis(targetGroup.jid, targetDate, ownerChatJid);
      return `mass bunk analysis chal rahi hai — report thodi der mein aayegi`;
    }

    case 'FORGET_PERSON': {
      if (!entities.person) return 'kisko bhulna hai?';
      let person = entities.resolvedPerson || null;
      if (!person) {
        const people = await getRecentPeopleForResolution();
        const result = findPersonTarget(entities.person, people);
        if (!result.match) {
          if (!result.candidates.length) return `${entities.person} naam ka contact nahi mila.`;
          pendingDisambig.set(senderJid, { type: 'FORGET_PERSON', candidates: result.candidates, originalIntent: parsed });
          return `kis person ki memory bhoolun?\n${formatPersonChoices(result.candidates)}\nnumber ya naam reply kar de`;
        }
        person = result.match;
      }
      try {
        const { forgetPerson } = await import('../db/repos/memory.js');
        await forgetPerson(person.id);
        return `${person.display_name || person.push_name || entities.person} ke baare mein sab bhool gaya`;
      } catch {
        return `${person.display_name || entities.person} ke baare mein bhoolne mein error aayi`;
      }
    }

    case 'SCHEDULE_MESSAGE': {
      const selfReminder = entities.selfReminder === true || isSelfTargetName(entities.person);
      const message = String(entities.text || '').trim();
      const targetName = String(entities.person || '').trim();

      if (!message) {
        setPendingReminderDraft(senderJid, {
          source: 'owner-schedule', missing: 'message',
          entities: { ...entities, selfReminder, ...(selfReminder ? { person: 'mujhe' } : {}) },
        });
        return selfReminder ? 'kis baat ka reminder chahiye? bas woh bata de.' : 'kya message bheju? message ka text bata de.';
      }
      if (!selfReminder && !targetName) {
        setPendingReminderDraft(senderJid, { source: 'owner-schedule', missing: 'target', entities: { ...entities, text: message } });
        return 'kisko bheju? contact ya group ka naam bata de.';
      }

      const phrase = entities.scheduleAtPhrase || entities.time || entities.datetime || entities.date;
      const runAt = parseScheduleDateTime(phrase || '', {
        now: new Date(), explicitTime: entities.time, explicitDate: entities.date,
      });
      if (!runAt) {
        setPendingReminderDraft(senderJid, {
          source: 'owner-schedule', missing: 'time',
          entities: { ...entities, text: message, selfReminder, ...(selfReminder ? { person: 'mujhe' } : {}) },
        });
        return selfReminder ? 'kab yaad dilau? jaise kal subah 8 baje.' : 'kis time bheju? jaise kal subah 8 baje ya aaj 6 pm.';
      }

      if (selfReminder) {
        clearPendingReminderDraft(senderJid);
        const result = await scheduleSelfReminder({
          requesterJid: ctx.chatJid,
          requesterPersonId: ctx.person?.id || null,
          message,
          runAt,
        });
        return result.reply;
      }

      const people = await getRecentPeopleForResolution(100);
      const groups = await getAllGroups();
      const target = entities.resolvedTarget
        ? { match: entities.resolvedTarget.item, type: entities.resolvedTarget.type, ambiguous: false, candidates: [] }
        : resolveTarget(targetName, people, groups);
      if (target.ambiguous || !target.match) {
        const candidates = target.candidates?.length ? target.candidates : [
          ...groups.map(item => ({ item: { ...item, __targetType: 'group' }, score: 0 })),
          ...people.map(item => ({ item: { ...item, __targetType: 'person' }, score: 0 })),
        ].slice(0, 10);
        if (!candidates.length) return `“${targetName}” ka contact ya group nahi mila. naam dobara bata de.`;
        const intentForClarification = { ...parsed, entities: { ...entities, scheduledAtISO: runAt.toISOString() } };
        pendingDisambig.set(senderJid, { type: 'SCHEDULE_MESSAGE', candidates, originalIntent: intentForClarification });
        return `“${targetName}” ke liye clear match nahi mila. kis target par bheju?\n${formatTargetChoices(candidates)}\nnumber ya naam reply kar de.`;
      }

      let jid = target.type === 'group' ? target.match.jid : null;
      if (target.type !== 'group') {
        const identities = await getIdentities(target.match.id).catch(() => []);
        const preferred = identities.find(identity => String(identity.jid || '').endsWith('@s.whatsapp.net'))
          || identities.find(identity => identity.kind === 'phone')
          || identities[0];
        jid = preferred?.jid || null;
      }
      if (!jid) {
        const candidates = target.candidates?.length ? target.candidates : [];
        if (candidates.length) {
          pendingDisambig.set(senderJid, { type: 'SCHEDULE_MESSAGE', candidates, originalIntent: { ...parsed, entities: { ...entities, scheduledAtISO: runAt.toISOString() } } });
          return `WhatsApp contact ka exact address nahi mila. inmein se choose kar:\n${formatTargetChoices(candidates)}\nnumber ya naam reply kar de.`;
        }
        return `${targetName} ka WhatsApp contact nahi mila. kisi aur saved naam se try kar.`;
      }

      const result = await scheduleOrderedMessage({
        targetName, targetJid: jid, message,
        runAt, verbatim: entities.verbatim,
      });
      if (!result.ok) return result.reply;
      clearPendingReminderDraft(senderJid);
      const label = target.match.subject || target.match.display_name || target.match.push_name || targetName;
      return `✅ *${label}* ke liye schedule kar diya — ${formatScheduledIST(runAt)} pe bhejunga.`;
    }

    case 'MERGE_PEOPLE': {
      return 'merge_people currently requires DB access directly or exact names';
    }

    case 'NAME_SET': {
      if (!entities.person || !entities.text) return 'kiska naam kya set karu?';
      let person = entities.resolvedPerson || null;
      if (!person) {
        const people = await getRecentPeopleForResolution();
        const result = findPersonTarget(entities.person, people);
        if (!result.match) {
          if (!result.candidates.length) return `${entities.person} naam ka contact nahi mila.`;
          pendingDisambig.set(senderJid, { type: 'NAME_SET', candidates: result.candidates, originalIntent: parsed });
          return `kis person ka naam change karna hai?\n${formatPersonChoices(result.candidates)}\nnumber ya naam reply kar de`;
        }
        person = result.match;
      }
      await assignNameDirectly(person.id, entities.text);
      return `${person.display_name || person.push_name || 'wo'} ka naam ab se ${entities.text} set kar diya`;
    }

    case 'NAME_APPROVE':
    case 'NAME_REJECT':
    case 'APPROVE_DM':
    case 'DENY_DM':
    case 'REVOKE_DM': {
      return `ye kaam pending card ka number likh ke ya card pe reply karke kar (jaise "D4 yes")`;
    }

    case 'ADD_GROUP_RULE': {
      return 'Group rule feature not fully mapped yet. Use SETTINGS.';
    }

    case 'SILENCE_BOT': {
      return 'Bot ko silence karne ke liye DISABLE_GROUP use kar.';
    }

    default:
      return null; // Not a command, treat as chat
  }
}

/**
 * Handle an approval code decision.
 */
async function handleApprovalCode(code, decision, extra, ctx) {
  const approval = await findOpenApproval(code);
  if (!approval) return `${code} nahi mila ya already decided`;

  if (approval.kind === 'name') {
    const { displayName, wasApproved } = await executeNameDecision(approval, decision);
    if (wasApproved) return `naam approved: ${displayName}`;
    return 'naam reject kar diya';
  }

  if (approval.kind === 'dm') {
    await decideApproval(approval.id, decision);
    const personId = approval.subject_person_id;
    if (decision === 'approved') {
      await setDmAccess(personId, 'approved');
      // Send approval message to person
      try {
        const identities = await (await import('../db/repos/people.js')).getIdentities(personId);
        const payload = approval.payload || {};
        const jid = payload.requestChatJid ||
          identities.find(identity => identity.kind === 'phone')?.jid ||
          identities[0]?.jid;
        if (jid) {
          const { humanSend } = await import('../gateway/outbox.js');
          const sent = await humanSend(jid, 'owner ne haan bol diya. ab bol, kya scene hai');
          log.info({ code, personId, openingSent: Boolean(sent?.key?.id) }, 'DM approval decided');
        } else {
          log.warn({ code, personId }, 'DM approved but no destination identity was found');
        }
      } catch (err) {
        log.warn({ err, code, personId }, 'Could not send DM approval opening');
      }
      return `DM ${code} approve kar diya`;
    } else {
      await setDmAccess(personId, 'denied');
      log.info({ code, personId }, 'DM approval denied');
      return `DM ${code} deny kar diya`;
    }
  }

  await decideApproval(approval.id, decision, extra || null);
  return `${code} ${decision === 'approved' ? 'approve' : 'reject'} kar diya`;
}

/**
 * Handle disambiguation reply.
 */
async function handleDisambigReply(senderJid, text, pending, ownerChatJid, ctx) {
  const { type, candidates, originalIntent } = pending;

  // Prefer a numbered choice, but also accept a candidate name. Keep the pending
  // state until a valid answer arrives so a typo does not lose the selection list.
  let chosen = null;
  const numMatch = text.trim().match(/^(?:no\.?\s*)?(\d+)(?:\s*[,.)])?$/i);
  if (numMatch) {
    const n = Number(numMatch[1]) - 1;
    if (n >= 0 && n < candidates.length) chosen = candidates[n].item;
  } else {
    chosen = resolveDisambigChoice(text, candidates, c => c.item?.subject || c.item?.display_name || c.item?.push_name || c.item?.name || 'unknown');
  }

  if (!chosen) {
    const choiceList = ['SEND_MESSAGE', 'SCHEDULE_MESSAGE'].includes(type)
      ? formatTargetChoices(candidates)
      : type === 'FORGET_PERSON' || type === 'NAME_SET'
        ? formatPersonChoices(candidates)
        : formatGroupChoices(candidates);
    return `number ya naam bhej de:\n${choiceList}`;
  }
  pendingDisambig.delete(senderJid);

  if (['ENABLE_GROUP', 'DISABLE_GROUP', 'SET_MODE'].includes(type)) {
    return applyGroupControl(type, chosen, originalIntent?.entities?.mode);
  }
  if (type === 'MASS_BUNK_STATS') {
    const date = originalIntent?.entities?.date;
    const targetDate = date ? new Date(date + 'T00:00:00+05:30') : new Date();
    await runMassBunkAnalysis(chosen.jid, targetDate, ownerChatJid);
    return `mass bunk analysis chal rahi hai — report thodi der mein aayegi`;
  }
  if (type === 'FORGET_PERSON' || type === 'NAME_SET') {
    const updated = { ...originalIntent, entities: { ...originalIntent.entities, resolvedPerson: chosen } };
    return executeIntent(updated, ctx, ownerChatJid);
  }
  if (type === 'SCHEDULE_MESSAGE' || type === 'SEND_MESSAGE') {
    const chosenName = chosen.display_name || chosen.push_name || chosen.subject || chosen.name;
    const targetType = chosen.__targetType || (chosen.subject && !chosen.display_name ? 'group' : 'person');
    const updated = { ...originalIntent, entities: { ...originalIntent.entities, person: chosenName, resolvedTarget: { type: targetType, item: chosen } } };
    if (type === 'SCHEDULE_MESSAGE' && originalIntent.entities?.scheduledAtISO) {
      updated.entities.scheduleAtPhrase = originalIntent.entities.scheduledAtISO;
      updated.entities.time = null;
      updated.entities.date = null;
    }
    return executeIntent(updated, ctx, ownerChatJid);
  }
  return 'samajh nahi aaya. phir se try kar';
}
