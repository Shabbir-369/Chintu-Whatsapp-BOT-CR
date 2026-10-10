# Not Your Type – Chintu 🤖

> A WhatsApp presence for your class group — witty, loyal, and a little dangerous with words.  
> Chintu acts like a classmate: he replies, reacts, teases, backs up the CR, fetches attendance, and warns you before a mass bunk kills your percentage.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ (ESM) |
| WhatsApp | Baileys 7.0.0-rc14 (pairing code) |
| AI | Google Gemini 2.5 Flash (JSON mode, thinking budget: 0) |
| Database | PostgreSQL 14+ |
| Logging | Pino |
| Config | Zod-validated `.env` |
| Tests | Node.js built-in `node:test` |

---

## Folder Structure

```
not-your-type/
├── src/
│   ├── index.js              # Boot: migrate → connect → scheduler
│   ├── config.js             # Zod-validated env config
│   ├── logger.js             # Pino logger with redaction
│   ├── gateway/
│   │   ├── socket.js         # Baileys connection, pairing, reconnect
│   │   ├── ingress.js        # Normalise, identify, dedupe, queue
│   │   └── outbox.js         # Human-like send pipeline
│   ├── router/
│   │   ├── router.js         # Main dispatcher
│   │   ├── ownerConsole.js   # Owner commands & intent parsing
│   │   ├── dmHandler.js      # DM approval flow + Pod queries
│   │   └── groupHandler.js   # Group reply/react/ignore
│   ├── brain/
│   │   ├── decision.js       # 11-block priority decision engine
│   │   ├── llm.js            # Gemini client (JSON output, retries)
│   │   ├── persona.js        # System prompt builder (Chintu's voice)
│   │   ├── memory.js         # Memory pack builder + write ops
│   │   ├── guard.js          # Output guard + extraction detector
│   │   └── fallback.js       # Canned fallback line bank
│   ├── skills/
│   │   ├── timetable.js      # Day context + NL timetable queries
│   │   ├── morning.js        # Morning message sender
│   │   ├── starter.js        # Conversation initiators
│   │   ├── massBunk.js       # Mass-bunk analysis + warnings
│   │   ├── naming.js         # Name approval flow
│   │   ├── sendOrder.js      # Owner-ordered messaging
│   │   └── pod/
│   │       ├── client.js     # Pod API client (login, sessions)
│   │       ├── attendance.js # Attendance fetch + formatting
│   │       ├── bunk.js       # Bunk calculator
│   │       ├── marks.js      # Grades/marks
│   │       ├── notices.js    # Pod announcements polling
│   │       └── link.js       # Pod account linking flow
│   ├── scheduler/
│   │   ├── tick.js           # 30-second scheduler tick
│   │   └── jobs.js           # DB-backed job executor
│   ├── policy/
│   │   ├── access.js         # Group/DM access control
│   │   ├── limits.js         # Rate limits (cooldown, cap, flood)
│   │   └── quietHours.js     # Quiet hours enforcement
│   ├── db/
│   │   ├── pool.js           # pg connection pool
│   │   ├── migrate.js        # SQL migration runner
│   │   └── repos/            # Data access layer
│   └── util/
│       ├── crypto.js         # AES-256-GCM for Pod credentials
│       ├── fuzzy.js          # Fuzzy matching for group/person names
│       ├── text.js           # Normalise, similarity, guard helpers
│       └── time.js           # IST timezone helpers
├── migrations/
│   └── 001_init.sql          # Full schema
├── data/
│   ├── classinfo.json        # Timetable (edit this for your class)
│   ├── academic-calendar.json # Exams and holidays
│   └── fallback-lines.json   # Canned responses
├── scripts/
│   ├── import-data.js        # Import classinfo + calendar into DB
│   └── smoke-test.mjs        # Quick sanity check
├── test/
│   ├── bunk.test.js          # Bunk math unit tests
│   └── guard.test.js         # Guard + extraction tests
├── auth/                     # WhatsApp auth state (git-ignored)
├── docs/                     # Blueprint and build docs
├── .env.example              # Environment template
└── package.json
```

---

## Quick Start

### 1. Prerequisites

