import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConversationHistory, isPhoneFallbackName } from '../src/util/conversationContext.js';
import { findPersonTarget } from '../src/util/personResolver.js';

test('builds recent history and omits the current incoming message', () => {
  const history = buildConversationHistory([
    { wa_id: '1', text: 'kal movie dekhne chale?', from_bot: false, push_name: 'Aman' },
    { wa_id: '2', text: 'kaunsi movie?', from_bot: true },
    { wa_id: '3', text: 'latest message', from_bot: false },
  ], { currentWaId: '3' });
  assert.equal(history.length, 2);
  assert.match(history[0].parts[0].text, /Aman: kal movie/);
  assert.match(history[1].parts[0].text, /Chintu: kaunsi movie/);
  assert.ok(!JSON.stringify(history).includes('latest message'));
});

test('group history filters Pod and attendance messages without discarding ordinary context', () => {
  const history = buildConversationHistory([
    { wa_id: '1', text: 'kal movie dekhne chale?', from_bot: false, push_name: 'Aman' },
    { wa_id: '2', text: 'meri attendance 62 percent hai', from_bot: false, push_name: 'Aman' },
    { wa_id: '3', text: 'marks bata', from_bot: false, push_name: 'Aman' },
  ], { isGroup: true });
  const joined = JSON.stringify(history);
  assert.match(joined, /movie dekhne/);
  assert.doesNotMatch(joined, /attendance|marks bata/);
});

test('phone number fallback labels can be recognized as phone numbers', () => {
  assert.equal(isPhoneFallbackName('919123456789'), true);
  assert.equal(isPhoneFallbackName('+91 91234 56789'), true);
  assert.equal(isPhoneFallbackName('Aman Sharma'), false);
});

test('owner can resolve a contact using the stored phone-number alias', () => {
  const people = [{ id: '1', display_name: '919123456789', phone_numbers: ['919123456789'] }];
  assert.equal(findPersonTarget('+91 91234 56789', people).match?.id, '1');
});

test('unknown phone labels trigger a one-time owner prompt and owner name resolution accepts numbers', async () => {
  const naming = await (await import('node:fs/promises')).readFile(new URL('../src/skills/naming.js', import.meta.url), 'utf8');
  const router = await (await import('node:fs/promises')).readFile(new URL('../src/router/router.js', import.meta.url), 'utf8');
  assert.match(naming, /requestOwnerNameForUnknownPerson/);
  assert.match(naming, /claimNamePrompt\(person\.id\)/);
  assert.match(naming, /Number: \+\$\{phone\}/);
  assert.match(router, /requestOwnerNameForUnknownPerson/);
});

test('DM and group handlers pass recent conversation history to reply generation', async () => {
  const fs = await import('node:fs/promises');
  const dm = await fs.readFile(new URL('../src/router/dmHandler.js', import.meta.url), 'utf8');
  const group = await fs.readFile(new URL('../src/router/groupHandler.js', import.meta.url), 'utf8');
  assert.match(dm, /buildConversationHistory\(recentRows/);
  assert.match(dm, /generateReply\(systemPrompt, conversationHistory, text/);
  assert.match(group, /buildConversationHistory\(recentRows/);
  assert.match(group, /generateReply\(systemPrompt, conversationHistory, text/);
});
