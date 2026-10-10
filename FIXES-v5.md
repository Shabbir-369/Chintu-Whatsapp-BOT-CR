# Fixes in v5

- Added a hard group-level guard so attendance, bunk, marks, and Pod queries never trigger a timetable answer in a group. The bot redirects those questions to DM without fetching attendance or timetable data.
- Mass-bunk messages are handled with a fixed group-safe response before the decision engine or LLM. Personal calculations and course data are not placed in the group reply.
- Removed live timetable/calendar context from ordinary group LLM prompts to prevent accidental timetable leakage during unrelated conversations.
- Mute mode is absolute, including messages from the owner inside the muted group. Unmute/manage the group from the owner's private chat.
- Trigger mode now ignores unaddressed messages before special handlers, and replies when the bot is mentioned, addressed by alias, or replied to.
- Ambient mode now replies to substantive messages by default after hard safety/rate-limit checks, rather than relying only on the low-probability ambient score.

Validation: existing automated suite passes (57 tests); modified JavaScript files pass `node --check`. Live WhatsApp behavior must still be tested on the user's connected session.
