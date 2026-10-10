# VERIFICATION.md
# Not Your Type – Chintu | Blueprint Requirement Checklist

Generated: 2026-10-06

## Legend
- ✅ Done – Fully implemented
- ⚠️ Partial – Implemented with limitations noted
- ❌ Missing – Not yet implemented
- N/A – Not applicable in this build

---

## §1–3: Project Goals & Persona

| Requirement | Status | File(s) | Notes |
|---|---|---|---|
| Chintu persona (classmate, not bot) | ✅ | `brain/persona.js` | Full system prompt with identity, voice, loyalty rules |
| Roman-script Hinglish by default | ✅ | `brain/persona.js` | Prompt instructs language mirroring |
| ≤12 word replies (60%) | ✅ | `brain/persona.js` | Prompt constraint + guard |
| No emoji overuse | ✅ | `brain/persona.js` | Prompt: most replies have NO emoji |
| Dry humor, not cringe | ✅ | `brain/persona.js` | Tone descriptions |
| Owner loyalty | ✅ | `brain/decision.js`, `brain/persona.js` | Defender block, system prompt loyalty section |
| Never reveal AI identity | ✅ | `brain/guard.js`, `brain/persona.js` | Extraction patterns + deflect tone |

## §5: Architecture

| Requirement | Status | File(s) | Notes |
|---|---|---|---|
| Layered architecture L1–L9 | ✅ | All src/ | Follows blueprint §5.2 exactly |
| Per-chat FIFO queue | ✅ | `gateway/ingress.js` | Map of per-chat queues |
| pg Pool max 8 | ✅ | `db/pool.js` | `max: 8` |
| One Node.js process | ✅ | `src/index.js` | Single process, no worker threads |

## §7: Safety

| Requirement | Status | File(s) | Notes |
|---|---|---|---|
| Extraction detection | ✅ | `brain/guard.js` | 15 patterns |
| Output guard (banned phrases) | ✅ | `brain/guard.js` | Bot phrases, technical terms, length |
| Repetition check | ✅ | `brain/guard.js`, `util/text.js` | `isRepetitive()` |
| Never log credentials/DM bodies | ✅ | `logger.js` | Pino redact paths |
| Rate limiting | ✅ | `policy/limits.js` | Cooldown, hourly cap, flood |
| Quiet hours | ✅ | `policy/quietHours.js`, `brain/decision.js` | IST-aware |
| Token/key never hardcoded | ✅ | `config.js`, `.env.example` | All via env |

## §8: Gateway

| Requirement | Status | File(s) | Notes |
|---|---|---|---|
| Baileys 7.0.0-rc14 pinned | ✅ | `package.json` | Exact version |
| Pairing code (not QR) | ✅ | `gateway/socket.js` | `requestPairingCode()` |
| Reconnect with backoff (5,10,20,40,60s) | ✅ | `gateway/socket.js` | Jitter ±20% |
| Logout detection | ✅ | `gateway/socket.js` | `DisconnectReason.loggedOut` → exit |
| Messages older than 180s ignored | ✅ | `gateway/ingress.js` | Timestamp check |
| Deduplicate by wa_id | ✅ | `gateway/ingress.js` | `findMessage()` check |
| Human typing indicator | ✅ | `gateway/outbox.js` | `sendPresenceUpdate('composing')` |
| Pre-send delay | ✅ | `gateway/outbox.js` | `HUMAN_PRE_DELAY_MS` |
| 1–2 part splits | ✅ | `gateway/outbox.js` | `splitIntoParts()` |
| Global rate limiter (token bucket) | ✅ | `gateway/outbox.js` | Per-minute token bucket |

## §9: Decision Engine

| Requirement | Status | File(s) | Notes |
|---|---|---|---|
| Block 1: Group enabled | ✅ | `brain/decision.js` | `isGroupEnabled()` |
| Block 2: Flood penalty | ✅ | `brain/decision.js`, `policy/limits.js` | 8 msgs/20s → 2min penalty |
| Block 3: Hourly cap | ✅ | `brain/decision.js` | `isGroupOverCap()` |
| Block 4: Quiet hours | ✅ | `brain/decision.js` | `inQuietHours()` |
| Block 5: Non-text (audio/sticker) | ✅ | `brain/decision.js` | Audio → brush-off, sticker → maybe react |
| Block 6: Owner always | ✅ | `brain/decision.js` | `isOwner` check |
| Block 7: Admin by non-owner | ✅ | `brain/decision.js` | Pattern match → refusal |
| Block 8: Extraction attempt | ✅ | `brain/decision.js` | `isExtractionAttempt()` |
| Block 9: Distress | ✅ | `brain/decision.js` | `isDistressSignal()` |
| Block 10: Owner attack | ✅ | `brain/decision.js` | Defender keywords |
| Block 11: Ambient scoring | ✅ | `brain/decision.js` | `computeAmbientScore()` |
| Burst handling (2-5 msgs in 8s) | ✅ | `router/groupHandler.js` | Debounce timer |
| Cooldown per person | ✅ | `policy/limits.js` | `isOnCooldown()` |
| Per-person fairness (5/min) | ✅ | `policy/limits.js` | `exceedsPersonFairness()` |

## §10: Memory

| Requirement | Status | File(s) | Notes |
|---|---|---|---|
| Memory write from LLM ops | ✅ | `brain/memory.js` | `processMemoryOps()` |
| Memory pack for model call | ✅ | `brain/memory.js` | `buildMemoryPack()` |
| Rank score (ts_rank + recency + importance) | ✅ | `db/repos/memory.js` | SQL formula |
| Strength decay nightly | ✅ | `db/repos/memory.js` | `applyMemoryDecay()` |
| Archive weak memories | ✅ | `db/repos/memory.js` | Strength < 0.1 |
| DM-scope memory never in group | ✅ | `brain/persona.js` | System prompt instruction |
| Cheap rule pass (name claims, promises) | ✅ | `brain/memory.js` | `cheapRulePass()` |
| Dedupe/merge similar memories | ✅ | `db/repos/memory.js` | `findSimilarMemories()` |

