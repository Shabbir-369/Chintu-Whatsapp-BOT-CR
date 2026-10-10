# Fixes v9 — Scheduling and reminders only

This update focuses on scheduled messages and reminders. Existing group modes, privacy guards, mass-bunk logic, timetable/calendar features, reactions, and conversation starters are preserved.

## Owner scheduling
- Owner can schedule messages for a resolved saved contact or WhatsApp group.
- Recognizes common Hinglish and English request shapes, including target-first and time-first phrasing.
- Resolves the target through known people and groups; ambiguous or uncertain matches present a numbered choice and also accept the exact name.
- Incomplete requests ask for one missing field at a time (recipient, message, or time) rather than asking for everything again.
- Scheduled owner messages use the existing persisted `send_ordered` job and execute through the scheduler.

## Non-owner reminders
- Approved users can request reminders from a private DM.
- The recipient is always the exact private chat in which the request arrived. The requester cannot specify another person or a group.
- The same restriction is validated when the job is created and again when it executes.
- Pending reminder drafts ask only for missing message/time information and can be cancelled.

## Verification
- `npm test`: 109 tests passed, 0 failed in the local test run.
- JavaScript source and test files passed `node --check`.
- Live WhatsApp delivery and the user's PostgreSQL instance must still be verified in the connected environment.
