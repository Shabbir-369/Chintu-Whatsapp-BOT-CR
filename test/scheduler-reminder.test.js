import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isValidSelfReminderPayload } from '../src/util/reminderPolicy.js';

const dmHandler = await readFile(new URL('../src/router/dmHandler.js', import.meta.url), 'utf8');
const ownerConsole = await readFile(new URL('../src/router/ownerConsole.js', import.meta.url), 'utf8');
const schedulerJobs = await readFile(new URL('../src/scheduler/jobs.js', import.meta.url), 'utf8');
const reminderSkill = await readFile(new URL('../src/skills/reminder.js', import.meta.url), 'utf8');

test('self-reminder payload only permits the requester private DM', () => {
  assert.equal(isValidSelfReminderPayload({ selfOnly: true, requesterJid: '91@s.whatsapp.net', targetJid: '91@s.whatsapp.net', message: 'submit assignment' }), true);
  assert.equal(isValidSelfReminderPayload({ selfOnly: true, requesterJid: '91@s.whatsapp.net', targetJid: '92@s.whatsapp.net', message: 'submit assignment' }), false);
  assert.equal(isValidSelfReminderPayload({ selfOnly: true, requesterJid: '91@s.whatsapp.net', targetJid: '123@g.us', message: 'submit assignment' }), false);
  assert.equal(isValidSelfReminderPayload({ selfOnly: true, requesterJid: '91@s.whatsapp.net', targetJid: '91@s.whatsapp.net', message: ' ' }), false);
});

test('scheduler executes self-reminder jobs only after enforcing the private self-only policy', () => {
  assert.match(schedulerJobs, /case 'self_reminder':[\s\S]*?isValidSelfReminderPayload\(payload\)[\s\S]*?humanSend\(payload\.targetJid/);
});

test('non-owner DM reminders bind to chatJid and arbitrary person/group schedules are refused', () => {
  assert.match(dmHandler, /parseScheduledMessageCommand\(raw\)[\s\S]*?kisi aur person ya group ko message schedule karna owner ka permission hai/);
  assert.match(dmHandler, /requesterJid: ctx\.chatJid[\s\S]*?message,[\s\S]*?runAt/);
});

test('owner schedules resolve both known people and groups, showing choices when uncertain', () => {
  assert.match(ownerConsole, /const people = await getRecentPeopleForResolution\(100\);[\s\S]*?const groups = await getAllGroups\(\)/);
  assert.match(ownerConsole, /resolveTarget\(targetName, people, groups\)/);
  assert.match(ownerConsole, /formatTargetChoices\(candidates\)[\s\S]*?number ya naam reply kar de/);
});

test('private reminder creator stores only the requester as both target and requester', () => {
  assert.match(reminderSkill, /targetJid: requesterJid,[\s\S]*?requesterJid,[\s\S]*?selfOnly: true/);
  assert.match(reminderSkill, /requesterJid\.endsWith\('@g\.us'\)/);
});
