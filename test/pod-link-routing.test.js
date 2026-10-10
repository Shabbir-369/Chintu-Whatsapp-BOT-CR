import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const link = await readFile(new URL('../src/skills/pod/link.js', import.meta.url), 'utf8');
const dm = await readFile(new URL('../src/router/dmHandler.js', import.meta.url), 'utf8');
const owner = await readFile(new URL('../src/router/ownerConsole.js', import.meta.url), 'utf8');

test('Pod-data request opens the link flow directly at the email step', () => {
  assert.match(link, /isExplicitLinkTrigger \|\| wantsPodData/);
  assert.match(link, /upsertPodLinkSession\(personId, 'email', \{ attempts: 0 \}\)/);
  assert.doesNotMatch(link, /haan ya nahi\?/);
});

test('DM and owner routes both use the shared Pod request classifier', () => {
  assert.match(dm, /import \{ isPodDataRequest \} from '\.\.\/util\/podIntent\.js'/);
  assert.match(dm, /const wantsData = isPodDataRequest\(t\)/);
  assert.match(owner, /const isDataRequest = isPodDataRequest\(tl\)/);
});

test('link prompt does not promise deletion of the password message', () => {
  assert.doesNotMatch(link, /message delete ho jaayega turant/);
  assert.match(link, /database mein encrypted save hoga/);
});
