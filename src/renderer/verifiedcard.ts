import type { JarvinApi } from '../shared/types';
import { esc } from './markdown';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const cards = new Map<string, HTMLElement>();

const STATE: Record<string, string> = {
  preparing: 'Making a private copy of your project…',
  baseline: 'Running the tests once before changing anything…',
  editing: 'Editing the copy',
  testing: 'Running the tests',
};

const RESULT: Record<string, { cls: string; text: string }> = {
  green: { cls: 'ok', text: 'Verified: tests pass' },
  red: { cls: 'bad', text: 'Not verified: tests still fail' },
  unverified: { cls: 'warn', text: 'Changed, but nothing could check it' },
  stopped: { cls: 'warn', text: 'Stopped' },
};

function colorDiff(text: string): string {
  return text
    .split('\n')
    .map((l) => {
      const c = l.startsWith('@@') ? 'h' : l.startsWith('+++') || l.startsWith('---') ? 'f' : l[0] === '+' ? 'a' : l[0] === '-' ? 'd' : '';
      return `<span class="ud ${c}">${esc(l)}</span>`;
    })
    .join('\n');
}

export async function showDiff(jarvin: JarvinApi, id: string, title: string, file?: string) {
  const dlg = $<HTMLDialogElement>('vcDlg');
  $('vcTitle').textContent = title;
  $('vcPre').textContent = 'Loading…';
  if (!dlg.open) dlg.showModal();
  try {
    const t = await jarvin.verifiedDiff(id, file);
    $('vcPre').innerHTML = t.trim() ? colorDiff(t) : 'No differences.';
  } catch (e: any) {
    $('vcPre').textContent = String(e?.message ?? e);
  }
}

/** Create or update the "verified change" card for this id. `put` adds a new card to the chat. */
export function renderVerified(e: any, jarvin: JarvinApi, put: (el: HTMLElement) => void, after: () => void) {
  const id = String(e.id);
  if (e.discarded) {
    const c = cards.get(id);
    if (c) { c.classList.add('gone'); c.querySelector('.vcbtns')?.remove(); c.querySelector('.vctitle')!.textContent = 'Discarded. Nothing was changed in your project.'; }
    return;
  }
  let d = cards.get(id);
  if (!d) {
    d = document.createElement('div');
    d.className = 'vccard';
    cards.set(id, d);
    put(d);
  }
  const done = e.state === 'done';
  const res = done ? RESULT[e.result ?? 'stopped'] : null;
  const applied = e.applied?.applied ?? 0;
  const left = (e.files ?? []) as { path: string; status: string }[];
  const title = done
    ? applied && !left.length && !(e.applied?.conflicts?.length) ? `Applied ${applied} file${applied === 1 ? '' : 's'} to your project` : res!.text
    : `${STATE[e.state] ?? 'Working'}${e.state === 'editing' || e.state === 'testing' ? ` · attempt ${e.attempt ?? 1} of ${e.max}` : ''}`;
  const cls = done ? (applied && !left.length ? 'ok' : res!.cls) : 'run';
  const attempts = (e.attempts ?? [])
    .map((a: any) => `<div class="vca ${a.green ? 'ok' : 'bad'}"><span class="vcn">${a.n}</span><span class="vcl">${esc(a.line)}</span><span class="vcs">${esc(String(a.summary).split('\n')[0].slice(0, 140))}</span></div>`)
    .join('');
  const files = left
    .slice(0, 14)
    .map((f) => `<div class="cpf ${f.status === 'added' ? 'created' : f.status}"><span class="cps">${f.status === 'added' ? 'new' : f.status === 'deleted' ? 'deleted' : 'edited'}</span><span class="cpn">${esc(f.path)}</span>${done ? `<button type="button" class="cpfdiff" data-path="${esc(f.path)}">Diff</button>` : ''}</div>`)
    .join('');
  const warns = (e.warnings ?? []).map((w: string) => `<div class="vcw">⚠ ${esc(w)}</div>`).join('');
  const conflicts = (e.applied?.conflicts ?? []).map((c: any) => `<div class="vcw">Not applied: ${esc(c.path)} (${esc(c.reason)})</div>`).join('');
  const canApply = done && left.length > 0 && e.result !== 'stopped';
  d.className = `vccard ${cls}`;
  d.innerHTML = `<div class="vchead"><span class="vctitle">${esc(title)}</span><span class="vcbtns">${canApply ? `<button type="button" class="btn small" data-a="diff">View diff</button><button type="button" class="btn small primary" data-a="apply">Apply ${left.length} file${left.length === 1 ? '' : 's'}</button><button type="button" class="btn small" data-a="discard">Discard</button>` : ''}</span></div>
    <div class="vctask">${esc(String(e.task ?? '').slice(0, 200))}</div>
    ${!done && e.activity ? `<div class="vcact">${esc(e.activity)}</div>` : ''}
    ${attempts ? `<div class="vcatt">${attempts}</div>` : ''}
    ${left.length ? `<div class="cplist">${files}</div>` : ''}${warns}${conflicts}
    <div class="cpmsg" hidden></div>`;
  const msg = d.querySelector<HTMLElement>('.cpmsg')!;
  const say = (t: string, c = '') => { msg.hidden = false; msg.className = 'cpmsg ' + c; msg.textContent = t; };
  d.querySelector<HTMLButtonElement>('[data-a=diff]')?.addEventListener('click', () => void showDiff(jarvin, id, 'Changes in the private copy'));
  d.querySelectorAll<HTMLButtonElement>('.cpfdiff').forEach((b) => (b.onclick = () => void showDiff(jarvin, id, b.dataset.path!, b.dataset.path)));
  d.querySelector<HTMLButtonElement>('[data-a=discard]')?.addEventListener('click', async () => {
    if (confirm('Throw this change away? Nothing has been changed in your project.')) await jarvin.verifiedDiscard(id);
  });
  const ap = d.querySelector<HTMLButtonElement>('[data-a=apply]');
  if (ap) ap.onclick = async () => {
    if (e.result === 'red' && !confirm('The tests still fail with this change. Apply it anyway?')) return;
    ap.disabled = true;
    try {
      const r = await jarvin.verifiedApply(id);
      after();
      if (r.conflicts.length) say(`${r.applied} applied. ${r.conflicts.length} skipped: ${r.conflicts.map((c) => c.path).join(', ')}`, 'bad');
    } catch (err: any) {
      ap.disabled = false;
      say(String(err?.message ?? err), 'bad');
    }
  };
}
