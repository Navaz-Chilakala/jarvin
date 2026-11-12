import type { JarvinApi } from '../shared/types';
import { fmtMs, traceToText, type Trace, type TraceStep, type TraceSummary } from '../shared/trace';
import { esc } from './markdown';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const OUTCOME: Record<string, { cls: string; text: string }> = {
  done: { cls: 'ok', text: 'finished' },
  error: { cls: 'bad', text: 'failed' },
  paused: { cls: 'warn', text: 'paused at step limit' },
  stopped: { cls: 'warn', text: 'stopped' },
  unknown: { cls: 'warn', text: 'no end recorded' },
};

type Filter = 'all' | 'tools' | 'errors';

/** The run viewer: a list of past runs and, for the chosen one, a timeline of model turns and tool calls. */
export function createTraceUi(jarvin: JarvinApi, deps: { toast(m: string): void }) {
  let runs: TraceSummary[] = [];
  let cur: Trace | null = null;
  let filter: Filter = 'all';
  let query = '';

  const when = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  function renderList() {
    $('trcList').innerHTML =
      runs
        .map((r) => {
          const o = OUTCOME[r.outcome] ?? OUTCOME.unknown;
          return `<button type="button" class="trcrun${cur?.id === r.id ? ' on' : ''}" data-id="${esc(r.id)}"><div class="trcq">${esc(r.prompt || '(no prompt recorded)')}</div>` +
            `<div class="hint">${esc(when(r.startedAt))} · ${esc(fmtMs(r.durationMs))} · ${r.toolCalls} tool${r.toolCalls === 1 ? '' : 's'}${r.toolErrors ? ` · <span class="bad">${r.toolErrors} failed</span>` : ''} · <span class="${o.cls}">${esc(o.text)}</span></div></button>`;
        })
        .join('') || '<div class="hint" style="padding:12px">No runs yet. Ask Jarvin something and it will appear here.</div>';
  }

  const keep = (s: TraceStep) => {
    if (filter === 'tools' && s.kind !== 'tool') return false;
    if (filter === 'errors' && !(s.ok === false || s.kind === 'error' || s.unfinished)) return false;
    if (query && !`${s.title}\n${s.detail ?? ''}`.toLowerCase().includes(query)) return false;
    return true;
  };

  function renderDetail() {
    const t = cur;
    const box = $('trcDetail');
    if (!t) { box.innerHTML = '<div class="hint" style="padding:12px">Pick a run on the left.</div>'; return; }
    const o = OUTCOME[t.outcome] ?? OUTCOME.unknown;
    const total = Math.max(1, t.durationMs);
    const m = t.totals;
    const modelPct = Math.min(100, (m.modelMs / total) * 100);
    const toolPct = Math.min(100 - modelPct, (m.toolMs / total) * 100);
    const toolRows = t.tools.slice(0, 6).map((s) => `<tr><td>${esc(s.name)}</td><td>${s.calls}</td><td>${esc(fmtMs(s.totalMs))}</td><td>${esc(fmtMs(s.maxMs))}</td><td>${s.errors ? `<span class="bad">${s.errors}</span>` : '0'}</td></tr>`).join('');
    const tok = m.tokensIn || m.tokensOut ? `${m.tokensIn.toLocaleString()} in · ${m.tokensOut.toLocaleString()} out` : 'not reported by this model';
    const rows = t.steps
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => keep(s))
      .map(({ s, i }) => {
        const left = Math.min(99, (s.at / total) * 100);
        const width = Math.max(0.6, Math.min(100 - left, (s.ms / total) * 100));
        const cls = s.kind === 'tool' ? (s.unfinished ? 'unf' : s.ok ? 'tool' : 'fail') : s.kind === 'error' ? 'fail' : s.kind;
        const slow = s.ms > 0 && s.ms / total >= 0.25 && t.steps.length > 3;
        const meta = [s.ms ? fmtMs(s.ms) : '', s.waited ? 'includes your approval wait' : '', s.tokensIn || s.tokensOut ? `${s.tokensIn ?? '?'} in / ${s.tokensOut ?? '?'} out tokens` : '', s.unfinished ? 'never finished' : ''].filter(Boolean).join(' · ');
        return `<div class="trcstep ${cls}${slow ? ' slow' : ''}" data-i="${i}"><div class="trct">+${esc(fmtMs(s.at))}</div><div class="trctrack"><div class="trcbar" style="left:${left}%;width:${width}%"></div></div>` +
          `<div class="trctitle">${esc(s.title)}${meta ? `<div class="hint">${esc(meta)}</div>` : ''}</div></div>`;
      })
      .join('');
    box.innerHTML =
      `<div class="trcprompt">${esc(t.prompt || '(no prompt recorded)')}</div>` +
      `<div class="hint">${esc(when(t.startedAt))} · ${esc(fmtMs(t.durationMs))} · ${esc(t.model || 'model unknown')} · <span class="${o.cls}">${esc(o.text)}</span>${t.partial ? ' · very large log, middle part not shown' : ''}</div>` +
      (t.error ? `<div class="hint bad">${esc(t.error)}</div>` : '') +
      `<div class="trcsplit" title="Model time and tool time as a share of the run"><i class="m" style="width:${modelPct}%"></i><i class="t" style="width:${toolPct}%"></i></div>` +
      `<div class="trcchips"><span><b>${esc(fmtMs(m.modelMs))}</b> model · ${m.modelTurns} turn${m.modelTurns === 1 ? '' : 's'}</span><span><b>${esc(fmtMs(m.toolMs))}</b> tools · ${m.toolCalls} call${m.toolCalls === 1 ? '' : 's'}${m.toolErrors ? ` (<span class="bad">${m.toolErrors} failed</span>)` : ''}</span><span>tokens: ${esc(tok)}</span></div>` +
      (toolRows ? `<table class="trctab"><tr><th>Tool</th><th>Calls</th><th>Total</th><th>Slowest</th><th>Failed</th></tr>${toolRows}</table>` : '') +
      `<div class="trcbar2"><button type="button" data-f="all" class="btn small${filter === 'all' ? ' primary' : ''}">All</button><button type="button" data-f="tools" class="btn small${filter === 'tools' ? ' primary' : ''}">Tools</button><button type="button" data-f="errors" class="btn small${filter === 'errors' ? ' primary' : ''}">Problems</button><input id="trcQ" placeholder="Search this run" value="${esc(query)}" autocomplete="off" /></div>` +
      `<div class="trcsteps">${rows || '<div class="hint" style="padding:8px">Nothing matches.</div>'}</div>` +
      `<div class="row end"><button type="button" id="trcCopy" class="btn small">Copy summary</button><button type="button" id="trcShow" class="btn small">Show file</button><button type="button" id="trcDel" class="btn small danger">Delete run</button></div>`;
    $<HTMLInputElement>('trcQ').oninput = (e) => { query = (e.target as HTMLInputElement).value.toLowerCase(); const pos = (e.target as HTMLInputElement).selectionStart; renderDetail(); const q = $<HTMLInputElement>('trcQ'); q.focus(); q.setSelectionRange(pos, pos); };
  }

  async function show(id: string) {
    $('trcDetail').innerHTML = '<div class="hint" style="padding:12px">Loading…</div>';
    try {
      cur = await jarvin.traceGet(id);
      query = '';
    } catch (e: any) {
      cur = null;
      deps.toast(String(e?.message ?? e));
    }
    renderList();
    renderDetail();
  }

  async function load(select?: string) {
    runs = await jarvin.traceList();
    renderList();
    const id = select ?? cur?.id ?? runs[0]?.id;
    if (id && runs.some((r) => r.id === id)) await show(id);
    else { cur = null; renderDetail(); }
  }

  async function open() {
    $<HTMLDialogElement>('trcDlg').showModal();
    $('trcList').innerHTML = '<div class="hint" style="padding:12px">Loading…</div>';
    cur = null;
    filter = 'all';
    await load();
  }

  function wire() {
    $('trcList').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('.trcrun');
      if (b?.dataset.id) void show(b.dataset.id);
    });
    $('trcDetail').addEventListener('click', async (e) => {
      const tgt = e.target as HTMLElement;
      const f = tgt.closest<HTMLElement>('[data-f]');
      if (f) { filter = f.dataset.f as Filter; renderDetail(); return; }
      const step = tgt.closest<HTMLElement>('.trcstep');
      if (step && cur) {
        const s = cur.steps[Number(step.dataset.i)];
        const next = step.nextElementSibling;
        if (next?.classList.contains('trcdet')) { next.remove(); return; }
        if (s?.detail) {
          const pre = document.createElement('pre');
          pre.className = 'trcdet';
          pre.textContent = s.detail + (s.cut ? `\n… ${s.cut.toLocaleString()} more characters not shown` : '');
          step.after(pre);
        }
        return;
      }
      if (!cur) return;
      if (tgt.id === 'trcCopy') {
        try { await navigator.clipboard.writeText(traceToText(cur)); deps.toast('Summary copied'); } catch { deps.toast('Could not copy'); }
      } else if (tgt.id === 'trcShow') void jarvin.traceReveal(cur.id);
      else if (tgt.id === 'trcDel') {
        if (tgt.dataset.sure !== '1') { tgt.dataset.sure = '1'; tgt.textContent = 'Really delete?'; setTimeout(() => { if (tgt.isConnected) { tgt.dataset.sure = ''; tgt.textContent = 'Delete run'; } }, 4000); return; }
        const id = cur.id;
        await jarvin.traceDelete(id);
        cur = null;
        await load(runs.find((r) => r.id !== id)?.id);
      }
    });
    $('trcFolder').onclick = () => void jarvin.traceReveal();
    $('trcClear').onclick = async (e) => {
      const b = e.currentTarget as HTMLButtonElement;
      if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Really delete runs older than 7 days?'; setTimeout(() => { if (b.isConnected) { b.dataset.sure = ''; b.textContent = 'Delete old runs'; } }, 4000); return; }
      b.dataset.sure = '';
      b.textContent = 'Delete old runs';
      const n = await jarvin.traceClear(7);
      deps.toast(`Deleted ${n} run${n === 1 ? '' : 's'}`);
      cur = null;
      await load();
    };
  }

  return { open, wire };
}
