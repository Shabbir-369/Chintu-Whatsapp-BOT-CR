import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ownerConsole = await readFile(new URL('../src/router/ownerConsole.js', import.meta.url), 'utf8');

test('mass-bunk group selection uses the same strict resolver as group controls', () => {
  assert.match(ownerConsole, /case 'MASS_BUNK_STATS':[\s\S]*?findGroupTarget\(entities\.group, groups\)/);
  assert.match(ownerConsole, /type: 'MASS_BUNK_STATS', candidates, originalIntent: parsed/);
  assert.match(ownerConsole, /if \(type === 'MASS_BUNK_STATS'\)[\s\S]*?runMassBunkAnalysis\(chosen\.jid, targetDate, ownerChatJid\)/);
});

test('invalid person/group choice replies keep a type-appropriate numbered list', () => {
  assert.match(ownerConsole, /\['SEND_MESSAGE', 'SCHEDULE_MESSAGE'\]\.includes\(type\)[\s\S]*?formatTargetChoices\(candidates\)/);
  assert.match(ownerConsole, /type === 'FORGET_PERSON' \|\| type === 'NAME_SET'[\s\S]*?formatPersonChoices\(candidates\)/);
});
