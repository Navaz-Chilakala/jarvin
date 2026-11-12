import fs from 'node:fs';
import path from 'node:path';
import { parseTrace, summarize, type Trace, type TraceSummary, type TraceStep } from '../shared/trace';
import { redactSecrets } from './sandbox';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WHOLE = 3 * 1024 * 1024;
const EDGE = 1024 * 1024;
export const MAX_LIST = 100;

export const validTraceId = (id: unknown): id is string => typeof id === 'string' && ID.test(id);

function readFor(file: string, size: number): { text: string; partial: boolean } {
  if (size <= WHOLE) return { text: fs.readFileSync(file, 'utf8'), partial: false };
  const fd = fs.openSync(file, 'r');
  try {
    const a = Buffer.alloc(EDGE);
    const b = Buffer.alloc(EDGE);
    fs.readSync(fd, a, 0, EDGE, 0);
    fs.readSync(fd, b, 0, EDGE, size - EDGE);
    // Cut to whole lines so no half-written line is read as an event.
    const head = a.toString('utf8');
    const tail = b.toString('utf8');
    return { text: head.slice(0, head.lastIndexOf('\n') + 1) + tail.slice(tail.indexOf('\n') + 1), partial: true };
  } finally {
    fs.closeSync(fd);
  }
}

function clean(t: Trace): Trace {
  const r = (s?: string) => (s ? redactSecrets(s) : s);
  const steps: TraceStep[] = t.steps.map((s) => ({ ...s, title: r(s.title) ?? '', detail: r(s.detail) }));
  return { ...t, prompt: r(t.prompt) ?? '', steps, error: r(t.error) };
}

export function listTraces(dir: string): TraceSummary[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl') && validTraceId(n.slice(0, -6)));
  } catch {
    return [];
  }
  const stats = names
    .map((n) => {
      try {
        const st = fs.statSync(path.join(dir, n));
        return { id: n.slice(0, -6), mtime: st.mtimeMs, size: st.size };
      } catch {
        return null;
      }
    })
    .filter((x): x is { id: string; mtime: number; size: number } => !!x && x.size > 0)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_LIST);
  const out: TraceSummary[] = [];
  for (const s of stats) {
    try {
      const { text, partial } = readFor(path.join(dir, s.id + '.jsonl'), s.size);
      const t = clean(parseTrace(s.id, text, { partial }));
      if (t.startedAt) out.push(summarize(t, { mtime: s.mtime, bytes: s.size }));
    } catch {
      /* unreadable log: skip */
    }
  }
  return out;
}

export function readTrace(dir: string, id: unknown): Trace {
  if (!validTraceId(id)) throw new Error('Invalid run id.');
  const file = path.join(dir, id + '.jsonl');
  const st = fs.statSync(file);
  const { text, partial } = readFor(file, st.size);
  return clean(parseTrace(id, text, { partial }));
}

export function deleteTrace(dir: string, id: unknown): void {
  if (!validTraceId(id)) throw new Error('Invalid run id.');
  fs.rmSync(path.join(dir, id + '.jsonl'), { force: true });
}

/** Deletes runs last written more than `days` days ago (0 = all). Returns how many. */
export function clearTraces(dir: string, days: number): number {
  let n = 0;
  const cutoff = Date.now() - Math.max(0, days) * 86_400_000;
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    if (!name.endsWith('.jsonl') || !validTraceId(name.slice(0, -6))) continue;
    const f = path.join(dir, name);
    try {
      if (days <= 0 || fs.statSync(f).mtimeMs < cutoff) { fs.rmSync(f, { force: true }); n++; }
    } catch { /* skip */ }
  }
  return n;
}
