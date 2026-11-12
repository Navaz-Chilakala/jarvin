import fs from 'node:fs';
import path from 'node:path';
import { SttService, engineInstalled, modelCached } from './stt';
import { QWEN_ASR_MODEL, SAMPLE_RATE, cleanTranscript } from '../shared/voice';
import { VOICE_TEST_SENTENCES, rankModels, scoreModel, type VoiceTestModel, type VoiceTestReport } from '../shared/voicetest';

/** Every recognizer Jarvin can run. Only the ones whose engine and model files are on this PC are tested. */
const CANDIDATES = [
  QWEN_ASR_MODEL,
  'onnx-community/whisper-large-v3-turbo',
  'Xenova/whisper-medium.en',
  'Xenova/whisper-small.en',
  'distil-whisper/distil-small.en',
  'Xenova/whisper-base.en',
  'onnx-community/moonshine-base-ONNX',
];

/**
 * The user's own voice as a private test set: recordings of fixed sentences, kept only on this PC, and a run of every
 * installed recognizer over them. This is how the recognizer is chosen from evidence instead of a guess.
 */
export class VoiceTest {
  private running = false;
  constructor(private dirs: { appRoot: string; data: string; workerFile: string }) {}
  private get dir() { return path.join(this.dirs.data, 'voice-test'); }
  private get cacheDir() { return path.join(this.dirs.data, 'models'); }
  private clipFile(index: number) { return path.join(this.dir, `clip-${String(index).padStart(2, '0')}.f32`); }

  private usable(): string[] {
    return CANDIDATES.filter((m) => engineInstalled(this.dirs.appRoot, m) && modelCached(this.cacheDir, m));
  }

  recorded(): number[] {
    return VOICE_TEST_SENTENCES.map((_, i) => i).filter((i) => fs.existsSync(this.clipFile(i)));
  }

  status(): { sentences: string[]; recorded: number[]; models: string[]; running: boolean; report: VoiceTestReport | null } {
    let report: VoiceTestReport | null = null;
    try { report = JSON.parse(fs.readFileSync(path.join(this.dir, 'report.json'), 'utf8')) as VoiceTestReport; } catch { /* no report yet */ }
    return { sentences: VOICE_TEST_SENTENCES, recorded: this.recorded(), models: this.usable(), running: this.running, report };
  }

  save(index: unknown, audio: unknown): number[] {
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= VOICE_TEST_SENTENCES.length) throw new Error('Unknown test sentence.');
    const samples = audio instanceof Float32Array ? audio : new Float32Array(audio as ArrayLike<number>);
    if (samples.length < SAMPLE_RATE * 0.4) throw new Error('That recording is too short. Record the whole sentence.');
    if (samples.length > SAMPLE_RATE * 20) throw new Error('That recording is too long. Record only the one sentence.');
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.clipFile(index as number), Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
    return this.recorded();
  }

  clear(): void {
    if (this.running) throw new Error('Wait for the test to finish.');
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  private clip(index: number): Float32Array {
    const raw = fs.readFileSync(this.clipFile(index));
    return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  }

  /** Runs every usable recognizer over the recordings. One recognizer is loaded at a time. */
  async run(onProgress: (p: { model: string; done: number; total: number }) => void, only?: (model: string) => boolean, save = true): Promise<VoiceTestReport> {
    if (this.running) throw new Error('The voice test is already running.');
    const clips = this.recorded();
    if (clips.length < 5) throw new Error('Record at least 5 sentences first.');
    const models = this.usable().filter((m) => !only || only(m));
    if (!models.length) throw new Error('No speech recognizer is installed.');
    this.running = true;
    try {
      const scored: VoiceTestModel[] = [];
      const total = models.length * clips.length;
      let done = 0;
      for (const model of models) {
        const stt = new SttService(this.dirs.workerFile, this.cacheDir, () => undefined, true);
        const results: { index: number; heard: string; ms: number }[] = [];
        let failed: string | undefined;
        try {
          await stt.load(model, true);
          await stt.transcribe(this.clip(clips[0]), { model, offline: true }); // first run warms the model and is not timed
          for (const index of clips) {
            const audio = this.clip(index);
            const started = Date.now();
            const heard = cleanTranscript(await stt.transcribe(audio, { model, offline: true }), audio.length / SAMPLE_RATE);
            results.push({ index, heard, ms: Date.now() - started });
            onProgress({ model, done: ++done, total });
          }
        } catch (e: any) {
          failed = String(e?.message ?? e).split('\n')[0].slice(0, 200);
          done = (scored.length + 1) * clips.length;
          onProgress({ model, done, total });
        } finally { await stt.dispose().catch(() => undefined); }
        scored.push({ ...scoreModel(model, results), ...(failed ? { failed } : {}) });
      }
      const report: VoiceTestReport = { at: Date.now(), clips: clips.length, models: rankModels(scored) };
      if (save) fs.writeFileSync(path.join(this.dir, 'report.json'), JSON.stringify(report, null, 2));
      return report;
    } finally { this.running = false; }
  }
}
