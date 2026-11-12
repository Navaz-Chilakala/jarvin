import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEchoOfOwnSpeech } from '../src/shared/echo';

const spoken = "I've calculated 10 times 6 on the Calculator app, and the result shown on the screen is 60.";

test('own voice coming back through the mic is recognised', () => {
  assert.equal(isEchoOfOwnSpeech('I have calculated 10 times 6 on the Calculator app', spoken), true); // speech-to-text spells it slightly differently
  assert.equal(isEchoOfOwnSpeech('calculated 10 times 6 on the calculator app and the result', spoken), true);
  assert.equal(isEchoOfOwnSpeech("the result shown on the screen is 60", spoken), true);
});

test('real interruptions and new requests are not treated as echo', () => {
  assert.equal(isEchoOfOwnSpeech('stop', spoken), false);
  assert.equal(isEchoOfOwnSpeech('open notepad and write hello', spoken), false);
  assert.equal(isEchoOfOwnSpeech('stop calculating and open chrome', spoken), false);
  assert.equal(isEchoOfOwnSpeech('anything', ''), false);
});
