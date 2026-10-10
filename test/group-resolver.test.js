import test from 'node:test';
import assert from 'node:assert/strict';
import { findGroupTarget, normalizeGroupName } from '../src/util/groupResolver.js';

const groups = [
  { jid: '1@g.us', subject: 'Photography Club', member_count: 30 },
  { jid: '2@g.us', subject: 'Photography Club Core', member_count: 12 },
  { jid: '3@g.us', subject: 'IT V-B', member_count: 65 },
  { jid: '4@g.us', subject: 'IT V-A', member_count: 63 },
];

test('normalizes generic group suffixes without changing the intended name', () => {
  assert.equal(normalizeGroupName('Photography Club group'), 'photography club');
  assert.equal(normalizeGroupName('IT V-B WhatsApp group'), 'it vb');
});

test('resolves an exact group directly', () => {
  const result = findGroupTarget('Photography Club group', groups);
  assert.equal(result.match?.jid, '1@g.us');
});

test('ambiguous short names return candidates instead of choosing a group', () => {
  const result = findGroupTarget('IT', groups);
  assert.equal(result.match, null);
  assert.ok(result.candidates.length >= 2);
});

test('misspellings return suggestions or all groups, never a weak auto-match', () => {
  const result = findGroupTarget('Photograpy Clb', groups);
  if (result.match) assert.equal(result.match.jid, '1@g.us');
  else assert.ok(result.candidates.length > 0);
});

test('missing target returns a numbered-choice-ready list', () => {
  const result = findGroupTarget('', groups);
  assert.equal(result.match, null);
  assert.equal(result.candidates.length, groups.length);
});
