import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseScheduleDateTime,
  parseScheduledMessageCommand,
  formatScheduledIST,
} from '../src/util/scheduleTime.js';

const now = new Date('2026-10-09T08:00:00.000Z'); // 13:30 IST, 9 October 2026

test('parses owner reminder and scheduled message phrasing', () => {
  assert.deepEqual(parseScheduledMessageCommand('Sneha ko 6 baje yaad dila de ki assignment submit karna'), {
    target: 'Sneha', timePhrase: '6 baje', message: 'assignment submit karna',
  });
  assert.deepEqual(parseScheduledMessageCommand('Rohan ko kal 8 baje message kar ki lab record lana'), {
    target: 'Rohan', timePhrase: 'kal 8 baje', message: 'lab record lana',
  });
});

test('does not convert an ordinary immediate message mentioning tomorrow into a scheduled job', () => {
  assert.equal(parseScheduledMessageCommand('Rohan ko bol de kal lab record lana'), null);
});

test('interprets unqualified 6 baje as 6 PM and tomorrow 8 baje as 8 AM IST', () => {
  const evening = parseScheduleDateTime('6 baje', { now });
  const tomorrowMorning = parseScheduleDateTime('kal 8 baje', { now });
  assert.equal(formatScheduledIST(evening), 'Fri, 9 Oct, 2026 06:00 pm IST');
  assert.equal(formatScheduledIST(tomorrowMorning), 'Sat, 10 Oct, 2026 08:00 am IST');
});

test('day-part phrases get a usable default time and ISO timestamps survive disambiguation', () => {
  assert.equal(formatScheduledIST(parseScheduleDateTime('kal subah', { now })), 'Sat, 10 Oct, 2026 08:10 am IST');
  assert.equal(formatScheduledIST(parseScheduleDateTime('2026-10-10T02:30:00.000Z', { now })), 'Sat, 10 Oct, 2026 08:00 am IST');
});
