# ASSUMPTIONS.md
# Not Your Type – Chintu | Decisions made where blueprint was silent/ambiguous

## A1: Group discovery method
Groups are upserted from `groupFetchAllParticipating()` at boot and also lazily when the first message arrives from an unknown group.

## A2: Pod API endpoints
Endpoints are based on known Pod API patterns for Medicaps. Stored in `.env` for easy update. Default values set to the known working endpoints.

## A3: Memory consolidation (nightly)
Implemented as memory decay + archival in SQL. Full LLM-based consolidation is structured but fires via the `consolidate` job kind (add nightly job to trigger it). Daily summary is written by the morning message flow.

## A4: LID (Linked Device ID) support
Both JID types stored in `person_identities`. Phone extraction from LIDs depends on Baileys providing `senderPn`, which is not always present.

## A5: No admin UI
All owner commands are via DM. Status available via the `status` command.

## A6: Nightly cleanup timing
Tick checks `hour === 3 && minute <= 1`. The 30-second tick means max 1-minute drift.

## A7: First-run Pod polling
A `firstRun` flag in `pollPodNotices()` marks all existing notices as seen without announcing. Should be called when owner links Pod account.

## A8: Message retention
Configurable via `MESSAGE_RETENTION_DAYS` env var (default 30). Cleanup runs nightly.

## A9: Group mode default
Groups are inserted with `enabled = FALSE`. Owner must explicitly enable each group.

## A10: Fallback line anti-repeat window
Last 5 lines per chat+category tracked in memory. Resets on restart (acceptable).

## A11: Pairing code instead of QR
`requestPairingCode()` called 3s after socket creation, only if not already registered.

## A12: Bot's own JID
@mention detection uses PAIR_NUMBER. Text alias matching (BOT_ALIASES) is the primary trigger detection.

## A13: Mass-bunk target date
If "kal" or "tomorrow" in message, target = tomorrow. Otherwise target = today.

## A14: Owner first-time identity
Owner claims via `!claim <secret>`. Message deleted after successful claim.

## A15: pino-pretty in devDependencies
Added for pretty terminal output in dev. Not required in production.
