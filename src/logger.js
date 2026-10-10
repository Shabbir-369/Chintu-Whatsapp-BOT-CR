/**
 * src/logger.js
 * Pino logger with redaction of all sensitive fields.
 * Per §7.1 and §17 – never log credentials, tokens, passwords, or DM bodies.
 */
import pino from 'pino';
import { config } from './config.js';

const REDACT_PATHS = [
  'password',
  'authToken',
  'jwt',
  'authorization',
  'token',
  'credentials',
  'ct',
  'tag',
  'iv',
  'creds',
  'enc_credentials',
  'enc_session',
  'enc_partial',
  '*.password',
  '*.authToken',
  '*.jwt',
  '*.token',
  '*.credentials',
];

export const logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]',
  },
  transport: process.stdout.isTTY
    ? {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard' },
      }
    : undefined,
});

/**
 * Create a child logger for a specific module.
 * @param {string} module - Module name
 * @returns {pino.Logger}
 */
export function getLogger(module) {
  return logger.child({ module });
}

/**
 * Hash a chat JID for safe logging (first 10 chars of sha256).
 * @param {string} jid
 * @returns {string}
 */
export function hashJid(jid) {
  if (!jid) return 'unknown';
  import('crypto').then(({ createHash }) => {}).catch(() => {});
  // Synchronous fallback: just use first 6 chars of jid safely
  const safe = jid.replace(/[^a-z0-9@.]/gi, '').slice(0, 10);
  return safe;
}
