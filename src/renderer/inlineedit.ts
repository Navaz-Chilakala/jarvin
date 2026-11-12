import * as monaco from 'monaco-editor';

export interface InlineEditApi {
  edit(req: { code: string; instruction: string; language: string; path?: string; before?: string; after?: string }): Promise<{ text: string; error?: string }>;
  path(): string | undefined;
  toast(msg: string): void;
}

type Phase = 'input' | 'loading' | 'preview';

interface Session {
  phase: Phase;
  startLine: number;
  original: string;
  range: monaco.Range; // range of the text that is in the document now (selection, or the applied replacement)
  applied: boolean;
  instruction: string;
  token: number;
  widget: monaco.editor.IContentWidget;
  dom: HTMLElement;
  zoneId?: string;
  decos?: monaco.editor.IEditorDecorationsCollection;
  readOnlyBefore: boolean;
  model: monaco.editor.ITextModel;
}

/**
 * Cursor-style Ctrl+K: a small prompt box over the selection. The answer is applied in place, the old code is shown as a red
 * block above the new green code, and Enter accepts / Esc rejects (or Retry asks again).
 */
export function installInlineEdit(ed: monaco.editor.IStandaloneCodeEditor, api: InlineEditApi) {
  let session = null as Session | null;
  let tokenSeq = 0;

  const close = (restoreFocus = true) => {
    const s = session;
    if (!s) return;
    session = null;
    s.token = -1;
    ed.removeContentWidget(s.widget);
    if (s.zoneId) ed.changeViewZones((acc) => acc.removeZone(s.zoneId!));
    s.decos?.clear();
    ed.updateOptions({ readOnly: s.readOnlyBefore });
    if (restoreFocus) ed.focus();
  };

  const revert = () => {
    const s = session;
    if (!s || !s.applied) return;
    s.model.pushEditOperations([], [{ range: s.range, text: s.original }], () => null);
    s.applied = false;
    const start = s.range.getStartPosition();
    const end = s.model.getPositionAt(s.model.getOffsetAt(start) + s.original.length);
    s.range = monaco.Range.fromPositions(start, end);
    if (s.zoneId) { const id = s.zoneId; ed.changeViewZones((acc) => acc.removeZone(id)); s.zoneId = undefined; }
    s.decos?.clear();
  };

  const showOriginalZone = (s: Session) => {
    if (!s.original.trim()) return;
    const fi = ed.getOption(monaco.editor.EditorOption.fontInfo);
    const node = document.createElement('div');
    node.className = 'ie-orig';
    const pre = document.createElement('pre');
    pre.textContent = s.original.replace(/\n$/, '');
    pre.style.cssText = `margin:0;font-family:${fi.fontFamily};font-size:${fi.fontSize}px;line-height:${fi.lineHeight}px;white-space:pre;padding-left:0;`;
    node.appendChild(pre);
    const lines = s.original.replace(/\n$/, '').split('\n').length;
    ed.changeViewZones((acc) => {
      s.zoneId = acc.addZone({ afterLineNumber: s.startLine - 1, heightInLines: lines, domNode: node, suppressMouseDown: true });
    });
  };

  const run = async (s: Session) => {
    const my = ++tokenSeq;
    s.token = my;
    setPhase(s, 'loading');
    const model = s.model;
    const before = model.getValueInRange(new monaco.Range(Math.max(1, s.startLine - 60), 1, s.startLine, 1));
    const endLine = s.range.endLineNumber;
    const after = model.getValueInRange(new monaco.Range(Math.min(model.getLineCount(), endLine + 1), 1, Math.min(model.getLineCount(), endLine + 40), model.getLineMaxColumn(Math.min(model.getLineCount(), endLine + 40))));
    let res: { text: string; error?: string };
    try {
      res = await api.edit({ code: s.original, instruction: s.instruction, language: model.getLanguageId(), path: api.path(), before, after });
    } catch (e: any) {
      res = { text: '', error: String(e?.message ?? e) };
    }
    if (session !== s || s.token !== my) return; // cancelled meanwhile
    if (res.error || (!res.text && s.original.trim())) {
      setPhase(s, 'input', res.error || 'No change returned.');
      return;
    }
    // Apply in place.
    const startPos = s.range.getStartPosition();
    model.pushEditOperations([], [{ range: s.range, text: res.text }], () => null);
    const endPos = model.getPositionAt(model.getOffsetAt(startPos) + res.text.length);
    s.range = monaco.Range.fromPositions(startPos, endPos);
    s.applied = true;
    const lastLine = res.text.endsWith('\n') && endPos.column === 1 ? endPos.lineNumber - 1 : endPos.lineNumber;
    s.decos = s.decos ?? ed.createDecorationsCollection();
    s.decos.set([{ range: new monaco.Range(startPos.lineNumber, 1, Math.max(startPos.lineNumber, lastLine), 1), options: { isWholeLine: true, className: 'ie-added', linesDecorationsClassName: 'ie-added-gutter' } }]);
    showOriginalZone(s);
    ed.revealRangeInCenterIfOutsideViewport(s.range);
    setPhase(s, 'preview');
  };

  const setPhase = (s: Session, phase: Phase, note?: string) => {
    s.phase = phase;
    const input = s.dom.querySelector<HTMLInputElement>('.ie-input')!;
    const state = s.dom.querySelector<HTMLElement>('.ie-state')!;
    const bar = s.dom.querySelector<HTMLElement>('.ie-bar')!;
    input.disabled = phase === 'loading';
    input.hidden = phase === 'preview';
    bar.hidden = phase !== 'preview';
    state.className = 'ie-state' + (note ? ' err' : '');
    state.textContent = phase === 'loading' ? 'Thinking…' : note ?? (phase === 'preview' ? 'Review the change' : '');
    ed.layoutContentWidget(s.widget);
    if (phase === 'input') requestAnimationFrame(() => { input.focus(); input.select(); });
    if (phase === 'preview') requestAnimationFrame(() => bar.querySelector<HTMLButtonElement>('.ie-acc')?.focus());
  };

  const open = () => {
    if (session) { (session.dom.querySelector<HTMLElement>('.ie-input:not([hidden])') ?? session.dom).focus(); return; }
    const model = ed.getModel();
    const sel = ed.getSelection();
    if (!model || !sel) return;
    // Work on whole lines when something is selected; with no selection we generate at the cursor.
    let range: monaco.Range;
    if (sel.isEmpty()) {
      range = new monaco.Range(sel.startLineNumber, sel.startColumn, sel.startLineNumber, sel.startColumn);
    } else {
      const endLine = sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber ? sel.endLineNumber - 1 : sel.endLineNumber;
      range = new monaco.Range(sel.startLineNumber, 1, endLine, model.getLineMaxColumn(endLine));
    }
    const original = model.getValueInRange(range);
    const dom = document.createElement('div');
    dom.className = 'ie-widget';
    dom.innerHTML = '<div class="ie-row"><span class="ie-spark">✦</span><input class="ie-input" spellcheck="false" /><span class="ie-state"></span></div><div class="ie-bar" hidden><button type="button" class="ie-acc">Accept <kbd>↵</kbd></button><button type="button" class="ie-retry">Retry</button><button type="button" class="ie-rej">Reject <kbd>Esc</kbd></button></div>';
    const input = dom.querySelector<HTMLInputElement>('.ie-input')!;
    input.placeholder = original ? 'Describe how to change the selected code…' : 'Describe the code to write here…';
    const widget: monaco.editor.IContentWidget = {
      getId: () => 'jarvin.inlineedit',
      getDomNode: () => dom,
      getPosition: () => {
        const P = monaco.editor.ContentWidgetPositionPreference;
        // While reviewing, sit under the new code so the old (red) and new (green) blocks stay visible.
        if (session?.phase === 'preview') return { position: { lineNumber: Math.max(session.startLine, session.range.endLineNumber - (session.range.endColumn === 1 && session.range.endLineNumber > session.startLine ? 1 : 0)), column: 1 }, preference: [P.BELOW, P.ABOVE] };
        return { position: { lineNumber: session?.startLine ?? range.startLineNumber, column: 1 }, preference: [P.ABOVE, P.BELOW] };
      },
      allowEditorOverflow: true,
    };
    const s: Session = { phase: 'input', startLine: range.startLineNumber, original, range, applied: false, instruction: '', token: 0, widget, dom, readOnlyBefore: !!ed.getOption(monaco.editor.EditorOption.readOnly), model };
    session = s;
    ed.updateOptions({ readOnly: true });
    ed.addContentWidget(widget);

    dom.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); if (s.phase === 'preview') revert(); close(); }
      else if (e.key === 'Enter' && s.phase === 'input') {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        s.instruction = text;
        void run(s);
      } else if (e.key === 'Enter' && s.phase === 'preview' && !(e.target as HTMLElement).matches('.ie-retry, .ie-rej')) { e.preventDefault(); close(); }
    });
    dom.addEventListener('mousedown', (e) => e.stopPropagation());
    dom.querySelector('.ie-acc')!.addEventListener('click', () => close());
    dom.querySelector('.ie-rej')!.addEventListener('click', () => { revert(); close(); });
    dom.querySelector('.ie-retry')!.addEventListener('click', () => { revert(); setPhase(s, 'input'); });
    setPhase(s, 'input');
  };

  // Ctrl+K is also Monaco's chord prefix, so intercept it before the keybinding service sees it.
  ed.onKeyDown((e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.keyCode === monaco.KeyCode.KeyK) {
      e.preventDefault();
      e.stopPropagation();
      open();
    }
  });
  ed.addAction({ id: 'jarvin-inline-edit', label: 'Jarvin: Edit with AI (Ctrl+K)', keybindings: [monaco.KeyMod.Alt | monaco.KeyMod.Shift | monaco.KeyCode.KeyK], contextMenuGroupId: 'navigation', contextMenuOrder: 0, run: () => open() });
  // Switching files while a suggestion is pending keeps it (accepts it) instead of leaving a dangling zone.
  ed.onDidChangeModel(() => { if (session) close(false); });
  return { open, isOpen: () => !!session };
}
