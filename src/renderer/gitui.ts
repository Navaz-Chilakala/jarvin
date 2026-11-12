import type { JarvinApi } from '../shared/types';
import { splitDiff, type Branch, type Commit, type GitFile, type GitStatus } from '../shared/gitparse';
import { esc } from './markdown';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

type St = (GitStatus & { repo: true; root: string }) | { repo: false };
type Sel = { path: string; kind: 'staged' | 'unstaged' | 'untracked' } | null;

const LETTER: Record<string, string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', untracked: 'U', conflict: '!', typechange: 'T' };

function colorLines(text: string): string {
  return text
    .split('\n')
    .map((l) => {
      const c = l.startsWith('@@') ? 'h' : l.startsWith('+++') || l.startsWith('---') ? 'f' : l[0] === '+' ? 'a' : l[0] === '-' ? 'd' : '';
      return `<span class="ud ${c}">${esc(l)}</span>`;
    })
    .join('\n');
}

/** The Git panel: changes, staging (files and single hunks), commits with AI wording, branches, history, pull request drafts. */
export function createGitUi(jarvin: JarvinApi, deps: { toast(m: string): void; refreshTree(): void }) {
  let st: St = { repo: false };
  let sel: Sel = null;
  let tab: 'diff' | 'log' | 'pr' = 'diff';
  let branches: Branch[] = [];
  let busy = false;

  const g = <T = any>(op: string, args?: Record<string, unknown>) => jarvin.gitx<T>(op, args);
  const say = (m: string) => deps.toast(m.length > 300 ? m.slice(0, 300) + '…' : m);

  async function act<T>(label: string, fn: () => Promise<T>, after = true): Promise<T | undefined> {
    if (busy) return;
    busy = true;
    document.querySelectorAll<HTMLButtonElement>('#gitDlg .gtact').forEach((b) => (b.disabled = true));
    try {
      const r = await fn();
      if (after) await refresh();
      return r;
    } catch (e: any) {
      say(`${label}: ${String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`);
      if (after) await refresh();
    } finally {
      busy = false;
      document.querySelectorAll<HTMLButtonElement>('#gitDlg .gtact').forEach((b) => (b.disabled = false));
    }
  }

  const fileRow = (f: GitFile, kind: 'staged' | 'unstaged') => {
    const state = kind === 'staged' ? f.staged : f.unstaged;
    const k: 'staged' | 'unstaged' | 'untracked' = kind === 'staged' ? 'staged' : f.unstaged === 'untracked' ? 'untracked' : 'unstaged';
    const slash = f.path.lastIndexOf('/');
    const dir = slash >= 0 ? f.path.slice(0, slash + 1) : '';
    const name = f.path.slice(slash + 1);
    const on = sel?.path === f.path && sel.kind === k;
    const discard = kind === 'unstaged' && k === 'unstaged' && !f.conflict ? `<button type="button" class="btn small gtact danger" data-a="discard" title="Throw away these changes">Discard</button>` : '';
    return `<div class="gtfile${on ? ' on' : ''}" data-path="${esc(f.path)}" data-kind="${k}"><span class="gtl ${esc(state ?? '')}">${esc(LETTER[state ?? ''] ?? '?')}</span><span class="gtname" title="${esc(f.path)}"><span class="hint">${esc(dir)}</span>${esc(name)}${f.from ? ` <span class="hint">← ${esc(f.from)}</span>` : ''}</span>` +
      `${discard}<button type="button" class="btn small gtact" data-a="${kind === 'staged' ? 'unstage' : 'stage'}">${kind === 'staged' ? 'Unstage' : 'Stage'}</button></div>`;
  };

  function renderTop() {
    if (!st.repo) return;
    const s = st;
    const sel2 = $<HTMLSelectElement>('gtBranch');
    const local = branches.filter((b) => !b.remote);
    const remote = branches.filter((b) => b.remote && !local.some((l) => b.name.endsWith('/' + l.name)));
    sel2.innerHTML = (s.detached ? `<option selected>(detached HEAD)</option>` : '') + local.map((b) => `<option value="${esc(b.name)}"${b.current ? ' selected' : ''}>${esc(b.name)}</option>`).join('') +
      (remote.length ? `<optgroup label="On the remote">${remote.map((b) => `<option value="remote:${esc(b.name)}">${esc(b.name)}</option>`).join('')}</optgroup>` : '');
    if (!local.length && !s.detached) sel2.innerHTML = `<option selected>${esc(s.branch || 'main')}</option>`;
    $('gtTrack').textContent = s.upstream ? `${s.upstream}${s.ahead ? ` · ${s.ahead} to push` : ''}${s.behind ? ` · ${s.behind} to pull` : ''}${!s.ahead && !s.behind ? ' · in sync' : ''}` : 'no upstream yet';
    $('gtPush').textContent = s.ahead || !s.upstream ? `Push${s.ahead ? ` ${s.ahead}` : ''}` : 'Push';
    $('gtPull').textContent = s.behind ? `Pull ${s.behind}` : 'Pull';
  }

  function renderFiles() {
    if (!st.repo) return;
    const staged = st.files.filter((f) => f.staged);
    const changes = st.files.filter((f) => f.unstaged);
    $('gtStagedN').textContent = String(staged.length);
    $('gtChangesN').textContent = String(changes.length);
    $('gtStaged').innerHTML = staged.map((f) => fileRow(f, 'staged')).join('') || '<div class="hint gtempty">Nothing staged.</div>';
    $('gtChanges').innerHTML = changes.map((f) => fileRow(f, 'unstaged')).join('') || '<div class="hint gtempty">No other changes.</div>';
    $<HTMLButtonElement>('gtCommit').disabled = busy;
    $('gtConflict').hidden = !st.files.some((f) => f.conflict);
  }

  function renderBranches() {
    $('gtBranchList').innerHTML = branches
      .filter((b) => !b.remote)
      .map((b) => `<div class="gtbr" data-name="${esc(b.name)}"><span class="gtname"><b>${esc(b.name)}</b>${b.current ? ' <span class="mdtag">current</span>' : ''}<div class="hint">${esc(b.subject ?? '')}${b.date ? ` · ${esc(b.date)}` : ''}</div></span>` +
        (b.current ? '' : `<button type="button" class="btn small gtact" data-a="switch">Switch</button><button type="button" class="btn small gtact danger" data-a="delbr">Delete</button>`) + '</div>')
      .join('');
  }

  async function showDiff() {
    const box = $('gtDiff');
    if (!st.repo) return;
    if (!sel) { $('gtDiffTitle').textContent = ''; box.innerHTML = '<div class="hint" style="padding:12px">Pick a file to see what changed.</div>'; return; }
    $('gtDiffTitle').textContent = `${sel.path} · ${sel.kind === 'staged' ? 'staged (will be committed)' : sel.kind === 'untracked' ? 'new file, not tracked yet' : 'not staged'}`;
    let text = '';
    try { text = await g<string>('diff', { path: sel.path, kind: sel.kind }); } catch (e: any) { box.textContent = String(e?.message ?? e); return; }
    const file = splitDiff(text)[0];
    if (!file) { box.innerHTML = '<div class="hint" style="padding:12px">No differences to show.</div>'; return; }
    if (file.binary || !file.hunks.length) { box.innerHTML = `<pre class="gtpre">${colorLines(file.head.trim())}</pre>`; return; }
    const canHunk = sel.kind !== 'untracked';
    box.innerHTML = file.hunks.map((h, i) => `<div class="gthunk" data-i="${i}"><div class="gthead"><span class="hint">${esc(h.header)}</span><span class="spacer"></span><span class="hint">+${h.add} −${h.del}</span>${canHunk ? `<button type="button" class="btn small gtact" data-a="${sel!.kind === 'staged' ? 'unhunk' : 'hunk'}">${sel!.kind === 'staged' ? 'Unstage this piece' : 'Stage this piece'}</button>` : ''}</div><pre class="gtpre">${colorLines(h.text.split('\n').slice(1).join('\n').replace(/\n$/, ''))}</pre></div>`).join('');
  }

  async function showLog() {
    const box = $('gtLog');
    box.innerHTML = '<div class="hint" style="padding:12px">Loading…</div>';
    try {
      const l = await g<Commit[]>('log', { n: 60 });
      box.innerHTML = l.map((c) => `<button type="button" class="gtcm" data-h="${esc(c.hash)}"><b>${esc(c.subject)}</b><div class="hint">${esc(c.short)} · ${esc(c.author)} · ${esc(c.date)}</div></button>`).join('') || '<div class="hint" style="padding:12px">No commits yet.</div>';
    } catch (e: any) { box.textContent = String(e?.message ?? e); }
  }

  async function preparePr() {
    try {
      const info = await g<{ base: string; remote: string; head: string; url: string | null }>('prInfo');
      if (!$<HTMLInputElement>('gtBase').value) $<HTMLInputElement>('gtBase').value = info.base;
      $('gtHead').textContent = info.head || '(no branch)';
      $<HTMLButtonElement>('gtOpenPr').disabled = !info.url;
      $<HTMLButtonElement>('gtOpenPr').dataset.url = info.url ?? '';
      $('gtPrHint').textContent = info.url ? 'Push this branch first, then open the page: it starts the pull request for you to finish.' : info.remote ? 'Opening a pull request page works for GitHub and GitLab. Copy the text below instead.' : 'This repository has no remote yet.';
    } catch (e: any) { $('gtPrHint').textContent = String(e?.message ?? e); }
  }

  function setTab(t: 'diff' | 'log' | 'pr') {
    tab = t;
    document.querySelectorAll<HTMLElement>('#gitDlg .gttabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
    $('gtDiffPane').hidden = t !== 'diff';
    $('gtLogPane').hidden = t !== 'log';
    $('gtPrPane').hidden = t !== 'pr';
    if (t === 'log') void showLog();
    if (t === 'pr') void preparePr();
  }

  async function refresh() {
    try {
      st = await g<St>('status');
    } catch (e: any) { $('gtNone').hidden = false; $('gtNone').textContent = String(e?.message ?? e); $('gtMain').hidden = true; return; }
    $('gtNone').hidden = st.repo;
    $('gtMain').hidden = !st.repo;
    $('gtBar').hidden = !st.repo;
    if (!st.repo) { $('gtNone').innerHTML = 'This folder is not a git repository yet.<div class="row"><button type="button" class="btn primary" id="gtInit">Create a repository here</button></div>'; $('gtInit').onclick = () => void act('Create repository', async () => { await g('init'); }); return; }
    try { branches = await g<Branch[]>('branches'); } catch { branches = []; }
    if (sel && !st.files.some((f) => f.path === sel!.path && ((sel!.kind === 'staged' && f.staged) || (sel!.kind !== 'staged' && f.unstaged)))) sel = null;
    renderTop();
    renderFiles();
    renderBranches();
    if (tab === 'diff') await showDiff();
    deps.refreshTree();
  }

  async function open() {
    $<HTMLDialogElement>('gitDlg').showModal();
    sel = null;
    setTab('diff');
    await refresh();
    if (st.repo) {
      const first = st.files.find((f) => f.staged) ?? st.files[0];
      if (first) { sel = { path: first.path, kind: first.staged && !first.unstaged ? 'staged' : first.unstaged === 'untracked' ? 'untracked' : first.staged ? 'staged' : 'unstaged' }; renderFiles(); await showDiff(); }
    }
  }

  function wire() {
    const dlg = $<HTMLDialogElement>('gitDlg');
    $('gitBtn').onclick = () => void open();
    $('gitClose').onclick = () => dlg.close();
    $('gtRefresh').onclick = () => void act('Refresh', async () => {});
    $('gtFetch').onclick = () => void act('Fetch', async () => say(await g('fetch')));
    $('gtPull').onclick = () => void act('Pull', async () => say(await g('pull')));
    $('gtPush').onclick = () => void act('Push', async () => say(await g('push')));
    $('gtStageAll').onclick = () => void act('Stage', async () => { await g('stage'); });
    $('gtUnstageAll').onclick = () => void act('Unstage', async () => { await g('unstage'); });
    $<HTMLSelectElement>('gtBranch').onchange = (e) => {
      const v = (e.target as HTMLSelectElement).value;
      const remote = v.startsWith('remote:');
      void act('Switch branch', async () => { say(await g('checkout', { name: remote ? v.slice(7) : v, remote })); });
    };
    $('gtNewBtn').onclick = () => {
      const name = $<HTMLInputElement>('gtNewName').value.trim();
      if (!name) { $('gtNewRow').hidden = !$('gtNewRow').hidden; $('gtNewName').focus(); return; }
      void act('New branch', async () => { say(await g('createBranch', { name })); $<HTMLInputElement>('gtNewName').value = ''; $('gtNewRow').hidden = true; });
    };
    $('gtNewName').addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') $('gtNewBtn').click(); });

    const fileClick = (e: Event) => {
      const t = e.target as HTMLElement;
      const row = t.closest<HTMLElement>('.gtfile');
      if (!row) return;
      const path = row.dataset.path!;
      const kind = row.dataset.kind as 'staged' | 'unstaged' | 'untracked';
      const a = t.closest<HTMLElement>('[data-a]')?.dataset.a;
      if (a === 'stage') return void act('Stage', async () => { await g('stage', { paths: [path] }); });
      if (a === 'unstage') return void act('Unstage', async () => { await g('unstage', { paths: [path] }); });
      if (a === 'discard') {
        const b = t.closest<HTMLButtonElement>('button')!;
        if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Really discard?'; setTimeout(() => { if (b.isConnected) { b.dataset.sure = ''; b.textContent = 'Discard'; } }, 4000); return; }
        return void act('Discard', async () => { await g('discard', { path }); say(`Discarded changes to ${path}`); });
      }
      sel = { path, kind };
      setTab('diff');
      renderFiles();
      void showDiff();
    };
    $('gtStaged').addEventListener('click', fileClick);
    $('gtChanges').addEventListener('click', fileClick);

    $('gtDiff').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-a]');
      const h = (e.target as HTMLElement).closest<HTMLElement>('.gthunk');
      if (!b || !h || !sel) return;
      const mode = b.dataset.a === 'unhunk' ? 'unstage' : 'stage';
      const path = sel.path;
      void act('Stage piece', async () => { await g('hunks', { path, indexes: [Number(h.dataset.i)], mode }); });
    });

    $('gtBranchList').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-a]');
      const row = (e.target as HTMLElement).closest<HTMLElement>('.gtbr');
      if (!b || !row) return;
      const name = row.dataset.name!;
      if (b.dataset.a === 'switch') return void act('Switch branch', async () => { say(await g('checkout', { name })); });
      if (b.dataset.a === 'delbr') {
        const force = b.dataset.force === '1';
        if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Really delete?'; setTimeout(() => { if (b.isConnected && b.dataset.force !== '1') { b.dataset.sure = ''; b.textContent = 'Delete'; } }, 4000); return; }
        void (async () => {
          try { say(await g('deleteBranch', { name, force })); await refresh(); } catch (err: any) {
            const m = String(err?.message ?? err);
            if (/not fully merged/i.test(m)) { b.dataset.force = '1'; b.dataset.sure = '1'; b.textContent = 'Not merged. Delete anyway?'; say('That branch has commits that are not merged anywhere else.'); } else say(m.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
          }
        })();
      }
    });

    $('gtDraft').onclick = () => {
      const btn = $<HTMLButtonElement>('gtDraft');
      btn.textContent = 'Writing…';
      void act('Draft message', async () => {
        const m = await g<{ subject: string; body: string }>('draftCommit');
        $<HTMLTextAreaElement>('gtMsg').value = m.subject + (m.body ? `\n\n${m.body}` : '');
      }, false).finally(() => (btn.textContent = 'Draft with AI'));
    };
    $('gtCommit').onclick = () => {
      const message = $<HTMLTextAreaElement>('gtMsg').value;
      const amend = $<HTMLInputElement>('gtAmend').checked;
      void act('Commit', async () => { say(await g('commit', { message, amend })); $<HTMLTextAreaElement>('gtMsg').value = ''; $<HTMLInputElement>('gtAmend').checked = false; });
    };

    document.querySelectorAll<HTMLElement>('#gitDlg .gttabs button').forEach((b) => (b.onclick = () => setTab(b.dataset.t as 'diff' | 'log' | 'pr')));
    $('gtLog').addEventListener('click', async (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('.gtcm');
      if (!b) return;
      document.querySelectorAll('#gtLog .gtcm').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      let next = b.nextElementSibling;
      if (next?.classList.contains('gtshow')) { next.remove(); return; }
      try {
        const text = await g<string>('show', { hash: b.dataset.h });
        const pre = document.createElement('pre');
        pre.className = 'gtpre gtshow';
        pre.innerHTML = colorLines(text);
        b.after(pre);
      } catch (err: any) { say(String(err?.message ?? err)); }
    });

    $('gtDraftPr').onclick = () => {
      const btn = $<HTMLButtonElement>('gtDraftPr');
      btn.textContent = 'Writing…';
      const base = $<HTMLInputElement>('gtBase').value.trim();
      void act('Draft pull request', async () => {
        const r = await g<{ title: string; body: string }>('draftPr', { base });
        $<HTMLInputElement>('gtPrTitle').value = r.title;
        $<HTMLTextAreaElement>('gtPrBody').value = r.body;
      }, false).finally(() => (btn.textContent = 'Draft with AI'));
    };
    const copy = async (id: string) => { try { await navigator.clipboard.writeText($<HTMLInputElement>(id).value); say('Copied'); } catch { say('Could not copy'); } };
    $('gtCopyTitle').onclick = () => void copy('gtPrTitle');
    $('gtCopyBody').onclick = () => void copy('gtPrBody');
    $('gtOpenPr').onclick = (e) => { const u = (e.currentTarget as HTMLElement).dataset.url; if (u) void jarvin.openExternal(u); };
  }

  return { wire, open };
}
