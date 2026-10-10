# v10 — Contact Naming and Conversation Context

Focused changes from v9:

- New identities receive a stable initial label from their WhatsApp push name, or their phone number when no name is available.
- Unknown phone-number-labeled group members trigger a one-time private owner prompt with the number and a direct `name +number as Name` instruction.
- Owner-side contact resolution accepts phone numbers with spaces, punctuation, or a leading plus.
- Recent same-chat messages are passed into DM, group, and owner DM model calls.
- Group recent-history context filters attendance, bunk, marks, credentials, and other Pod-sensitive messages; existing private-memory filters remain in place.
- Canonical people display names are now used in the memory pack, so owner-assigned names appear in the model's context.

No scheduler, mode, timetable, mass-bunk, or Pod workflow was intentionally changed.
