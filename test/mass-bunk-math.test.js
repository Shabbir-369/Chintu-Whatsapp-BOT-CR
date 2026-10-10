import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { matchCoursesToTimetable, calculateAttendanceAfterMiss } from '../src/skills/massBunkMath.js';

describe('Mass-bunk matching', () => {
  test('counts every repeated class session for a course', () => {
    const courses = [{ code: 'CN301', name: 'Computer Networks', present: 18, total: 24, percentage: 75 }];
    const entries = [
      { code: 'CN301', subject: 'Computer Networks' },
      { code: 'CN301', subject: 'Computer Networks' },
      { code: 'CN301', subject: 'Computer Networks' },
    ];
    assert.equal(matchCoursesToTimetable(courses, entries)[0].missCount, 3);
  });
  test('does not double-count parallel timetable rows in the same time slot', () => {
    const courses = [{ code: 'CN301', name: 'Computer Networks' }];
    const entries = [
      { code: 'CN301', subject: 'Computer Networks', start_time: '10:00', end_time: '10:50', batch: 'A' },
      { code: 'CN301', subject: 'Computer Networks', start_time: '10:00', end_time: '10:50', batch: 'B' },
      { code: 'CN301', subject: 'Computer Networks', start_time: '12:00', end_time: '12:50', batch: 'A' },
    ];
    assert.equal(matchCoursesToTimetable(courses, entries)[0].missCount, 2);
  });

  test('matches normalized subject names when timetable codes differ', () => {
    const courses = [{ code: 'CS301', name: 'Computer Networks', present: 18, total: 24, percentage: 75 }];
    const entries = [{ code: 'CN', subject: 'Computer Networks' }];
    assert.equal(matchCoursesToTimetable(courses, entries)[0].missCount, 1);
  });
  test('does not create a course match when no code or subject matches', () => {
    const courses = [{ code: 'CN301', name: 'Computer Networks' }];
    const entries = [{ code: 'DBMS', subject: 'Database Management' }];
    assert.deepEqual(matchCoursesToTimetable(courses, entries), []);
  });
  test('keeps distinct courses separate', () => {
    const courses = [
      { code: 'CN301', name: 'Computer Networks' },
      { code: 'DBMS', name: 'Database Systems' },
    ];
    const entries = [
      { code: 'CN301', subject: 'Computer Networks' },
      { code: 'DBMS', subject: 'Database Systems' },
    ];
    assert.equal(matchCoursesToTimetable(courses, entries).length, 2);
  });
});


test('projects attendance from exact present/total counts and all missed sessions', () => {
  assert.equal(calculateAttendanceAfterMiss({ present: 18, total: 24 }, 2), 69.23);
  assert.equal(calculateAttendanceAfterMiss({ present: 18, total: 24 }, 0), 75);
});

test('invalid attendance counts do not produce misleading percentages', () => {
  assert.equal(calculateAttendanceAfterMiss({ present: 18, total: 0 }, 0), null);
  assert.equal(calculateAttendanceAfterMiss({ present: 18, total: 24 }, -1), null);
});
