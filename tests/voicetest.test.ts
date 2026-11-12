import test from 'node:test';
import assert from 'node:assert/strict';
import { VOICE_TEST_SENTENCES, rankModels, scoreModel, wordErrors } from '../src/shared/voicetest';

test('word errors count wrong, missing and extra words and ignore case and punctuation', () => {
  assert.deepEqual(wordErrors('Open the settings.', 'open the settings'), { errors: 0, words: 3 });
  assert.deepEqual(wordErrors('Open the settings', 'Open settings'), { errors: 1, words: 3 });
  assert.deepEqual(wordErrors('Open the settings', 'Open the old settings'), { errors: 1, words: 3 });
  assert.deepEqual(wordErrors('Find my resume', 'Find my resin'), { errors: 1, words: 3 });
  assert.deepEqual(wordErrors('Stop', ''), { errors: 1, words: 1 });
});

test('the name is scored separately from the request words', () => {
  const nameIndex = VOICE_TEST_SENTENCES.indexOf('Hey Jarvin, open the calculator.');
  const plainIndex = VOICE_TEST_SENTENCES.indexOf('Find my resume and open it in Word.');
  const good = scoreModel('good', [{ index: nameIndex, heard: 'Hey Jarvan, open the calculator.', ms: 900 }, { index: plainIndex, heard: 'Find my resume and open it in Word.', ms: 1100 }]);
  assert.equal(good.nameHeard, 1, 'a close spelling of the name still counts as heard');
  assert.equal(good.errors, 0);
  assert.equal(good.exactSentences, 2);
  assert.equal(good.avgMs, 1000);
  const bad = scoreModel('bad', [{ index: nameIndex, heard: 'A garden, open the calculate.', ms: 300 }, { index: plainIndex, heard: 'Find my resin and open it in Word.', ms: 300 }]);
  assert.equal(bad.nameHeard, 0);
  assert.equal(bad.nameExpected, 1);
  assert.equal(bad.errors, 2, 'one wrong word in each request; the lost name is not counted twice');
  assert.deepEqual(rankModels([bad, { ...good, failed: 'blocked' }, good]).map((m) => `${m.model}${m.failed ? '!' : ''}`), ['good', 'bad', 'good!']);
});

test('the sentence list is twenty lines, half with the wake phrase, and has no digits', () => {
  assert.equal(VOICE_TEST_SENTENCES.length, 20);
  assert.equal(VOICE_TEST_SENTENCES.filter((s) => s.startsWith('Hey Jarvin')).length, 10);
  assert.equal(VOICE_TEST_SENTENCES.some((s) => /\d/.test(s)), false);
});
