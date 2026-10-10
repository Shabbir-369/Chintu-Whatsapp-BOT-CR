/**
 * src/router/ownerConsole.js
 * Owner intent parsing and command execution. §11.1, §11.2, §11.4, §11.5.
 * Intent parsing: first regex rules, then model fallback.
 */
import { getAllGroups, enableGroup, disableGroup, setGroupMode, getGroup } from '../db/repos/groups.js';
import { findPeopleByName, getPersonById, addOwnerJid, isOwnerJid } from '../db/repos/people.js';
import {
  findOpenApproval, findApprovalByMessageId, decideApproval,
  getOpenApprovals, createApproval, genCode, setCardMessageId,
  getDmAccess, setDmAccess,
} from '../db/repos/approvals.js';
import { setDisplayName } from '../db/repos/people.js';
import { executeNameDecision, assignNameDirectly } from '../skills/naming.js';
import { addDayNote, setSetting, getSetting, writeAuditLog } from '../db/repos/timetable.js';
import { scheduleOrderedMessage, resolveTarget, canSendFirstContact, recordFirstContact } from '../skills/sendOrder.js';
import { buildIntentParserPrompt } from '../brain/persona.js';
import { parseOwnerIntent } from '../brain/llm.js';
import { fuzzyMatch, formatDisambig, scoreAll } from '../util/fuzzy.js';
import { runMassBunkAnalysis } from '../skills/massBunk.js';
import { config } from '../config.js';
import { getLogger } from '../logger.js';
import { isExtractionAttempt } from '../brain/guard.js';
import { getDeflectLine } from '../brain/fallback.js';
import { parseScheduledMessageCommand, parseScheduleDateTime, formatScheduledIST } from '../util/scheduleTime.js';
import { toISTDateString } from '../util/time.js';
import { isCalendarQuestion } from '../util/calendar.js';
import { isTimetableQuestion } from '../util/timetableQuery.js';
import { parseDisableGroupCommand } from '../util/groupCommand.js';

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
  // ONLY two things route to link flow:
  //   1. There is an active link session (any step) → continue it
  //   2. User sends an explicit link command ("!link", "link pod", etc.)
  // Broad topics like "attendance" or "bunk" do NOT start the link flow here —
  // they are handled below in the Pod data queries block.
  {
    const { handleLinkFlow } = await import('../skills/pod/link.js');
    const { getPodLinkSession } = await import('../db/repos/pod.js');
    const linkSession = await getPodLinkSession(ctx.person?.id).catch(() => null);

    const isExplicitLinkTrigger =
      tl === '!link' ||
      tl === 'link pod' ||
      /\b(pod link|link account|connect pod|pod connect)\b/.test(tl);

    if (linkSession || isExplicitLinkTrigger) {
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
      // Not linked — suggest linking when they ask for data
      if (/\b(meri attendance|attendance|bunk|marks|grade|pod data|link karo)\b/i.test(tl) &&
          !/status|group|message|send|schedule|notice|holiday|timetable/i.test(tl)) {
        return 'pehle pod link karna hoga. "link pod" bol ya "!link" bhej';
      }
    }
  }

  // ── Check pending disambiguation ──────────────────────────────────
  const pending = pendingDisambig.get(senderJid);
  if (pending) {
    return handleDisambigReply(senderJid, t, pending, ownerChatJid, ctx);
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

  // Enable group
  if (/^(enable|start|chalu kar|band mat kar|is group mein bol)\b/.test(t) ||
      /\b(group enable|enable group|group chalu)\b/.test(t)) {
    const groupName = t.replace(/^(enable|start|chalu kar|group enable|enable group|group chalu)\s*/i, '').trim();
    return { intent: 'ENABLE_GROUP', entities: { group: groupName || null }, confidence: 0.9 };
  }

  // Disable/mute a group from natural language, including 'stop talking in ... group'.
  const disableTarget = parseDisableGroupCommand(text);
  if (disableTarget !== null) {
    return { intent: 'DISABLE_GROUP', entities: { group: disableTarget || null }, confidence: 0.93 };
  }

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

  // Set mode
  const modeMatch = t.match(/^(?:(.+?)\s+mein\s+)?(ambient|trigger|mute)\s+mode/i);
  if (modeMatch) {
    return { intent: 'SET_MODE', entities: { group: modeMatch[1]?.trim() || null, mode: modeMatch[2].toLowerCase() }, confidence: 0.9 };
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

/**
 * Execute a parsed intent.
 */
async function executeIntent(parsed, ctx, ownerChatJid) {
  const { intent, entities } = parsed;
  const { senderJid } = ctx;

  switch (intent) {
    case 'ENABLE_GROUP': {
      const groups = await getAllGroups();
      if (!groups.length) return 'koi group nahi dikh raha abhi';
      if (!entities.group) {
        return 'kaunsa group enable karna hai? naam bhej';
      }
      const { match, ambiguous, candidates } = fuzzyMatch(entities.group, groups.map(g => ({ ...g, name: g.subject })));
      if (match) {
        await enableGroup(match.jid, 'ambient');
        return `done, ${match.subject} mein ab bolega`;
      }
      if (ambiguous || candidates.length > 0) {
        pendingDisambig.set(senderJid, { type: 'ENABLE_GROUP', candidates, originalIntent: parsed });
        const list = candidates.map((c, i) => `${i + 1}. ${c.item.subject} (${c.item.member_count || '?'} members)`).join('\n');
        return `${candidates.length} groups mile:\n${list}\nkaunsa?`;
      }
      return 'koi group nahi mila is naam se';
    }

    case 'DISABLE_GROUP': {
      const groups = await getAllGroups();
      if (!entities.group) return 'kaunsa group? exact naam bhej de, ya groups list bol';
      const norm = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const wanted = norm(entities.group);
      const exact = groups.filter(g => norm(g.subject) === wanted);
      if (exact.length === 1) {
        await disableGroup(exact[0].jid);
        return `${exact[0].subject} mein ab chup. group mute kar diya`;
      }
      // Never mute a group on a weak/fuzzy guess. Offer ranked candidates for a number reply.
      const ranked = scoreAll(entities.group, groups.map(g => ({ ...g, name: g.subject })))
        .filter(c => c.score > 0.25).slice(0, 8);
      const choices = ranked.length ? ranked : groups.slice(0, 12).map(item => ({ item, score: 0 }));
      pendingDisambig.set(senderJid, { type: 'DISABLE_GROUP', candidates: choices, originalIntent: parsed });
      return `exact group match nahi mila${exact.length > 1 ? ' (duplicate names hain)' : ''}. kaunsa mute karun?\n${choices.map((c, i) => `${i + 1}. ${c.item.subject} (${c.item.member_count || '?'} members)`).join('\n')}\nnumber reply kar de`;
    }

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
      const people = await findPeopleByName(entities.person);
      const groups = await getAllGroups();
      const target = resolveTarget(entities.person, people, groups);

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
        return `kaun? ${target.candidates.map((c, i) => `${i+1}. ${c.item?.display_name || c.item?.subject || 'unknown'}`).join('\n')}`;
      }
      return `${entities.person} nahi mila`;
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

    case 'SET_MODE': {
      const groups = await getAllGroups();
      if (!entities.group) return 'kaunse group ka mode set karu?';
      const { match } = fuzzyMatch(entities.group, groups.map(g => ({ ...g, name: g.subject })));
      if (match) {
        const mode = entities.mode || 'ambient';
        await setGroupMode(match.jid, mode);
        return `${match.subject} ka mode ${mode} kar diya`;
      }
      return 'group nahi mila';
    }

    case 'MASS_BUNK_STATS': {
      const groups = await getAllGroups();
      // If no group specified, pick the first enabled one
      const targetGroup = entities.group 
        ? fuzzyMatch(entities.group, groups.map(g => ({ ...g, name: g.subject }))).match
        : groups.find(g => g.enabled);
        
      if (targetGroup) {
        // entities.date is a string like '2026-10-08'; convert to a proper Date
        const targetDate = entities.date
          ? new Date(entities.date + 'T00:00:00+05:30')
          : new Date();
        await runMassBunkAnalysis(targetGroup.jid, targetDate, ownerChatJid);
        return `mass bunk analysis chal rahi hai — report thodi der mein aayegi`;
      }
      return 'group nahi mila mass bunk stats ke liye';
    }

    case 'FORGET_PERSON': {
      if (!entities.person) return 'kisko bhulna hai?';
      const people = await findPeopleByName(entities.person);
      if (people.length > 0) {
        try {
          const { forgetPerson } = await import('../db/repos/memory.js');
          await forgetPerson(people[0].id);
          return `${people[0].display_name || entities.person} ke baare mein sab bhool gaya`;
        } catch(e) {
          return `${people[0].display_name || entities.person} ke baare mein bhoolne mein error aayi`;
        }
      }
      return `${entities.person} pehle se hi yaad nahi hai`;
    }

    case 'SCHEDULE_MESSAGE': {
      if (!entities.person || !entities.text) return 'kisko aur kya bhejna hai? naam aur message dono bata';
      const phrase = entities.scheduleAtPhrase || entities.time || entities.datetime || entities.date;
      const runAt = parseScheduleDateTime(phrase || '', {
        now: new Date(), explicitTime: entities.time, explicitDate: entities.date,
      });
      if (!runAt) return 'kis time bheju? jaise “kal subah 8 baje” ya “aaj 6 pm” bol';

      const people = await findPeopleByName(entities.person);
      const groups = await getAllGroups();
      const target = resolveTarget(entities.person, people, groups);
      if (target.ambiguous) {
        pendingDisambig.set(senderJid, { type: 'SCHEDULE_MESSAGE', candidates: target.candidates, originalIntent: { ...parsed, entities: { ...entities, scheduledAtISO: runAt.toISOString() } } });
        return `kaun sa ${entities.person}?\n${target.candidates.map((c, i) => `${i + 1}. ${c.item.display_name || c.item.push_name || c.item.subject || 'unknown'}`).join('\n')}\nnumber reply kar de`;
      }
      if (!target.match) return `${entities.person} nahi mila — naam/group ka sahi naam bata`;
      const jid = target.type === 'group' ? target.match.jid :
        (await import('../db/repos/people.js').then(m => m.getIdentities(target.match.id)).catch(() => []))[0]?.jid;
      if (!jid) return `${entities.person} ka WhatsApp contact nahi mila`;

      const result = await scheduleOrderedMessage({
        targetName: entities.person, targetJid: jid, message: entities.text,
        runAt, verbatim: entities.verbatim,
      });
      if (!result.ok) return result.reply;
      return `✅ ${target.match.display_name || target.match.push_name || target.match.subject || entities.person} ko *${formatScheduledIST(runAt)}* pe bhejunga.`;
    }

    case 'MERGE_PEOPLE': {
      return 'merge_people currently requires DB access directly or exact names';
    }

    case 'NAME_SET': {
      if (!entities.person || !entities.text) return 'kiska naam kya set karu?';
      const people = await findPeopleByName(entities.person);
      if (people.length) {
        await assignNameDirectly(people[0].id, entities.text);
        return `${people[0].display_name || 'wo'} ka naam ab se ${entities.text} set kar diya`;
      }
      return `${entities.person} nahi mila`;
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
  pendingDisambig.delete(senderJid);

  // Try to resolve choice
  const numMatch = text.match(/^\d+$/);
  if (numMatch) {
    const n = parseInt(numMatch[0]) - 1;
    if (n >= 0 && n < candidates.length) {
      const chosen = candidates[n].item;
      if (type === 'ENABLE_GROUP') {
        await enableGroup(chosen.jid, 'ambient');
        return `done, ${chosen.subject} mein ab bolega`;
      }
      if (type === 'DISABLE_GROUP') {
        await disableGroup(chosen.jid);
        return `${chosen.subject} mein ab chup. group mute kar diya`;
      }
      if (type === 'SCHEDULE_MESSAGE' || type === 'SEND_MESSAGE') {
        const chosenName = chosen.display_name || chosen.push_name || chosen.subject || chosen.name;
        const updated = { ...originalIntent, entities: { ...originalIntent.entities, person: chosenName } };
        if (type === 'SCHEDULE_MESSAGE' && originalIntent.entities?.scheduledAtISO) {
          updated.entities.scheduleAtPhrase = originalIntent.entities.scheduledAtISO;
          updated.entities.time = null;
          updated.entities.date = null;
        }
        return executeIntent(updated, ctx, ownerChatJid);
      }
    }
  }
  return 'samajh nahi aaya. phir se try kar';
}
