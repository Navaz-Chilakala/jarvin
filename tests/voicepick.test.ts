import test from 'node:test';
import assert from 'node:assert/strict';
import { pickVoice } from '../src/shared/voicepick';

const v = (name: string, lang = 'en-US', localService = true) => ({ name, lang, localService });
test('prefers the saved voice, then natural English voices over David', () => {
  const list = [v('Microsoft David Desktop'), v('Microsoft Zira Desktop'), v('Microsoft Aria Online (Natural)'), v('Microsoft Hortense', 'fr-FR')];
  assert.equal(pickVoice(list, 'Microsoft David Desktop')?.name, 'Microsoft David Desktop');
  assert.equal(pickVoice(list)?.name, 'Microsoft Aria Online (Natural)');
  assert.equal(pickVoice([v('Microsoft David Desktop'), v('Microsoft Zira Desktop')])?.name, 'Microsoft Zira Desktop');
  assert.equal(pickVoice([v('X', 'en-US', false)]), undefined);
});
