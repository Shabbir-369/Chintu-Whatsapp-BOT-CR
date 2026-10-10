# BUILD PLAN — Not Your Type (Chintu)

## Project Summary (≤10 lines)

Chintu is a virtual class representative WhatsApp bot that lives on the owner's WhatsApp number under the name "Not Your Type". It behaves like a real, witty, savage classmate in an unofficial college class group (B.Tech IT Sem V, Medicaps Univ.). It uses Baileys to drive WhatsApp, Gemini for language generation, and PostgreSQL for all persistent state. It has a human-like memory system, integrates with the Medicaps Pod portal for attendance/marks, delivers morning timetable messages, computes bunk calculations, analyses mass-bunk scenarios, and handles all group/DM moderation privately through the owner's WhatsApp chat. It never reveals its internals, never gets the number banned, and is loyal to the owner through behaviour alone.

**Stack:** Node.js 20+ · @whiskeysockets/baileys 7.0.0-rc14 · PostgreSQL 15+ · Google Gemini API · zod · pino

---

## Final Folder Structure

```
not-your-type/
├── package.json
├── .env.example
├── .gitignore
├── README.md
├── SETUP.md
├── docs/
├── migrations/
│   ├── 001_init.sql
│   └── 002_indexes.sql
├── data/
│   ├── classinfo.json
│   ├── academic-calendar.json
│   └── fallback-lines.json
├── auth/
├── scripts/
│   ├── import-data.js
│   ├── migrate-old-store.js
│   └── smoke-test.mjs
└── src/
    ├── index.js
    ├── config.js
    ├── logger.js
    ├── db/pool.js, migrate.js, repos/*.js
    ├── gateway/socket.js, ingress.js, outbox.js
    ├── router/router.js, ownerConsole.js, dmHandler.js, groupHandler.js
    ├── policy/access.js, limits.js, quietHours.js
    ├── brain/decision.js, memory.js, persona.js, llm.js, guard.js, fallback.js
    ├── skills/naming.js, sendOrder.js, timetable.js, morning.js, starter.js, massBunk.js
    ├── skills/pod/client.js, attendance.js, bunk.js, marks.js, notices.js, link.js
    ├── scheduler/tick.js, jobs.js
    └── util/crypto.js, time.js, text.js, fuzzy.js
```

---

## Numbered Milestone List

| # | Milestone | Done When |
|---|-----------|-----------|
| 1 | Foundation | npm run migrate creates schema; npm test passes |
| 2 | WhatsApp Core | Pair via code; owner DM gets human-like echo |
| 3 | Owner Console & Access | Owner enables group by partial name; D-card works |
| 4 | Brain v1 | Group banter natural; extraction → brush-off |
| 5 | Memory | Bot callbacks to earlier chat; habits persist |
| 6 | Naming | Names set only after owner approval |
| 7 | Class Data & Scheduling | Morning message at right time |
| 8 | Pod Integration | Correct attendance + bunk numbers |
| 9 | Mass Bunk | Private warnings + owner report |
| 10 | Hardening | 7-day dry run without issues |

---

## Requirement-to-File Traceability

| Blueprint Requirement | File(s) |
|----------------------|---------|
| N1-N7 non-negotiables | src/policy/access.js, src/brain/guard.js, src/gateway/outbox.js |
| §8.1 Connection | src/gateway/socket.js |
| §8.2 humanSend | src/gateway/outbox.js |
| §9 Decision engine | src/brain/decision.js |
| §10 Memory | src/brain/memory.js, src/db/repos/memory.js |
| §11.1 Owner console | src/router/ownerConsole.js |
| §11.4 Naming | src/skills/naming.js |
| §11.7 Timetable/morning | src/skills/timetable.js, src/skills/morning.js |
| §11.8 Pod link | src/skills/pod/link.js |
| §11.10 Mass bunk | src/skills/massBunk.js |
| §12 Pod client | src/skills/pod/client.js |
| §13 Schema | migrations/001_init.sql |
| §15 Brain/LLM | src/brain/llm.js, src/brain/persona.js, src/brain/guard.js |
| §16 Scheduler | src/scheduler/tick.js, src/scheduler/jobs.js |
| §19 Config | .env.example, src/config.js |
