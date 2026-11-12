import test from 'node:test';
import assert from 'node:assert/strict';
import { planSegments, fmtTime, formatTranscript } from '../src/shared/transcribe';

const RATE = 100; // tiny rate keeps the arrays small; the logic only depends on ratios
const tone = (sec: number, quietAt: number[] = []) => {
  const a = new Float32Array(sec * RATE).fill(0.5);
  for (const q of quietAt) a.fill(0, Math.round(q * RATE), Math.round((q + 0.2) * RATE));
  return a;
};

test('short audio stays in one piece, empty gives none', () => {
  assert.deepEqual(planSegments(tone(70), RATE, 60, 5), [{ start: 0, end: 7000 }]);
  assert.deepEqual(planSegments(new Float32Array(0), RATE), []);
});

test('long audio is cut near the target at quiet spots and covers every sample', () => {
  const a = tone(200, [57.0, 117.4, 176.0]);
  const seg = planSegments(a, RATE, 60, 5);
  assert.ok(seg.length >= 3);
  assert.equal(seg[0].start, 0);
  assert.equal(seg.at(-1)!.end, a.length);
  seg.forEach((s, i) => { if (i) assert.equal(s.start, seg[i - 1].end, 'no gaps or overlaps'); });
  assert.ok(Math.abs(seg[0].end / RATE - 57.1) < 0.2, `first cut at the quiet spot, got ${seg[0].end / RATE}`);
  for (const s of seg.slice(0, -1)) assert.ok((s.end - s.start) / RATE <= 60.01 && (s.end - s.start) / RATE >= 54.9);
});

test('time and transcript formatting', () => {
  assert.equal(fmtTime(0), '00:00');
  assert.equal(fmtTime(65.9), '01:05');
  assert.equal(fmtTime(3725), '1:02:05');
  const parts = [{ startSec: 0, text: ' Hello there. ' }, { startSec: 60, text: '   ' }, { startSec: 120, text: 'Bye.' }];
  assert.equal(formatTranscript(parts, true), '[00:00] Hello there.\n[02:00] Bye.');
  assert.equal(formatTranscript(parts, false), 'Hello there.\n\nBye.');
});
