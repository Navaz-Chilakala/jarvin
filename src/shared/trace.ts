// Reads the per-run event log (one JSON object per line) into a timeline a person can follow.
// Pure and renderer-safe. Tolerant: old logs without a header or usage lines still open.

export type StepKind = 'prompt' | 'model' | 'tool' | 'note' | 'error' | 'verified' | 'problems' | 'checkpoint' | 'question';

export interface TraceStep {
  kind: StepKind;
  /** Milliseconds from the first event of the run. */
  at: number;
  /** Duration. 0 for things that happen at one moment. */
  ms: number;
  title: string;
  detail?: string;
  name?: string;
  ok?: boolean;
  /** The person was asked to approve; the duration includes the wait. */
  waited?: boolean;
  /** The tool never reported back (stopped, crashed). */
  unfinished?: boolean;
  tokensIn?: number;
  tokensOut?: number;
  model?: string;
  /** Length of text cut from `detail`. */
  cut?: number;
}

export interface ToolStat {
  name: string;
  calls: number;
  errors: number;
  totalMs: number;
  maxMs: number;
}

export type Outcome = 'done' | 'error' | 'paused' | 'stopped' | 'unknown';

export interface Trace {
  id: string;
  startedAt: string;
  durationMs: number;
  prompt: string;
  model: string;
  workspace: string;
  mode: string;
  outcome: Outcome;
  error?: string;
  steps: TraceStep[];
  tools: ToolStat[];
  totals: { toolCalls: number; toolErrors: number; toolMs: number; modelMs: number; modelTurns: number; tokensIn: number; tokensOut: number };
  /** Only the start and end of a very large log were read. */
  partial?: boolean;
}

export interface TraceSummary {
  id: string;
  startedAt: string;
  mtime: number;
  bytes: number;
  prompt: string;
  model: string;
  durationMs: number;
  toolCalls: number;
  toolErrors: number;
  outcome: Outcome;
  partial?: boolean;
}

export const DETAIL_LIMIT = 4000;

const clip = (s: string, n = DETAIL_LIMIT): { text: string; cut: number } => (s.length > n ? { text: s.slice(0, n), cut: s.length - n } : { text: s, cut: 0 });

const pretty = (v: unknown): string => {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? '';
  } catch {
    return String(v);
  }
};

/** One short line that says what a tool call did, from its arguments. */
export function toolTitle(name: string, args: unknown): string {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, any>;
  const pick = a.path ?? a.file ?? a.file_path ?? a.command ?? a.cmd ?? a.query ?? a.pattern ?? a.url ?? a.task ?? a.name;
  const s = typeof pick === 'string' ? pick.replace(/\s+/g, ' ').trim() : '';
  return s ? `${name}  ${s.length > 90 ? s.slice(0, 90) + '…' : s}` : name;
}

