import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseDisableGroupCommand } from '../src/util/groupCommand.js';

describe('owner group mute command parsing', () => {
  test('parses stop talking in a named group', () => {
    assert.equal(parseDisableGroupCommand('stop talking in IT V-B group'), 'it v-b');
  });
  test('parses polite phrasing and strips generic group word', () => {
    assert.equal(parseDisableGroupCommand('please stop replying in the Photography Club group'), 'photography club');
  });
  test('parses Hinglish group mute phrasing', () => {
    assert.equal(parseDisableGroupCommand('iss group mein bolna band kar'), ''); // no target: owner is asked to specify a group
    assert.equal(parseDisableGroupCommand('mute Photography Club group'), 'photography club');
  });
  test('does not classify ordinary conversation as a mute command', () => {
    assert.equal(parseDisableGroupCommand('stop talking about attendance'), null);
  });
});
