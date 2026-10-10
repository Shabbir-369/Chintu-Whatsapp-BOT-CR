# Fixes in v6

## Unified group/person target resolution

- Group controls (`mute`, `unmute`, `enable`, `disable`, and switching to `ambient`, `trigger`, or `mute`) use the same strict target resolver.
- Exact, unambiguous targets are applied immediately.
- Ambiguous, misspelled, or missing targets produce a numbered list instead of a premature “group not found” response.
- The numbered-choice state remains active when a reply is invalid, and accepts a number or an exact candidate name. New group commands and cancellation safely replace/clear the pending choice.
- Person/group name collisions are explicitly disambiguated for send and schedule commands; the choice list identifies each entry's type.
- “Forget person” and name changes use the same safe person resolver rather than selecting the first database result.

## Easier Pod linking

- Asking for an unlinked Pod data item (for example, “attendance bata”, “bunk kitna hai”, or “marks bata”) starts linking immediately at the email step.
- Explicit “link pod” commands and data requests share the same entry point in owner and approved DM flows.
- Existing link sessions continue normally; cancellation remains available.
- The flow asks only for the required Medi-Caps login email and password. Password handling continues to use the project's encrypted credential storage.

## Verification

- Run `npm test` for the automated regression suite.
- Run `npm start` with a configured `.env`, reachable PostgreSQL database, and WhatsApp session for live integration verification.
- Live WhatsApp interactions were not exercised in the build environment.
