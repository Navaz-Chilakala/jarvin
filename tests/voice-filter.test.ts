import test from 'node:test';
import assert from 'node:assert/strict';
import { implausibleHearing } from '../src/shared/voice';
import { isStopPhrase, isEarlyStop } from '../src/shared/voicecmd';
import { Segmenter } from '../src/shared/handsfree';

test('made-up hearings are dropped and real requests are kept', () => {
  // Stock phrases recognizers produce from noise, at any audio length.
  for (const junk of ['Thank you.', 'you', 'Bye bye!', 'Thanks for watching.', '...']) assert.equal(implausibleHearing(junk, 6), true, junk);
  // More words than can be said in the time.
  assert.equal(implausibleHearing('open the calculator and then work out the total of all the numbers on screen', 1.2), true);
  // The same phrase over and over.
  assert.equal(implausibleHearing('the the the the the', 3), true);
  assert.equal(implausibleHearing('I am going I am going I am going I am going', 6), true);
  // Real requests, including short ones and ones with a repeated word.
  for (const [text, seconds] of [['open the calculator', 1.5], ['stop', 0.5], ['what time is it right now', 1.8], ['turn the volume down a little', 2], ['very very good, open Chrome', 2.5], ['remind me to call the bank in the evening', 3]] as [string, number][]) assert.equal(implausibleHearing(text, seconds), false, text);
});

test('only a bare stop request counts as a stop phrase', () => {
  for (const yes of ['Stop.', 'stop that', 'Jarvin, stop', 'Hey Jarvis, stop it now', 'Cancel', 'please stop', 'be quiet', 'Stop talking!']) assert.equal(isStopPhrase(yes), true, yes);
  for (const no of ['stop the music in Chrome', 'do not stop', 'stock', 'open the stop watch', 'wait', '']) assert.equal(isStopPhrase(no), false, no);
});

test('the early stop check accepts what the small recognizer really returns for "Hey Jarvin, stop"', () => {
  // Real outputs of the quick model on the user's recording, cut at 1.2 s, 1.6 s and 2.2 s of speech.
  for (const heard of ['Hayds, Avin, stop.', "Hades haven't stopped.", "Hey, it's Evan stop.", 'Stop that.', 'cancel']) assert.equal(isEarlyStop(heard), true, heard);
  // Its outputs before the word "stop" was reached, and longer sentences, do not count.
  for (const heard of ["Hey, it's Robin.", "Hey, it's Evan Stott.", 'please do not let the music in the other room stop', 'stop the timer and open Chrome']) assert.equal(isEarlyStop(heard), false, heard);
});

test('the segmenter can be peeked at mid-utterance and told to end sooner', () => {
  const chunk = () => new Float32Array(1024).fill(0.1);
  const seg = new Segmenter({ minLevel: 0.007, minSpeechMs: 250, endSilenceMs: 650 });
  const feed = (seconds: number, speech: boolean) => { let out: Float32Array | null = null; for (let i = 0; i < seconds * 1000 / 64; i++) out = seg.feed(chunk(), speech) ?? out; return out; };
  feed(1, false);
  assert.equal(seg.current(), null);
  feed(0.6, true);
  assert.ok(seg.speaking && seg.currentMs >= 450);
  assert.ok((seg.current()?.length ?? 0) >= 16000 * 0.45, 'the audio so far is available before the utterance ends');
  // With the normal 650 ms rule, 0.4 s of quiet does not end it; with the urgent 350 ms rule it does.
  assert.equal(feed(0.4, false), null);
  feed(0.3, true);
  seg.setEndSilence(350);
  assert.ok(feed(0.45, false), 'the utterance ends after the shorter quiet');
});
