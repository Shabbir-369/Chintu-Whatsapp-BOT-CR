# Not Your Type — timetable and calendar fixes

This build addresses the timetable/calendar failures reported from the WhatsApp terminal log.

- Defines the missing timetable time-range formatter, preventing `formatTimeRange is not defined` errors.
- Fixes the conversation-starter morning quiet-window calculation, preventing `hour is not defined` errors.
- Routes `time table` (two words), weekday-based requests, and whole-week requests to the timetable engine instead of casual chat/day-note parsing.
- Supports `aaj`, `kal`, `parso`, `narso`/`narsō`, English weekday names, common Hinglish weekday names, `iss hafte`, and `next week`.
- Adds a seven-day timetable reply with dates, time ranges, holidays, exams, and day notes.
- Selects timetable rows using the requested date, not the database server's `CURRENT_DATE`.
- Uses the bundled academic calendar when DB event rows are stale, recognizes `MST1`/`MST2` without a space, and handles `chutti` spelling.
- Adds automated regression tests for these cases.

## Update an existing Windows installation

1. Stop the old bot with `Ctrl+C`.
2. Extract this ZIP into a new folder.
3. Copy your existing `.env` file and `auth` folder into the new folder. They are intentionally not included in the archive.
4. From PowerShell in the new project folder, run `npm ci`, `npm test`, and `npm start`.
5. Keep using your existing PostgreSQL database. If the timetable table is empty or contains old data, stop the bot and run `npm run import:data` once before starting again.
