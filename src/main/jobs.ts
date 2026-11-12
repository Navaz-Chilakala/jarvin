import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { shellFor, killTree, type ShellChoice } from './terminal';
import { appendCapped, detectUrls, lastLines, statusOf, type JobInfo } from '../shared/jobs';

const MAX_RUNNING = 8;
const KEEP_FINISHED = 20;

interface Job {
  info: JobInfo;
  proc: ChildProcess | null;
  out: string;
  stopped: boolean;
}

/** Commands that keep running while you work: dev servers, watchers, long builds. */
export class JobManager {
  private jobs = new Map<string, Job>();
  private listeners = new Set<(list: JobInfo[]) => void>();
  private finishedCb: ((j: JobInfo) => void) | null = null;
  private timer: NodeJS.Timeout | null = null;

  onChange(cb: (list: JobInfo[]) => void) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  onFinished(cb: (j: JobInfo) => void) { this.finishedCb = cb; }

  list(): JobInfo[] {
    return [...this.jobs.values()].map((j) => ({ ...j.info })).sort((a, b) => b.startedAt - a.startedAt);
  }
  runningCount() { return [...this.jobs.values()].filter((j) => j.info.status === 'running').length; }
  get(id: string) { return this.jobs.get(id); }

  start(command: string, cwd: string, shell: ShellChoice | undefined, byAgent: boolean): JobInfo {
    const cmd = command.trim();
    if (!cmd) throw new Error('Type a command to run.');
    if (cmd.length > 4000) throw new Error('That command is too long.');
    if (!cwd) throw new Error('Open a project folder first.');
    if (this.runningCount() >= MAX_RUNNING) throw new Error(`Already running ${MAX_RUNNING} background commands. Stop one first.`);
    const spec = shellFor(cmd, shell ?? 'auto');
    const id = crypto.randomUUID().slice(0, 8);
    const info: JobInfo = { id, command: cmd, cwd, status: 'running', exitCode: null, startedAt: Date.now(), urls: [], tail: '', byAgent };
    const job: Job = { info, proc: null, out: '', stopped: false };
    this.jobs.set(id, job);
    try {
      // Own process group on Linux/macOS so stopping it also stops what it started.
      job.proc = spawn(spec.file, spec.args, { cwd, windowsHide: true, detached: process.platform !== 'win32', windowsVerbatimArguments: spec.verbatim, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e: any) {
      this.finish(job, null, String(e?.message ?? e));
      return { ...job.info };
    }
    const feed = (d: Buffer) => {
      job.out = appendCapped(job.out, d.toString('utf8'));
      this.schedule();
    };
    job.proc.stdout?.on('data', feed);
    job.proc.stderr?.on('data', feed);
    job.proc.on('error', (e) => this.finish(job, null, String(e?.message ?? e)));
    job.proc.on('close', (code) => this.finish(job, typeof code === 'number' ? code : null));
    this.emit();
    return { ...info };
  }

  output(id: string): { info: JobInfo; output: string } {
    const j = this.jobs.get(id);
    if (!j) throw new Error(`Unknown background job: ${id}`);
    this.refresh(j);
    return { info: { ...j.info }, output: j.out };
  }

  stop(id: string): boolean {
    const j = this.jobs.get(id);
    if (!j || j.info.status !== 'running') return false;
    j.stopped = true;
    killTree(j.proc?.pid);
    // If the process ignores the kill, still mark it so the list does not lie.
    setTimeout(() => { if (j.info.status === 'running') this.finish(j, null); }, 3000).unref();
    return true;
  }

  remove(id: string) {
    const j = this.jobs.get(id);
    if (!j) return;
    if (j.info.status === 'running') this.stop(id);
    this.jobs.delete(id);
    this.emit();
  }

  clearFinished() {
    for (const [id, j] of this.jobs) if (j.info.status !== 'running') this.jobs.delete(id);
    this.emit();
  }

  killAll() {
    for (const j of this.jobs.values()) if (j.info.status === 'running') { j.stopped = true; killTree(j.proc?.pid); }
  }

  private refresh(j: Job) {
    j.info.tail = lastLines(j.out, 3);
    j.info.urls = detectUrls(j.out);
  }

  private finish(j: Job, code: number | null, error?: string) {
    if (j.info.status !== 'running') return;
    this.refresh(j);
    j.info.exitCode = code;
    j.info.error = error;
    j.info.endedAt = Date.now();
    j.info.status = statusOf(code, j.stopped, error);
    this.prune();
    this.emit();
    if (!j.stopped) this.finishedCb?.({ ...j.info });
  }

  private prune() {
    const done = [...this.jobs.values()].filter((j) => j.info.status !== 'running').sort((a, b) => (a.info.endedAt ?? 0) - (b.info.endedAt ?? 0));
    for (const j of done.slice(0, Math.max(0, done.length - KEEP_FINISHED))) this.jobs.delete(j.info.id);
  }

  private schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      for (const j of this.jobs.values()) if (j.info.status === 'running') this.refresh(j);
      this.emit();
    }, 400);
  }

  private emit() {
    const l = this.list();
    for (const cb of this.listeners) cb(l);
  }
}

export const jobs = new JobManager();
