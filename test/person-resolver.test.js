import test from 'node:test';
import assert from 'node:assert/strict';
import { findPersonTarget } from '../src/util/personResolver.js';

const people = [
  { id: '1', display_name: 'Meenu Raghuwanshi', push_name: 'Meenu' },
  { id: '2', display_name: 'Meenu Shah', push_name: 'Meenu S' },
  { id: '3', display_name: 'Priyanshu Jaiswal', push_name: 'Priyanshu' },
];

test('resolves a unique exact known name', () => {
  assert.equal(findPersonTarget('Priyanshu Jaiswal', people).match?.id, '3');
});

test('does not guess when a short name could mean multiple people', () => {
  const result = findPersonTarget('Meenu', people);
  assert.equal(result.match, null);
  assert.equal(result.candidates.length, 2);
});

test('returns suggestions for a misspelled name rather than silently selecting', () => {
  const result = findPersonTarget('Priyansh Jaiswl', people);
  assert.ok(result.match?.id === '3' || result.candidates.some(c => c.item.id === '3'));
});
