/** Helpers for transcribing long audio files in pieces. Pure, shared by the renderer and tests. */
import { rms } from './voice';

export interface Segment { start: number; end: number }

/**
 * Cut `total` samples into pieces of about `targetSec`. Each cut is moved to the quietest 20 ms inside the last
 * `searchSec` seconds of the piece, so words are not split in half.
 */
export function planSegments(samples: ArrayLike<number>, rate = 16000, targetSec = 60, searchSec = 5): Segment[] {
  const total = samples.length;
  const target = Math.round(targetSec * rate);
  if (total <= target * 1.25) return total ? [{ start: 0, end: total }] : [];
  const frame = Math.round(rate * 0.02);
  const out: Segment[] = [];
  let start = 0;
  while (total - start > target * 1.25) {
    const lo = start + target - Math.round(searchSec * rate);
    const hi = start + target;
    let best = hi;
    let bestE = Infinity;
    for (let i = lo; i + frame <= hi; i += frame) {
      const e = rms(samples, i, i + frame);
      if (e < bestE) {
        bestE = e;
        best = i + Math.floor(frame / 2);
      }
    }
    out.push({ start, end: best });
    start = best;
  }
  out.push({ start, end: total });
  return out;
}

export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`;
}

export interface TimedText { startSec: number; text: string }

/** Join the pieces. With timestamps each piece starts on its own line with `[mm:ss]`; without, it is one paragraph per piece. */
export function formatTranscript(parts: TimedText[], timestamps: boolean): string {
  const live = parts.filter((p) => p.text.trim());
  return live.map((p) => (timestamps ? `[${fmtTime(p.startSec)}] ${p.text.trim()}` : p.text.trim())).join(timestamps ? '\n' : '\n\n');
}

export const MAX_FILE_MB = 150;
