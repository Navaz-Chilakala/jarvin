import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';

/**
 * Speech detection for automatic listening. The model runs in its own small process so that loading the native runtime
 * can never disturb the recognizer or the window. Every failure answers null, which tells the listener to use the
 * loudness check instead: detection problems must never stop Jarvin from hearing.
 */
export class VadService {
  private child: ChildProcess | null = null;
  private waiting = new Map<number, (value: number | null) => void>();
  private nextId = 0;
  private failures = 0;
  private lastError = '';

  constructor(private workerFile: string, private modelFile: string, private timeoutMs = 1500) {}

  get error(): string { return this.lastError; }

  private fail(reason: string): void {
    this.lastError = reason;
    this.failures++;
    const child = this.child; this.child = null;
    try { child?.kill(); } catch { /* already gone */ }
    for (const done of this.waiting.values()) done(null);
    this.waiting.clear();
  }

  private worker(): ChildProcess | null {
    if (this.child) return this.child;
    // After repeated failures the detector stays off for this session; the loudness check carries on.
    if (this.failures >= 3) return null;
    if (!fs.existsSync(this.workerFile) || !fs.existsSync(this.modelFile)) { this.failures = 3; this.lastError = 'The speech detector files are missing.'; return null; }
    const child = fork(this.workerFile, [this.modelFile], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    this.child = child;
    child.on('message', (m: { id: number; probability?: number; error?: string }) => {
      if (this.child !== child) return;
      const done = this.waiting.get(m.id);
      if (!done) return;
      this.waiting.delete(m.id);
      if (typeof m.error === 'string') { done(null); this.fail(m.error); }
      else { this.failures = 0; done(typeof m.probability === 'number' && Number.isFinite(m.probability) ? m.probability : null); }
    });
    child.on('error', (e) => { if (this.child === child) this.fail(e.message); });
    child.on('exit', () => { if (this.child === child) this.fail('The speech detector stopped.'); });
    return child;
  }

  /** Probability (0 to 1) that this chunk of 16 kHz audio contains speech, or null when the detector is unavailable. */
  score(audio: Float32Array, reset = false): Promise<number | null> {
    const child = this.worker();
    if (!child) return Promise.resolve(null);
    const id = ++this.nextId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { if (this.waiting.delete(id)) { resolve(null); this.fail('The speech detector did not answer in time.'); } }, this.timeoutMs);
      this.waiting.set(id, (value) => { clearTimeout(timer); resolve(value); });
      try { child.send({ id, audio, reset }); } catch (e: any) { this.waiting.delete(id); clearTimeout(timer); resolve(null); this.fail(String(e?.message ?? e)); }
    });
  }

  dispose(): void {
    const child = this.child; this.child = null;
    try { child?.kill(); } catch { /* already gone */ }
    for (const done of this.waiting.values()) done(null);
    this.waiting.clear();
  }
}
