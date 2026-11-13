import test from 'node:test';
import assert from 'node:assert/strict';
import { VadStream, isSpeech, VAD_WINDOW, VAD_CONTEXT } from '../src/shared/vad';
import { Segmenter } from '../src/shared/handsfree';

test('the detector stream feeds whole windows with the previous 64 samples in front and carries the state', async () => {
  const seen: { first: number; length: number; state: number }[] = [];
  const vad = new VadStream(async (input, state) => {
    seen.push({ first: input[VAD_CONTEXT], length: input.length, state: state[0] });
    return { probability: input[VAD_CONTEXT] > 0.5 ? 0.9 : 0.1, state: Float32Array.from({ length: 256 }, () => seen.length) };
  });
  // 64 ms microphone chunk = two windows; the higher probability of the two is returned.
  const chunk = new Float32Array(1024); chunk.fill(1, 512);
  assert.equal(await vad.score(chunk), 0.9);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].length, VAD_CONTEXT + VAD_WINDOW);
  assert.deepEqual(seen.map((s) => s.state), [0, 1], 'the state returned by one window is given to the next');
  // Less than a window is kept for the next call, and the last answer is repeated meanwhile.
  assert.equal(await vad.score(new Float32Array(300)), 0.9);
  assert.equal(seen.length, 2);
  await vad.score(new Float32Array(300));
  assert.equal(seen.length, 3, '300 + 300 samples complete one window');
  vad.reset();
  await vad.score(new Float32Array(512));
  assert.equal(seen.at(-1)!.state, 0, 'reset clears the carried state');
});

test('an utterance starts at 0.5 and keeps going down to 0.35', () => {
  assert.equal(isSpeech(0.49, false), false);
  assert.equal(isSpeech(0.5, false), true);
  assert.equal(isSpeech(0.4, true), true);
  assert.equal(isSpeech(0.3, true), false);
});

test('with a detector verdict, loud non-speech is not captured and quiet speech is', () => {
  const chunk = (level: number) => new Float32Array(1024).fill(level);
  const opts = { minLevel: 0.007, minSpeechMs: 250, endSilenceMs: 650 };
  const feed = (seg: Segmenter, level: number, seconds: number, speech?: boolean) => { let got = 0; for (let i = 0; i < seconds * 1000 / 64; i++) if (seg.feed(chunk(level), speech)) got++; return got; };

  // Loud steady noise: the loudness check alone captures it, the detector's "not speech" stops it.
  const byLoudness = new Segmenter(opts);
  feed(byLoudness, 0.001, 1);
  assert.ok(feed(byLoudness, 0.2, 3) + feed(byLoudness, 0.001, 1.5) >= 1, 'loudness alone treats the noise as an utterance');
  const withDetector = new Segmenter(opts);
  feed(withDetector, 0.001, 1, false);
  assert.equal(feed(withDetector, 0.2, 3, false) + feed(withDetector, 0.001, 1.5, false), 0);

  // Speech too quiet for the loudness threshold is still captured when the detector says it is speech.
  const quiet = new Segmenter(opts);
  feed(quiet, 0.001, 1, false);
  assert.equal(feed(quiet, 0.004, 2, true) + feed(quiet, 0.001, 1.5, false), 1);
});
