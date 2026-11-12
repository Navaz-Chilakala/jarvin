import * as monaco from 'monaco-editor';
import { changeAtLine, revertHunkText, type LineChange } from '../shared/hunks';

export interface ReviewFile { path: string; status: 'created' | 'modified' | 'deleted' }
export interface ReviewApi {
  baseline(id: string, path: string): Promise<string | null>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<unknown>;
  rewindFile(id: string, path: string, force: boolean): Promise<{ ok: boolean; conflicts: string[]; error?: string }>;
  langFor(path: string): string;
  /** Called when the dialog closes so the app can refresh the tree and open tabs. */
  onClose(changed: boolean): void;
  toast(msg: string): void;
}

/**
 * Cursor-style "review all changes" screen: every file the agent touched, a diff with the model's version on the right,
 * and per-change Revert. Edits made here are written straight to disk.
 */
export function createReview(api: ReviewApi) {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const dlg = $<HTMLDialogElement>('reviewDlg');
  let diff: monaco.editor.IStandaloneDiffEditor | null = null;
  let files: ReviewFile[] = [];
  let cpId = '';
  let active = -1;
  let cur = 0;
  const reviewed = new Set<string>();
  const gone = new Set<string>();
  let orig: monaco.editor.ITextModel | null = null;
  let mod: monaco.editor.ITextModel | null = null;
  let changed = false;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let loading = false;
  let inline = false;
  let decos: monaco.editor.IEditorDecorationsCollection | null = null;

  const changes = (): LineChange[] => (diff?.getLineChanges() ?? []) as LineChange[];

  const renderFiles = () => {
    const box = $('rvFiles');
    box.innerHTML = '';
    files.forEach((f, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      const isGone = gone.has(f.path);
      row.className = 'rv-file' + (i === active ? ' on' : '') + (reviewed.has(f.path) ? ' done' : '') + (isGone ? ' gone' : '');
      const name = f.path.split('/').pop() ?? f.path;
      const dir = f.path.slice(0, f.path.length - name.length).replace(/\/$/, '');
      row.innerHTML = `<span class="rv-tick">${reviewed.has(f.path) ? '✓' : ''}</span><span class="rv-fn"></span><span class="rv-st ${f.status}">${isGone ? 'reverted' : f.status === 'created' ? 'new' : f.status === 'deleted' ? 'deleted' : 'edited'}</span>`;
      const fn = row.querySelector<HTMLElement>('.rv-fn')!;
      fn.textContent = name;
      if (dir) { const d = document.createElement('small'); d.textContent = ' ' + dir; fn.appendChild(d); }
      row.title = f.path;
      row.onclick = () => void open(i);
      box.appendChild(row);
    });
    const left = files.filter((f) => !gone.has(f.path) && !reviewed.has(f.path)).length;
    $('rvCount').textContent = `${files.length} file${files.length === 1 ? '' : 's'} · ${left} left to review`;
  };

  const flushSave = async () => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = undefined; }
    if (!mod || active < 0 || loading) return;
    const f = files[active];
    if (!f || gone.has(f.path)) return;
    try {
      await api.write(f.path, mod.getValue());
      changed = true;
      $('rvSaved').textContent = 'Saved';
    } catch (e) {
      $('rvSaved').textContent = 'Save failed';
      api.toast(String((e as Error).message ?? e));
    }
  };
  const scheduleSave = () => {
    $('rvSaved').textContent = 'Saving…';
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void flushSave(), 450);
  };

  const mark = () => {
    const list = changes();
    $('rvInfo').textContent = list.length ? `Change ${Math.min(cur, list.length - 1) + 1} of ${list.length}` : files[active] && gone.has(files[active].path) ? 'File reverted' : 'No differences';
    decos?.clear();
    if (!diff || !list.length) return;
    const c = list[Math.min(cur, list.length - 1)];
    const s = c.modifiedStartLineNumber || 1;
    const e = c.modifiedEndLineNumber === 0 ? s : c.modifiedEndLineNumber;
    decos = decos ?? diff.getModifiedEditor().createDecorationsCollection();
    decos.set([{ range: new monaco.Range(s, 1, e, 1), options: { isWholeLine: true, linesDecorationsClassName: 'rv-cur' } }]);
  };

  const goto = (i: number) => {
    const list = changes();
    if (!list.length || !diff) return;
    cur = Math.max(0, Math.min(list.length - 1, i));
    const c = list[cur];
    const line = Math.max(1, c.modifiedStartLineNumber || 1);
    diff.getModifiedEditor().revealLineInCenter(line);
    diff.getModifiedEditor().setPosition({ lineNumber: line, column: 1 });
    mark();
  };

  const open = async (i: number) => {
    if (i < 0 || i >= files.length) return;
    await flushSave();
    active = i;
    cur = 0;
    const f = files[i];
    loading = true;
    $('rvPath').textContent = f.path;
    $('rvSaved').textContent = '';
    renderFiles();
    const old = (await api.baseline(cpId, f.path)) ?? '';
    let now = '';
    try { now = await api.read(f.path); } catch { /* removed or binary */ }
    if (!diff) {
      diff = monaco.editor.createDiffEditor($('rvEditor'), {
        automaticLayout: true,
        renderSideBySide: !inline,
        originalEditable: false,
        readOnly: false,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 13,
        ignoreTrimWhitespace: false,
        renderOverviewRuler: true,
      });
      diff.onDidUpdateDiff(() => { if (!loading) mark(); else mark(); });
    }
    const lang = api.langFor(f.path);
    const lm = orig, rm = mod;
    orig = monaco.editor.createModel(old, lang);
    mod = monaco.editor.createModel(now, lang);
    diff.setModel({ original: orig, modified: mod });
    lm?.dispose();
    rm?.dispose();
    mod.onDidChangeContent(() => { if (!loading) scheduleSave(); });
    decos = null;
    loading = false;
    const revertBtn = $<HTMLButtonElement>('rvRevert');
    revertBtn.textContent = f.status === 'created' ? 'Delete new file' : f.status === 'deleted' ? 'Restore file' : 'Revert file';
    $('rvReviewed').textContent = reviewed.has(f.path) ? 'Unmark reviewed' : 'Mark reviewed';
    setTimeout(() => { mark(); if (changes().length) goto(0); }, 250);
  };

  const nextFile = async () => {
    for (let k = 1; k <= files.length; k++) {
      const j = (active + k) % files.length;
      if (!gone.has(files[j].path) && !reviewed.has(files[j].path)) { await open(j); return true; }
    }
    return false;
  };

  const close = async () => {
    await flushSave();
    if (dlg.open) dlg.close();
  };

  // ---- buttons ----
  $('rvClose').onclick = () => void close();
  $('rvNext').onclick = () => {
    const list = changes();
    if (cur >= list.length - 1) void nextFile(); else goto(cur + 1);
  };
  $('rvPrev').onclick = () => goto(cur - 1);
  $('rvMode').onclick = () => {
    inline = !inline;
    diff?.updateOptions({ renderSideBySide: !inline });
    $('rvMode').textContent = inline ? 'Side by side' : 'Inline';
  };
  $('rvRevertHunk').onclick = () => {
    if (!diff || !mod || !orig) return;
    const list = changes();
    if (!list.length) return;
    const c = list[Math.min(cur, list.length - 1)];
    const next = revertHunkText(orig.getValue(), mod.getValue(), c);
    mod.pushEditOperations([], [{ range: mod.getFullModelRange(), text: next }], () => null);
    setTimeout(() => { mark(); if (changes().length) goto(Math.min(cur, changes().length - 1)); }, 200);
  };
  $('rvReviewed').onclick = () => {
    const f = files[active];
    if (!f) return;
    if (reviewed.has(f.path)) reviewed.delete(f.path); else reviewed.add(f.path);
    renderFiles();
    $('rvReviewed').textContent = reviewed.has(f.path) ? 'Unmark reviewed' : 'Mark reviewed';
    if (reviewed.has(f.path)) void nextFile();
  };
  $('rvRevert').onclick = async () => {
    const f = files[active];
    if (!f || !mod || !orig) return;
    if (f.status === 'created') {
      if (!confirm(`Delete the new file ${f.path}?`)) return;
      let r = await api.rewindFile(cpId, f.path, false);
      if (!r.ok && r.conflicts.length) r = await api.rewindFile(cpId, f.path, true);
      if (!r.ok) { api.toast(r.error ?? 'Could not delete the file.'); return; }
      gone.add(f.path);
      changed = true;
      renderFiles();
      mod.setValue('');
      $('rvInfo').textContent = 'File deleted';
      return;
    }
    mod.pushEditOperations([], [{ range: mod.getFullModelRange(), text: orig.getValue() }], () => null);
    setTimeout(mark, 200);
  };
  $('rvAcceptAll').onclick = () => void close();
  dlg.addEventListener('close', () => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = undefined; }
    const m = mod, o = orig;
    diff?.setModel(null);
    m?.dispose(); o?.dispose();
    mod = null; orig = null;
    decos = null;
    api.onClose(changed);
  });
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'F7') { e.preventDefault(); if (e.shiftKey) goto(cur - 1); else $('rvNext').click(); }
  });

  return {
    async show(id: string, list: ReviewFile[], startPath?: string) {
      cpId = id;
      files = list;
      reviewed.clear();
      gone.clear();
      changed = false;
      active = -1;
      dlg.showModal();
      renderFiles();
      const at = Math.max(0, startPath ? list.findIndex((f) => f.path === startPath) : 0);
      await open(at);
    },
  };
}
