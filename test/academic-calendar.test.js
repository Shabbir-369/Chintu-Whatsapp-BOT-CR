import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeCalendarEvents, answerCalendarQuestion } from '../src/util/calendar.js';

const calendar = JSON.parse(readFileSync(new URL('../data/academic-calendar.json', import.meta.url), 'utf8'));
const events = normalizeCalendarEvents(calendar);
const now = new Date('2026-10-09T08:00:00.000Z'); // 13:30 IST, 9 October 2026

test('keeps non-consecutive MST-I dates and skips Gandhi Jayanti', () => {
  const rows = events.filter(e => e.name === 'MST-I');
  assert.deepEqual(rows.map(e => e.date_from), [
    '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-03',
  ]);
  assert.equal(rows.some(e => e.date_from === '2026-10-02'), false);
});

test('answers a named past MST date instead of replacing it with the next exam', () => {
  const result = answerCalendarQuestion(events, 'MST 1 kab hai?', now);
  assert.match(result, /MST-I/);
  assert.match(result, /28 Sept/);
  assert.match(result, /3 Oct/);
  assert.match(result, /ho chuka hai/);
  assert.match(result, /Gandhi Jayanti/);
});

test('generic MST query resolves to next scheduled MST', () => {
  const result = answerCalendarQuestion(events, 'MST kab hai?', now);
  assert.match(result, /MST-II/);
  assert.match(result, /16–20 Nov 2026/);
});

test('next holiday and named academic events resolve from the entire calendar', () => {
  assert.match(answerCalendarQuestion(events, 'next holiday', now), /Vijayadashami/);
  assert.match(answerCalendarQuestion(events, 'course registration kab hai?', now), /Course Registration/);
  assert.match(answerCalendarQuestion(events, 'when is convocation?', now), /29 Dec 2026/);
});


test('date-specific questions respect gaps in explicit exam dates', () => {
  const result = answerCalendarQuestion(events, 'what is on 2 October?', now);
  assert.match(result, /Gandhi Jayanti/);
  assert.doesNotMatch(result, /MST-I/);
});

test('semester start and teaching end queries match the correct events', () => {
  assert.match(answerCalendarQuestion(events, 'when does semester start?', now), /Higher Semester Classes/);
  assert.match(answerCalendarQuestion(events, 'when does teaching end?', now), /END of Teaching/);
});
