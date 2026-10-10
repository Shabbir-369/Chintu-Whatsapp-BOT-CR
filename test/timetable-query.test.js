import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTimetableTimeRange,
  isTimetableQuestion,
  isWeeklyTimetableQuestion,
  resolveTimetableRequest,
} from '../src/util/timetableQuery.js';
import { isCalendarQuestion, normalizeCalendarEvents, answerCalendarQuestion } from '../src/util/calendar.js';
import { readFileSync } from 'node:fs';

const fridayEvening = new Date('2026-10-09T12:00:00.000Z'); // Fri, 17:30 IST

test('recognizes one-word and two-word timetable phrases and a whole-week request', () => {
  assert.equal(isTimetableQuestion('Monday ka time table bata de'), true);
  assert.equal(isTimetableQuestion('Tuesday ka timetable'), true);
  assert.equal(isTimetableQuestion('Aaj ka time table bata de'), true);
  assert.equal(isTimetableQuestion('Pure hafte ka timetable bata de'), true);
  assert.equal(isWeeklyTimetableQuestion('Pure hafte ka timetable bata de'), true);
  assert.equal(isWeeklyTimetableQuestion('Iss hafte ka schedule'), true);
  assert.equal(isWeeklyTimetableQuestion('Next week timetable'), true);
});

test('resolves weekdays and relative Hindi dates in the India timezone', () => {
  assert.deepEqual(resolveTimetableRequest('Aaj ka time table', fridayEvening), {
    kind: 'day', dateStr: '2026-10-09', offset: 0, source: 'relative',
  });
  assert.equal(resolveTimetableRequest('Kal ka time table', fridayEvening).dateStr, '2026-10-10');
  assert.equal(resolveTimetableRequest('Parso ka time table', fridayEvening).dateStr, '2026-10-11');
  assert.equal(resolveTimetableRequest('Narsō ka time table', fridayEvening).dateStr, '2026-10-12');
  assert.equal(resolveTimetableRequest('Monday ka time table', fridayEvening).dateStr, '2026-10-12');
  assert.equal(resolveTimetableRequest('Tuesday ka time table', fridayEvening).dateStr, '2026-10-13');
  assert.equal(resolveTimetableRequest('Next Monday ka timetable', fridayEvening).dateStr, '2026-10-12');
  assert.equal(resolveTimetableRequest('Next Monday ka timetable', new Date('2026-10-12T05:00:00.000Z')).dateStr, '2026-10-19');
  assert.equal(resolveTimetableRequest('Pure hafte ka timetable', fridayEvening).kind, 'week');
  assert.equal(resolveTimetableRequest('Next week timetable', fridayEvening).startDate, '2026-10-12');
});

test('formats a real class time range safely', () => {
  assert.equal(formatTimetableTimeRange({ start_time: '08:30:00', end_time: '09:20:00' }), '08:30–09:20');
  assert.equal(formatTimetableTimeRange({ start_time: '08:30:00', end_time: '00:00:00' }), '08:30');
  assert.equal(formatTimetableTimeRange({}), 'time unavailable');
});

test('MST 1 without a space is still a calendar question and returns past dates', () => {
  const calendar = JSON.parse(readFileSync(new URL('../data/academic-calendar.json', import.meta.url), 'utf8'));
  const events = normalizeCalendarEvents(calendar);
  const now = new Date('2026-10-09T08:00:00.000Z');
  assert.equal(isCalendarQuestion('MST1 kab hai?'), true);
  const answer = answerCalendarQuestion(events, 'MST1 kab hai?', now);
  assert.match(answer, /MST-I/);
  assert.match(answer, /ho chuka hai/);
});

test('next holiday recognizes the common single-h spelling chutti', () => {
  const calendar = JSON.parse(readFileSync(new URL('../data/academic-calendar.json', import.meta.url), 'utf8'));
  const events = normalizeCalendarEvents(calendar);
  const now = new Date('2026-10-09T08:00:00.000Z');
  assert.match(answerCalendarQuestion(events, 'Ab next chutti kab hai?', now), /Vijayadashami/);
});
