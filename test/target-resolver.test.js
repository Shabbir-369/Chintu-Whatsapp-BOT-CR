import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveNamedTarget } from '../src/util/targetResolver.js';

const people = [
  { id: 'p1', display_name: 'Meenu Raghuwanshi', push_name: 'Meenu' },
  { id: 'p3', display_name: 'Meenu Shah', push_name: 'Meenu S' },
  { id: 'p2', display_name: 'Priyanshu Jaiswal', push_name: 'Priyanshu' },
];
const groups = [
  { jid: 'g1@g.us', subject: 'Photography Club' },
  { jid: 'g2@g.us', subject: 'IT V-B' },
];

test('resolves a person or group safely', () => {
  assert.equal(resolveNamedTarget('Priyanshu Jaiswal', people, groups).match.__targetType, 'person');
  assert.equal(resolveNamedTarget('Photography Club group', people, groups).match.__targetType, 'group');
});

test('ambiguous/missing targets return selectable candidates with types', () => {
  const ambiguous = resolveNamedTarget('Meenu', people, groups);
  assert.equal(ambiguous.match, null);
  assert.ok(ambiguous.candidates.length > 0);
  assert.ok(ambiguous.candidates.every(c => ['person', 'group'].includes(c.item.__targetType)));
});

test('asks the owner to disambiguate when a person and group share a name', () => {
  const sameNameGroups = [...groups, { jid: 'g3@g.us', subject: 'Meenu Community' }];
  const result = resolveNamedTarget('Meenu', people, sameNameGroups);
  assert.equal(result.match, null);
  assert.ok(result.candidates.some(c => c.item.__targetType === 'person'));
  assert.ok(result.candidates.some(c => c.item.__targetType === 'group'));
});
