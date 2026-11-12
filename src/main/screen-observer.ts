import type { ScreenFrame } from './visual-grounding';

/** Keeps only the latest in-memory screen image while the companion is floating. */
export class ScreenObserver {
  private latest: { frame: ScreenFrame; at: number } | null = null;
  private captureJob: Promise<ScreenFrame> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private generation = 0;
  private invalidated = false;
  private paused = false;
  constructor(private capture: () => Promise<ScreenFrame>, private intervalMs = 600, private onAvailability?: (available: boolean) => void) {}

  start(): void {
    if (this.timer) return;
    if (!this.paused) void this.sample().catch(() => { this.onAvailability?.(false); });
    this.timer = setInterval(() => {
      if (!this.paused) void this.sample().catch(() => { this.onAvailability?.(false); });
    }, this.intervalMs);
  }
  /** Keep the last image but stop background captures while speech needs the main process. */
  setPaused(paused: boolean): void { this.paused = paused; }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; this.latest = null; this.generation++; this.invalidated = true; this.onAvailability?.(false); }
  invalidate(): void { this.latest = null; this.generation++; this.invalidated = true; }
  private sample(): Promise<ScreenFrame> {
    if (this.captureJob) return this.captureJob;
    const generation = this.generation;
    const job = this.capture().then(frame => { if (this.generation === generation) { this.latest = { frame, at: Date.now() }; this.invalidated = false; this.onAvailability?.(true); } return frame; });
    this.captureJob = job.finally(() => { if (this.captureJob === done) this.captureJob = null; });
    const done = this.captureJob;
    return done;
  }
  /** A click confirmation always requests a new image to detect intervening changes. */
  async frame(fresh = false): Promise<ScreenFrame> {
    if (!fresh && this.latest && Date.now() - this.latest.at <= this.intervalMs) return Promise.resolve(this.latest.frame);
    if ((fresh || this.invalidated) && this.captureJob) await this.captureJob.catch(() => undefined);
    return this.sample();
  }
}
