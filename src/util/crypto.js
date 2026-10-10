/**
 * src/util/crypto.js
 * AES-256-GCM encryption/decryption for credentials and session tokens.
 * Envelope format: { v: 1, alg: 'aes-256-gcm', iv: hex, tag: hex, ct: hex }
 * AAD = the subject's person_id (prevents cross-person decryption).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { config } from '../config.js';

const ALG = 'aes-256-gcm';
const VERSION = 1;

/** Parse the encryption key from env (accepts 64-char hex or 44-char base64) */
function getKey() {
  const raw = config.CRED_ENC_KEY;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  const buf = Buffer.from(raw, 'base64');
  if (buf.length === 32) return buf;
  throw new Error('CRED_ENC_KEY must be 32 bytes (64-char hex or 44-char base64)');
}

/**
 * Encrypt a value.
 * @param {object|string} value - Data to encrypt
 * @param {string} aad - Additional authenticated data (person_id)
 * @returns {{ v, alg, iv, tag, ct }} Envelope object
 */
export function encrypt(value, aad = '') {
  const key = getKey();
  const iv = randomBytes(12);
  const plaintext = typeof value === 'string' ? value : JSON.stringify(value);
  const cipher = createCipheriv(ALG, key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: VERSION,
    alg: ALG,
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    ct: ct.toString('hex'),
  };
}

/**
 * Decrypt an envelope.
 * @param {{ v, alg, iv, tag, ct }} envelope
 * @param {string} aad - Must match the AAD used during encryption
 * @returns {any} Decrypted value (parsed if JSON)
 */
export function decrypt(envelope, aad = '') {
  if (!envelope || envelope.v !== VERSION) throw new Error('Unknown envelope version');
  const key = getKey();
  const decipher = createDecipheriv(ALG, key, Buffer.from(envelope.iv, 'hex'));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ct, 'hex')),
    decipher.final(),
  ]).toString('utf8');
  try {
    return JSON.parse(plaintext);
  } catch {
    return plaintext;
  }
}
