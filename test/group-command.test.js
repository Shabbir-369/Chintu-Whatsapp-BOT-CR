import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseDisableGroupCommand, parseGroupControlCommand } from '../src/util/groupCommand.js';

describe('owner group control command parsing', () => {
  test('parses stop talking in a named group', () => {
    assert.equal(parseDisableGroupCommand('stop talking in IT V-B group'), 'it v-b');
    assert.deepEqual(parseGroupControlCommand('stop talking in IT V-B group'), {
      intent: 'DISABLE_GROUP', entities: { group: 'it v-b', mode: 'mute' }, confidence: 0.96,
    });
  });
  test('parses polite phrasing and strips generic group word', () => {
    assert.equal(parseDisableGroupCommand('please stop replying in the Photography Club group'), 'photography club');
    assert.equal(parseGroupControlCommand('enable Photography Club group')?.entities.group, 'photography club');
  });
  test('parses Hinglish group mute phrasing', () => {
    assert.equal(parseDisableGroupCommand('iss group mein bolna band kar'), '');
    assert.equal(parseGroupControlCommand('iss group mein bolna band kar')?.intent, 'DISABLE_GROUP');
    assert.equal(parseGroupControlCommand('mute Photography Club group')?.entities.group, 'photography club');
  });
  test('unmute variations use the same enable intent', () => {
    for (const phrase of [
      'unmute Photography Club group',
      'Photography Club group ko unmute kar de',
      'enable Photography Club group',
    ]) {
      assert.equal(parseGroupControlCommand(phrase)?.intent, 'ENABLE_GROUP', phrase);
      assert.equal(parseGroupControlCommand(phrase)?.entities.group, 'photography club', phrase);
    }
  });
  test('mode phrases handle English and Hinglish variants', () => {
    const samples = [
      ['switch Photography Club group to trigger mode', 'photography club', 'trigger'],
      ['set mode of Photography Club group to ambient', 'photography club', 'ambient'],
      ['Photography Club group ka mode trigger kar do', 'photography club', 'trigger'],
      ['Photography Club group ko mute mode mein kar do', 'photography club', 'mute'],
      ['trigger mode for Photography Club group', 'photography club', 'trigger'],
    ];
    for (const [phrase, group, mode] of samples) {
      const parsed = parseGroupControlCommand(phrase);
      assert.equal(parsed?.intent, 'SET_MODE', phrase);
      assert.equal(parsed?.entities.group, group, phrase);
      assert.equal(parsed?.entities.mode, mode, phrase);
    }
  });
  test('mode with no target is parsed so router can request numbered group choice', () => {
    const parsed = parseGroupControlCommand('switch to trigger mode');
    assert.equal(parsed?.intent, 'SET_MODE');
    assert.equal(parsed?.entities.group, '');
    assert.equal(parsed?.entities.mode, 'trigger');
  });
  test('does not classify ordinary conversation as a mute command', () => {
    assert.equal(parseDisableGroupCommand('stop talking about attendance'), null);
    assert.equal(parseGroupControlCommand('what are you talking about?'), null);
  });
});
