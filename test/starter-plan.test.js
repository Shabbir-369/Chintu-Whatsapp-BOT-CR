import test from 'node:test';
import assert from 'node:assert/strict';
import { getDailyStarterWindows, isStarterWindowDue, isNearConfiguredTime } from '../src/util/starterPlan.js';

test('daily starter windows are stable per group and date, but vary across groups', () => {
  const first = getDailyStarterWindows('2026-10-09', 'group-a');
  assert.deepEqual(getDailyStarterWindows('2026-10-09', 'group-a'), first);
  assert.ok(first.length >= 1 && first.length <= 2);
  assert.ok(first.every(minute => minute >= 720 && minute < 1320));
  assert.notDeepEqual(getDailyStarterWindows('2026-10-09', 'group-b'), first);
});

test('scheduled starter window is recognized in India Standard Time', () => {
  const target = new Date('2026-10-09T08:00:00.000Z'); // 13:30 IST
  assert.equal(isStarterWindowDue(target, [810]), true);
  assert.equal(isStarterWindowDue(target, [809]), true);
  assert.equal(isStarterWindowDue(target, [815]), false);
});


test('morning-message quiet window is calculated in IST without relying on an outer hour variable', () => {
  assert.equal(isNearConfiguredTime(new Date('2026-10-09T02:10:00.000Z'), '07:45', 30), true); // 07:40 IST
  assert.equal(isNearConfiguredTime(new Date('2026-10-09T02:50:00.000Z'), '07:45', 30), false); // 08:20 IST
  assert.equal(isNearConfiguredTime(new Date('2026-10-09T02:10:00.000Z'), 'not-a-time', 30), false);
});
