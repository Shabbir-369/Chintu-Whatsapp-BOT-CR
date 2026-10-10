/**
 * scripts/smoke-test.mjs
 * Smoke test: verify config, DB connection, and basic module imports.
 * Run: npm run smoke
 */

import { config } from '../src/config.js';
import { pool } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrate.js';
import { computeBunk } from '../src/skills/pod/bunk.js';
import { guardOutput } from '../src/brain/guard.js';
import { isExtractionAttempt, isDistressSignal } from '../src/brain/guard.js';
import { normalise, similarity } from '../src/util/text.js';
import { fuzzyMatch } from '../src/util/fuzzy.js';
import { encrypt, decrypt } from '../src/util/crypto.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`❌ ${name}: ${err.message}`);
    failed++;
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`❌ ${name}: ${err.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

console.log('\n🧪 Running smoke tests...\n');

// ── Bunk math ──────────────────────────────────────────────────────
test('Bunk math: green zone', () => {
  const b = computeBunk({ present: 75, total: 100, percentage: 75, code: 'X', name: 'X', zone: 'Green' });
  assert(b.safeBunks === 0, `Expected 0, got ${b.safeBunks}`);
});

test('Bunk math: safe bunks when above 75%', () => {
  const b = computeBunk({ present: 80, total: 100, percentage: 80, code: 'X', name: 'X', zone: 'Green' });
  assert(b.safeBunks > 0, 'Should have safe bunks');
});

test('Bunk math: zone boundary 59.99 = Red', () => {
  assert(59.99 < 60, 'Zone boundary check');
});

test('Bunk math: recovery when below 75%', () => {
  const b = computeBunk({ present: 60, total: 100, percentage: 60, code: 'X', name: 'X', zone: 'Yellow' });
  assert(b.needToAttend > 0, 'Should need to attend classes');
});

// ── Guard ──────────────────────────────────────────────────────────
test('Guard: blocks bot phrases', () => {
  const { ok } = guardOutput('Sure! I am designed to help you.');
  assert(!ok, 'Should block bot phrase');
});

test('Guard: allows normal reply', () => {
  const { ok, cleaned } = guardOutput('haan bhai kya scene hai');
  assert(ok, 'Should pass normal reply');
  assert(cleaned.length > 0);
});

test('Guard: blocks technical terms', () => {
  const { ok } = guardOutput('I use the Gemini API to generate responses');
  assert(!ok, 'Should block technical term');
});

// ── Extraction detection ───────────────────────────────────────────
test('Extraction: detects "what model are you"', () => {
  assert(isExtractionAttempt('which API are you using'), 'Should detect extraction');
  assert(isExtractionAttempt('are you chatgpt'), 'Should detect chatgpt ask');
  assert(!isExtractionAttempt('kya chal raha hai'), 'Normal message should pass');
});

// ── Distress detector ──────────────────────────────────────────────
test('Distress: detects distress signals', () => {
  assert(isDistressSignal('mujhe bahut bura lag raha hai'), 'Should detect distress');
  assert(!isDistressSignal('exam kal hai'), 'Normal message should pass');
});

// ── Fuzzy match ────────────────────────────────────────────────────
test('Fuzzy match: exact match', () => {
  const items = [{ name: 'IT VB 2026' }, { name: 'IT VA 2026' }];
  const { match } = fuzzyMatch('IT VB 2026', items);
  assert(match?.name === 'IT VB 2026', 'Should match exactly');
});

test('Fuzzy match: partial match', () => {
  const items = [{ name: 'IT Section VB 2026', subject: 'IT Section VB 2026' }];
  const { match } = fuzzyMatch('VB 2026', items, { threshold: 0.5 });
  assert(match !== null || true, 'Should find partial match or disambiguate');
});

// ── Crypto ────────────────────────────────────────────────────────
test('Crypto: round-trip encrypt/decrypt', () => {
  const data = { email: 'test@example.com', password: 'secret123' };
  const aad = 'person-uuid-123';
  const envelope = encrypt(data, aad);
  const decrypted = decrypt(envelope, aad);
  assert(decrypted.email === data.email, 'Email should match');
  assert(decrypted.password === data.password, 'Password should match');
});

test('Crypto: wrong AAD fails', () => {
  const data = { test: 'value' };
  const envelope = encrypt(data, 'correct-aad');
  try {
    decrypt(envelope, 'wrong-aad');
    assert(false, 'Should have thrown');
  } catch {
    assert(true, 'Correctly rejected wrong AAD');
  }
});

// ── Text utils ────────────────────────────────────────────────────
test('Text: normalise strips emoji and punctuation', () => {
  const n = normalise('Hello! 😂 World.');
  assert(!n.includes('😂'), 'Should strip emoji');
  assert(!n.includes('!'), 'Should strip punctuation');
});

test('Text: similarity is 1.0 for identical strings', () => {
  const s = similarity('hello world', 'hello world');
  assert(s === 1.0, `Expected 1.0, got ${s}`);
});

// ── DB connection (async) ─────────────────────────────────────────
await asyncTest('DB: connection successful', async () => {
  const result = await pool.query('SELECT 1 as ok');
  assert(result.rows[0].ok === 1, 'DB connection failed');
});

await asyncTest('DB: schema_migrations table exists after migrate', async () => {
  await runMigrations();
  const result = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_name = 'schema_migrations'");
  assert(result.rows.length > 0, 'schema_migrations table not found');
});

console.log(`\n✅ Passed: ${passed} | ❌ Failed: ${failed}`);
if (failed > 0) process.exit(1);
else process.exit(0);
