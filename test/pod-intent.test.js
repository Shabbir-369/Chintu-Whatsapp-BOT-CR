import test from 'node:test';
import assert from 'node:assert/strict';
import { isPodDataRequest, isPodLinkCommand } from '../src/util/podIntent.js';

test('attendance and other Pod data requests can start linking automatically', () => {
  for (const text of ['attendance bata', 'meri attendance dikha', 'bunk kitna bacha hai', 'marks bata', 'show my attendance']) {
    assert.equal(isPodDataRequest(text), true, text);
  }
});

test('non-Pod requests do not start Pod linking', () => {
  for (const text of ['aaj ka time table', 'next holiday kab hai', 'hello bhai', 'mass bunk plan', 'enable IT group']) {
    assert.equal(isPodDataRequest(text), false, text);
  }
});

test('natural link commands are recognized', () => {
  for (const text of ['!link', 'link pod', 'connect my pod', 'account link kar', 'pod jod do']) {
    assert.equal(isPodLinkCommand(text), true, text);
  }
});
