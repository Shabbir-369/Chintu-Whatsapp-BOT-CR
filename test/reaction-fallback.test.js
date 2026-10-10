import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { shouldReactInsteadOfReply } from '../src/util/reactionFallback.js';

const base = {
  ctx: { isGroup: true, kind: 'text', text: 'hello everyone', rawMsg: { key: { id: 'msg-1' } } },
  groupRow: { enabled: true, mode: 'ambient' },
  reason: 'ambient_below_threshold',
};

test('ambient group reacts when a normal message would otherwise be ignored', () => {
  assert.equal(shouldReactInsteadOfReply(base), true);
});

test('mute mode never sends a fallback reaction', () => {
  assert.equal(shouldReactInsteadOfReply({ ...base, groupRow: { enabled: true, mode: 'mute' } }), false);
});

test('disabled groups never send a fallback reaction', () => {
  assert.equal(shouldReactInsteadOfReply({ ...base, groupRow: { enabled: false, mode: 'ambient' } }), false);
});

test('trigger mode stays silent unless the message explicitly addresses the bot', () => {
  const trigger = { ...base, groupRow: { enabled: true, mode: 'trigger' } };
  assert.equal(shouldReactInsteadOfReply({ ...trigger, explicitlyTriggered: false }), false);
  assert.equal(shouldReactInsteadOfReply({ ...trigger, explicitlyTriggered: true }), true);
});

test('incoming reactions do not cause reaction loops', () => {
  assert.equal(shouldReactInsteadOfReply({ ...base, ctx: { ...base.ctx, kind: 'reaction' } }), false);
});

test('hard rate and quiet-hour blocks remain silent', () => {
  for (const reason of ['group_disabled', 'flood_penalty', 'hourly_cap', 'quiet_hours', 'mute_mode', 'trigger_mode_no_trigger']) {
    assert.equal(shouldReactInsteadOfReply({ ...base, reason }), false, reason);
  }
});

test('direct messages never use the group reaction fallback', () => {
  assert.equal(shouldReactInsteadOfReply({ ...base, ctx: { ...base.ctx, isGroup: false } }), false);
});

test('group handler uses reaction fallback for ignored and LLM-silent outcomes', async () => {
  const source = await readFile(new URL('../src/router/groupHandler.js', import.meta.url), 'utf8');
  assert.match(source, /case 'IGNORE':[\s\S]{0,120}reactIfNoReply\(ctx, grpRow, decision\.reason\)/);
  assert.match(source, /parts\.length === 0[\s\S]{0,180}reactIfNoReply\(ctx, await getGroup\(chatJid\)\.catch\(\(\) => null\), 'llm_silence'\)/);
  assert.match(source, /if \(!text\) \{[\s\S]{0,140}reactIfNoReply\(ctx, initialGroup/);
});
