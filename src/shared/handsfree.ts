/**
 * Splits a live microphone stream into utterances for hands-free mode. Pure and Node-free, so it can be tested.
 * Nothing is kept except the utterance being built: silence is never stored.
 */
export interface SegmenterOpts {
  sampleRate: number;
  /** Quietest level that can count as speech (RMS, 0..1). */
  minLevel: number;
  /** How much louder than the background noise speech has to be. */
  noiseFactor: number;
  /** Loud audio needed in a row before an utterance starts. */
  startMs: number;
  /** Quiet needed after speech before the utterance ends. */
  endSilenceMs: number;
  /** Utterances shorter than this much actual speech are dropped (coughs, clicks). */
  minSpeechMs: number;
  /** Hard cap: a longer utterance is cut here. */
  maxMs: number;
  /** Audio kept from just before the start so the first word is not clipped. */
  prerollMs: number;
}

export const DEFAULT_SEGMENTER: SegmenterOpts = {
  sampleRate: 16000,
  minLevel: 0.012,
  noiseFactor: 3,
  startMs: 200,
  endSilenceMs: 800,
  minSpeechMs: 400,
  maxMs: 12000,
  prerollMs: 400,
};

// Six 64 ms worklet chunks establish a useful room baseline without losing
// the first full second after the microphone opens.
const WARM_MS = 384;

export const rms = (c: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < c.length; i++) s += c[i] * c[i];
  return c.length ? Math.sqrt(s / c.length) : 0;
};

export class Segmenter {
  private o: SegmenterOpts;
  private floor = 0.004;
  private ring: { c: Float32Array; ms: number }[] = [];
  private ringMs = 0;
  private run = 0;
  private buf: Float32Array[] = [];
  private bufMs = 0;
  private voicedMs = 0;
  private quietMs = 0;
  private on = false;
  private warmMs = 0;
  /** Loudest recent level of the utterance being built (slowly decaying). */
  private peak = 0;

  constructor(o: Partial<SegmenterOpts> = {}) {
    this.o = { ...DEFAULT_SEGMENTER, ...o };
  }

  get speaking(): boolean {
    return this.on;
  }

  /** Current speech threshold. Rises with background noise so a fan or a hum does not trigger it. */
  get threshold(): number {
    return Math.max(this.o.minLevel, this.floor * this.o.noiseFactor);
  }

  reset() {
    this.ring = [];
    this.ringMs = 0;
    this.run = 0;
    this.buf = [];
    this.bufMs = 0;
    this.voicedMs = 0;
    this.quietMs = 0;
    this.on = false;
    // The noise estimate survives a reset; only a fresh Segmenter re-calibrates.
  }

  /** Feed one chunk. Returns a finished utterance, or null. */
  feed(chunk: Float32Array): Float32Array | null {
    const ms = (chunk.length / this.o.sampleRate) * 1000;
    const level = rms(chunk);
    // The opening calibration only measures the room, so a constant hum is learned before anything can trigger.
    if (this.warmMs < WARM_MS) {
      this.warmMs += ms;
      this.floor = this.floor * 0.7 + level * 0.3;
      return null;
    }
    const loud = level > this.threshold;
    if (!this.on) {
      // Fast to follow the room getting quieter, slow to follow it getting louder (speech must not raise the bar).
      this.floor = loud ? this.floor * 0.995 + level * 0.005 : this.floor * 0.97 + level * 0.03;
      this.ring.push({ c: chunk, ms });
      this.ringMs += ms;
      while (this.ring.length > 1 && this.ringMs - this.ring[0].ms >= this.o.prerollMs) this.ringMs -= this.ring.shift()!.ms;
      this.run = loud ? this.run + ms : 0;
      if (this.run >= this.o.startMs) {
        this.on = true;
        this.buf = this.ring.map((r) => r.c);
        this.bufMs = this.ringMs;
        this.voicedMs = this.run;
        this.quietMs = 0;
        this.peak = level;
        this.ring = [];
        this.ringMs = 0;
      }
      return null;
    }
    this.buf.push(chunk);
    this.bufMs += ms;
    // Inside an utterance, "still speaking" is judged against the speaker's own loudness, not only the room threshold.
    // Otherwise steady sound that is above the threshold but well below the voice (music, a TV, a fan that started)
    // keeps the utterance open until the 12 s cap, and the request is never sent.
    this.peak = Math.max(level, this.peak * 0.985);
    const speaking = level > Math.max(this.threshold, this.peak * 0.3);
    if (speaking) {
      this.voicedMs += ms;
      this.quietMs = 0;
    } else this.quietMs += ms;
    if (this.quietMs >= this.o.endSilenceMs || this.bufMs >= this.o.maxMs) return this.finish();
    return null;
  }

  private finish(): Float32Array | null {
    const keep = this.voicedMs >= this.o.minSpeechMs;
    const out = new Float32Array(this.buf.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of this.buf) {
      out.set(c, o);
      o += c.length;
    }
    this.reset();
    return keep ? out : null;
  }
}
