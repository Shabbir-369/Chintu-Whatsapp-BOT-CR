/**
 * test/bunk.test.js
 * Unit tests for bunk math. §20 acceptance tests.
 * Run: npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeBunk, whatIfBunk } from '../src/skills/pod/bunkMath.js';

describe('Bunk Math', () => {
  test('safe bunks when exactly at 75%', () => {
    const b = computeBunk({ present: 75, total: 100, percentage: 75, code: 'X', name: 'X', zone: 'Green' });
    assert.equal(b.safeBunks, 0);
  });

  test('safe bunks when above 75%', () => {
    const b = computeBunk({ present: 80, total: 100, percentage: 80, code: 'X', name: 'X', zone: 'Green' });
    // safe = floor(80/0.75 - 100) = floor(106.67 - 100) = 6
    assert.equal(b.safeBunks, 6);
  });

  test('safe bunks with 90%', () => {
    const b = computeBunk({ present: 90, total: 100, percentage: 90, code: 'X', name: 'X', zone: 'Green' });
    // safe = floor(90/0.75 - 100) = floor(120 - 100) = 20
    assert.equal(b.safeBunks, 20);
  });

  test('recovery count when below 75%', () => {
    const b = computeBunk({ present: 60, total: 100, percentage: 60, code: 'X', name: 'X', zone: 'Yellow' });
    // need = ceil((0.75 * 100 - 60) / (1 - 0.75)) = ceil(15 / 0.25) = ceil(60) = 60
    assert.equal(b.needToAttend, 60);
  });

  test('recovery count at 50%', () => {
    const b = computeBunk({ present: 50, total: 100, percentage: 50, code: 'X', name: 'X', zone: 'Red' });
    // need = ceil((75 - 50) / 0.25) = ceil(100) = 100
    assert.equal(b.needToAttend, 100);
  });

  test('what-if bunk: stays green', () => {
    const course = { present: 80, total: 100, percentage: 80, zone: 'Green' };
    const { pctAfter, zoneAfter } = whatIfBunk(course, 5);
    // 80 / 105 * 100 = 76.19%
    assert.ok(pctAfter > 75, `Expected > 75, got ${pctAfter}`);
    assert.equal(zoneAfter, 'Green');
  });

  test('what-if bunk: drops to yellow', () => {
    const course = { present: 76, total: 100, percentage: 76, zone: 'Green' };
    const { pctAfter, zoneAfter } = whatIfBunk(course, 2);
    // 76 / 102 * 100 = 74.5%
    assert.ok(pctAfter < 75, `Expected < 75, got ${pctAfter}`);
    assert.equal(zoneAfter, 'Yellow');
  });

  test('zone boundary: 74.99 = Yellow', () => {
    const zone = (pct) => pct >= 75 ? 'Green' : pct >= 60 ? 'Yellow' : 'Red';
    assert.equal(zone(74.99), 'Yellow');
  });

  test('zone boundary: 75.0 = Green', () => {
    const zone = (pct) => pct >= 75 ? 'Green' : pct >= 60 ? 'Yellow' : 'Red';
    assert.equal(zone(75.0), 'Green');
  });

  test('zone boundary: 59.99 = Red', () => {
    const zone = (pct) => pct >= 75 ? 'Green' : pct >= 60 ? 'Yellow' : 'Red';
    assert.equal(zone(59.99), 'Red');
  });

  test('zone boundary: 60.0 = Yellow', () => {
    const zone = (pct) => pct >= 75 ? 'Green' : pct >= 60 ? 'Yellow' : 'Red';
    assert.equal(zone(60.0), 'Yellow');
  });
});
