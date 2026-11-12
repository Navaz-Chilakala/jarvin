import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Segmenter } from '../src/shared/handsfree';

const CH = 2048; // 128 ms at 16 kHz, the chunk size the microphone code uses
const tone = (amp: number) => Float32Array.from({ length: CH }, (_, i) => amp * Math.sin(i / 5));
const feedN = (s: Segmenter, amp: number, n: number) => {
  const out: Float32Array[] = [];
  for (let i = 0; i < n; i++) {
    const r = s.feed(tone(amp));
    if (r) out.push(r);
  }
  return out;
};

test('silence never produces an utterance', () => {
  assert.equal(feedN(new Segmenter(), 0.001, 200).length, 0);
});

test('speech followed by quiet gives one utterance', () => {
  const s = new Segmenter();
  feedN(s, 0.002, 20);
  assert.equal(feedN(s, 0.2, 12).length, 0, 'still speaking');
  const out = feedN(s, 0.002, 10);
  assert.equal(out.length, 1);
  assert.ok(out[0].length >= CH * 12, 'keeps the whole phrase');
  assert.ok(out[0].length < CH * 25, 'does not keep a long tail of silence');
  assert.equal(s.speaking, false);
});

test('keeps a little audio from before the start so the first word is not clipped', () => {
  const s = new Segmenter();
  feedN(s, 0.002, 30);
  feedN(s, 0.2, 8);
  const out = feedN(s, 0.002, 10)[0];
  assert.ok(out.length >= CH * (8 + 2), 'preroll included');
});

test('a short click or cough is dropped', () => {
  const s = new Segmenter();
  feedN(s, 0.002, 20);
  assert.equal(feedN(s, 0.3, 1).length, 0);
  assert.equal(feedN(s, 0.002, 20).length, 0);
  assert.equal(s.speaking, false);
});

test('constant background noise does not trigger it', () => {
  const s = new Segmenter();
  assert.equal(feedN(s, 0.01, 300).length, 0);
});

test('a loud room raises the bar: noise at 0.02 is ignored but speech at 0.3 still works', () => {
  const s = new Segmenter();
  assert.equal(feedN(s, 0.02, 200).length, 0);
  assert.ok(s.threshold >= 0.012);
  feedN(s, 0.3, 10);
  assert.equal(feedN(s, 0.02, 10).length, 1);
});

test('very long speech is cut at the limit', () => {
  const s = new Segmenter({ maxMs: 2000 });
  feedN(s, 0.002, 10);
  const out = feedN(s, 0.3, 40);
  assert.ok(out.length >= 2);
  assert.ok(out[0].length <= CH * 17);
});

test('an utterance ends when the voice stops, even if steady background sound stays above the room threshold', () => {
  const seg = new Segmenter({ minLevel: 0.012, minSpeechMs: 250, endSilenceMs: 650 });
  const chunk = (level: number) => new Float32Array(1024).fill(level);
  for (let i = 0; i < 12; i++) seg.feed(chunk(0.002));            // quiet room is learned
  let out: Float32Array | null = null;
  for (let i = 0; i < 20 && !out; i++) out = seg.feed(chunk(0.2));  // about 1.3 s of speech
  assert.equal(out, null);
  assert.equal(seg.speaking, true);
  // Music starts: well above the room threshold (0.012) but far below the voice. It must count as "not speaking".
  for (let i = 0; i < 20 && !out; i++) out = seg.feed(chunk(0.03));
  assert.ok(out, 'the utterance closes after the end-silence time instead of running to the 12 s cap');
  assert.ok(out!.length < 16000 * 4);
});
