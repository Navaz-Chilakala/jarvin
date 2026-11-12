// Background commands and the message queue: the parts that need no Electron.

export type JobStatus = 'running' | 'done' | 'failed' | 'stopped';

export interface JobInfo {
  id: string;
  command: string;
  cwd: string;
  status: JobStatus;
  exitCode: number | null;
  startedAt: number;
  endedAt?: number;
  /** Local addresses the output mentioned, e.g. a dev server's URL. */
  urls: string[];
  error?: string;
  /** Last few lines of output, for the list. */
  tail: string;
  /** Started by Jarvin's agent (true) or by the user from the Tasks window (false). */
  byAgent: boolean;
}

export const OUTPUT_MAX = 200_000;
export const OUTPUT_KEEP = 100_000;

/** Appends output, dropping the oldest part once it grows past the cap. */
export function appendCapped(buf: string, chunk: string): string {
  const s = buf + chunk;
  return s.length > OUTPUT_MAX ? s.slice(s.length - OUTPUT_KEEP) : s;
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
export const clean = (s: string) => s.replace(ANSI, '').replace(/\r(?!\n)/g, '\n');

export function lastLines(text: string, n: number): string {
  const lines = clean(text).split('\n').map((l) => l.replace(/\s+$/, '')).filter(Boolean);
  return lines.slice(-n).join('\n');
}

const URL_RE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):\d{2,5}(?:\/[^\s'"<>)\]]*)?/gi;

/** Local addresses in a dev server's output, normalised to localhost, without duplicates. */
export function detectUrls(text: string, max = 3): string[] {
  const out: string[] = [];
  for (const m of clean(text).matchAll(URL_RE)) {
    const u = m[0].replace(/0\.0\.0\.0|\[::1?\]|127\.0\.0\.1/i, 'localhost').replace(/[.,;:]+$/, '');
    const key = u.replace(/\/$/, '');
    if (!out.some((x) => x.replace(/\/$/, '') === key)) out.push(u);
    if (out.length >= max) break;
  }
  return out;
}

export function statusOf(exitCode: number | null, stopped: boolean, error?: string): JobStatus {
  if (stopped) return 'stopped';
  if (error || (exitCode !== null && exitCode !== 0)) return 'failed';
  return 'done';
}

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function jobLine(j: JobInfo, now = Date.now()): string {
  const t = fmtElapsed((j.endedAt ?? now) - j.startedAt);
  const st = j.status === 'running' ? `running ${t}` : j.status === 'done' ? `finished in ${t}` : j.status === 'stopped' ? `stopped after ${t}` : `failed after ${t}${j.exitCode !== null ? ` (exit ${j.exitCode})` : ''}${j.error ? `: ${j.error}` : ''}`;
  return `${j.id}: ${j.command} — ${st}`;
}

/** What the agent is told when it asks for a job's output. */
export function jobReport(j: JobInfo, output: string, tailLines = 200): string {
  const body = clean(output).split('\n').slice(-tailLines).join('\n');
  const urls = j.urls.length ? `\nAddresses seen: ${j.urls.join(', ')}` : '';
  return `Job ${j.id}: ${j.status === 'running' ? 'running' : j.status === 'done' ? 'finished (exit 0)' : j.status === 'stopped' ? 'stopped' : `failed${j.exitCode !== null ? ` (exit ${j.exitCode})` : ''}${j.error ? ` error: ${j.error}` : ''}`}${urls}\n${body}`;
}

/* ---------- message queue ---------- */

export interface QueueItem {
  id: string;
  text: string;
  images?: string[];
}

export const QUEUE_MAX = 20;
let seq = 0;

export function enqueue(q: QueueItem[], text: string, images?: string[]): { queue: QueueItem[]; added: boolean } {
  const t = text.trim();
  if (!t || q.length >= QUEUE_MAX) return { queue: q, added: false };
  return { queue: [...q, { id: `q${Date.now().toString(36)}${(seq++).toString(36)}`, text: t, images: images?.length ? images : undefined }], added: true };
}

export type RunOutcome = 'done' | 'error' | 'stopped' | 'paused';

/** After a run ends: the next message to send, or why the queue is waiting. */
export function nextInQueue(q: QueueItem[], outcome: RunOutcome): { item: QueueItem | null; rest: QueueItem[]; paused: boolean } {
  if (!q.length) return { item: null, rest: q, paused: false };
  if (outcome !== 'done') return { item: null, rest: q, paused: true };
  return { item: q[0], rest: q.slice(1), paused: false };
}

export function moveInQueue(q: QueueItem[], id: string, dir: -1 | 1): QueueItem[] {
  const i = q.findIndex((x) => x.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= q.length) return q;
  const out = [...q];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

export const shortText = (s: string, n = 80) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
