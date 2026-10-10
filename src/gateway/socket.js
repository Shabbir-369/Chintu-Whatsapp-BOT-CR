/**
 * src/gateway/socket.js
 * WhatsApp connection via Baileys. Pairing, reconnect with backoff, event intake.
 * Implements §8.1 exactly.
 */
import makeWASocket, {
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  Browsers,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { getLogger } from '../logger.js';

const log = getLogger('gateway/socket');
const __dirname = dirname(fileURLToPath(import.meta.url));

const AUTH_DIR = resolve(__dirname, '../../auth');

// Backoff schedule: 5,10,20,40,60 seconds with ±20% jitter
const BACKOFF_STEPS = [5000, 10000, 20000, 40000, 60000];
let reconnectAttempt = 0;

let sock = null;
let messageHandler = null;
let socketConnected = false;
let reconnectTimer = null;

/**
 * Register the handler that processes incoming messages.upsert events.
 * @param {function} handler
 */
export function setMessageHandler(handler) {
  messageHandler = handler;
}

/**
 * Send a raw WhatsApp message.
 */
export async function sendWAMessage(jid, content, opts = {}) {
  if (!sock || !socketConnected) throw new Error('Socket not connected');
  return sock.sendMessage(jid, content, opts);
}

/**
 * Send a reaction.
 */
export async function sendWAReaction(jid, emoji, messageKey) {
  if (!sock || !socketConnected) throw new Error('Socket not connected');
  return sock.sendMessage(jid, { react: { text: emoji, key: messageKey } });
}

/**
 * Send presence update (typing/recording).
 */
export async function sendWAPresence(jid, type) {
  if (!sock || !socketConnected) throw new Error('Socket not connected');
  return sock.sendPresenceUpdate(type, jid);
}

/**
 * Mark messages as read.
 */
export async function markRead(keys) {
  if (!sock) return;
  try {
    await sock.readMessages(keys);
  } catch (err) {
    log.warn({ err }, 'Failed to mark read');
  }
}

/**
 * Delete a message (for !claim secret removal).
 */
export async function deleteMessage(jid, messageKey) {
  if (!sock) return;
  try {
    await sock.sendMessage(jid, { delete: messageKey });
  } catch (err) {
    log.warn({ err }, 'Failed to delete message');
  }
}

/**
 * Fetch all groups the bot is in (rate-limited: at most every 10 min).
 */
let lastGroupFetch = 0;
export async function fetchGroups() {
  const now = Date.now();
  if (now - lastGroupFetch < 10 * 60 * 1000) return null;
  lastGroupFetch = now;
  if (!sock) return null;
  try {
    const groups = await sock.groupFetchAllParticipating();
    return Object.values(groups);
  } catch (err) {
    log.warn({ err }, 'Failed to fetch groups');
    return null;
  }
}

/**
 * Get socket state info.
 */
export function getSocketState() {
  return {
    connected: socketConnected,
    user: sock?.user || null,
  };
}

/**
 * Connect and return the socket. Handles pairing, reconnect, events.
 * @param {object} opts
 * @param {function} opts.onConnect – called when connected
 * @param {function} opts.onDisconnect – called on disconnect with reason
 */
export async function connect({ onConnect, onDisconnect } = {}) {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  log.info({ version }, 'Connecting to WhatsApp');

  const socket = makeWASocket({
    version,
    auth: state,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    logger: { level: 'silent', trace: () => { }, debug: () => { }, info: () => { }, warn: () => { }, error: () => { }, fatal: () => { }, child: () => ({ level: 'silent', trace: () => { }, debug: () => { }, info: () => { }, warn: () => { }, error: () => { }, fatal: () => { }, child: () => { } }) },
    printQRInTerminal: false,
  });
  sock = socket;
  socketConnected = false;

  // Pairing code
  if (!state.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await socket.requestPairingCode(config.PAIR_NUMBER.replace(/\D/g, ''));
        console.log(`\n🔗 PAIRING CODE: ${code}\n   WhatsApp > Linked devices > Link with phone number\n`);
      } catch (err) {
        log.error({ err }, 'Failed to request pairing code');
      }
    }, 3000);
  }

  socket.ev.on('creds.update', saveCreds);

  socket.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // A stale socket can emit events after a replacement has connected. It
    // must never change state or start another reconnect loop.
    if (socket !== sock) return;

    if (connection === 'open') {
      socketConnected = true;
      log.info('WhatsApp connected');
      reconnectAttempt = 0;
      onConnect && onConnect(socket);
    } else if (connection === 'close') {
      socketConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        log.error('WhatsApp logged out. Delete auth folder and re-pair.');
        onDisconnect && onDisconnect('loggedOut');
        process.exit(1);
      } else {
        const idx = Math.min(reconnectAttempt, BACKOFF_STEPS.length - 1);
        const base = BACKOFF_STEPS[idx];
        const jitter = Math.floor(base * 0.2 * (Math.random() * 2 - 1));
        const delay = base + jitter;
        log.warn({ statusCode, delay }, 'Disconnected, reconnecting...');
        reconnectAttempt++;
        if (!reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            if (socket === sock) connect({ onConnect, onDisconnect });
          }, delay);
        }
        onDisconnect && onDisconnect(statusCode);
      }
    }
  });

  socket.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    if (!messageHandler) return;
    for (const msg of messages) {
      try {
        await messageHandler(msg, socket);
      } catch (err) {
        log.error({ err }, 'Error in message handler');
      }
    }
  });

  return socket;
}
