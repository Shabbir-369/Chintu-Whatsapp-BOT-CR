import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldRunMorningWindow,
  canStartConversationInMode,
  pickMorningFallbackLine,
  composeMorningMessage,
  extractSavageLine,
} from '../src/util/schedulerPlan.js';

const at = value => new Date(value);

test('morning schedule runs at the configured IST time', () => {
  // 07:45 IST = 02:15 UTC
  assert.equal(shouldRunMorningWindow(at('2026-10-10T02:15:00Z'), '', '07:45'), true);
});

test('morning scheduler catches up after a restart but does not run early or too late', () => {
  assert.equal(shouldRunMorningWindow(at('2026-10-10T02:00:00Z'), '', '07:45'), false); // 07:30 IST
  assert.equal(shouldRunMorningWindow(at('2026-10-10T04:45:00Z'), '', '07:45'), true); // 10:15 IST
  assert.equal(shouldRunMorningWindow(at('2026-10-10T05:46:00Z'), '', '07:45'), false); // 11:16 IST
  assert.equal(shouldRunMorningWindow(at('2026-10-10T02:15:00Z'), '2026-10-10', '07:45'), false);
});

test('morning schedule safely rejects invalid times', () => {
  assert.equal(shouldRunMorningWindow(at('2026-10-10T02:15:00Z'), '', 'bad-time'), false);
  assert.equal(shouldRunMorningWindow(new Date('invalid'), '', '07:45'), false);
});

test('only ambient groups receive automatic conversation starters', () => {
  assert.equal(canStartConversationInMode({ enabled: true, mode: 'ambient' }), true);
  assert.equal(canStartConversationInMode({ enabled: true, mode: 'trigger' }), false);
  assert.equal(canStartConversationInMode({ enabled: true, mode: 'mute' }, true), false);
  assert.equal(canStartConversationInMode({ enabled: false, mode: 'ambient' }, true), false);
  assert.equal(canStartConversationInMode({ enabled: true, mode: 'trigger' }, true), true);
});

test('morning fallback avoids a line already present in recent messages', () => {
  const first = pickMorningFallbackLine([], () => 0);
  const next = pickMorningFallbackLine([{ text: `yesterday: ${first}` }], () => 0);
  assert.notEqual(next, first);
});

test('daily morning message includes the exact timetable plus one savage line', () => {
  const result = composeMorningMessage('*Monday — 12 Oct*\n• 08:30  CN - B-001', 'consistency glamorous nahi hoti.', false);
  assert.equal(result, '*Monday — 12 Oct*\n• 08:30  CN - B-001\n\nconsistency glamorous nahi hoti.');
});

test('holiday morning message remains a short line with no timetable', () => {
  const result = composeMorningMessage('*Sunday — 11 Oct*\nKoi class nahi', 'aaj bhi rest ka attendance full hai.', true);
  assert.equal(result, 'aaj bhi rest ka attendance full hai.');
});

test('LLM timetable duplication is stripped from the savage-line output', () => {
  assert.equal(extractSavageLine('*Monday — 12 Oct*\n• 08:30  CN - B-001\nconfidence se entry milti hai.', '*Monday — 12 Oct*\n• 08:30  CN - B-001'), 'confidence se entry milti hai.');
});

test('a timetable-only model response cannot be mistaken for the savage line', () => {
  assert.equal(extractSavageLine('*Monday — 12 Oct*\n• 08:30  CN - B-001', '*Monday — 12 Oct*\n• 08:30  CN - B-001'), '');
});
