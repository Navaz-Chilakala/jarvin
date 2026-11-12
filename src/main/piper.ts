import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

/** Loads the locally installed voice once and synthesizes bounded chunks off the main thread. */
export class PiperService {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private readyTimer: NodeJS.Timeout | null = null;
  private settleReady: { resolve: () => void; reject: (error: Error) => void } | null = null;
  private jobs = new Map<number, { resolve: (value: { pcm: Float32Array; sampleRate: number }) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private nextId = 1;
  constructor(private workerFile: string, private dir: string, private kokoroDir: string = path.join(dir, '..', 'kokoro')) {}
  /** Kokoro (smoother, more human) is used when its model folder is installed; otherwise the Piper "joe" voice. */
  private hasKokoro(): boolean { return ['model.int8.onnx', 'voices.bin', 'tokens.txt'].every((f) => fs.existsSync(path.join(this.kokoroDir, f))) && fs.existsSync(path.join(this.kokoroDir, 'espeak-ng-data')); }
  available(): boolean { return this.hasKokoro() || (fs.existsSync(path.join(this.dir, 'joe.onnx')) && fs.existsSync(path.join(this.dir, 'joe.onnx.json'))); }
  warm(): Promise<void> {
    if (!this.available()) return Promise.reject(new Error('The natural voice model is not installed.'));
    if (this.ready) return this.ready;
    const worker = new Worker(this.workerFile);
    this.worker = worker;
    this.ready = new Promise<void>((resolve, reject) => { this.settleReady = { resolve, reject }; });
    this.readyTimer = setTimeout(() => this.fail(new Error('Natural voice initialization timed out.')), 30_000);
    worker.on('message', (m: any) => {
      if (m.t === 'ready') { if (this.readyTimer) clearTimeout(this.readyTimer); this.readyTimer = null; this.settleReady?.resolve(); this.settleReady = null; }
      else if (m.t === 'audio') { const job = this.jobs.get(m.id); if (job) { clearTimeout(job.timer); this.jobs.delete(m.id); job.resolve({ pcm: m.pcm, sampleRate: m.sampleRate }); } }
      else if (m.t === 'error' && m.id !== undefined) { const job = this.jobs.get(m.id); if (job) { clearTimeout(job.timer); this.jobs.delete(m.id); job.reject(new Error(m.message)); } }
      else if (m.t === 'error') this.fail(new Error(m.message));
    });
    worker.on('error', (error) => this.fail(error));
    worker.on('exit', (code) => { if (this.worker === worker) this.fail(new Error(`Natural voice worker stopped (${code}).`)); });
    worker.postMessage({ t: 'init', dir: this.dir, kokoro: this.hasKokoro() ? this.kokoroDir : null });
    return this.ready;
  }
  async synthesize(text: string, rate = 1): Promise<{ pcm: Float32Array; sampleRate: number }> {
    if (typeof text !== 'string' || !text.trim() || text.length > 500) throw new Error('Natural voice requires 1–500 characters.');
    if (!Number.isFinite(rate) || rate < 0.5 || rate > 2) throw new Error('Natural voice rate must be between 0.5 and 2.');
    await this.warm();
    if (!this.worker) throw new Error('Natural voice worker is unavailable.');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.jobs.delete(id); reject(new Error('Natural voice synthesis timed out.')); }, 30_000);
      this.jobs.set(id, { resolve, reject, timer });
      this.worker!.postMessage({ t: 'speak', id, text, rate });
    });
  }
  private fail(error: Error) {
    if (this.readyTimer) clearTimeout(this.readyTimer); this.readyTimer = null;
    this.settleReady?.reject(error); this.settleReady = null;
    for (const job of this.jobs.values()) { clearTimeout(job.timer); job.reject(error); }
    this.jobs.clear();
    const old = this.worker; this.worker = null; this.ready = null;
    if (old) void old.terminate();
  }
  async dispose(): Promise<void> { const old = this.worker; this.worker = null; if (old) await old.terminate(); this.fail(new Error('Natural voice stopped.')); }
}
