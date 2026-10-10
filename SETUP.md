# SETUP.md – Complete Setup Guide

## Prerequisites

- Node.js 20 or later: https://nodejs.org/
- PostgreSQL 15 or later: https://www.postgresql.org/downloads/
- A spare WhatsApp number (for the bot)
- Google Gemini API key: https://aistudio.google.com/

## Step-by-Step Installation

### 1. Install Node.js dependencies

```bash
npm install
```

### 2. Create PostgreSQL database

```sql
CREATE DATABASE not_your_type;
CREATE USER chintu_bot WITH PASSWORD 'your_password';
GRANT ALL PRIVILEGES ON DATABASE not_your_type TO chintu_bot;
\c not_your_type
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in:
- `PAIR_NUMBER` – the bot's WhatsApp number (e.g. `919876543210`)
- `OWNER_NUMBER` – your WhatsApp number
- `OWNER_SECRET` – any random secret (e.g. `mysecret123`) you'll type once
- `DATABASE_URL` – e.g. `postgres://chintu_bot:your_password@localhost:5432/not_your_type`
- `CRED_ENC_KEY` – run `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` to generate
- `GEMINI_API_KEY` – from Google AI Studio

### 4. Run database migrations

```bash
npm run migrate
```

This creates all tables and indexes.

### 5. Add timetable and calendar data (optional but recommended)

Place your `classinfo.json` and `academic-calendar.json` files in the `data/` folder.

Format: same as the old class-bot format. See `data/classinfo.json.example` for structure.

Then run:
```bash
npm run import:data
```

### 6. First run and pairing

```bash
node src/index.js
```

Watch the console for a 8-digit pairing code like:
```
📱 WhatsApp > Linked devices > Link with phone number
Pairing code: ABCD-EFGH
```

On your bot's WhatsApp: Settings → Linked Devices → Link a Device → Link with phone number.
Enter the pairing code. Wait for "WhatsApp connected!" in the console.

### 7. Claim owner identity

In WhatsApp, send a DM to the bot number:
```
!claim your_owner_secret_here
```

The bot will reply and register your number. All owner commands are now active.

### 8. Enable your class group

In the DM with the bot, type the name of your class group (full or partial):
```
IT V-B group mein chat kar
```

The bot will find the group and ask you to confirm if multiple match.

### 9. Production deployment with PM2

```bash
npm install -g pm2
pm2 start src/index.js --name chintu
pm2 save
pm2 startup
```

## Backup

- Back up `auth/` folder daily (WhatsApp session)
- Back up the PostgreSQL database daily:
  ```bash
  pg_dump not_your_type > backup_$(date +%Y%m%d).sql
  ```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "WhatsApp logged out" | Delete `auth/` folder and re-pair from step 6 |
| Database connection error | Check DATABASE_URL and that PostgreSQL is running |
| Pairing code not shown | Wait 10s, check PAIR_NUMBER is correct format (digits only) |
| "Module not found" | Run `npm install` again |
| Two instances warning | Kill the other process; never run two at once |
