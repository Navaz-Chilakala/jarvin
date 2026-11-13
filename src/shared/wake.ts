/**
 * Streaming wake-phrase detection with openWakeWord's three models (melspectrogram -> speech embedding -> "hey jarvis"
 * classifier). Pure: the three models are passed in, so this can be tested and measured without the app.
 *
 * Every 80 ms of 16 kHz audio gives 8 new mel frames; the last 76 mel frames give one embedding; the last 16
 * embeddings (about 1.3 s) give one score between 0 and 1.
 */
export interface WakeModels {
  /** Audio as 16-bit-range samples -> mel frames, 32 values each, already flattened row by row. */
  mel(samples: Float32Array): Promise<Float32Array>;
  /** 76 mel frames (76 x 32 values) -> one 96-value embedding. */
  embed(window: Float32Array): Promise<Float32Array>;
  /** 16 embeddings (16 x 96 values) -> probability that the wake phrase was just said. */
  score(features: Float32Array): Promise<number>;
}

export const WAKE_STEP = 1280;       // samples per step (80 ms)
const CONTEXT = 480;                 // extra samples in front so the step yields exactly 8 mel frames
const MEL_BINS = 32, MEL_WINDOW = 76, EMBEDDING = 96, HISTORY = 16;
/** Score at or above which the phrase counts as said. openWakeWord's own default. */
export const WAKE_THRESHOLD = 0.5;

export class WakeStream {
  private tail = new Float32Array(CONTEXT);
  private pending = new Float32Array(0);
  private mels: Float32Array[] = [];
  private features: Float32Array[] = [];

  constructor(private models: WakeModels) { this.reset(); }

  reset(): void {
    this.tail = new Float32Array(CONTEXT);
    this.pending = new Float32Array(0);
    // Start from "silence" frames so the first second of audio can already be scored.
    this.mels = Array.from({ length: MEL_WINDOW }, () => new Float32Array(MEL_BINS).fill(1));
    this.features = Array.from({ length: HISTORY }, () => new Float32Array(EMBEDDING));
  }

  /** Feed audio in the usual -1..1 range. Returns the highest score among the steps this audio completed (0 if none). */
  async feed(audio: Float32Array): Promise<number> {
    const all = new Float32Array(this.pending.length + audio.length);
    all.set(this.pending); all.set(audio, this.pending.length);
    let best = 0, offset = 0;
    for (; offset + WAKE_STEP <= all.length; offset += WAKE_STEP) best = Math.max(best, await this.step(all.subarray(offset, offset + WAKE_STEP)));
    this.pending = all.slice(offset);
    return best;
  }

  private async step(chunk: Float32Array): Promise<number> {
    const input = new Float32Array(CONTEXT + WAKE_STEP);
    input.set(this.tail);
    for (let i = 0; i < chunk.length; i++) input[CONTEXT + i] = chunk[i] * 32767; // the mel model was trained on 16-bit sample values
    this.tail = input.slice(input.length - CONTEXT);
    const mel = await this.models.mel(input);
    for (let f = 0; f + MEL_BINS <= mel.length; f += MEL_BINS) {
      const frame = new Float32Array(MEL_BINS);
      for (let b = 0; b < MEL_BINS; b++) frame[b] = mel[f + b] / 10 + 2; // openWakeWord's scaling of the raw mel output
      this.mels.push(frame);
    }
    while (this.mels.length > MEL_WINDOW) this.mels.shift();
    const window = new Float32Array(MEL_WINDOW * MEL_BINS);
    this.mels.forEach((frame, i) => window.set(frame, i * MEL_BINS));
    this.features.push(Float32Array.from(await this.models.embed(window)));
    while (this.features.length > HISTORY) this.features.shift();
    const flat = new Float32Array(HISTORY * EMBEDDING);
    this.features.forEach((feature, i) => flat.set(feature, i * EMBEDDING));
    return this.models.score(flat);
  }
}