export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '–';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m} min ${s} s`;
}

interface Raw {
  ts: number;
  e: any;
}

function readLines(text: string): Raw[] {
  const out: Raw[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      const ts = Date.parse(j?.ts);
      if (j && typeof j.event === 'object' && j.event && Number.isFinite(ts)) out.push({ ts, e: j.event });
    } catch {
      /* a cut line at the edge of a partial read */
    }
  }
  return out;
}

export function parseTrace(id: string, text: string, opts: { partial?: boolean } = {}): Trace {
  const raw = readLines(text);
  const t0 = raw.length ? raw[0].ts : 0;
  const tEnd = raw.length ? raw[raw.length - 1].ts : 0;
  const steps: TraceStep[] = [];
  const tr: Trace = {
    id,
    startedAt: raw.length ? new Date(t0).toISOString() : '',
    durationMs: Math.max(0, tEnd - t0),
    prompt: '',
    model: '',
    workspace: '',
    mode: '',
    outcome: 'unknown',
    steps,
    tools: [],
    totals: { toolCalls: 0, toolErrors: 0, toolMs: 0, modelMs: 0, modelTurns: 0, tokensIn: 0, tokensOut: 0 },
    partial: opts.partial || undefined,
  };

  const open = new Map<string, { name: string; args: unknown; at: number; ts: number; out: string; waited: boolean }>();
  let boundary = t0;
  let pend = { text: '', first: 0, last: 0 };

  const flushModel = (usage?: { ts: number; e: any }) => {
    const hasText = pend.text.trim().length > 0;
    if (!hasText && !usage) return;
    let start = boundary;
    let end = pend.last || boundary;
    if (usage) {
      const ms = Number(usage.e.ms);
      end = usage.ts;
      if (Number.isFinite(ms) && ms >= 0) start = usage.ts - ms;
    }
    const c = clip(pend.text.trim());
    const tin = Number(usage?.e.promptTokens);
    const tout = Number(usage?.e.completionTokens);
    const step: TraceStep = {
      kind: 'model',
      at: Math.max(0, start - t0),
      ms: Math.max(0, end - start),
      title: hasText ? `Model wrote ${pend.text.trim().length} characters` : 'Model chose tools',
      detail: c.text || undefined,
      cut: c.cut || undefined,
      model: typeof usage?.e.model === 'string' ? usage.e.model : undefined,
      tokensIn: Number.isFinite(tin) ? tin : undefined,
      tokensOut: Number.isFinite(tout) ? tout : undefined,
    };
    steps.push(step);
    tr.totals.modelMs += step.ms;
    tr.totals.modelTurns++;
    if (step.tokensIn) tr.totals.tokensIn += step.tokensIn;
    if (step.tokensOut) tr.totals.tokensOut += step.tokensOut;
    pend = { text: '', first: 0, last: 0 };
  };

  const instant = (kind: StepKind, ts: number, title: string, detail?: string, ok?: boolean) => {
    const c = detail ? clip(detail) : { text: '', cut: 0 };
    steps.push({ kind, at: Math.max(0, ts - t0), ms: 0, title, detail: c.text || undefined, cut: c.cut || undefined, ok });
  };

  for (const { ts, e } of raw) {
    if (e.type === 'token') {
      if (!pend.first) pend.first = ts;
      pend.last = ts;
      pend.text += String(e.text ?? '');
      continue;
    }
    if (e.type === 'usage') {
      flushModel({ ts, e });
      boundary = ts;
      continue;
    }
    flushModel();
    switch (e.type) {
      case 'run':
        tr.prompt = String(e.prompt ?? '');
        tr.model = String(e.model ?? '');
        tr.workspace = String(e.workspace ?? '');
        tr.mode = String(e.mode ?? '');
        instant('prompt', ts, 'You asked', tr.prompt);
        boundary = ts;
        break;
      case 'tool_start':
        open.set(String(e.id), { name: String(e.name ?? 'tool'), args: e.args, at: ts - t0, ts, out: '', waited: false });
        break;
      case 'tool_output': {
        const o = open.get(String(e.id));
        if (o && o.out.length < DETAIL_LIMIT * 4) o.out += String(e.text ?? '');
        break;
      }
      case 'approval': {
        const o = open.get(String(e.id));
        if (o) o.waited = true;
        break;
      }
      case 'tool_result': {
        const o = open.get(String(e.id));
        const name = o?.name ?? 'tool';
        const full = String(e.output ?? o?.out ?? '');
        const c = clip(full);
        const argsText = pretty(o?.args);
        const ms = o ? Math.max(0, ts - o.ts) : 0;
        steps.push({
          kind: 'tool',
          at: o ? o.at : Math.max(0, ts - t0),
          ms,
          title: toolTitle(name, o?.args),
          name,
          ok: !!e.ok,
          waited: o?.waited || undefined,
          detail: `${clip(argsText, 1500).text}\n\n— result —\n${c.text}`,
          cut: c.cut || undefined,
        });
        tr.totals.toolCalls++;
        tr.totals.toolMs += ms;
        if (!e.ok) tr.totals.toolErrors++;
        const st = tr.tools.find((x) => x.name === name) ?? (tr.tools[tr.tools.length] = { name, calls: 0, errors: 0, totalMs: 0, maxMs: 0 });
        st.calls++;
        st.totalMs += ms;
        st.maxMs = Math.max(st.maxMs, ms);
        if (!e.ok) st.errors++;
        open.delete(String(e.id));
        boundary = Math.max(boundary, ts);
        break;
      }
      case 'note': {
        const t = String(e.text ?? '');
        instant('note', ts, t.length > 140 ? t.slice(0, 140) + '…' : t, t.length > 140 ? t : undefined);
        if (/^Paused after \d+ steps/.test(t)) tr.outcome = 'paused';
        else if (/^Stopped\b/.test(t) && tr.outcome === 'unknown') tr.outcome = 'stopped';
        break;
      }
      case 'question':
        instant('question', ts, `Asked you: ${String(e.question ?? '').slice(0, 120)}`, pretty(e.options));
        break;
      case 'checkpoint':
        instant('checkpoint', ts, `Saved a checkpoint (${e.summary?.files?.length ?? 0} files)`, (e.summary?.files ?? []).map((f: any) => `${f.status} ${f.path}`).join('\n'));
        break;
      case 'problems': {
        const n = Array.isArray(e.result?.problems) ? e.result.problems.length : 0;
        instant('problems', ts, `Error check found ${n} problem${n === 1 ? '' : 's'}`, undefined, n === 0);
        break;
      }
      case 'verified':
        instant('verified', ts, `Verified change: ${String(e.state ?? e.result ?? 'update')}`, undefined, e.result === 'green' || undefined);
        break;
      case 'error':
        instant('error', ts, String(e.message ?? 'Error').slice(0, 200), String(e.message ?? ''), false);
        tr.outcome = 'error';
        tr.error = String(e.message ?? '');
        break;
      case 'done':
        if (tr.outcome === 'unknown') tr.outcome = 'done';
        break;
      default:
        break;
    }
    if (e.type === 'note' || e.type === 'checkpoint' || e.type === 'problems' || e.type === 'verified') boundary = Math.max(boundary, ts);
  }
  flushModel();

  for (const [, o] of open) {
    const ms = Math.max(0, tEnd - o.ts);
    const c = clip(o.out);
    steps.push({ kind: 'tool', at: o.at, ms, title: toolTitle(o.name, o.args), name: o.name, unfinished: true, waited: o.waited || undefined, detail: `${clip(pretty(o.args), 1500).text}${c.text ? `\n\n— output so far —\n${c.text}` : ''}`, cut: c.cut || undefined });
    tr.totals.toolCalls++;
  }

  steps.sort((a, b) => a.at - b.at || (a.kind === 'prompt' ? -1 : 0));
  tr.tools.sort((a, b) => b.totalMs - a.totalMs);
  return tr;
}

export function summarize(t: Trace, meta: { mtime: number; bytes: number }): TraceSummary {
  return {
    id: t.id,
    startedAt: t.startedAt,
    mtime: meta.mtime,
    bytes: meta.bytes,
    prompt: t.prompt,
    model: t.model,
    durationMs: t.durationMs,
    toolCalls: t.totals.toolCalls,
    toolErrors: t.totals.toolErrors,
    outcome: t.outcome,
    partial: t.partial,
  };
}

/** Plain-text export of a run, for pasting into a bug report. Secrets are the caller's job to remove first. */
export function traceToText(t: Trace): string {
  const L: string[] = [];
  L.push(`Run ${t.id}`, `Started ${t.startedAt}  ·  ${fmtMs(t.durationMs)}  ·  ${t.outcome}${t.model ? `  ·  ${t.model}` : ''}`);
  if (t.prompt) L.push('', `Asked: ${t.prompt}`);
  L.push('');
  for (const s of t.steps) {
    const mark = s.kind === 'tool' ? (s.ok ? 'ok ' : s.unfinished ? '?? ' : 'ERR') : '   ';
    L.push(`+${fmtMs(s.at).padStart(8)}  ${mark} ${s.title}${s.ms ? `  (${fmtMs(s.ms)})` : ''}`);
  }
  L.push('', `Model ${fmtMs(t.totals.modelMs)} in ${t.totals.modelTurns} turns · tools ${fmtMs(t.totals.toolMs)} in ${t.totals.toolCalls} calls (${t.totals.toolErrors} failed)${t.totals.tokensIn || t.totals.tokensOut ? ` · tokens in ${t.totals.tokensIn}, out ${t.totals.tokensOut}` : ''}`);
  return L.join('\n');
}
