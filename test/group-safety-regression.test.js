import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const groupHandler = await readFile(new URL('../src/router/groupHandler.js', import.meta.url), 'utf8');
const decision = await readFile(new URL('../src/brain/decision.js', import.meta.url), 'utf8');

test('group handler has a pre-routing attendance/Pod privacy guard', () => {
  assert.match(groupHandler, /Never answer attendance\/marks\/bunk\/Pod queries in a group/);
  assert.match(groupHandler, /Personal attendance yahan nahi dikhata/);
});

test('ordinary group LLM prompts do not receive live timetable context', () => {
  assert.doesNotMatch(groupHandler, /liveContext|classContext:\s*liveContext/);
});

test('mute is checked before owner messages are processed', () => {
  assert.match(groupHandler, /Mute is absolute[\s\S]{0,300}initialGroup\?\.mode === 'mute'/);
});

test('trigger mode filters unaddressed messages before special handlers', () => {
  assert.match(groupHandler, /grpRow\?\.mode === 'trigger'[\s\S]{0,180}if \(!isExplicitlyTriggered\(ctx\)\) return/);
  assert.match(groupHandler, /function isExplicitlyTriggered\(ctx\)/);
});

test('ambient mode favors replies to substantive messages', () => {
  assert.match(decision, /groupMode === 'ambient' && t\.trim\(\)\.length >= 3/);
});
