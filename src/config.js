/**
 * src/config.js
 * Zod-validated environment configuration.
 * All secrets/config come from env variables – never hardcoded.
 */
import { z } from 'zod';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// Load .env file manually (no dotenv dependency)
const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

const schema = z.object({
  // WhatsApp
  PAIR_NUMBER: z.string().min(10),
  OWNER_NUMBER: z.string().min(10),
  OWNER_SECRET: z.string().min(6),
  BOT_NAME: z.string().default('Not Your Type'),
  BOT_ALIASES: z.string().default('Chintu,chintu,not your type'),

  // Database
  DATABASE_URL: z.string().url(),

  // Encryption
  CRED_ENC_KEY: z.string().min(32),

  // LLM
  GEMINI_API_KEY: z.string().min(10),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
  DAILY_AI_CAP: z.coerce.number().default(400),

  // Timing
  TZ_NAME: z.string().default('Asia/Kolkata'),
  MORNING_TIME: z.string().default('07:45'),
  QUIET_START: z.string().default('00:30'),
  QUIET_END: z.string().default('07:30'),

  // Group behaviour
  GROUP_REPLY_MODE: z.string().default('ambient'),
  GROUP_AMBIENT_REPLY_CHANCE: z.coerce.number().default(0.15),
  REACTION_CHANCE: z.coerce.number().default(0.08),
  USER_COOLDOWN_MS_GROUP: z.coerce.number().default(15000),
  USER_COOLDOWN_MS_DM: z.coerce.number().default(3000),
  GROUP_HOURLY_CAP: z.coerce.number().default(30),
  GROUP_DAILY_CAP: z.coerce.number().default(150),
  GLOBAL_PER_MINUTE: z.coerce.number().default(12),

  // Human send pipeline
  HUMAN_MIN_TYPING_MS: z.coerce.number().default(2200),
  HUMAN_MAX_TYPING_MS: z.coerce.number().default(7200),
  HUMAN_PRE_DELAY_MS: z.coerce.number().default(900),
  HUMAN_SPLIT_CHANCE: z.coerce.number().default(0.22),

  // Conversation starters
  STARTERS_ENABLED: z.string().default('true').transform(v => v === 'true'),
  STARTERS_PER_DAY: z.coerce.number().default(2),

  // DM approvals
  FIRST_DM_APPROVAL: z.string().default('true').transform(v => v === 'true'),
  MAX_FIRST_CONTACT_DMS_PER_DAY: z.coerce.number().default(10),

  // Data retention
  MESSAGE_RETENTION_DAYS: z.coerce.number().default(30),

  // Attendance zones
  ZONE_YELLOW_BELOW: z.coerce.number().default(75),
  ZONE_RED_BELOW: z.coerce.number().default(60),
  POD_REQUIRED_ATTENDANCE: z.coerce.number().default(75),

  // Pod API
  POD_SUBDOMAIN: z.string().default('medicaps'),
  POD_COLLEGE_ID: z.string().default('kiNdHC'),
  POD_API_ORIGIN: z.string().default('https://api.pod.ai'),
  POD_V4_BASE: z.string().default('https://api.pod.ai/v4/api'),
  POD_ERP_BASE: z.string().default('https://arp-api.pod.ai/v1'),
  POD_GRADE_BASE: z.string().default('https://asv-api.pod.ai/v1'),
  POD_REPORTING_BASE: z.string().default('https://reporting-api.pod.ai/classroom-reporting'),
  POD_ORIGIN: z.string().default('https://medicaps.pod.ai'),
  POD_LOGIN_FIELD: z.string().default('username'),
  POD_PROGRAM_TOKEN: z.string().default(''),
  POD_TIMEOUT_MS: z.coerce.number().default(20000),

  // Pod feed
  POD_ANNOUNCEMENT_EMAIL: z.string().default(''),
  POD_ANNOUNCEMENT_PASSWORD: z.string().default(''),
  POD_FEED_USE_OWNER_LINK: z.string().default('true').transform(v => v === 'true'),
  POD_FEED_POLL_MINUTES: z.coerce.number().default(5),
  POD_NOTIFICATION_MAX_AGE_DAYS: z.coerce.number().default(45),
  POD_NOTIFICATION_LIMIT: z.coerce.number().default(8),

  // Logging
  LOG_LEVEL: z.string().default('info'),
});

const result = schema.safeParse(process.env);
if (!result.success) {
  console.error('❌ Invalid configuration:');
  for (const issue of result.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = result.data;

/** Bot aliases as an array */
export const botAliases = config.BOT_ALIASES.split(',').map(a => a.trim().toLowerCase());
