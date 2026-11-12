import { Worker } from 'node:worker_threads';
import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { OutMsg } from './stt-worker';
import { QWEN_ASR_DIR, QWEN_ASR_MODEL, type VoiceProgress } from '../shared/voice';

const RUN_TIMEOUT_MS = 180_000;

/** Whisper model files that must exist for a q8 model to be usable offline. */
export function modelCached(cacheDir: string, model: string): boolean {
  if (model === QWEN_ASR_MODEL) {
    const d = path.join(cacheDir, QWEN_ASR_DIR);
    return ['conv_frontend.onnx', 'encoder.int8.onnx', 'decoder.int8.onnx', 'tokenizer/vocab.json'].every((f) => fs.existsSync(path.join(d, f)));
  }
  const d = path.join(cacheDir, ...model.split('/'), 'onnx');
  return ['encoder_model_quantized.onnx', 'decoder_model_merged_quantized.onnx'].every((f) => fs.existsSync(path.join(d, f)));
}

export function engineInstalled(root: string, model = ''): boolean {
  const pkg = model === QWEN_ASR_MODEL ? ['sherpa-onnx-node'] : ['@huggingface', 'transformers'];
  return fs.existsSync(path.join(root, 'node_modules', ...pkg, 'package.json'));
}

export class SttService {
  private worker: Worker | ChildProcess | null = null;
  private model = '';
  private ready: Promise<void> | null = null;
  private nextId = 1;
  private jobs = new Map<number, { ok: (t: string) => void; fail: (e: Error) => void; timer: NodeJS.Timeout }>();
  private probes = new Map<number, { ok: (speech: boolean | null) => void; fail: (e: Error) => void; timer: NodeJS.Timeout }>();
  private onReady: { ok: () => void; fail: (e: Error) => void } | null = null;

  constructor(
    private workerFile: string,
    private cacheDir: string,
    private onProgress: (p: VoiceProgress) => void,
  ) {}

  private spawn(model: string): Worker | ChildProcess {
    const w: Worker | ChildProcess = model === QWEN_ASR_MODEL
      ? fork(this.workerFile, [], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
      : new Worker(this.workerFile);
    w.on('message', (m: OutMsg) => this.handle(m));
    w.on('error', (e) => this.crash(e));
    w.on('exit', (code) => {
      if (this.worker === w) {
        this.worker = null;
        this.ready = null;
        this.model = '';
        if (code !== 0) this.crash(new Error(`Speech worker stopped (code ${code}).`));
      }
    });
    return w;
  }

  private handle(m: OutMsg) {
    if (m.t === 'progress') this.onProgress({ state: m.state, pct: m.pct, file: m.file });
    else if (m.t === 'ready') {
      this.onProgress({ state: 'ready' });
      this.onReady?.ok();
      this.onReady = null;
    } else if (m.t === 'result') {
      const j = this.jobs.get(m.id);
      if (j) {
        clearTimeout(j.timer);
        this.jobs.delete(m.id);
        j.ok(m.text);
      }
    } else if (m.t === 'probeResult') {
      const j = this.probes.get(m.id);
      if (j) {
        clearTimeout(j.timer);
        this.probes.delete(m.id);
        j.ok(m.speech);
      }
    } else if (m.t === 'error') {
      if (m.id !== undefined) {
        const j = this.jobs.get(m.id);
        if (j) {
          clearTimeout(j.timer);
          this.jobs.delete(m.id);
          j.fail(new Error(m.message));
        }
        const probe = this.probes.get(m.id);
        if (probe) {
          clearTimeout(probe.timer);
          this.probes.delete(m.id);
          probe.fail(new Error(m.message));
        }
      } else {
        this.onProgress({ state: 'error', message: m.message });
        this.onReady?.fail(new Error(m.message));
        this.onReady = null;
        this.ready = null;
        this.model = '';
      }
    }
  }

  private crash(e: Error) {
    this.onProgress({ state: 'error', message: e.message });
    for (const j of this.jobs.values()) {
      clearTimeout(j.timer);
      j.fail(e);
    }
    this.jobs.clear();
    for (const j of this.probes.values()) {
      clearTimeout(j.timer);
      j.fail(e);
    }
    this.probes.clear();
    this.onReady?.fail(e);
    this.onReady = null;
    this.ready = null;
    this.model = '';
  }

  /** Load (and if needed download) a model. Safe to call repeatedly. */
  async load(model: string, offline: boolean): Promise<void> {
    if (this.ready && this.model === model) return this.ready;
    if (this.worker && this.model !== model) await this.dispose();
    this.worker ??= this.spawn(model);
    this.model = model;
    const w = this.worker;
    this.ready = new Promise<void>((ok, fail) => {
      this.onReady = { ok, fail };
      const message = { t: 'init', cacheDir: this.cacheDir, offline, model };
      if (w instanceof Worker) w.postMessage(message);
      else w.send(message);
    });
    this.ready.catch(() => undefined);
    return this.ready;
  }

  async transcribe(audio: Float32Array, o: { model: string; offline: boolean; language?: string; task?: 'transcribe' | 'translate'; vad?: boolean }): Promise<string> {
    await this.load(o.model, o.offline);
    const w = this.worker!;
    const id = this.nextId++;
    return new Promise<string>((ok, fail) => {
      const timer = setTimeout(() => {
        this.jobs.delete(id);
        fail(new Error('Transcription timed out.'));
      }, RUN_TIMEOUT_MS);
      this.jobs.set(id, { ok, fail, timer });
      const message = { t: 'run', id, audio, language: o.language, task: o.task, vad: o.vad };
      if (w instanceof Worker) w.postMessage(message, [audio.buffer as ArrayBuffer]);
      else w.send(message);
    });
  }

  /** Inspect the already-loaded local detector without filtering raw diagnostic ASR. */
  async probeVoice(audio: Float32Array, model: string, offline: boolean): Promise<boolean | null> {
    if (model !== QWEN_ASR_MODEL) return null;
    await this.load(model, offline);
    const w = this.worker!;
    const id = this.nextId++;
    return new Promise<boolean | null>((ok, fail) => {
      const timer = setTimeout(() => { this.probes.delete(id); fail(new Error('Voice activity check timed out.')); }, 20_000);
      this.probes.set(id, { ok, fail, timer });
      if (w instanceof Worker) w.postMessage({ t: 'probe', id, audio });
      else w.send({ t: 'probe', id, audio });
    });
  }

  async dispose() {
    const w = this.worker;
    this.worker = null;
    this.ready = null;
    this.model = '';
    if (w instanceof Worker) await w.terminate();
    else if (w) w.kill();
  }
}