- Node.js ≥ 20
- PostgreSQL 14+ running locally (or hosted)
- A Google Gemini API key ([get one free](https://aistudio.google.com/apikey))
- A WhatsApp number for Chintu to run on (a SIM or virtual number)

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
# Edit .env with your values (see Environment Variables below)
```

### 4. Create the database

```bash
# Create database in psql
psql -U postgres -c "CREATE DATABASE chintu_db;"
```

### 5. Run migrations

```bash
npm run migrate
```

### 6. Import class timetable & calendar

Edit `data/classinfo.json` and `data/academic-calendar.json` with your section's real timetable, then:

```bash
npm run import:data
```

### 7. Start the bot

```bash
npm start
```

A **pairing code** will be printed to the console:

```
🔗 PAIRING CODE: ABCD-EFGH
   WhatsApp > Linked devices > Link with phone number
```

Enter the number in WhatsApp → Linked Devices → Link with phone number, then enter the code.

### 8. Claim owner identity

In Chintu's private DM, send:

```
!claim <your-OWNER_SECRET>
```

The message is deleted immediately after. You are now the owner/CR.

### 9. Enable a group

In your private DM with Chintu, say:

```
enable IT VB group
```

Chintu will fuzzy-match the group name and confirm.

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PAIR_NUMBER` | ✅ | — | WhatsApp number for Chintu (international, no +) |
| `OWNER_NUMBER` | ✅ | — | Your WhatsApp number |
| `OWNER_SECRET` | ✅ | — | Secret for `!claim` command |
| `DATABASE_URL` | ✅ | — | PostgreSQL connection URL |
| `CRED_ENC_KEY` | ✅ | — | 64-char hex key (32 bytes) for AES-256-GCM |
| `GEMINI_API_KEY` | ✅ | — | Google Gemini API key |
| `GEMINI_MODEL` | | `gemini-2.5-flash` | Model name |
| `DAILY_AI_CAP` | | `400` | Max AI calls per day |
| `MORNING_TIME` | | `07:45` | Morning message time (IST HH:MM) |
| `GROUP_AMBIENT_REPLY_CHANCE` | | `0.85` | Probability of ambient replies (0–1) |
| `GROUP_HOURLY_CAP` | | `30` | Max replies per group per hour |
| `POD_REQUIRED_ATTENDANCE` | | `75` | Attendance threshold % |
| `LOG_LEVEL` | | `info` | Pino log level |

See `.env.example` for the full list with descriptions.

---

## Run Commands

| Command | Description |
|---|---|
| `npm start` | Start the bot |
| `npm run dev` | Start with `--watch` (auto-restart on changes) |
| `npm run migrate` | Run database migrations |
| `npm run import:data` | Import timetable and calendar |
| `npm run smoke` | Run smoke tests (requires running DB) |
| `npm test` | Run unit tests |

---

## Owner Commands

Send these as plain text in Chintu's private DM:

| Command | Effect |
|---|---|
| `!claim <secret>` | Claim owner identity (one-time) |
| `enable <group name>` | Enable Chintu in a group |
| `disable <group name>` | Disable Chintu in a group |
| `status` | Get bot status (connection, AI usage, groups) |
| `<person> ko bol <message>` | Send a message to someone |
| `D4 yes` / `D4 no` | Approve/deny a DM request |
| `N7 yes` / `N7 no` | Approve/deny a name suggestion |
| `reload` | Reload timetable/calendar from JSON files |

---

## User Commands (DM)

Anyone can send these in Chintu's private DM (after DM approval):

| Message | Effect |
|---|---|
| `link pod` | Start Pod account linking flow |
| `attendance` | Get your attendance breakdown |
| `bunk` | Get safe bunk counts per subject |
| `marks` | Get grades/marks |
| `unlink pod` | Remove linked Pod account |
| `cancel` | Cancel any in-progress flow |

---

## Updating the Timetable

Edit `data/classinfo.json` then run:

```bash
npm run import:data
```

Or tell Chintu in your DM: `reload`

---

## Deployment

### PM2 (recommended)

```bash
npm install -g pm2
pm2 start src/index.js --name chintu --interpreter node
pm2 save
pm2 startup
```

### Running on a Server

1. Set all env variables in `.env` or as system environment variables.
2. Ensure PostgreSQL is running and accessible.
3. Run `npm run migrate` and `npm run import:data` once.
4. Start with `npm start` or PM2.
5. Pair the device once (pairing code shown in logs).
6. Auth state is saved in `auth/` — **back this up** to avoid re-pairing.

### Important Notes

- **Never commit `.env` or `auth/`** — both are git-ignored.
- **Back up `auth/`** regularly. If lost, you must re-pair.
- The bot uses one Node.js process. No Docker/Kubernetes needed.
- Baileys 7.0.0-rc14 is pinned — do not upgrade without testing.

---

## Architecture Overview

```
WhatsApp ─→ Baileys ─→ ingress.js ─→ per-chat FIFO queue
                                         │
                                         ▼
                                    router.js
                                    /    │    \
                         owner    DM    group
                        console handler handler
                                         │
                                    decision.js (11 blocks)
                                         │
                                    llm.js (Gemini)
                                         │
                                    guard.js → outbox.js → WhatsApp
```

---

## Safety & Privacy

- Pod passwords are encrypted with AES-256-GCM. The encryption key never leaves your server.
- DM bodies are never logged.
- The bot never reveals it is AI-powered. Extraction attempts are deflected in-character.
- Mass-bunk warnings are sent privately — names and numbers never appear in group chat.
- Memory is scoped (person vs. group): private DM facts never leak into group replies.

---

## What Needs Your Input

Before the bot is fully functional, you must provide:

1. **Real timetable** — edit `data/classinfo.json` with your section's schedule
2. **Real academic calendar** — edit `data/academic-calendar.json`  
3. **Gemini API key** — from [aistudio.google.com](https://aistudio.google.com/apikey)
4. **A WhatsApp number** for Chintu (any number you control)
5. **PostgreSQL database** (local or hosted, e.g. Supabase free tier)
6. **CRED_ENC_KEY** — generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

---

## What Was Built

- Full WhatsApp gateway (Baileys, pairing, reconnect with backoff)
- 11-block decision engine (owner → admin → extraction → distress → triggers → data → mass-bunk → small-talk → ambient)
- Gemini JSON-mode reply generation with persona, memory, output guard
- Human-like send pipeline (typing indicator, delay, split, rate limit)
- DM approval flow with owner notification cards
- Pod API client (login, session, attendance, bunk calc, marks, notices)
- Mass-bunk analysis with per-person private warnings
- Conversation starters, morning messages, nightly memory decay
- Owner console with rule-based + LLM intent parsing
- Full PostgreSQL schema (25+ tables, indexes, FTS, trigram)
- Name approval flow, memory CRUD with strength decay
- Complete test suite for core logic

---

*Built for Section V-B, IT, Medicaps University.*