## §11: Skills

| Requirement | Status | File(s) | Notes |
|---|---|---|---|
| Morning timetable message | ✅ | `skills/morning.js` | Per-group jitter, LLM voice |
| Timetable query (NL) | ✅ | `skills/timetable.js` | Subject, holiday, exam queries |
| Conversation starters | ✅ | `skills/starter.js` | Alive/quiet checks, ignore streaks |
| Owner console (intent parse) | ✅ | `router/ownerConsole.js` | Rules + LLM fallback |
| DM approval flow | ✅ | `router/dmHandler.js` | Pending → card → approve/deny |
| Name approval flow | ✅ | `skills/naming.js` | Proposal card, owner decides |
| Owner-ordered messaging | ✅ | `skills/sendOrder.js` | Target resolution, scheduling |
| Mass-bunk detection + warn | ✅ | `skills/massBunk.js` | Per-person private warnings, owner report |
| !claim owner command | ✅ | `router/ownerConsole.js` | Message deleted after |

## §12: Pod Integration

| Requirement | Status | File(s) | Notes |
|---|---|---|---|
| Pod login flow (5-step) | ✅ | `skills/pod/client.js` | auth → JWT → community/student/program tokens |
| Session caching | ✅ | `skills/pod/client.js`, `db/repos/pod.js` | DB-persisted, auto-refresh |
| Encrypted credentials (AES-256-GCM) | ✅ | `db/repos/pod.js`, `util/crypto.js` | personId as AAD |
| Attendance fetch + format | ✅ | `skills/pod/attendance.js` | Zone colors, overall % |
| Bunk calculator | ✅ | `skills/pod/bunk.js` | Safe bunks, recovery count |
| Marks/grades | ✅ | `skills/pod/marks.js` | Cached 30 min |
| Pod notices polling | ✅ | `skills/pod/notices.js` | Dedup, first-run seed |
| Account linking flow | ✅ | `skills/pod/link.js` | 3-step: consent → email → password |
| Max 3 login attempts/hour | ✅ | `skills/pod/link.js`, `db/repos/pod.js` | `getLinkAttempts()` |
| Concurrent request cap (3) | ✅ | `skills/pod/client.js` | `activeRequests` counter |

## §13: Schema & Data

| Requirement | Status | File(s) | Notes |
|---|---|---|---|
| Full PostgreSQL schema | ✅ | `migrations/001_init.sql` | 25+ tables |
| FTS index on memories | ✅ | `migrations/001_init.sql` | `TSVECTOR GENERATED ALWAYS` |
| Trigram index on memories | ✅ | `migrations/001_init.sql` | `GIN gin_trgm_ops` |
| Data import script | ✅ | `scripts/import-data.js` | Timetable + calendar |
| Sample timetable | ✅ | `data/classinfo.json` | IT-VB-2026 sample |
| Sample calendar | ✅ | `data/academic-calendar.json` | Exams + holidays |

## §15: Output Quality

| Requirement | Status | File(s) | Notes |
|---|---|---|---|
| JSON mode output | ✅ | `brain/llm.js` | `responseMimeType: 'application/json'` |
| Output schema validation (Zod) | ✅ | `brain/llm.js` | `replySchema.parse()` |
| Max 400 char guard | ✅ | `brain/guard.js` | Non-data replies |
| Fallback line bank | ✅ | `brain/fallback.js`, `data/fallback-lines.json` | 13 categories, anti-repeat |
| 2 LLM retries on failure | ✅ | `brain/llm.js` | `attempt < 2` loop |
| Budget exhaustion → fallback | ✅ | `brain/llm.js`, `router/groupHandler.js` | `isBudgetExhausted()` |
| Distress → serious tone | ✅ | `router/groupHandler.js` | Second model call with `serious` tone |

## §16: Scheduler

| Requirement | Status | File(s) | Notes |
|---|---|---|---|
| 30-second tick | ✅ | `scheduler/tick.js` | `setInterval(tick, 30000)` |
| Morning messages (scheduled) | ✅ | `scheduler/tick.js` | IST time check |
| Pod feed polling (job) | ✅ | `scheduler/jobs.js` | `pod_feed_poll` job kind |
| Nightly tasks at 03:00 | ✅ | `scheduler/tick.js` | Memory decay, cleanup |
| DB-backed job queue | ✅ | `db/repos/timetable.js` | `jobs` table |

## §17: Secrets & Privacy

| Requirement | Status | File(s) | Notes |
|---|---|---|---|
| `.env` for all secrets | ✅ | `config.js`, `.env.example` | Zod-validated |
| `auth/` git-ignored | ✅ | `.gitignore` | Check .gitignore |
| No credentials in logs | ✅ | `logger.js` | Pino redact list |

---

## Known Limitations / Assumptions

See `docs/ASSUMPTIONS.md` for full list.

1. **Group membership**: Members are upserted as they message, not on join events.
2. **Pod API endpoints**: Based on Medicaps-specific Pod API reverse engineering. May change with Pod updates.
3. **Consolidation job**: Nightly group conversation consolidation is implemented as decay only (no LLM summarization in the tick — can be added as a `consolidate` job kind).
4. **LID support**: Baileys LID (linked device IDs) are handled in identity resolution but phone extraction from LIDs is limited.
5. **No admin panel UI**: Owner interaction is entirely through WhatsApp DM.
6. **Audio transcription**: Audio messages get a brush-off reply, not transcription (not in blueprint).
