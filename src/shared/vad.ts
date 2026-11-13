/**
 * Feeds a live 16 kHz stream to the Silero voice-activity model in the windows it expects. Pure: the model itself is
 * passed in, so this can be tested without the native runtime.
 *
 * Silero reads 512 new samples at a time, each prefixed with the last 64 samples of the previous window, and carries
 * a small state from one window to the next.
 */
export type VadModel = (input: Float32Array, state: Float32Array) => Promise<{ probability: number; state: Float32Array }>;

export const VAD_WINDOW = 512;
export const VAD_CONTEXT = 64;
/** Probability that starts an utterance, and the lower one that keeps it going (so a soft syllable does not end it). */
export const VAD_START = 0.5;
export const VAD_CONTINUE = 0.35;

export class VadStream {
  private state = new Float32Array(2 * 128);
  private context = new Float32Array(VAD_CONTEXT);
  private rest = new Float32Array(0);
  private last = 0;

  constructor(private model: VadModel) {}

  reset(): void {
    this.state = new Float32Array(2 * 128);
    this.context = new Float32Array(VAD_CONTEXT);
    this.rest = new Float32Array(0);
    this.last = 0;
  }

  /** Highest speech probability among the windows completed by this audio. Audio shorter than a window is carried over. */
  async score(audio: Float32Array): Promise<number> {
    const all = new Float32Array(this.rest.length + audio.length);
    all.set(this.rest); all.set(audio, this.rest.length);
    let best = -1, offset = 0;
    for (; offset + VAD_WINDOW <= all.length; offset += VAD_WINDOW) {
      const input = new Float32Array(VAD_CONTEXT + VAD_WINDOW);
      input.set(this.context); input.set(all.subarray(offset, offset + VAD_WINDOW), VAD_CONTEXT);
      const out = await this.model(input, this.state);
      this.state = Float32Array.from(out.state);
      this.context = input.slice(VAD_WINDOW);
      best = Math.max(best, out.probability);
    }
    this.rest = all.slice(offset);
    if (best >= 0) this.last = best;
    return this.last;
  }
}

/** The speech decision for one chunk, with the lower bar while an utterance is already open. */
export const isSpeech = (probability: number, alreadySpeaking: boolean): boolean => probability >= (alreadySpeaking ? VAD_CONTINUE : VAD_START);
