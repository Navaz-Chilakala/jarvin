import { describeTool } from './tool-labels';
import { looksLikePlan } from '../shared/plan';
import type { AgentEvent, CheckpointSummary, McpStatus, Mode, PermissionLists, PermissionRule, Settings, TreeEntry } from '../shared/types';
import { icon, fileIcon } from './icons';
import { md, esc, highlight } from './markdown';
import { initTranscribe } from './transcribe';
import { createModelUi } from './modelui';
import { createMemoryUi } from './memoryui';
import { createTraceUi } from './traceui';
import { createImageUi } from './imageui';
import { createTasksUi } from './tasksui';
import { routineRequest, routineStepRequests } from '../shared/routines';
import { pickResumable, resumeRequest } from '../shared/run-journal';
import { proactiveSettings } from '../shared/proactive';
import { initProactive } from './proactive';
import { initVoiceTest } from './voicetest';
import { isImagePath } from '../shared/images';
import { createGitUi } from './gitui';
import { renderDiagrams } from './diagrams';
import { updateText, validUpdateUrl, type UpdateState } from '../shared/updatecfg';
import { isRemoteModelId, pickDefaultModel } from '../shared/models';
import { renderVerified } from './verifiedcard';
import { initVoiceMcp, refreshVoiceMcpPanel, wireVoiceMcpPanel } from './voicemcp';
import { initVoice, type VoiceActions, fillVoiceSettings, collectVoiceSettings, refreshVoiceStatus, renderVoiceHistory, wireHotkeyField } from './voiceui';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { SearchAddon } from 'xterm-addon-search';
import { WebLinksAddon } from 'xterm-addon-web-links';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const jarvin = window.jarvin;

document.body.classList.add(`plat-${jarvin.platform === 'win32' ? 'win' : jarvin.platform === 'darwin' ? 'mac' : 'linux'}`);
document.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => {
  el.outerHTML = icon(el.dataset.icon!, Number(el.dataset.size) || 17);
});

const msgs = $('messages');
const inner = $('inner');
const typing = $('typing');
const emptyEl = $('empty');
const input = $<HTMLTextAreaElement>('input');
(self as any).MonacoEnvironment = {
  getWorker: (_id: string, label: string) => {
    const opts = { type: 'module' } as WorkerOptions;
    switch (label) {
      case 'json': return new Worker('json.worker.js', opts);
      case 'css': return new Worker('css.worker.js', opts);
      case 'html': return new Worker('html.worker.js', opts);
      case 'typescript':
      case 'javascript': return new Worker('ts.worker.js', opts);
      default: return new Worker('editor.worker.js', opts);
    }
  },
};

import * as monaco from 'monaco-editor';
import { installInlineEdit } from './inlineedit';
import { createReview } from './review';
import { shouldAutocomplete } from '../shared/inline';
import { autoFixPrompt, countBySeverity, type Problem, type ProblemsResult } from '../shared/problems';

const sendBtn = $<HTMLButtonElement>('send');
const stopBtn = $<HTMLButtonElement>('stop');
const modelSel = $<HTMLSelectElement>('model');
const modeSel = $<HTMLSelectElement>('mode');
const code = $<HTMLTextAreaElement>('code');
const completeEl = $('complete');
let monacoEditor: monaco.editor.IStandaloneCodeEditor | null = null;
let editorModel: monaco.editor.ITextModel | null = null;
let updatingEditor = false;
function appThemeIsLight() {
  return (localStorage.getItem('jarvin-theme') || 'vs-dark') === 'vs';
}
function applyAppTheme(theme: string) {
  const light = theme === 'vs';
  document.body.classList.toggle('light', light);
  if (monacoEditor) monaco.editor.setTheme(light ? 'vs' : 'vs-dark');
  if (term) {
    term.options.theme = {
      background: light ? '#f8fafc' : '#0f172a',
      foreground: light ? '#18212f' : '#f8fafc',
      cursor: light ? '#0284c7' : '#67e8f9',
    };
    requestAnimationFrame(() => term?.focus());
  }
}
function langForPath(p: string) {
  const ext = p.split('.').pop()?.toLowerCase() ?? '';

  const map: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', json: 'json', css: 'css', scss: 'scss', html: 'html', htm: 'html', md: 'markdown', py: 'python', go: 'go', rs: 'rust', java: 'java', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', sh: 'shell', yml: 'yaml', yaml: 'yaml', xml: 'xml', sql: 'sql' };
  return map[ext] ?? 'plaintext';
}
let term: Terminal | null = null;
let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;

function appendSelectionToChat(instruction?: string) {
  if (!monacoEditor || !activeTab) return;
  const model = monacoEditor.getModel();
  const sel = monacoEditor.getSelection();
  if (!model || !sel || sel.isEmpty()) return;
  const code = model.getValueInRange(sel);
  const block = (instruction ? instruction + '\n\n' : '') +
    `[Selected code: ${activeTab.path} L${sel.startLineNumber}-${sel.endLineNumber}]\n\`\`\`${model.getLanguageId()}\n${code}\n\`\`\``;
  input.value = input.value.trim() ? input.value.trim() + '\n\n' + block : block;
  input.focus();
  autosize();
}
async function showCheckpointDiff(id: string, filePath: string) {
  ensureMonaco();
  const old = (await jarvin.checkpointBaseline(id, filePath)) ?? '';
  let current = '';
  try { current = await jarvin.readFile(filePath); } catch { /* created/deleted */ }
  if (!diffEditor) diffEditor = monaco.editor.createDiffEditor($('diffHost'), { automaticLayout: true, readOnly: true, minimap: { enabled: false } });
  const left = monaco.editor.createModel(old, langForPath(filePath));
  const right = monaco.editor.createModel(current, langForPath(filePath));
  diffEditor.setModel({ original: left, modified: right });
  $<HTMLDialogElement>('diffDlg').showModal();
}
function ensureMonaco() {
  if (monacoEditor) return;
  const host = $('monacoEditor');
  monacoEditor = monaco.editor.create(host, {
    automaticLayout: true,
    minimap: { enabled: true, side: 'right', scale: 1, showSlider: 'mouseover' },
    fontSize: 13.5,
    lineHeight: 20,
    scrollBeyondLastLine: false,
    wordWrap: 'off',
    tabSize: 2,
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: 'active', indentation: true },
    smoothScrolling: true,
    cursorSmoothCaretAnimation: 'on',
    fontLigatures: true,
    stickyScroll: { enabled: true, maxLineCount: 5 },
    theme: (localStorage.getItem('jarvin-theme') || 'vs-dark') === 'vs' ? 'vs' : 'vs-dark',
  });
  editorModel = monaco.editor.createModel('', 'plaintext');
  monacoEditor.setModel(editorModel);
  monacoEditor.addAction({
    id: 'jarvin-ai-complete',
    label: 'Jarvin AI Complete',
    keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.Backslash],
    run: async (ed) => {
      const model = ed.getModel();
      const pos = ed.getPosition();
      if (!model || !pos) return;
      const prefix = model.getValueInRange(new monaco.Range(1, 1, pos.lineNumber, pos.column));
      const suffix = model.getValueInRange(new monaco.Range(pos.lineNumber, pos.column, model.getLineCount(), model.getLineMaxColumn(model.getLineCount())));
      const out = await jarvin.codeComplete({ prefix, suffix, language: model.getLanguageId(), path: activeTab?.path, manual: true });
      if (!out) { toast('No suggestion'); return; }
      ed.executeEdits('jarvin-ai-complete', [{ range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column), text: out }]);
    },
  });
  if (new URLSearchParams(location.search).has('e2e')) (window as any).__ed = monacoEditor;
  installInlineEdit(monacoEditor, { edit: (req) => jarvin.codeEditSelection(req), path: () => activeTab?.path, toast: (m) => toast(m) });
  monacoEditor.addAction({ id: 'jarvin-add-selection-to-chat', label: 'Add Selection to Chat', contextMenuGroupId: 'navigation', run: () => appendSelectionToChat() });
  monacoEditor.addAction({ id: 'jarvin-explain-selection', label: 'Explain Selection', contextMenuGroupId: 'navigation', run: () => appendSelectionToChat('Explain this code:') });
  monacoEditor.addAction({ id: 'jarvin-fix-selection', label: 'Fix Selection', contextMenuGroupId: 'navigation', run: () => appendSelectionToChat('Fix this code:') });
  monacoEditor.addAction({ id: 'jarvin-tests-selection', label: 'Write Tests for Selection', contextMenuGroupId: 'navigation', run: () => appendSelectionToChat('Write tests for this code:') });
  try {
    monaco.languages.registerInlineCompletionsProvider('*', {
      provideInlineCompletions: async (model, position, _context, token) => {
        if (!model || !position || !settings?.autocomplete) return { items: [] };
        const line = model.getLineContent(position.lineNumber);
        if (!shouldAutocomplete(line.slice(0, position.column - 1), line.slice(position.column - 1))) return { items: [] };
        await new Promise((r) => setTimeout(r, 450)); // wait for a typing pause
        if (token.isCancellationRequested) return { items: [] };
        const prefix = model.getValueInRange(new monaco.Range(1, 1, position.lineNumber, position.column));
        const suffix = model.getValueInRange(new monaco.Range(position.lineNumber, position.column, model.getLineCount(), model.getLineMaxColumn(model.getLineCount())));
        let out = '';
        try { out = await jarvin.codeComplete({ prefix, suffix, language: model.getLanguageId(), path: activeTab?.path }); } catch { out = ''; }
        if (token.isCancellationRequested || !out) return { items: [] };
        return { items: [{ insertText: out, range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column) }] };
      },
      handleItemDidShow: () => {},
      disposeInlineCompletions: () => {},
    });
  } catch {
    /* inline completions not supported */
  }
  monacoEditor.onDidChangeModelContent(() => {
    if (!activeTab || updatingEditor || !editorModel) return;
    activeTab.content = editorModel.getValue();
    if (!activeTab.dirty) {
      activeTab.dirty = true;
      renderTabs();
      $('saveBtn').hidden = false;
    }
  });
}
let completeItems: { insert: string; label: string; desc?: string }[] = [];
const hl = $('hl');
const hlpre = $('hlpre');
const gutter = $('gutter');

interface Tab {
  path: string;
  content: string;
  dirty: boolean;
}

let settings: Settings;
const tabs: Tab[] = [];
let activeTab: Tab | null = null;
let includeActive = true;
let chatMessages: { role: 'user' | 'assistant'; content: string; images?: string[] }[] = [];
let sessionQuery = '';
let showArchived = false;
let attachedImages: string[] = [];
let attachedFiles: { name: string; content: string; kind?: 'browser' }[] = [];
function updateBrowserAttachment() {
  const count = attachedFiles.filter((f) => f.kind === 'browser').length;
  const button = $<HTMLButtonElement>('browserAttachment');
  button.hidden = count === 0;
  button.textContent = `${count} page${count === 1 ? '' : 's'} attached ×`;
}
let runHadWrites = false;
let lastCheckpointId = '';
let runFailed = false;
let userStopped = false;
let running = false;
let assistantSpeaking = false;
let assistantMicLevel = 0;
let assistantHearing = false;
let assistantLevelAt = 0;
let lastReply = '';
const expanded = new Set<string>();

const base = (p: string) => p.split('/').pop() ?? p;
const cleanErr = (e: any) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function toast(msg: string) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('out'), 2600);
  setTimeout(() => t.remove(), 3100);
}

/* ================= layout ================= */
const ui: { side: boolean; editor: boolean; sw: number; cw: number; mode: 'assistant' | 'code' } = { side: true, editor: true, sw: 260, cw: 460, mode: 'assistant' };
try {
  Object.assign(ui, JSON.parse(localStorage.getItem('jarvin.ui') ?? '{}'));
} catch {
  /* ignore */
}
if (ui.mode !== 'assistant' && ui.mode !== 'code') ui.mode = 'assistant';
const saveUi = () => {
  try {
    localStorage.setItem('jarvin.ui', JSON.stringify(ui));
  } catch {
    /* ignore */
  }
};
function applyLayout() {
  const assistant = ui.mode === 'assistant';
  const sideWidth = Math.min(ui.sw, Math.max(160, Math.floor(window.innerWidth * .23)));
  const chatWidth = Math.min(ui.cw, Math.max(300, Math.floor(window.innerWidth * .38)));
  document.body.classList.toggle('assistant-mode', assistant);
  $('app').style.gridTemplateColumns = assistant ? '0px 0px 0px 0px minmax(0,1fr)' : `${ui.side ? sideWidth : 0}px ${ui.side ? 4 : 0}px ${ui.editor ? 'minmax(0,1fr)' : '0px'} ${ui.editor ? 4 : 0}px ${ui.editor ? chatWidth + 'px' : 'minmax(0,1fr)'}`;
  $('tree').hidden = $('split1').hidden = assistant || !ui.side;
  $('editor').hidden = $('split2').hidden = assistant || !ui.editor;
  $('uiAssistant').setAttribute('aria-pressed', String(assistant));
  $('uiCode').setAttribute('aria-pressed', String(!assistant));
  $('emptyHeading').textContent = assistant ? 'How can I help?' : 'What should we build?';
  input.placeholder = assistant ? 'Ask Jarvin anything or describe a task…' : 'Ask Jarvin to build, fix, explain or run something… Use /commands and @file to attach files.';
  renderSuggestions();
  if (settings) wsLabel();
}
function setView(mode: 'assistant' | 'code') {
  ui.mode = mode;
  if (mode === 'code' && !ui.editor) ui.editor = true;
  applyLayout(); saveUi();
}
function drag(el: HTMLElement, fn: (x: number) => void) {
  el.onmousedown = (e) => {
    e.preventDefault();
    el.classList.add('drag');
    document.body.style.cursor = 'col-resize';
    const mv = (ev: MouseEvent) => fn(ev.clientX);
    const up = () => {
      document.removeEventListener('mousemove', mv);
      document.removeEventListener('mouseup', up);
      el.classList.remove('drag');
      document.body.style.cursor = '';
      saveUi();
    };
    document.addEventListener('mousemove', mv);
    document.addEventListener('mouseup', up);
  };
}
drag($('split1'), (x) => {
  ui.sw = Math.max(160, Math.min(480, x));
  applyLayout();
});
drag($('split2'), (x) => {
  ui.cw = Math.max(340, Math.min(window.innerWidth - 300, window.innerWidth - x));
  applyLayout();
});

/* ================= file tree ================= */
async function fill(container: HTMLElement, rel: string, depth: number) {
  let entries;
  try {
    entries = await jarvin.tree(rel);
  } catch {
    return;
  }
  for (const en of entries) {
    const row = document.createElement('div');
    row.className = 'node' + (en.path === activeTab?.path ? ' active' : '');
    row.style.paddingLeft = `${10 + depth * 14}px`;
    row.title = en.path;
    row.innerHTML = en.dir
      ? `<span class="chev">${icon(expanded.has(en.path) ? 'chevD' : 'chevR', 13)}</span><span class="fo">${icon('folder', 15)}</span><span class="nm">${esc(en.name)}</span>`
      : `<span class="chev"></span>${fileIcon(en.name)}<span class="nm">${esc(en.name)}</span>`;
    row.onclick = async () => {
      if (en.dir) {
        expanded.has(en.path) ? expanded.delete(en.path) : expanded.add(en.path);
        await refreshTree();
      } else await openFile(en.path);
    };
    row.oncontextmenu = (e) => {
      e.preventDefault();
      showTreeMenu(e.clientX, e.clientY, en);
    };
    container.appendChild(row);
    if (en.dir && expanded.has(en.path)) await fill(container, en.path, depth + 1);
  }
}

async function refreshTree() {
  const body = $('treeBody');
  if (!settings.workspace) {
    body.innerHTML = `<div class="noWs">No folder open<br><button class="btn primary small" id="treeOpen">Open Folder</button></div>`;
    $('treeOpen').onclick = () => void openWorkspace();
    return;
  }
  const frag = document.createElement('div');
  await fill(frag, '', 0);
  body.replaceChildren(...Array.from(frag.children));
}

function showTreeMenu(x: number, y: number, en: TreeEntry) {
  let menu = document.getElementById('treeCtx');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'treeCtx';
    menu.className = 'complete';
    menu.style.position = 'fixed';
    menu.style.width = '180px';
    document.body.appendChild(menu);
  }
  const dir = en.dir ? en.path : en.path.split('/').slice(0, -1).join('/');
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.innerHTML = `
    <div class="citem" data-a="newfile">New file…</div>
    <div class="citem" data-a="newfolder">New folder…</div>
    ${en.path ? `<div class="citem" data-a="rename">Rename…</div><div class="citem" data-a="delete">Delete</div>` : ''}
  `;
  menu.hidden = false;
  const hide = () => { menu!.hidden = true; document.removeEventListener('click', hide); };
  setTimeout(() => document.addEventListener('click', hide), 0);
  menu.querySelectorAll<HTMLElement>('.citem').forEach((el) => {
    el.onclick = async (ev) => {
      ev.stopPropagation();
      hide();
      try {
        if (el.dataset.a === 'newfile') {
          const name = prompt('New file name:', 'untitled.txt');
          if (!name) return;
          const rel = (dir ? dir + '/' : '') + name;
          await jarvin.writeFile(rel, '');
          if (dir) { /* expand parent */ }
        } else if (el.dataset.a === 'newfolder') {
          const name = prompt('New folder name:', 'newfolder');
          if (!name) return;
          await jarvin.makeDir((dir ? dir + '/' : '') + name);
        } else if (el.dataset.a === 'rename' && en.path) {
          const name = prompt('New name:', en.name);
          if (!name || name === en.name) return;
          const parent = en.path.split('/').slice(0, -1).join('/');
          await jarvin.movePath(en.path, (parent ? parent + '/' : '') + name);
        } else if (el.dataset.a === 'delete' && en.path) {
          if (!confirm(`Delete ${en.name}?`)) return;
          await jarvin.deletePath(en.path);
        }
      } catch (err) {
        toast(String((err as Error).message ?? err));
      }
      void refreshTree();
      void loadFiles(true);
    };
  });
}

/* ================= editor ================= */
function renderTabs() {
  $('tabs').replaceChildren(
    ...tabs.map((t) => {
      const d = document.createElement('div');
      d.className = 'tab' + (t === activeTab ? ' active' : '');
      d.title = t.path;
      d.innerHTML = `${fileIcon(t.path)}<span>${esc(base(t.path))}</span><button class="tclose" title="Close">${t.dirty ? '<span class="ddot"></span>' : icon('x', 12)}</button>`;
      d.onclick = () => activate(t);
      (d.querySelector('.tclose') as HTMLElement).onclick = (e) => {
        e.stopPropagation();
        closeTab(t);
      };
      return d;
    }),
  );
}

let paintRaf = 0;
function paintHl() {
  if (!activeTab) return;
  if (paintRaf) return;
  paintRaf = requestAnimationFrame(() => {
    paintRaf = 0;
    if (!activeTab) return;
    const v = code.value;
    hlpre.innerHTML = (v.length > 300000 ? esc(v) : highlight(v, activeTab.path)) + '\n';
    gutter.textContent = Array.from({ length: v.split('\n').length }, (_, i) => i + 1).join('\n');
  });
}

function paint() {
  ensureMonaco();
  const t = activeTab;
  $('edHost').hidden = !t;
  $('edEmpty').hidden = !!t;
  $('saveBtn').hidden = !t?.dirty;
  if (!t || !editorModel || !monacoEditor) return;
  updatingEditor = true;
  if (editorModel.getValue() !== t.content) editorModel.setValue(t.content);
  monaco.editor.setModelLanguage(editorModel, langForPath(t.path));
  updatingEditor = false;
  updateCtx();
}

function activate(t: Tab | null) {
  activeTab = t;
  includeActive = true;
  renderTabs();
  paint();
  applyMarkers();
  void refreshTree();
}

function closeTab(t: Tab) {
  if (t.dirty && !confirm(`Discard unsaved changes to ${base(t.path)}?`)) return;
  const i = tabs.indexOf(t);
  tabs.splice(i, 1);
  if (activeTab === t) activate(tabs[Math.min(i, tabs.length - 1)] ?? null);
  else renderTabs();
}

function revealLine(line: number) {
  if (!monacoEditor || !editorModel || line < 1) return;
  const max = editorModel.getLineCount();
  const target = Math.min(max, line);
  monacoEditor.setPosition({ lineNumber: target, column: 1 });
  monacoEditor.revealLineInCenter(target);
}
async function openPreview(target?: string) {
  const r = await jarvin.previewOpen(target);
  if (!r.ok && r.error) toast(r.error);
}
async function openFile(rel: string, line?: number) {
  if (isImagePath(rel)) { void imageUi.open(rel); return; }
  ensureMonaco();
  const ex = tabs.find((t) => t.path === rel);
  if (ex) { activate(ex); if (line) setTimeout(() => revealLine(line), 30); return; }
  try {
    const t: Tab = { path: rel, content: await jarvin.readFile(rel), dirty: false };
    tabs.push(t);
    activate(t);
    if (ui.mode !== 'code') setView('code');
    if (!ui.editor) {
      ui.editor = true;
      applyLayout();
    }
    if (line) setTimeout(() => revealLine(line), 30);
  } catch (e) {
    const m = cleanErr(e);
    toast(/binary/i.test(m) ? `Can't preview ${base(rel)} — binary file` : `Can't open ${base(rel)}: ${m}`);
  }
}

async function save(t: Tab | null = activeTab) {
  if (!t || !t.dirty) return;
  if (t === activeTab && editorModel) t.content = editorModel.getValue();
  await jarvin.writeFile(t.path, t.content);
  t.dirty = false;
  renderTabs();
  if (t === activeTab) $('saveBtn').hidden = true;
}
const saveAll = () => Promise.all(tabs.map((t) => save(t)));

async function reloadTabs() {
  for (const t of tabs) {
    if (t.dirty) continue;
    try {
      const c = await jarvin.readFile(t.path);
      if (c !== t.content) {
        t.content = c;
        if (t === activeTab) paint();
      }
    } catch {
      /* file removed or binary */
    }
  }
}

/* Monaco handles editing and highlighting; legacy textarea handlers disabled. */

/* ================= chat ================= */
let cur: HTMLElement | null = null;
let curBody: HTMLElement | null = null;
let curText = '';
let raf = 0;
let stick = true;
const raw = new WeakMap<HTMLElement, string>();
const toolRows = new Map<string, { el: HTMLElement; body: HTMLElement; name: string; args: any }>();

msgs.addEventListener('scroll', () => {
  stick = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 80;
});
const scrollEnd = () => {
  if (stick) msgs.scrollTop = msgs.scrollHeight;
};
function put(el: HTMLElement) {
  inner.insertBefore(el, typing);
  emptyEl.hidden = true;
  scrollEnd();
}
function updateTyping() {
  typing.hidden = !(running && !cur && !inner.querySelector('.tool.wait'));
  scrollEnd();
}
/** True once the current run has called a tool: Jarvin is doing a task, not only talking. */
let runUsedTools = false;
function setRunning(r: boolean) {
  if (r !== running) runUsedTools = false;
  running = r;
  sendBtn.hidden = r;
  stopBtn.hidden = !r;
  if (!r) endCur();
  updateTyping();
  publishAssistantState();
}

function publishAssistantState() {
  const micButton = $('mic');
  const handsFree = $('hfBtn').dataset.state;
  const mic = micButton.classList.contains('rec') ? 'recording' : micButton.classList.contains('busy') || handsFree === 'working' ? 'processing' : micButton.classList.contains('err') || handsFree === 'error' ? 'error' : handsFree === 'listening' ? 'listening' : handsFree === 'paused' || handsFree === 'starting' ? 'paused' : 'off';
  $('assistantPresence').textContent = running ? 'Working on your request' : mic === 'recording' ? 'Recording' : mic === 'processing' ? 'Processing voice' : mic === 'listening' ? 'Listening' : mic === 'error' ? 'Microphone needs attention' : mic === 'paused' ? 'Microphone paused' : 'Ready · mic off';
  jarvin.assistantState({ working: running, mic, speaking: assistantSpeaking, level: mic === 'listening' ? assistantMicLevel : 0, hearing: mic === 'listening' && assistantHearing });
}

function addUser(text: string, file: string | null, images?: string[], record = true) {
  const d = document.createElement('div');
  d.className = 'msg user';
  d.textContent = text;
  if (file) d.insertAdjacentHTML('beforeend', `<div class="uctx">${fileIcon(file)}${esc(base(file))}</div>`);
  if (images?.length) {
    for (const img of images) {
      const i = document.createElement('img');
      i.src = `data:image/png;base64,${img}`;
      i.style.maxWidth = '240px';
      i.style.maxHeight = '180px';
      i.style.borderRadius = '8px';
      i.style.marginTop = '6px';
      i.style.display = 'block';
      d.appendChild(i);
    }
  }
  if (record) chatMessages.push({ role: 'user', content: text, images });
  put(d);
}


function newBot() {
  const d = document.createElement('div');
  d.className = 'msg bot';
  d.innerHTML = `<div class="mbody"></div><div class="mactions"><button class="mcopy" type="button" title="Copy">${icon('copy', 14)}</button></div>`;
  put(d);
  cur = d;
  curBody = d.querySelector('.mbody');
  curText = '';
}
function renderCur() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    if (curBody) curBody.innerHTML = md(curText);
    scrollEnd();
  });
}
function endCur() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  if (cur && curBody) {
    curBody.innerHTML = md(curText);
    raw.set(cur, curText);
    void renderDiagrams(curBody, toast);
    void imageUi.hydrate(curBody);
  }
  cur = curBody = null;
  curText = '';
}

function diffHtml(oldS: string, newS: string): string {
  const rows = (s: string, c: string, p: string) => (s ? s.split('\n').slice(0, 80).map((l) => `<div class="${c}">${p} ${esc(l)}</div>`).join('') : '');
  return `<div class="diff">${rows(oldS, 'del', '-')}${rows(newS, 'add', '+')}</div>`;
}

function startTool(id: string, name: string, args: any) {
  if (['write_file', 'edit_file', 'apply_patch', 'delete_file', 'move_file', 'copy_file', 'delete_path', 'move_path'].includes(name)) runHadWrites = true;
  const d = describeTool(name, args);
  const el = document.createElement('div');
  el.className = 'tool run';
  el.innerHTML = `<div class="thead">${icon(d.i, 15)}<span class="tverb">${esc(d.v)}</span><span class="ttarget">${esc(d.t)}</span><span class="tact"></span><span class="tstate"><span class="spin"></span></span><span class="tchev">${icon('chevR', 14)}</span></div><div class="tbody"></div>`;
  const body = el.querySelector('.tbody') as HTMLElement;
  if (name === 'edit_file') body.innerHTML = diffHtml(String(args?.old_string ?? ''), String(args?.new_string ?? ''));
  else if (name === 'write_file') body.innerHTML = diffHtml('', String(args?.content ?? ''));
  else if (name === 'run_command') body.innerHTML = `<pre class="cmd">${esc(String(args?.command ?? ''))}</pre>`;
  else if (name.startsWith('mcp__')) body.innerHTML = `<pre class="tout" style="border-top:0">${esc(JSON.stringify(args, null, 2))}</pre>`;
  if (name === 'edit_file' || name === 'write_file') {
    const lines = (s: unknown) => (s ? String(s).split('\n').length : 0);
    const add = name === 'write_file' ? lines(args?.content) : lines(args?.new_string);
    const del = name === 'edit_file' ? lines(args?.old_string) : 0;
    el.querySelector('.tact')!.innerHTML = `<span class="stat add">+${add}</span>${del ? `<span class="stat del">−${del}</span>` : ''}`;
  }
  (el.querySelector('.thead') as HTMLElement).onclick = () => el.classList.toggle('open');
  toolRows.set(id, { el, body, name, args });
  put(el);
}

function renderPerms(lists: PermissionLists) {
  const box = $('permList');
  box.innerHTML = '';
  const label = (r: PermissionRule) => (r.match ? `${r.tool}: ${r.match}` : r.path ? `${r.tool}: ${r.path}` : r.tool);
  const section = (title: string, rules: PermissionRule[], kind: 'allow' | 'deny' | null, empty: string) => {
    const h = document.createElement('div');
    h.className = 'permsub';
    h.textContent = title;
    box.appendChild(h);
    if (!rules.length) {
      const e = document.createElement('div');
      e.className = 'hint';
      e.textContent = empty;
      box.appendChild(e);
    }
    rules.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'permrow';
      row.innerHTML = `<code>${esc(label(r))}</code>`;
      if (kind) {
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'btn small';
        x.textContent = 'Remove';
        x.onclick = async () => renderPerms(await jarvin.removePermission(kind, i));
        row.appendChild(x);
      } else {
        const t = document.createElement('span');
        t.className = 'hint';
        t.textContent = 'from the project';
        row.appendChild(t);
      }
      box.appendChild(row);
    });
  };
  section('Always allowed (no prompt)', lists.allow, 'allow', 'None yet. “Always allow” on an approval saves a rule here.');
  section('Always blocked', lists.deny, 'deny', 'None. Block a command like “git push” or a path like “secrets/**”.');
  if (lists.shared.length) section('Blocked by this project (.jarvin/permissions.json)', lists.shared, null, '');
}

function setupPermAdd() {
  const tool = $<HTMLInputElement>('paTool');
  const match = $<HTMLInputElement>('paMatch');
  const err = $('paErr');
  const hint = () => { match.placeholder = tool.value.trim() === 'run_command' ? 'Command prefix, e.g. npm test' : 'Path glob, e.g. src/** (blank = every path)'; };
  tool.oninput = hint;
  $('paAdd').onclick = async () => {
    err.hidden = true;
    const kind = $<HTMLSelectElement>('paKind').value as 'allow' | 'deny';
    const t = tool.value.trim();
    try {
      renderPerms(await jarvin.addPermission(kind, t === 'run_command' ? { tool: t, match: match.value } : { tool: t, path: match.value }));
      match.value = '';
    } catch (e) {
      err.hidden = false;
      err.textContent = String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    }
  };
}
setupPermAdd();

const pendingAppr = new Map<string, { tool: string; decide: (d: 'allow' | 'deny') => void }>();

async function askApproval(id: string, always?: string, summary?: string) {
  const r = toolRows.get(id);
  if (!r) return;
  r.el.classList.add('wait', 'open');
  r.el.querySelector('.tstate')!.innerHTML = '<span class="waitdot"></span>';
  if (summary) { const details = document.createElement('pre'); details.className = 'tout'; details.textContent = summary.slice(0, 4000); r.body.appendChild(details); }
  let patchContainer: HTMLElement | null = null;
  if (r.name === 'apply_patch') {
    const wrap = document.createElement('div');
    wrap.className = 'patchhunks';
    r.body.appendChild(wrap);
    patchContainer = wrap;
    void (async () => {
      let hunks: { key: string; path: string; type: string; oldText: string; newText: string }[] = [];
      try { hunks = await jarvin.patchHunks(String(r.args?.patch ?? '')); } catch { hunks = []; }
      if (!hunks.length) { wrap.remove(); patchContainer = null; return; }
      wrap.innerHTML = hunks.map((h) => `<label class="patchhunk"><input type="checkbox" checked data-key="${esc(h.key)}" /> <span>${esc(h.path)} (${esc(h.type)})</span>${diffHtml(h.oldText, h.newText)}</label>`).join('');
    })();
  }
  const bar = document.createElement('div');
  bar.className = 'tapprove';
  bar.innerHTML = '<span class="why">Needs your approval</span>';
  const mk = (label: string, d: 'allow' | 'always' | 'deny', cls: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn small ${cls}`;
    b.textContent = label;
    if (d === 'always' && always) b.title = `Saves a rule for this folder: ${always}`;
    b.onclick = () => decide(d);
    bar.appendChild(b);
  };
  const decide = async (d: 'allow' | 'always' | 'deny') => {
    if (!pendingAppr.delete(id)) return;
    let decision = d;
    let modifiedArgs: any;
    if (decision !== 'deny' && patchContainer) {
      const checked = Array.from(patchContainer.querySelectorAll<HTMLInputElement>('input[data-key]:checked')).map((cb) => String(cb.dataset.key));
      if (!checked.length) decision = 'deny';
      else {
        const total = patchContainer.querySelectorAll('input[data-key]').length;
        if (checked.length < total) {
          try { modifiedArgs = { patch: await jarvin.patchFilter(String(r.args?.patch ?? ''), checked) }; } catch { /* keep original */ }
        }
      }
    }
    r.el.classList.remove('wait');
    r.el.querySelector('.tstate')!.innerHTML = '<span class="spin"></span>';
    bar.innerHTML = `<span class="res">${decision === 'deny' ? 'Denied' : decision === 'always' ? `Approved · always allow ${esc(always ?? r.name)} in this folder` : 'Approved'}</span>`;
    void jarvin.approve(id, decision, modifiedArgs);
    updateTyping();
  };
  pendingAppr.set(id, { tool: r.name, decide: (d) => decide(d) });
  mk('Deny', 'deny', '');
  if (always) mk('Always allow', 'always', '');
  mk('Allow', 'allow', 'primary');
  r.body.appendChild(bar);
  updateTyping();
}

function liveTool(id: string, text: string) {
  const r = toolRows.get(id);
  if (!r) return;
  let pre = r.body.querySelector('pre.tout.live') as HTMLPreElement | null;
  if (!pre) {
    pre = document.createElement('pre');
    pre.className = 'tout live';
    r.body.appendChild(pre);
    r.el.classList.add('open');
  }
  const next = pre.textContent + text;
  pre.textContent = next.length > 100000 ? next.slice(-100000) : next;
  pre.scrollTop = pre.scrollHeight;
  scrollEnd();
}

function finishTool(id: string, ok: boolean, output: string) {
  const r = toolRows.get(id);
  if (!r) return;
  const el = r.el;
  const fileEdit = r.name === 'edit_file' || r.name === 'write_file';
  const denied = output.startsWith('The user denied');
  el.classList.remove('run', 'wait');
  el.classList.add(ok ? 'ok' : 'fail');
  el.querySelector('.tstate')!.innerHTML = icon(ok ? 'check' : 'x', 14);
  const livePre = r.body.querySelector('pre.tout.live') as HTMLPreElement | null;
  if (livePre) {
    livePre.classList.remove('live');
    if (output) livePre.textContent = output;
  } else if (!(ok && fileEdit) && output) {
    const pre = document.createElement('pre');
    pre.className = 'tout';
    pre.textContent = output;
    r.body.appendChild(pre);
  }
  if (!ok && !denied) el.classList.add('open');
  if (ok && fileEdit && r.args?.path) {
    const b = document.createElement('button');
    b.className = 'topen';
    b.type = 'button';
    b.textContent = 'Open';
    b.onclick = (e) => {
      e.stopPropagation();
      void openFile(String(r.args.path).replace(/\\/g, '/'));
    };
    el.querySelector('.tact')!.appendChild(b);
  }
}


/** After a plan-mode answer: approve it (switching out of plan mode) or keep refining it. */
function addPlanCard() {
  const d = document.createElement('div');
  d.className = 'cpcard plancard';
  d.innerHTML = '<div class="cphead"><span class="cptitle">Plan ready</span><span class="cpbtns"></span></div><div class="cpmsg" hidden></div>';
  const btns = d.querySelector<HTMLElement>('.cpbtns')!;
  const msg = d.querySelector<HTMLElement>('.cpmsg')!;
  const mk = (label: string, cls: string, fn: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn small ${cls}`;
    b.textContent = label;
    b.onclick = fn;
    btns.appendChild(b);
  };
  const approve = async (mode: Mode, how: string) => {
    btns.remove();
    settings = await jarvin.setSettings({ mode });
    modeSel.value = mode;
    d.classList.add('done');
    d.querySelector('.cptitle')!.textContent = 'Plan approved';
    msg.hidden = false;
    msg.textContent = `Running it now (${how}).`;
    void send('Go ahead and carry out the plan above, step by step.');
  };
  mk('Approve · ask before changes', 'primary', () => void approve('ask', 'asking before each change'));
  mk('Approve · auto-apply edits and desktop', '', () => void approve('auto-edit', 'edits and desktop actions run automatically; other commands still ask'));
  mk('Keep planning', '', () => {
    btns.remove();
    d.querySelector('.cptitle')!.textContent = 'Plan not approved yet';
    const oldPh = input.placeholder;
    input.placeholder = 'Tell Jarvin what to change in the plan…';
    input.addEventListener('input', () => (input.placeholder = oldPh), { once: true });
    input.focus();
  });
  put(d);
}

// ---- Problems panel ----
let problemsResult: ProblemsResult = { problems: [], checks: [] };
let problemsBusy = false;
function applyMarkers() {
  if (!editorModel) return;
  const p = activeTab?.path;
  const marks = p ? problemsResult.problems.filter((x) => x.file === p) : [];
  monaco.editor.setModelMarkers(editorModel, 'jarvin-problems', marks.map((x) => {
    const len = Math.max(1, Math.min(editorModel!.getLineMaxColumn(Math.min(x.line, editorModel!.getLineCount())) - x.col, 80));
    return {
      severity: x.severity === 'error' ? monaco.MarkerSeverity.Error : x.severity === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
      message: x.message,
      source: x.source,
      code: x.code,
      startLineNumber: Math.min(x.line, editorModel!.getLineCount()), startColumn: x.col,
      endLineNumber: Math.min(x.line, editorModel!.getLineCount()), endColumn: x.col + len,
    };
  }));
}
function renderProblems() {
  const { problems, checks } = problemsResult;
  const c = countBySeverity(problems);
  const badge = $('probBadge');
  badge.hidden = c.errors + c.warnings === 0;
  badge.textContent = String(c.errors + c.warnings);
  badge.className = 'badge' + (c.errors ? ' err' : ' warn');
  $('ppCount').textContent = problems.length ? `${c.errors} error${c.errors === 1 ? '' : 's'} · ${c.warnings} warning${c.warnings === 1 ? '' : 's'}` : checks.length ? 'No problems' : 'No checkers found';
  $('ppFixAll').hidden = c.errors === 0;
  $('ppChecks').innerHTML = checks.length
    ? checks.map((k) => `<span class="pp-chk ${!k.ran ? 'skip' : k.ok ? 'ok' : 'bad'}" title="${esc(k.command + (k.error ? '\n' + k.error : ''))}">${!k.ran ? '–' : k.ok ? '✓' : '✗'} ${esc(k.name)}${k.ran ? ` <small>${(k.ms / 1000).toFixed(1)}s</small>` : ` <small>${esc(k.error ?? 'skipped')}</small>`}</span>`).join('')
    : '<span class="pp-chk skip">Looks for tsconfig.json + local typescript, ESLint config, .py files, go.mod, Cargo.toml.</span>';
  const byFile = new Map<string, Problem[]>();
  for (const p of [...problems].sort((a, b) => Number(b.severity === 'error') - Number(a.severity === 'error') || a.line - b.line)) (byFile.get(p.file) ?? byFile.set(p.file, []).get(p.file)!).push(p);
  const list = $('ppList');
  list.innerHTML = '';
  for (const [file, items] of byFile) {
    const g = document.createElement('div');
    g.className = 'pp-file';
    g.innerHTML = `<div class="pp-fname">${fileIcon(file)}<span>${esc(file)}</span><small>${items.length}</small></div>`;
    for (const p of items) {
      const row = document.createElement('div');
      row.className = `pp-row ${p.severity}`;
      row.innerHTML = `<span class="pp-sev"></span><span class="pp-msg"></span><span class="pp-loc">${p.line}:${p.col}${p.code ? ' · ' + esc(p.code) : ''}</span><button type="button" class="pp-fix" title="Ask Jarvin to fix this">Fix</button>`;
      row.querySelector<HTMLElement>('.pp-msg')!.textContent = p.message;
      row.onclick = (e) => {
        if ((e.target as HTMLElement).closest('.pp-fix')) { void send(`Fix this ${p.source} ${p.severity} in ${p.file} at line ${p.line}:${p.col}${p.code ? ' (' + p.code + ')' : ''}: ${p.message}`); return; }
        void openFile(p.file, p.line);
      };
      g.appendChild(row);
    }
    list.appendChild(g);
  }
  applyMarkers();
}
function setProblems(r: ProblemsResult) {
  problemsResult = r;
  renderProblems();
}
async function runProblems(openPanel = false) {
  if (problemsBusy) return;
  problemsBusy = true;
  const btn = $<HTMLButtonElement>('ppRun');
  btn.disabled = true; btn.textContent = 'Checking…';
  if (openPanel) $('probPanel').hidden = false;
  try { setProblems(await jarvin.runProblems()); }
  catch (e) { toast(String((e as Error).message ?? e)); }
  finally { problemsBusy = false; btn.disabled = false; btn.textContent = 'Run checks'; }
}

let reviewUi: ReturnType<typeof createReview> | null = null;
async function openReview(sum: CheckpointSummary, startPath?: string) {
  reviewUi = reviewUi ?? createReview({
    baseline: (id, p) => jarvin.checkpointBaseline(id, p),
    read: (p) => jarvin.readFile(p),
    write: (p, c) => jarvin.writeFile(p, c),
    rewindFile: (id, p, f) => jarvin.rewindFile(id, p, f),
    langFor: langForPath,
    onClose: (changed) => { if (changed) { void refreshTree(); void reloadTabs(); } },
    toast: (m) => toast(m),
  });
  ensureMonaco();
  await reviewUi.show(sum.id, sum.files, startPath);
}
let lastCheckpointSummary: CheckpointSummary | null = null;
function addCheckpointCard(sum: CheckpointSummary) {
  const d = document.createElement('div');
  d.className = 'cpcard';
  const n = sum.files.length;
  const list = sum.files
    .slice(0, 12)
    .map((f) => `<div class="cpf ${f.status}"><span class="cps">${f.status === 'created' ? 'new' : f.status === 'deleted' ? 'deleted' : 'edited'}</span><span class="cpn">${esc(f.path)}</span><button type="button" class="cpfdiff" data-path="${esc(f.path)}">Diff</button><button type="button" class="cpfundo" data-path="${esc(f.path)}">Undo file</button></div>`)
    .join('');
  const more = n > 12 ? `<div class="cpmore">+ ${n - 12} more</div>` : '';
  d.innerHTML = `<div class="cphead"><span class="cptitle">${n} file${n === 1 ? '' : 's'} changed</span><span class="cpbtns"><button type="button" class="cpreview btn small primary">Review changes</button><button type="button" class="cpundo">Undo</button></span></div><div class="cplist">${list}${more}</div><div class="cpmsg" hidden></div>`;
  const btn = d.querySelector<HTMLButtonElement>('.cpundo')!;
  d.querySelector<HTMLButtonElement>('.cpreview')!.onclick = () => void openReview(sum);
  const msg = d.querySelector<HTMLElement>('.cpmsg')!;
  d.querySelectorAll<HTMLButtonElement>('.cpfdiff').forEach((b) => {
    b.onclick = async () => {
      try { await openReview(sum, b.dataset.path!); }
      catch (e) { msg.hidden = false; msg.className = 'cpmsg bad'; msg.textContent = String((e as Error).message ?? e); }
    };
  });
  d.querySelectorAll<HTMLButtonElement>('.cpfundo').forEach((b) => {
    b.onclick = async () => {
      const p = b.dataset.path!;
      b.disabled = true;
      try {
        let r = await jarvin.rewindFile(sum.id, p, false);
        if (!r.ok && r.conflicts.length) {
          if (!confirm(`File changed since Jarvin wrote: ${p}. Overwrite your edits?`)) { b.disabled = false; return; }
          r = await jarvin.rewindFile(sum.id, p, true);
        }
        if (!r.ok) { say(r.error ?? 'Undo failed.', 'bad'); b.disabled = false; return; }
        b.hidden = true;
        void refreshTree();
        void reloadTabs();
        say(`Reverted ${p}.`, '');
      } catch (e) {
        b.disabled = false;
        say(String((e as Error).message ?? e), 'bad');
      }
    };
  });
  const say = (t: string, cls = '') => {
    msg.hidden = false;
    msg.className = 'cpmsg ' + cls;
    msg.textContent = t;
  };
  let stage: 'idle' | 'confirm' | 'force' = 'idle';
  btn.onclick = async () => {
    try {
      if (stage === 'idle') {
        btn.disabled = true;
        const pv = await jarvin.rewindPreview(sum.id);
        btn.disabled = false;
        if (!pv.files.length) {
          say('Nothing to undo — this checkpoint is no longer available.', 'bad');
          btn.hidden = true;
          return;
        }
        const restore = pv.files.filter((f) => f.action === 'restore').length;
        const del = pv.files.length - restore;
        const parts = [restore ? `restore ${restore} file${restore === 1 ? '' : 's'}` : '', del ? `delete ${del} new file${del === 1 ? '' : 's'}` : ''].filter(Boolean);
        const conflicts = pv.files.filter((f) => f.conflict).map((f) => f.path);
        let t = `This will ${parts.join(' and ')}.`;
        if (pv.laterTurns) t += ` It also undoes ${pv.laterTurns} later turn${pv.laterTurns === 1 ? '' : 's'}.`;
        if (conflicts.length) {
          t += ` Changed since Jarvin wrote them: ${conflicts.slice(0, 5).join(', ')}${conflicts.length > 5 ? '…' : ''}. Undoing will overwrite your edits.`;
          stage = 'force';
          btn.textContent = 'Overwrite anyway';
        } else {
          stage = 'confirm';
          btn.textContent = 'Confirm undo';
        }
        say(t, conflicts.length ? 'warn' : '');
        return;
      }
      btn.disabled = true;
      const r = await jarvin.rewind(sum.id, stage === 'force');
      if (!r.ok) {
        btn.disabled = false;
        if (r.conflicts.length) {
          stage = 'force';
          btn.textContent = 'Overwrite anyway';
          say(`Files changed since: ${r.conflicts.slice(0, 5).join(', ')}. Click again to overwrite them.`, 'warn');
        } else say(r.error ?? 'Undo failed.', 'bad');
        return;
      }
      btn.hidden = true;
      d.classList.add('done');
      d.querySelector('.cptitle')!.textContent = `Restored · ${r.restored} reverted, ${r.deleted} removed`;
      say('Your files are back to how they were before this turn.', '');
      void refreshTree();
      void reloadTabs();
    } catch (err) {
      btn.disabled = false;
      say(String((err as Error).message ?? err), 'bad');
    }
  };
  put(d);
}

function onEvent(e: AgentEvent) {
  switch (e.type) {
    case 'token':
      if (!cur) newBot();
      curText += e.text;
      lastReply = curText;
      voiceCtl.pushSpeech(e.text);
      renderCur();
      break;
    case 'tool_start':
      runUsedTools = true;
      voiceCtl.flushSpeech();
      endCur();
      startTool(e.id, e.name, e.args);
      break;
    case 'approval':
      void askApproval(e.id, e.always, e.summary);
      break;
    case 'question': {
      const card = document.createElement('div');
      card.className = 'qcard';
      card.id = `q_${e.id}`;
      const opts = (e.options || []).map((o: string) => `<button class="btn small" data-opt="${esc(o)}">${esc(o)}</button>`).join(' ');
      card.innerHTML = `<div class="qtext">${esc(e.question)}</div><div class="qopts">${opts}</div>`;
      put(card);
      card.querySelectorAll('button[data-opt]').forEach((b) => {
        b.addEventListener('click', async () => {
          const v = (b as HTMLElement).dataset.opt || '';
          card.querySelectorAll('button').forEach((x) => ((x as HTMLButtonElement).disabled = true));
          card.classList.add('done');
          await jarvin.answerQuestion(e.id, v);
        });
      });
      break;
    }
    case 'tool_output':
      liveTool(e.id, e.text);
      break;
    case 'tool_result':
      finishTool(e.id, e.ok, e.output);
      break;
    case 'tasks': {
      let card = document.getElementById('taskCard');
      if (!card) {
        card = document.createElement('div');
        card.id = 'taskCard';
        card.className = 'taskcard';
        put(card);
      }
      const items = e.items || [];
      card.innerHTML = `<div class="cphead"><span class="cptitle">Tasks</span></div><div class="tasklist">${items.map((t: any) => `<div class="taskitem ${t.status || 'pending'}"><span class="taskdot"></span><span>${esc(t.content)}</span></div>`).join('')}</div>`;
      break;
    }
    case 'problems':
      setProblems(e.result);
      break;
    case 'verified':
      endCur();
      renderVerified(e, jarvin, (el) => put(el), () => { void refreshTree(); void reloadTabs(); });
      break;
    case 'fs_changed':
      void refreshTree();
      void reloadTabs();
      void loadFiles(true);
      break;
    case 'checkpoint':
      endCur();
      lastCheckpointId = e.summary?.id || lastCheckpointId;
      lastCheckpointSummary = e.summary ?? lastCheckpointSummary;
      addCheckpointCard(e.summary);
      break;
    case 'note': {
      endCur();
      const d = document.createElement('div');
      let cls = 'notice';
      if (e.text.startsWith('[subagent]')) {
        cls = 'notice subagent';
        if (e.text.includes('failed')) cls = 'notice subagent failed';
        else if (e.text.includes('completed')) cls = 'notice subagent completed';
        else if (e.text.includes('started')) cls = 'notice subagent running';
      }
      d.className = cls;
      d.textContent = e.text;
      put(d);
      break;
    }
    case 'error': {
      runFailed = true;
      endCur();
      const d = document.createElement('div');
      d.className = 'errbox';
      d.textContent = e.message;
      put(d);
      break;
    }
    case 'done':
      pendingAppr.clear();
      if (runHadWrites && lastCheckpointId) {
        const bar = document.createElement('div');
        bar.className = 'tapprove';
        bar.innerHTML = '<span class="why">Turn changes</span>';
        const keep = document.createElement('button');
        keep.type = 'button'; keep.className = 'btn small primary'; keep.textContent = 'Keep all';
        keep.onclick = () => { bar.innerHTML = '<span class="res">Kept all changes</span>'; };
        const undo = document.createElement('button');
        undo.type = 'button'; undo.className = 'btn small'; undo.textContent = 'Undo all';
        undo.onclick = async () => {
          const r = await jarvin.rewind(lastCheckpointId, false);
          bar.innerHTML = `<span class="res">${r?.ok ? 'Undone' : 'Undo failed'}</span>`;
        };
        const rev = document.createElement('button');
        rev.type = 'button'; rev.className = 'btn small'; rev.textContent = 'Review changes';
        rev.onclick = () => { if (lastCheckpointSummary) void openReview(lastCheckpointSummary); };
        bar.append(rev);
        bar.append(keep, undo);
        put(bar);
      }
      setRunning(false);
      if (settings.mode === 'plan' && looksLikePlan(lastReply)) addPlanCard();
      const stopSpeech = runFailed || userStopped || e.outcome === 'stopped' || e.outcome === 'failed';
      {
        const outcome = runFailed || e.outcome === 'failed' ? 'error' : userStopped || e.outcome === 'stopped' ? 'stopped' : e.outcome === 'paused' ? 'paused' : 'done';
        runFailed = false; userStopped = false;
        const next = tasksUi.onRunEnded(outcome);
        if (next) setTimeout(() => sendQueued(next), 50);
      }
      if (stopSpeech) voiceCtl.stopSpeaking();
      else voiceCtl.finishSpeech();
      if (lastReply.trim()) {
        chatMessages.push({ role: 'assistant', content: lastReply });
      }
      return;
  }
  updateTyping();
}

inner.addEventListener('click', async (e) => {
  const t = e.target as HTMLElement;
  const a = t.closest<HTMLElement>('a[data-ext]');
  if (a) {
    e.preventDefault();
    void jarvin.openExternal(a.dataset.ext!);
    return;
  }
  const cc = t.closest<HTMLElement>('.ccopy');
  if (cc) {
    await navigator.clipboard.writeText(cc.closest('.code')!.querySelector('pre')!.textContent ?? '');
    cc.textContent = 'Copied';
    setTimeout(() => (cc.textContent = 'Copy'), 1200);
    return;
  }
  const mc = t.closest<HTMLElement>('.mcopy');
  if (mc) {
    const m = mc.closest<HTMLElement>('.msg')!;
    await navigator.clipboard.writeText(raw.get(m) ?? curText);
    mc.innerHTML = icon('check', 14);
    setTimeout(() => (mc.innerHTML = icon('copy', 14)), 1200);
  }
});

/* ================= completion (@file and /commands) ================= */
let fileList: string[] = [];
let filesLoadedAt = 0;
async function loadFiles(force = false) {
  if (!settings?.workspace) {
    fileList = [];
    filesLoadedAt = 0;
    return;
  }
  const now = Date.now();
  if (!force && fileList.length && now - filesLoadedAt < 30000) return;
  const out: string[] = [];
  const MAX_FILES = 5000;
  const walk = async (rel: string): Promise<void> => {
    if (out.length >= MAX_FILES) return;
    let entries: any;
    try {
      entries = await jarvin.tree(rel);
    } catch {
      return;
    }
    for (const en of entries) {
      if (out.length >= MAX_FILES) return;
      if (en.dir) await walk(en.path);
      else out.push(en.path);
    }
  };
  await walk('');
  fileList = out;
  filesLoadedAt = Date.now();
}
const BASE_PLACEHOLDER = 'Ask Jarvin to build, fix, explain or run something… Use /commands and @file to attach files.';
function updatePlaceholder() {
  input.placeholder = settings.persona ? `Mode: ${settings.persona} · ${BASE_PLACEHOLDER}` : BASE_PLACEHOLDER;
}
const CMDS = [
  { name: 'help', desc: 'Show commands and @file usage' },
  { name: 'new', desc: 'Start a new chat' },
  { name: 'compact', desc: 'Compact the conversation history' },
  { name: 'diagnostics', desc: 'Write a diagnostics bundle' },
  { name: 'clear', desc: 'Clear the chat view' },
  { name: 'open', desc: '/open <path> — open a file in the editor' },
  { name: 'model', desc: '/model <name> — switch the active model' },
  { name: 'ctx', desc: 'Toggle the active file as context' },
  { name: 'plan', desc: 'Switch to plan-only mode (no changes)' },
  { name: 'init', desc: 'Generate an AGENTS.md for this repo' },
  { name: 'review', desc: 'Review the current working changes' },
  { name: 'commit', desc: 'Draft and propose a commit from the current diff' },
  { name: 'diff', desc: 'Summarize the current working diff' },
  { name: 'transcribe', desc: 'Transcribe an audio or video file' },
  { name: 'mode', desc: '/mode <name|off> — switch custom mode (reviewer, debugger, …)' },
  { name: 'rules', desc: 'Show the project rules Jarvin follows' },
  { name: 'hooks', desc: 'Show project hooks and trust them' },
];
function acceptComplete(i: number) {
  const it = completeItems[i];
  if (!it) return;
  const cur = input.selectionStart;
  const before = input.value.slice(0, cur);
  const after = input.value.slice(cur);
  const nb = before.replace(/(^|\s)(\/\S*|@\S*)$/, `$1${it.insert}`);
  input.value = nb + after;
  input.selectionStart = input.selectionEnd = nb.length;
  completeEl.hidden = true;
  autosize();
}
function updateComplete() {
  const val = input.value;
  const cur = input.selectionStart;
  const before = val.slice(0, cur);
  const m = before.match(/(^|\s)(\/\S*|@\S*)$/);
  if (!m) {
    completeEl.hidden = true;
    return;
  }
  const token = m[2];
  let items: { insert: string; label: string; desc?: string }[] = [];
  if (token.startsWith('/')) {
    const q = token.slice(1).toLowerCase();
    items = CMDS.filter((c) => c.name.startsWith(q)).map((c) => ({
      insert: '/' + c.name + (c.name === 'open' || c.name === 'model' || c.name === 'mode' ? ' ' : ''),
      label: '/' + c.name,
      desc: c.desc,
    }));
  } else {
    const q = token.slice(1).toLowerCase();
    items = fileList
      .filter((f) => f.toLowerCase().includes(q))
      .slice(0, 8)
      .map((f) => ({ insert: '@' + f + ' ', label: f }));
  }
  if (!items.length) {
    completeEl.hidden = true;
    return;
  }
  completeItems = items;
  completeEl.innerHTML = items
    .map((it, i) => `<div class="citem${i === 0 ? ' active' : ''}" data-i="${i}">${esc(it.label)}${it.desc ? ` <span class="cdesc">${esc(it.desc)}</span>` : ''}</div>`)
    .join('');
  completeEl.hidden = false;
  completeEl.querySelectorAll<HTMLElement>('.citem').forEach((el, i) => {
    el.onmousedown = (e) => {
      e.preventDefault();
      acceptComplete(i);
    };
  });
}

/* ================= command palette & quick open ================= */
const PAL_COMMANDS: { label: string; run: () => void }[] = [];
function registerCommands() {
  PAL_COMMANDS.length = 0;
  PAL_COMMANDS.push(
    { label: 'Toggle sidebar', run: () => $('toggleSide').click() },
    { label: 'Toggle editor', run: () => $('toggleEditor').click() },
    { label: 'Toggle terminal', run: () => $('termBtn').click() },
    { label: 'New chat', run: () => $('newChat').click() },
    { label: 'Open settings', run: () => $('setBtn').click() },
    { label: 'Models: download, delete, choose…', run: () => void modelUi.openModels() },
    { label: 'Setup guide', run: () => void modelUi.openSetup() },
    { label: 'Tasks and reminders', run: () => void tasksUi.open() },
    { label: 'Preview: open the browser preview window', run: () => void openPreview() },
    { label: 'Runs: see what Jarvin did, with timings', run: () => void traceUi.open() },
    { label: 'Transcribe an audio file…', run: () => transcriber.open() },
    { label: 'Open MCP', run: () => $('mcpBtn').click() },
    { label: 'Save file', run: () => void save() },
  );
}
let paletteMode: 'files' | 'commands' | 'search' | 'symbols' = 'files';
function openPalette(mode: 'files' | 'commands' | 'search' | 'symbols') {
  paletteMode = mode;
  const dlg = $<HTMLDialogElement>('palDlg');
  const input = $<HTMLInputElement>('palInput');
  input.value = '';
  input.placeholder = mode === 'files' ? 'Quick open file…' : mode === 'search' ? 'Search in files…' : mode === 'symbols' ? 'Workspace symbol…' : 'Command palette…';
  renderPalette('');
  dlg.showModal();
  input.focus();
  input.oninput = () => renderPalette(input.value);
  input.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = document.querySelector<HTMLElement>('#palList .citem');
      first?.click();
    } else if (e.key === 'Escape') {
      dlg.close();
    }
  };
}
async function renderPalette(q: string) {
  const list = $('palList');
  const low = q.toLowerCase();
  if (paletteMode === 'search') {
    if (!q || q.length < 2) {
      list.innerHTML = '<div class="hint">Type at least 2 characters…</div>';
      return;
    }
    list.innerHTML = '<div class="hint">Searching…</div>';
    try {
      const res = await jarvin.searchWorkspace(q);
      if (!res.length) { list.innerHTML = '<div class="hint">No results.</div>'; return; }
      list.innerHTML = res.slice(0, 200).map((r, i) => `<div class="citem${i === 0 ? ' active' : ''}" data-f="${esc(r.path)}" data-l="${r.line}">${esc(r.path)}:${r.line} <span class="hint">${esc(r.text)}</span></div>`).join('');
      list.querySelectorAll<HTMLElement>('.citem').forEach((el) => {
        el.onclick = () => {
          $<HTMLDialogElement>('palDlg').close();
          void openFile(el.dataset.f!);
        };
      });
    } catch {
      list.innerHTML = '<div class="hint">Search failed.</div>';
    }
    return;
  }
  if (paletteMode === 'symbols') {
    if (q.trim().length < 1) {
      list.innerHTML = '<div class="hint">Type to search symbols…</div>';
      return;
    }
    list.innerHTML = '<div class="hint">Searching symbols…</div>';
    try {
      const res = await jarvin.workspaceSymbols(q);
      if (!res.length) { list.innerHTML = '<div class="hint">No symbols.</div>'; return; }
      list.innerHTML = res.map((r, i) => `<div class="citem${i === 0 ? ' active' : ''}" data-f="${esc(r.path)}" data-l="${r.line}"><strong>${esc(r.name)}</strong> <span class="hint">${esc(r.kind)} ${esc(r.path)}:${r.line}</span></div>`).join('');
      list.querySelectorAll<HTMLElement>('.citem').forEach((el) => {
        el.onclick = () => {
          $<HTMLDialogElement>('palDlg').close();
          void openFile(el.dataset.f!, Number(el.dataset.l));
        };
      });
    } catch {
      list.innerHTML = '<div class="hint">Symbol search failed.</div>';
    }
    return;
  }
  if (paletteMode === 'files') {
    const items = fileList.filter((f) => f.toLowerCase().includes(low)).slice(0, 20);
    list.innerHTML = items.map((f, i) => `<div class="citem${i === 0 ? ' active' : ''}" data-f="${esc(f)}">${esc(f)}</div>`).join('');
    list.querySelectorAll<HTMLElement>('.citem').forEach((el) => {
      el.onclick = () => {
        $<HTMLDialogElement>('palDlg').close();
        void openFile(el.dataset.f!);
      };
    });
  } else {
    const items = PAL_COMMANDS.filter((c) => c.label.toLowerCase().includes(low));
    list.innerHTML = items.map((c, i) => `<div class="citem${i === 0 ? ' active' : ''}">${esc(c.label)}</div>`).join('');
    const els = list.querySelectorAll<HTMLElement>('.citem');
    els.forEach((el, i) => {
      el.onclick = () => {
        $<HTMLDialogElement>('palDlg').close();
        items[i].run();
      };
    });
  }
}

/* ================= composer ================= */
function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  sendBtn.disabled = !input.value.trim();
  updateContextMeter();
}

function updateContextMeter() {
  const chars = chatMessages.reduce((n, m) => n + String(m.content ?? '').length, 0) + (input.value?.length ?? 0);
  const toks = Math.round(chars / 4);
  const cap = settings?.numCtx || 16384;
  const pct = (toks / cap) * 100;
  const el = $('ctxMeter');
  if (!el) return;
  const k = (n: number) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  el.textContent = `${k(toks)} / ${k(cap)}`;
  el.title = `About ${toks.toLocaleString()} of ${cap.toLocaleString()} context tokens used`;
  el.style.color = pct >= 75 ? 'var(--warn, #f59e0b)' : '';
}
function updateCtx() {
  const show = !!activeTab && includeActive;
  $('ctxRow').hidden = !show;
  if (show) {
    const toks = Math.round((editorModel?.getValue().length ?? 0) / 4);
    $('ctx').innerHTML = `${fileIcon(activeTab!.path)}<span>${esc(base(activeTab!.path))} (~${toks.toLocaleString()} tok)</span><span id="ctxRemove" style="cursor:pointer">${icon('x', 12)}</span>`;
    const rem = $('ctxRemove');
    if (rem) rem.onclick = () => { includeActive = false; updateCtx(); };
  }
}

async function send(override?: string, options?: { preserveDraft?: boolean }) {
  let text = (override ?? input.value).trim();
  if (!text) return;
  if (running) {
    if (attachedFiles.length) return toast('Wait for the current task to finish before sending attached files.');
    const n = tasksUi.enqueue(text, attachedImages.length ? [...attachedImages] : undefined);
    if (!n) return toast('The queue is full (20). Open Tasks to clear it.');
    if (!options?.preserveDraft) { input.value = ''; attachedImages = []; }
    autosize();
    toast(n === 1 ? 'Queued. It sends when the current run ends.' : `Queued (${n} waiting). They send one after another.`);
    return;
  }
  if (!settings.workspace) return toast('Open a folder first');

  // Slash commands are handled locally.
  if (text.startsWith('/') && !override) {
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(' ');
    switch (cmd) {
      case '/help':
        addUser(text, null);
        {
          const d = document.createElement('div');
          d.className = 'notice';
          d.textContent = 'Commands: /new, /clear, /compact, /diagnostics, /open <path>, /model <name>, /models, /setup, /trace, /tasks, /preview <port or file>, /ctx, /plan, /init, /review, /commit, /diff, /verify <task>, /transcribe, /mode, /rules, /hooks, /help. Attach files with @path.';
          put(d);
        }
        input.value = '';
        autosize();
        return;
      case '/new':
      case '/clear':
        $('newChat').click();
        input.value = '';
        autosize();
        return;
      case '/compact': {
        const r = await jarvin.compactChat();
        toast(r.ok ? 'Context compacted' : (r.error ?? 'Compact failed'));
        input.value = '';
        autosize();
        return;
      }
      case '/diagnostics': {
        const r = await jarvin.diagnosticsBundle();
        toast(r.path ? `Diagnostics written: ${r.path}` : 'Diagnostics failed');
        input.value = '';
        autosize();
        return;
      }
      case '/open':
        if (arg) await openFile(arg.replace(/^@/, ''));
        input.value = '';
        autosize();
        return;
      case '/preview': {
        void openPreview(arg || undefined);
        input.value = '';
        autosize();
        return;
      }
      case '/tasks':
      case '/jobs':
      case '/queue':
        void tasksUi.open();
        input.value = '';
        autosize();
        return;
      case '/models':
        void modelUi.openModels();
        input.value = '';
        autosize();
        return;
      case '/trace':
      case '/runs':
        void traceUi.open();
        input.value = '';
        autosize();
        return;
      case '/setup':
        void modelUi.openSetup();
        input.value = '';
        autosize();
        return;
      case '/model':
        if (arg) {
          settings = await jarvin.setSettings({ model: arg });
          modelSel.value = arg;
          toast(`Model set to ${arg}`);
        }
        input.value = '';
        autosize();
        return;
      case '/ctx':
        includeActive = !includeActive;
        updateCtx();
        input.value = '';
        autosize();
        return;
      case '/plan':
        settings = await jarvin.setSettings({ mode: 'plan' });
        modeSel.value = 'plan';
        toast('Plan mode: no changes will be made');
        input.value = '';
        autosize();
        return;
      case '/transcribe':
        input.value = '';
        autosize();
        transcriber.open();
        return;
      case '/mode':
      case '/rules':
      case '/hooks': {
        input.value = '';
        autosize();
        addUser(text, null);
        const st = await jarvin.extStatus();
        const d = document.createElement('div');
        d.className = 'notice extcard';
        const lines: string[] = [];
        if (cmd === '/mode') {
          const want = arg.trim();
          if (want) {
            const hit = want === 'off' || want === 'none' ? '' : st.personas.find((p) => p.name === want)?.name;
            if (hit === undefined) lines.push(`No mode called "${want}". Available: ${st.personas.map((p) => p.name).join(', ')}.`);
            else {
              settings = await jarvin.setSettings({ persona: hit });
              updatePlaceholder();
              lines.push(hit ? `Mode "${hit}" is on. ${st.personas.find((p) => p.name === hit)?.description ?? ''}` : 'Custom mode turned off.');
            }
          } else {
            lines.push(`Modes (switch with /mode <name>, turn off with /mode off). Active: ${st.active || 'none'}`);
            for (const p of st.personas) lines.push(`• ${p.name}${p.builtin ? '' : ' (yours)'} — ${p.description || 'no description'} [tools: ${p.tools}]`);
            lines.push('Add your own as .jarvin/modes/<name>.md (frontmatter: description, tools, model).');
          }
        } else if (cmd === '/rules') {
          lines.push(st.rules.used.length ? 'Rules in use:' : 'No rules found. Add AGENTS.md or .jarvin/rules/*.md in your project, or ~/.jarvin/rules.md for all projects.');
          for (const r of st.rules.used) lines.push(`• ${r}${st.rules.truncated.includes(r) ? ' (cut to fit the size limit)' : ''}`);
          for (const r of st.rules.truncated.filter((x) => !st.rules.used.includes(x))) lines.push(`• ${r} (left out: size limit reached)`);
        } else {
          const fmt = (h: { event: string; tool: string; match: string; command: string }) => `• ${h.event}${h.tool ? ' ' + h.tool : ''}${h.match ? ' /' + h.match + '/' : ''}: ${h.command}`;
          if (!st.hooks.active.length && !st.hooks.pending.length) lines.push('No hooks. Add .jarvin/hooks.json (events: PreToolUse, PostToolUse, Stop).');
          if (st.hooks.active.length) { lines.push('Active hooks:'); st.hooks.active.forEach((h) => lines.push(fmt(h))); }
          if (st.hooks.pending.length) {
            lines.push('Waiting for your trust (they run commands on your PC, so read them first):');
            st.hooks.pending.forEach((h) => lines.push(fmt(h)));
          }
          st.hooks.errors.forEach((e) => lines.push('! ' + e));
        }
        d.textContent = lines.join('\n');
        d.style.whiteSpace = 'pre-wrap';
        if (cmd === '/hooks' && st.hooks.pending.length) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'btn small primary trustbtn';
          b.textContent = 'Trust these hooks';
          b.onclick = async () => { b.disabled = true; await jarvin.trustHooks(); b.textContent = 'Trusted'; toast('Hooks trusted for this folder'); };
          d.appendChild(document.createElement('br'));
          d.appendChild(b);
        }
        put(d);
        return;
      }
      case '/init':
        input.value = 'Inspect this repository and create an AGENTS.md describing its purpose, structure, conventions and test commands. Read key files first; do not modify anything else.';
        autosize();
        void send();
        return;
      case '/verify':
        if (!arg) { toast('Say what to change: /verify fix the login redirect bug'); return; }
        input.value = `Use the verified_change tool for this task so the change is tested in a private copy before it touches my project, then summarize the result. Task: ${arg}`;
        autosize();
        void send();
        return;
      case '/review':
        input.value = 'Review the current working changes: list findings with file, line and severity, and propose fixes.';
        autosize();
        void send();
        return;
      case '/commit':
        input.value = 'Inspect git_status and git_diff, draft a concise commit message, then propose git_commit with that message and ask for approval before committing.';
        autosize();
        void send();
        return;
      case '/diff':
        input.value = 'Summarize the current working tree diff, file by file, and highlight risks.';
        autosize();
        void send();
        return;
      default: {
        // Custom slash commands from .jarvin/commands/<name>.md
        const name = cmd.slice(1);
        if (name && /^[A-Za-z0-9_-]+$/.test(name) && settings.workspace) {
          try {
            const tmpl = await jarvin.readFile(`.jarvin/commands/${name}.md`);
            text = tmpl.replace(/\$ARGUMENTS/g, arg).trim();
            input.value = text;
            autosize();
          } catch {
            /* not a custom command; fall through */
          }
        }
        break;
      }
    }
  }

  // Resolve @file mentions into attached context.
  const mentions = [...new Set([...text.matchAll(/@([^\s]+)/g)].map((m) => m[1]))];
  const attached: string[] = [];
  for (const m of mentions) {
    try {
      const c = await jarvin.readFile(m);
      attached.push(`[Attached file: ${m}]\n${c.slice(0, 12000)}`);
    } catch {
      /* ignore unreadable mentions */
    }
  }
  const fileAtt = options?.preserveDraft ? [] : attachedFiles.map((f) => `[Attached file: ${f.name}]\n${f.content.slice(0, 12000)}`);
  const allAtt = [...attached, ...fileAtt];
  const payload = allAtt.length ? `${text}\n\n${allAtt.join('\n\n')}` : text;

  const file = includeActive && activeTab ? activeTab.path : null;
  lastReply = '';
  runHadWrites = false;
  lastCheckpointId = '';
  voiceCtl.beginSpeech();
  await saveAll();
  const imgs = !options?.preserveDraft && attachedImages.length ? [...attachedImages] : undefined;
  addUser(text, file, imgs);
  if (!options?.preserveDraft) input.value = '';
  autosize();
  endCur();
  stick = true;
  runFailed = false;
  userStopped = false;
  setRunning(true);
  if (!options?.preserveDraft) { attachedImages = []; attachedFiles = []; }
  updateBrowserAttachment();
  void jarvin.send(payload, file, imgs, ui.mode);
}

const CODE_SUGGEST: [string, string, string][] = [
  ['search', 'Explain this project', 'Give me an overview of this project: structure, main entry points and how to run it.'],
  ['bug', 'Find bugs', 'Review the main source files (or the active file) and list real bugs or risky code with file and line references.'],
  ['flask', 'Write tests', 'Add tests for the most important untested code, then run them and fix any failures.'],
  ['git', 'Review changes', 'Run git status and git diff, then summarize what changed and flag anything risky.'],
];
const ASSISTANT_SUGGEST: [string, string, string][] = [
  ['globe', 'Open Chrome', 'Open Google Chrome.'],
  ['search', 'Research a topic', 'Help me research a topic and include source links. First ask what topic I want.'],
  ['file', 'Summarize a document', 'Help me summarize a document. Ask which file I want to use.'],
  ['list', 'Set a reminder', 'Help me set a reminder. Ask what I should be reminded about and when.'],
];
function renderSuggestions() {
  const suggestions = ui.mode === 'assistant' ? ASSISTANT_SUGGEST : CODE_SUGGEST;
  $('chips').innerHTML = suggestions.map(([i, t], k) => `<button class="sug" type="button" data-k="${k}">${icon(i, 16)}<span>${esc(t)}</span></button>`).join('');
}
$('chips').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('.sug');
  const suggestions = ui.mode === 'assistant' ? ASSISTANT_SUGGEST : CODE_SUGGEST;
  const suggestion = b && suggestions[Number(b.dataset.k)];
  if (suggestion) void send(suggestion[2]);
});

/* ================= setup ================= */
const wsLabel = () => {
  $('wsName').textContent = settings.workspace ? settings.workspace.split(/[\\/]/).filter(Boolean).pop()! : 'Open folder…';
  $('openWs').title = settings.workspace || 'Open folder';
  $('emptySub').textContent = ui.mode === 'assistant' ? (settings.workspace ? 'Ask a question, start a task, or use your voice.' : 'Open a folder to start a conversation, then ask or use your voice.') : (settings.workspace ? 'Ask me to read, edit, run and verify code in this folder.' : 'Open a folder, then ask me to read, edit, run and verify code.');
};

async function openWorkspace() {
  if (running) return toast('Stop or finish the current task before changing folders.');
  const p = await jarvin.pickWorkspace();
  if (!p) return;
  try { settings = await jarvin.setSettings({ workspace: p }); }
  catch (e: any) { toast(String(e?.message ?? e)); return; }
  tabs.length = 0;
  expanded.clear();
  toolRows.clear();
  activate(null);
  resetChatView();
  wsLabel();
  await refreshTree();
  void loadFiles();
  try {
    restoreChat(await jarvin.chatHistory());
  } catch {
    /* ignore */
  }
  void refreshSessions();
  void tasksUi.refreshRecovered();
}

function resetChatView() {
  endCur();
  chatMessages = [];
  Array.from(inner.children).forEach((c) => c !== emptyEl && c !== typing && c.remove());
  emptyEl.hidden = false;
  setRunning(false);
}

async function refreshSessions() {
  const sel = $<HTMLSelectElement>('sessionSel');
  if (!settings?.workspace) {
    sel.innerHTML = '';
    return;
  }
  try {
    const s = await jarvin.chatSessions();
    let sessions = s.sessions.filter((x) => showArchived || !x.archived);
    if (sessionQuery.trim()) {
      const q = sessionQuery.toLowerCase();
      sessions = sessions.filter((x) => x.title.toLowerCase().includes(q));
    }
    sessions.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updated - a.updated);
    sel.innerHTML = sessions.map((x) => `<option value="${esc(x.id)}"${x.id === s.active ? ' selected' : ''}>${x.pinned ? '📌 ' : ''}${esc(x.title)}${x.archived ? ' (archived)' : ''}</option>`).join('');
  } catch {
    sel.innerHTML = '';
  }
}

function restoreChat(msgs: { role: 'user' | 'assistant'; content: string; images?: string[] }[]) {
  endCur();
  chatMessages = [];
  Array.from(inner.children).forEach((c) => c !== emptyEl && c !== typing && c.remove());
  emptyEl.hidden = msgs.length > 0;
  for (const m of msgs) {
    if (m.role === 'assistant' && !m.content.trim()) continue;
    if (m.role === 'user') {
      chatMessages.push({ role: 'user', content: m.content, images: m.images });
      addUser(m.content, null, m.images, false);
    } else {
      chatMessages.push({ role: 'assistant', content: m.content, images: m.images });
      const d = document.createElement('div');
      d.className = 'msg bot';
      d.innerHTML = `<div class="mbody">${md(m.content)}</div>`;
      put(d);
      void renderDiagrams(d, toast);
      void imageUi.hydrate(d);
    }
  }
  setRunning(false);
}

let modelsLoadedAt = 0;
let modelsRetry: ReturnType<typeof setTimeout> | undefined;
async function loadModels(quiet = false) {
  if (modelsRetry) { clearTimeout(modelsRetry); modelsRetry = undefined; }
  const r = await jarvin.listModels();
  modelsLoadedAt = Date.now();
  // Ollama may start after Jarvin: keep retrying quietly until it answers, so local models (e.g. qwen) show up on their own.
  if (r.error) modelsRetry = setTimeout(() => void loadModels(true), 6000);
  const hasKey = !!r.hasKey;
  const localSet = new Set(r.local ?? r.models.filter((m) => !isRemoteModelId(m)));
  const ollamaCloud = new Set(r.ollamaCloud ?? []);
  const loc = r.models.filter((m) => localSet.has(m) && !ollamaCloud.has(m));
  const hosted = r.models.filter((m) => localSet.has(m) && ollamaCloud.has(m));
  const cloud = r.models.filter((m) => !localSet.has(m));
  const opts = (xs: string[]) => xs.map((m) => `<option>${esc(m)}</option>`).join('');
  modelSel.innerHTML = !r.models.length ? '<option value="">no models</option>'
    : cloud.length || hosted.length ? `${loc.length ? `<optgroup label="On this PC">${opts(loc)}</optgroup>` : ''}${hosted.length ? `<optgroup label="Cloud (via Ollama)">${opts(hosted)}</optgroup>` : ''}${cloud.length ? `<optgroup label="${hasKey ? 'Cloud (OpenRouter)' : 'Cloud (needs an API key in Settings)'}">${opts(cloud)}</optgroup>` : ''}`
    : opts(loc);
  $('conn').className = 'dot ' + (r.error ? 'bad' : 'ok');
  $('conn').title = r.error ?? 'Connected to Ollama';
  if (r.error && !quiet) toast(r.error);
  if (r.models.length) {
    const saved = settings.model;
    // When Ollama is down only cloud ids are listed; keep a saved local model instead of replacing it for good.
    const keepSavedLocal = !!r.error && !!saved && !isRemoteModelId(saved);
    if (keepSavedLocal && !r.models.includes(saved)) modelSel.insertAdjacentHTML('afterbegin', `<option>${esc(saved)}</option>`);
    const unusable = !keepSavedLocal && (!r.models.includes(saved) || (!localSet.has(saved) && !hasKey));
    if (unusable) {
      const chosen = pickDefaultModel(loc.length ? loc : r.models, hasKey, loc.length ? loc : r.local);
      if (chosen && chosen !== saved) settings = await jarvin.setSettings({ model: chosen });
    }
    modelSel.value = settings.model;
  }
}

function renderMcp(status: McpStatus[]) {
  $('mcpStatus').innerHTML =
    status.map((s) => (s.ok ? `<div class="good">● ${esc(s.name)} — ${s.tools} tools</div>` : `<div class="bad">● ${esc(s.name)} — ${esc(s.error ?? 'failed')}</div>`)).join('') ||
    '<div class="hint">No servers configured.</div>';
}

function updateSpeakToggle() {
  const on = (settings?.voice?.speak ?? 'off') !== 'off';
  const btn = $('speakToggle') as HTMLButtonElement;
  btn.innerHTML = icon(on ? 'volume' : 'volumeOff', 17);
  btn.title = on ? 'Speak replies aloud: ON (click to mute)' : 'Speak replies aloud: OFF (click to enable)';
  btn.classList.toggle('active', on);
}

async function init() {
  $('uiAssistant').onclick = () => setView('assistant');
  $('uiCode').onclick = () => setView('code');
  $('uiCompact').onclick = () => void jarvin.assistantCompact().catch((e: any) => toast(cleanErr(e)));
  window.addEventListener('resize', applyLayout);
  for (const [menuId, targetId] of [['termMore', 'termBtn'], ['problemsMore', 'probBtn'], ['gitMore', 'gitBtn'], ['mcpMore', 'mcpBtn']]) {
    $(menuId).onclick = () => { if (targetId !== 'mcpBtn' && ui.mode !== 'code') setView('code'); $(targetId).click(); };
  }
  let companionVoicePending = false;
  jarvin.onAssistantAction((action) => {
    if (action === 'stop') { voiceCtl.stopSpeaking(); return; }
    if (action === 'tasks') { setView('assistant'); void tasksUi.open(); return; }
    if (action === 'mute') { voiceCtl.toggleListening(); return; }
    if (action === 'voice') {
      if (voiceCtl.isBusy()) { voiceCtl.toggle({ live: false }); return; }
      if (companionVoicePending) return;
      companionVoicePending = true;
      void (async () => {
        try {
          const st = await jarvin.voiceStatus();
          if (!settings.voice.enabled || !st.available || !st.cached) {
            await jarvin.assistantRestore(); setView('assistant');
            if (!settings.voice.enabled) { toast('Turn on voice in Settings before using the microphone.'); return; }
          }
          voiceCtl.toggle({ live: false });
        } catch (error: any) { await jarvin.assistantRestore(); setView('assistant'); toast(cleanErr(error)); }
        finally { companionVoicePending = false; }
      })();
      return;
    }
    setView(action === 'code' ? 'code' : 'assistant');
  });
  const voiceStateObserver = new MutationObserver(() => publishAssistantState());
  voiceStateObserver.observe($('mic'), { attributes: true, attributeFilter: ['class'] });
  voiceStateObserver.observe($('hfBtn'), { attributes: true, attributeFilter: ['class', 'data-state'] });
  publishAssistantState();
  const browserDlg = $<HTMLDialogElement>('browserShareDlg');
  let sharedPage: import('../shared/browser-share').SharedBrowserPage | null = null;
  $('browserShareBtn').onclick = async () => {
    if (browserDlg.open) return;
    sharedPage = null; $('bsPair').hidden = false; $('bsReview').hidden = true;
    $('bsError').textContent = ''; $<HTMLInputElement>('bsCode').value = 'Starting…';
    browserDlg.showModal();
    try {
      const connection = await jarvin.browserShareStart();
      if (!browserDlg.open) { void jarvin.browserShareStop(); return; }
      $<HTMLInputElement>('bsCode').value = connection.code;
    } catch (error: any) { $('bsError').textContent = String(error?.message ?? error); }
  };
  $<HTMLInputElement>('bsCode').onclick = () => $<HTMLInputElement>('bsCode').select();
  $('bsFolder').onclick = () => void jarvin.browserShareFolder().catch((e: any) => { $('bsError').textContent = String(e?.message ?? e); });
  $('bsClose').onclick = () => browserDlg.close();
  $('bsDiscard').onclick = () => browserDlg.close();
  browserDlg.addEventListener('close', () => { sharedPage = null; void jarvin.browserShareStop(); });
  jarvin.onBrowserShare((page) => {
    if (!browserDlg.open) return;
    sharedPage = page; $('bsPair').hidden = true; $('bsReview').hidden = false;
    $('bsSource').textContent = `${page.title || '(Untitled page)'} — ${page.url}`;
    $<HTMLTextAreaElement>('bsText').value = page.text;
    $('bsTruncated').textContent = page.truncated ? 'Page text was truncated.' : '';
  });
  $('bsAttach').onclick = () => {
    if (!sharedPage) return;
    if (running) { toast('Wait for the current task to finish before attaching a page.'); return; }
    attachedFiles.push({ kind: 'browser', name: 'Untrusted shared browser page', content: `Source: ${sharedPage.url}\nTitle: ${sharedPage.title.replace(/[\r\n]/g, ' ')}\n\n${sharedPage.text}${sharedPage.truncated ? '\n[Page text was truncated.]' : ''}` });
    updateBrowserAttachment();
    browserDlg.close(); toast('Page attached. Add your question and send when ready.'); input.focus();
  };
  $('browserAttachment').onclick = () => { attachedFiles = attachedFiles.filter((file) => file.kind !== 'browser'); updateBrowserAttachment(); toast('Shared pages removed.'); };
  settings = await jarvin.getSettings();
  updatePlaceholder();
  setTimeout(() => { try { updateSpeakToggle(); } catch {} }, 0);
  registerCommands();
  voiceCtl.syncVisibility();
  // After a hidden start at sign-in, the microphone and voices wait until the window is first opened.
  if (new URLSearchParams(location.search).has('background')) jarvin.onFirstOpen(() => { voiceCtl.syncHandsFree(); void voiceCtl.warmNatural(); });
  else { voiceCtl.syncHandsFree(); void voiceCtl.warmNatural(); }
  modeSel.value = settings.mode;
  wsLabel();
  applyLayout();
  try {
    restoreChat(await jarvin.chatHistory());
  } catch {
    /* ignore */
  }
  void refreshSessions();
  jarvin.onEvent(onEvent);
  await Promise.all([loadModels(), refreshTree()]);
  void loadFiles();
  modelUi.wire();
  traceUi.wire();
  imageUi.wire();
  tasksUi.wire();
  setTimeout(() => void modelUi.maybeFirstRun(), 400);

  wireToolbar();
  gitUi.wire();
  createMemoryUi(jarvin).wire();
  wireWorktreesAndAttachments();

  wireChatControls();
  wireChatMenusAndShortcuts();

  wireMcpAndPrivacyDialogs();

  wireSettingsDialog();
  autosize();
  applyAppTheme(localStorage.getItem('jarvin-theme') || 'vs-dark');
  input.focus();

  wireTerminalPanel();
}

/** Top toolbar: folder, layout toggles, save, export, theme and preview. */
function wireToolbar() {
  $('openWs').onclick = () => void openWorkspace();
  $('toggleSide').onclick = () => {
    if (ui.mode === 'assistant') { ui.side = true; setView('code'); return; }
    ui.side = !ui.side;
    applyLayout();
    saveUi();
  };
  $('toggleEditor').onclick = () => {
    if (ui.mode === 'assistant') { ui.editor = true; setView('code'); return; }
    ui.editor = !ui.editor;
    applyLayout();
    saveUi();
  };
  $('refreshTree').onclick = () => void refreshTree();
  $<HTMLDialogElement>('diffDlg').addEventListener('close', () => { if (diffEditor) diffEditor.dispose(); diffEditor = null; });
  $('diffClose').onclick = () => $<HTMLDialogElement>('diffDlg').close();
  $('saveBtn').onclick = () => void save();
  $('exportChat').onclick = () => {
    const md = chatMessages.map((m) => `## ${m.role === 'user' ? 'User' : 'Jarvin'}\n\n${m.content}`).join('\n\n---\n\n');
    const blob = new Blob([md || '# Empty chat'], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'jarvin-chat.md';
    a.click();
    URL.revokeObjectURL(url);
  };
  $('themeBtn').onclick = () => {
    const cur = localStorage.getItem('jarvin-theme') || 'vs-dark';
    const next = cur === 'vs-dark' ? 'vs' : 'vs-dark';
    localStorage.setItem('jarvin-theme', next);
    applyAppTheme(next);
  };
  $('previewBtn').onclick = () => void openPreview(activeTab && /\.(html?|md|markdown|svg)$/i.test(activeTab.path) ? activeTab.path : undefined);
  jarvin.onPreviewToChat((m) => {
    if (m.kind === 'image') {
      attachedImages.push(m.base64);
      toast(`${m.note} attached to your next message`);
    } else {
      const inp = $<HTMLTextAreaElement>('input');
      inp.value = (inp.value ? inp.value + '\n\n' : '') + m.text;
      autosize();
      inp.focus();
      toast('Console problems added to the message box');
    }
  });
  $('exportChatJson').onclick = () => {
    const data = JSON.stringify({ messages: chatMessages }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'jarvin-chat.json';
    a.click();
    URL.revokeObjectURL(url);
  };
}

/** Worktree and sub-agent dialogs, and the image/file attach buttons. */
function wireWorktreesAndAttachments() {
  let activeWorktree: string | null = null;
  const refreshWorktrees = async () => {
    const rows = await jarvin.worktrees();
    const box = $('wtList');
    box.textContent = '';
    activeWorktree = rows.length ? rows[0].id : null;
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'permrow';
      const info = document.createElement('span');
      info.textContent = `${r.id}: ${r.task} (${r.path})`;
      const btn = document.createElement('button');
      btn.textContent = 'View';
      btn.onclick = async () => { activeWorktree = r.id; await viewWorktree(r.id); };
      row.append(info, btn);
      box.appendChild(row);
    }
    if (!rows.length) { box.textContent = '(none)'; activeWorktree = null; }
  };
  const viewWorktree = async (id: string) => {
    const diff = await jarvin.worktreeDiff(id);
    $<HTMLPreElement>('wtDiff').textContent = diff;
  };
  $('wtBtn').onclick = async () => { $<HTMLDialogElement>('wtDlg').showModal(); await refreshWorktrees(); };
  $('wtRefresh').onclick = refreshWorktrees;
  $('wtClose').onclick = () => $<HTMLDialogElement>('wtDlg').close();
  $('wtKeep').onclick = async () => {
    if (!activeWorktree) return toast('Select a worktree.');
    try {
      const result = await jarvin.worktreeKeep(activeWorktree);
      $<HTMLPreElement>('wtOut').textContent = `${result.stage}\n${result.output}${result.conflicts ? '\nConflicts:\n' + result.conflicts : ''}`;
      if (result.ok) { toast('Worktree changes kept.'); await refreshWorktrees(); }
      else toast('Merge did not complete.');
    } catch (e: any) { $<HTMLPreElement>('wtOut').textContent = String(e?.message ?? e); toast(String(e?.message ?? e)); }
  };
  $('wtDiscard').onclick = async () => {
    if (!activeWorktree) return toast('Select a worktree.');
    try { await jarvin.worktreeDiscard(activeWorktree); toast('Worktree discarded.'); await refreshWorktrees(); } catch (e: any) { toast(String(e?.message ?? e)); }
  };
  const refreshSubagents = async () => {
    const rows = await jarvin.subagentRuns();
    const box = $('subList');
    box.textContent = '';
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'permrow';
      const info = document.createElement('span');
      info.textContent = `${r.id} [${r.kind}] ${r.state} — ${r.task.slice(0, 80)}`;
      row.appendChild(info);
      if (r.state === 'running') {
        const cancel = document.createElement('button');
        cancel.textContent = 'Cancel';
        cancel.onclick = async () => {
          await jarvin.subagentCancel(r.id);
          await refreshSubagents();
        };
        row.appendChild(cancel);
      }
      box.appendChild(row);
    }
    if (!rows.length) box.textContent = '(none)';
  };
  $('subBtn').onclick = async () => { $<HTMLDialogElement>('subDlg').showModal(); await refreshSubagents(); };
  $('subRefresh').onclick = refreshSubagents;
  $('subClose').onclick = () => $<HTMLDialogElement>('subDlg').close();
  $('attachImg').onclick = () => $('imgFile').click();
  $('imgFile').onchange = async (e) => {
    const input = e.target as HTMLInputElement;
    attachedImages = [];
    for (const f of Array.from(input.files ?? [])) {
      const buf = await f.arrayBuffer();
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      attachedImages.push(b64);
    }
    input.value = '';
    toast(attachedImages.length ? `Attached ${attachedImages.length} image(s)` : 'No image selected');
  };
  $('attachFile').onclick = () => $('fileFile').click();
  $('fileFile').onchange = async (e) => {
    const input = e.target as HTMLInputElement;
    attachedFiles = [];
    updateBrowserAttachment();
    for (const f of Array.from(input.files ?? [])) {
      if (f.type.startsWith('image/')) {
        const buf = await f.arrayBuffer();
        const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        attachedImages.push(b64);
      } else {
        try {
          const text = await f.text();
          attachedFiles.push({ name: f.name, content: text });
        } catch {}
      }
    }
    input.value = '';
    const n = attachedImages.length + attachedFiles.length;
    toast(n ? `Attached ${n} file(s)` : 'No file selected');
  };
}

/** Speak toggle, context meter, model and mode pickers, and new/fork/rename/delete chat. */
function wireChatControls() {
  $('speakToggle').onclick = async () => {
    const on = (settings?.voice?.speak ?? 'off') !== 'off';
    settings = await jarvin.setSettings({ voice: { ...settings.voice, speak: on ? 'off' : 'full' } } as any);
    if (on) voiceCtl.stopSpeaking();
    updateSpeakToggle();
    toast(on ? 'Jarvin will stay silent' : 'Jarvin will speak replies');
  };
  $('ctx').onclick = () => {
    includeActive = false;
    updateCtx();
  };
  modelSel.onchange = async () => (settings = await jarvin.setSettings({ model: modelSel.value }));
  modeSel.onchange = async () => {
    const next = modeSel.value as Mode;
    if (next === 'auto') {
      const ok = window.confirm('Enable Full auto mode? Jarvin will make edits and run commands without asking. (Checkpoints stay on.)');
      if (!ok) {
        modeSel.value = settings.mode;
        return;
      }
    }
    settings = await jarvin.setSettings({ mode: next });
  };
  $('forkChat').onclick = async () => {
    if (running) return toast('Stop or finish the current task before switching chats.');
    if (!settings.workspace) return;
    try { const r = await jarvin.forkChatSession(); if (r.id) toast('Forked chat created'); }
    catch (e: any) { toast(String(e?.message ?? e)); }
  };
  $('newChat').onclick = async () => {
    if (running) return toast('Stop or finish the current task before starting a new chat.');
    let r: Awaited<ReturnType<typeof jarvin.newChatSession>>;
    try { r = await jarvin.newChatSession(); } catch (e: any) { toast(String(e?.message ?? e)); return; }
    toolRows.clear();
    restoreChat(r.messages);
    void refreshSessions();
    input.focus();
  };
  $('renChat').onclick = async () => {
    const s = await jarvin.chatSessions();
    if (!s.active) return;
    const meta = s.sessions.find((x) => x.id === s.active);
    const title = prompt('Rename chat:', meta?.title ?? '');
    if (title) {
      await jarvin.renameChatSession(s.active, title);
      void refreshSessions();
    }
  };
  $('delChat').onclick = async () => {
    if (running) return toast('Stop or finish the current task before deleting a chat.');
    const s = await jarvin.chatSessions();
    if (!s.active || !confirm('Delete this chat?')) return;
    try { await jarvin.deleteChatSession(s.active); } catch (e: any) { toast(String(e?.message ?? e)); return; }
    toolRows.clear();
    restoreChat(await jarvin.chatHistory());
    void refreshSessions();
  };
}

/** Model list refresh, session picker, chat and top menus, session search and global shortcuts. */
function wireChatMenusAndShortcuts() {
  // Opening the model list re-checks Ollama (at most every 20s) so newly pulled/started models appear.
  modelSel.addEventListener('mousedown', () => { if (Date.now() - modelsLoadedAt > 20000) void loadModels(true); });
  $('sessionSel').onchange = async () => {
    if (running) { toast('Stop or finish the current task before switching chats.'); void refreshSessions(); return; }
    let r: Awaited<ReturnType<typeof jarvin.loadChatSession>>;
    try { r = await jarvin.loadChatSession($<HTMLSelectElement>('sessionSel').value); }
    catch (e: any) { toast(String(e?.message ?? e)); void refreshSessions(); return; }
    toolRows.clear();
    restoreChat(r.messages);
    void refreshSessions();
  };
  // Chat "more" menu: pin/archive/fork/rename/export/delete live here instead of eight cramped icons.
  $('probBtn').onclick = () => { const p = $('probPanel'); p.hidden = !p.hidden; if (!p.hidden && !problemsResult.checks.length) void runProblems(); };
  $('ppClose').onclick = () => { $('probPanel').hidden = true; };
  $('ppRun').onclick = () => void runProblems();
  $('ppFixAll').onclick = () => {
    const errs = problemsResult.problems.filter((p) => p.severity === 'error');
    if (errs.length) void send(autoFixPrompt(errs, 0).replace(/^\[Automatic check 1\] /, ''));
  };
  const chatMenu = $('chatMenu');
  const closeChatMenu = () => { chatMenu.hidden = true; };
  $('chatMore').onclick = (e) => {
    e.stopPropagation();
    chatMenu.hidden = !chatMenu.hidden;
    if (!chatMenu.hidden) $<HTMLInputElement>('sessionSearch').focus();
  };
  chatMenu.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button.mi')) closeChatMenu();
    e.stopPropagation();
  });
  document.addEventListener('click', closeChatMenu);
  const topMenu = $('topMenu');
  $('topMore').onclick = (e) => { e.stopPropagation(); topMenu.hidden = !topMenu.hidden; };
  topMenu.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('button.mi')) topMenu.hidden = true; e.stopPropagation(); });
  document.addEventListener('click', () => { topMenu.hidden = true; });

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !chatMenu.hidden) closeChatMenu(); });
  const sessSearch = $<HTMLInputElement>('sessionSearch');
  sessSearch.oninput = () => { sessionQuery = sessSearch.value; void refreshSessions(); };
  $('pinChat').onclick = async () => {
    const s = await jarvin.chatSessions();
    if (!s.active) return;
    const meta = s.sessions.find((x) => x.id === s.active);
    await jarvin.updateChatSession(s.active, { pinned: !meta?.pinned });
    void refreshSessions();
  };
  $('archChat').onclick = async () => {
    const s = await jarvin.chatSessions();
    if (!s.active) return;
    const meta = s.sessions.find((x) => x.id === s.active);
    await jarvin.updateChatSession(s.active, { archived: !meta?.archived });
    if (!meta?.archived) { toolRows.clear(); restoreChat(await jarvin.chatHistory()); }
    void refreshSessions();
  };
  stopBtn.onclick = () => { userStopped = true; void jarvin.abort(); };
  $('composer').onsubmit = (e) => {
    e.preventDefault();
    void send();
  };
  input.oninput = () => {
    autosize();
    updateComplete();
  };
  input.onkeydown = (e) => {
    const menu = completeEl;
    if (!menu.hidden) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        // keep simple: Enter accepts first
        return;
      }
      if ((e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) && completeItems.length) {
        e.preventDefault();
        acceptComplete(0);
        return;
      }
      if (e.key === 'Escape') {
        menu.hidden = true;
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void send();
    }
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void send();
    }
  };
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === 's') {
      e.preventDefault();
      void save();
    } else if (mod && e.key === 'b') {
      e.preventDefault();
      $('toggleSide').click();
    } else if (mod && e.key === 'l') {
      e.preventDefault();
      input.focus();
    } else if (mod && (e.key === 'p' || e.key === 'P')) {
      e.preventDefault();
      void openPalette(e.shiftKey ? 'commands' : 'files');
    } else if (mod && (e.key === 't' || e.key === 'T')) {
      e.preventDefault();
      void openPalette('symbols');
    } else if (mod && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      void openPalette('search');
    } else if (e.key === 'Escape' && running) { userStopped = true; void jarvin.abort(); }
    else if (mod && e.shiftKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      void jarvin.killAll();
      toast('Stopped all runs and terminals');
    }
  });
}

/** MCP servers dialog and the privacy exclusions list. */
function wireMcpAndPrivacyDialogs() {
  const mcpDlg = $<HTMLDialogElement>('mcpDlg');
  $('mcpBtn').onclick = async () => {
    const m = await jarvin.getMcp();
    $<HTMLTextAreaElement>('mcpText').value = m.config;
    renderMcp(m.status);
    mcpDlg.showModal();
  };
  $('mcpClose').onclick = () => mcpDlg.close();
  let privacyWindows: { app: string; title: string }[] = [];
  const refreshPrivacyWindows = async () => {
    const select = $<HTMLSelectElement>('privacyVisibleWindows');
    select.replaceChildren(new Option('Loading open windows…', ''));
    try {
      privacyWindows = await jarvin.privacyWindows();
      select.replaceChildren(...privacyWindows.map((item, index) => new Option(`${item.app || 'Unknown app'} — ${item.title || 'Untitled window'}`, String(index))));
      if (!privacyWindows.length) select.replaceChildren(new Option('No open windows found', ''));
    } catch (error) {
      privacyWindows = [];
      select.replaceChildren(new Option('Could not list open windows', ''));
      toast(String((error as Error)?.message ?? error));
    }
  };
  const addPrivacyEntry = (field: string, value: string) => {
    value = value.replace(/[\r\n,]+/g, ' ').trim().slice(0, 120);
    if (!value) return;
    const textarea = $<HTMLTextAreaElement>(field);
    const entries = textarea.value.split(/[\r\n]+/).map((item) => item.trim()).filter(Boolean);
    if (!entries.some((item) => item.toLowerCase() === value.toLowerCase())) textarea.value = [...entries, value].join('\n');
  };
  $('privacyRefreshWindows').onclick = () => void refreshPrivacyWindows();
  $('privacyAddApp').onclick = () => { const selected = privacyWindows[Number($<HTMLSelectElement>('privacyVisibleWindows').value)]; if (selected) addPrivacyEntry('privacyExcludedApps', selected.app); };
  $('privacyAddTitle').onclick = () => { const selected = privacyWindows[Number($<HTMLSelectElement>('privacyVisibleWindows').value)]; if (selected) addPrivacyEntry('privacyExcludedTitles', selected.title); };
  $('privacyBtn').onclick = async () => {
    settings = await jarvin.getSettings();
    $<HTMLInputElement>('privacyOffline').checked = !!settings.offline;
    $<HTMLInputElement>('privacyScreenPaused').checked = settings.observationPaused === true;
    $<HTMLTextAreaElement>('privacyExcludedApps').value = (settings.excludedApps ?? []).join('\n');
    $<HTMLTextAreaElement>('privacyExcludedTitles').value = (settings.excludedWindowTitles ?? []).join('\n');
    $<HTMLDialogElement>('privacyDlg').showModal();
    void refreshPrivacyWindows();
  };
  $('privacySave').onclick = async () => {
    const entries = (id: string) => [...new Set($<HTMLTextAreaElement>(id).value.split(/[\r\n,]+/).map((value) => value.trim()).filter(Boolean))];
    try {
      settings = await jarvin.setSettings({ offline: $<HTMLInputElement>('privacyOffline').checked, observationPaused: $<HTMLInputElement>('privacyScreenPaused').checked, excludedApps: entries('privacyExcludedApps'), excludedWindowTitles: entries('privacyExcludedTitles') });
      $<HTMLDialogElement>('privacyDlg').close();
    } catch (error) { toast(String((error as Error)?.message ?? error)); }
  };
  $('privacyClose').onclick = () => $<HTMLDialogElement>('privacyDlg').close();
  $('mcpSave').onclick = async () => {
    const r = await jarvin.setMcp($<HTMLTextAreaElement>('mcpText').value);
    renderMcp(r.status);
    if (r.error) $('mcpStatus').insertAdjacentHTML('afterbegin', `<div class="bad">${esc(r.error)}</div>`);
  };
}

/** Settings dialog: models, updates, voice options and saving. */
function wireSettingsDialog() {
  const setDlg = $<HTMLDialogElement>('setDlg');
  $('sModels').onclick = () => void modelUi.openModels();
  let lastUp: UpdateState | null = null;
  const showUpdate = (s: UpdateState) => {
    const prev = lastUp?.phase;
    lastUp = s;
    $('upText').textContent = updateText(s);
    $('upText').className = s.phase === 'error' ? 'hint bad' : 'hint';
    $('upDownload').hidden = s.phase !== 'available';
    $('upInstall').hidden = s.phase !== 'ready';
    $<HTMLButtonElement>('upCheck').disabled = s.phase === 'checking' || s.phase === 'downloading';
    if (prev !== s.phase && s.phase === 'available') toast(`Jarvin ${s.next} is available. Settings → Updates.`);
    if (prev !== s.phase && s.phase === 'ready') toast('Update downloaded. Settings → Updates → Restart and install.');
  };
  jarvin.onUpdate(showUpdate);
  void jarvin.updateState().then(showUpdate);
  const saveUpdateFields = async () => {
    const raw = $<HTMLInputElement>('sUpdateUrl').value.trim();
    if (raw) {
      const c = validUpdateUrl(raw);
      if (!c.ok) { toast(c.error ?? 'Bad update address.'); return false; }
      $<HTMLInputElement>('sUpdateUrl').value = c.url!;
    }
    settings = await jarvin.setSettings({ updateUrl: raw ? validUpdateUrl(raw).url : '', updateAuto: $<HTMLInputElement>('sUpdateAuto').checked });
    return true;
  };
  $('upCheck').onclick = async () => { if (await saveUpdateFields()) showUpdate(await jarvin.updateCheck()); };
  $('upDownload').onclick = async () => showUpdate(await jarvin.updateDownload());
  $('upInstall').onclick = () => void jarvin.updateInstall();
  $('sSetup').onclick = () => void modelUi.openSetup();
  $('setBtn').onclick = async () => {
    settings = await jarvin.getSettings();
    $<HTMLInputElement>('sBase').value = settings.baseUrl;
    $<HTMLInputElement>('sApiKey').value = settings.providerApiKey ?? '';
    $<HTMLInputElement>('sEmbed').value = settings.embeddingModel;
    $<HTMLInputElement>('sCoding').value = settings.codingModel ?? '';
    $<HTMLInputElement>('sReasoning').value = settings.reasoningModel ?? '';
    $<HTMLInputElement>('sVision').value = settings.visionModel ?? '';
    $<HTMLInputElement>('sCtx').value = String(settings.numCtx);
    $<HTMLInputElement>('sTemp').value = String(settings.temperature);
    $<HTMLInputElement>('sSteps').value = String(settings.maxSteps);
    $<HTMLSelectElement>('sShell').value = settings.shell;
    $<HTMLInputElement>('sNotify').checked = settings.notifyDone !== false;
    $<HTMLInputElement>('sResume').checked = settings.resumeTasks !== false;
    $<HTMLInputElement>('sStartLogin').checked = settings.startAtLogin === true;
    const pro = proactiveSettings(settings.proactive);
    $<HTMLInputElement>('sProactive').checked = pro.enabled;
    $<HTMLInputElement>('sProBattery').checked = pro.lowBattery;
    $<HTMLInputElement>('sProReminders').checked = pro.speakReminders;
    $<HTMLInputElement>('sProDownloads').checked = pro.downloads;
    $<HTMLInputElement>('sProCommands').checked = pro.commands;
    $<HTMLInputElement>('sProMeetings').checked = pro.meetings;
    $<HTMLInputElement>('sProQuietFrom').value = pro.quietFrom;
    $<HTMLInputElement>('sProQuietTo').value = pro.quietTo;
    $<HTMLInputElement>('sOffline').checked = !!settings.offline;
    $<HTMLInputElement>('sAutocomplete').checked = !!settings.autocomplete;
    $<HTMLInputElement>('sAutoCheck').checked = settings.autoCheck !== false;
    $<HTMLInputElement>('sCompletionModel').value = settings.completionModel ?? '';
    $<HTMLInputElement>('sUpdateUrl').value = settings.updateUrl ?? '';
    $<HTMLInputElement>('sUpdateAuto').checked = settings.updateAuto !== false;
    void jarvin.updateState().then(showUpdate);
    fillVoiceSettings(settings.voice, [...modelSel.options].map((o) => o.value).filter(Boolean));
    void refreshVoiceStatus(jarvin, settings.voice);
    void refreshVoiceMcpPanel(jarvin);
    void renderVoiceHistory(jarvin);
    void renderPerms(await jarvin.getPermissions());
    setDlg.showModal();
  };
  $('vDownload').onclick = async () => {
    const v = collectVoiceSettings(settings.voice);
    settings = await jarvin.setSettings({ voice: v });
    $('vStatus').textContent = 'Downloading… this can take a minute.';
    const r = await jarvin.voiceDownload();
    if (!r.ok) $('vStatus').textContent = r.error ?? 'Download failed.';
    else void refreshVoiceStatus(jarvin, settings.voice);
  };
  $('vHistClear').onclick = async () => renderVoiceHistory(jarvin, await jarvin.voiceHistoryDelete());
  const applyVoice = async () => {
    settings = await jarvin.setSettings({ voice: collectVoiceSettings(settings.voice) });
    voiceCtl.syncHandsFree();
    updateSpeakToggle();
    void refreshVoiceStatus(jarvin, settings.voice);
    setTimeout(() => void refreshVoiceMcpPanel(jarvin), 400);
  };
  for (const id of ['vSize', 'vLang', 'vTranslate', 'vOffline', 'vEnabled', 'vSensitivity', 'vOverlay', 'vLive', 'vInsert', 'vCommands', 'vApprove', 'vSpeak', 'vMcp', 'vMcpMic', 'vMcpPort']) $(id).addEventListener('change', applyVoice);
  wireHotkeyField(applyVoice);
  $('setClose').onclick = () => setDlg.close();
  setDlg.addEventListener('close', () => voiceCtl.cancelDiagnostic());
  $('setSave').onclick = async () => {
    settings = await jarvin.setSettings({
      baseUrl: $<HTMLInputElement>('sBase').value.trim().replace(/\/$/, ''),
      providerApiKey: $<HTMLInputElement>('sApiKey').value.trim(),
      embeddingModel: $<HTMLInputElement>('sEmbed').value.trim() || 'nomic-embed-text',
      codingModel: $<HTMLInputElement>('sCoding').value.trim() || undefined,
      reasoningModel: $<HTMLInputElement>('sReasoning').value.trim() || undefined,
      visionModel: $<HTMLInputElement>('sVision').value.trim() || undefined,
      numCtx: Number($<HTMLInputElement>('sCtx').value) || 16384,
      temperature: Number($<HTMLInputElement>('sTemp').value) || 0,
      maxSteps: Number($<HTMLInputElement>('sSteps').value) || 40,
      shell: $<HTMLSelectElement>('sShell').value as Settings['shell'],
      notifyDone: $<HTMLInputElement>('sNotify').checked,
      resumeTasks: $<HTMLInputElement>('sResume').checked,
      startAtLogin: $<HTMLInputElement>('sStartLogin').checked,
      proactive: proactiveSettings({ enabled: $<HTMLInputElement>('sProactive').checked, lowBattery: $<HTMLInputElement>('sProBattery').checked, speakReminders: $<HTMLInputElement>('sProReminders').checked, downloads: $<HTMLInputElement>('sProDownloads').checked, commands: $<HTMLInputElement>('sProCommands').checked, meetings: $<HTMLInputElement>('sProMeetings').checked, quietFrom: $<HTMLInputElement>('sProQuietFrom').value, quietTo: $<HTMLInputElement>('sProQuietTo').value }),
      offline: $<HTMLInputElement>('sOffline').checked,
      autocomplete: $<HTMLInputElement>('sAutocomplete').checked,
      autoCheck: $<HTMLInputElement>('sAutoCheck').checked,
      completionModel: $<HTMLInputElement>('sCompletionModel').value.trim(),
      updateUrl: (() => { const r = $<HTMLInputElement>('sUpdateUrl').value.trim(); return r ? (validUpdateUrl(r).url ?? settings.updateUrl ?? '') : ''; })(),
      updateAuto: $<HTMLInputElement>('sUpdateAuto').checked,
      voice: collectVoiceSettings(settings.voice),
    });
    voiceCtl.syncVisibility();
    voiceCtl.syncHandsFree();
    void voiceCtl.warmNatural();
    setDlg.close();
    void loadModels();
    updateContextMeter();
  };
}

/** Integrated terminal panel: one shell session, resize, restart and docking. */
function wireTerminalPanel() {
  // Integrated terminal panel (E1). One shell session that survives hiding the panel; "Restart" starts a fresh one.
  term = null;
  const termPanel = $('termPanel') as HTMLElement;
  const termDims = $('termDims');
  let fit: FitAddon | null = null;
  let termId: string | null = null;
  let termExited = false;
  let creating = false;
  let early: { id: string; data: string }[] = [];
  let backendInfo: { backend: 'conpty' | 'winpty' | null; build: number } = { backend: null, build: 0 };
  let termH = Number(localStorage.getItem('jarvin-term-h')) || Math.round(window.innerHeight * 0.38);
  let expandedTerm = false;
  let fitRaf = 0;

  const dock = (open: boolean) => {
    document.documentElement.style.setProperty('--termh', open ? `${termH}px` : '0px');
    termPanel.style.height = `${termH}px`;
  };
  const doFit = () => {
    if (fitRaf) return;
    fitRaf = requestAnimationFrame(() => {
      fitRaf = 0;
      if (termPanel.hidden || !term || !fit) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      termDims.textContent = `${term.cols} × ${term.rows}`;
      if (termId) void jarvin.termResize(termId, term.cols, term.rows);
    });
  };
  const termWriteSafe = (data: string) => term?.write(data);

  async function startShell() {
    if (creating || !term) return;
    creating = true;
    termExited = false;
    early = [];
    try {
      fit?.fit();
      const r = await jarvin.termCreate(settings.workspace || undefined, term.cols, term.rows);
      if (!r) {
        term.writeln('\r\n[Jarvin] The terminal could not start. Check app.log for details.');
        return;
      }
      termId = r.id;
      backendInfo = { backend: r.backend, build: r.build };
      if (r.backend) term.options.windowsPty = { backend: r.backend, buildNumber: r.build };
      for (const e of early) if (e.id === termId) termWriteSafe(e.data);
      early = [];
      termDims.textContent = `${term.cols} × ${term.rows}`;
      $('termShell').textContent = r.label;
      term.focus();
    } finally {
      creating = false;
    }
  }

  function buildTerm() {
    term = new Terminal({
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      theme: appThemeIsLight()
        ? { background: '#f8fafc', foreground: '#18212f', cursor: '#0284c7', selectionBackground: '#bcd4f0' }
        : { background: '#0f172a', foreground: '#f8fafc', cursor: '#67e8f9', selectionBackground: '#2b4a7a' },
      fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
      fontSize: 14,
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new SearchAddon());
    term.loadAddon(new WebLinksAddon((_e, uri) => void jarvin.openExternal(uri)));
    term.open($('termhost'));

    // Input and output are wired before the shell exists, so neither the first prompt nor the first keys are lost.
    term.onData((d) => {
      if (termExited) {
        void startShell();
        return;
      }
      if (termId) void jarvin.termWrite(termId, d);
    });
    jarvin.onTermData((p) => {
      if (!termId) early.push(p);
      else if (p.id === termId) termWriteSafe(p.data);
    });
    jarvin.onTermExit((p) => {
      if (p.id !== termId) return;
      termId = null;
      termExited = true;
      term?.writeln(`\r\n\x1b[90m[shell exited with code ${p.exitCode}. Press any key to start a new one.]\x1b[0m`);
    });

    // Copy and paste like a normal terminal: Ctrl+C copies only while text is selected, Ctrl+V and Ctrl+Shift+V paste.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const k = e.key.toLowerCase();
      if (e.ctrlKey && (k === 'c' && (e.shiftKey || term!.hasSelection()))) {
        void navigator.clipboard.writeText(term!.getSelection()).catch(() => undefined);
        term!.clearSelection();
        return false;
      }
      // Ctrl+V / Ctrl+Shift+V: the browser's own paste event inserts the text; xterm must not also send ^V to the shell.
      if (e.ctrlKey && k === 'v') return false;
      return true;
    });
    // Keys typed in the terminal belong to the shell: keep the app's own shortcuts (Ctrl+L, Ctrl+P, Ctrl+B, Esc…) away from them.
    $('termhost').addEventListener('keydown', (e) => {
      const ke = e as KeyboardEvent;
      if ((ke.ctrlKey || ke.metaKey) && ke.shiftKey && ['k', 'm'].includes(ke.key.toLowerCase())) return;
      e.stopPropagation();
    });
    const ro = new ResizeObserver(() => doFit());
    ro.observe($('termhost'));
    window.addEventListener('resize', doFit);
  }

  const showTerm = async () => {
    termPanel.hidden = false;
    dock(true);
    if (!term) {
      buildTerm();
      doFit();
      await startShell();
    } else {
      doFit();
      term.focus();
    }
  };
  const hideTerm = () => {
    termPanel.hidden = true;
    dock(false);
    input.focus();
  };
  $('termBtn').onclick = () => (termPanel.hidden ? void showTerm() : hideTerm());
  $('termCloseBtn').onclick = hideTerm;
  $('termRestart').onclick = async () => {
    if (termId) await jarvin.termKill(termId);
    termId = null;
    term?.reset();
    await startShell();
  };
  $('termExpand').onclick = () => {
    expandedTerm = !expandedTerm;
    termH = expandedTerm ? Math.round(window.innerHeight * 0.8) : Number(localStorage.getItem('jarvin-term-h')) || Math.round(window.innerHeight * 0.38);
    dock(true);
    $('termExpand').textContent = expandedTerm ? 'Restore' : 'Maximize';
    doFit();
  };
  $('termResize').onmousedown = (e: MouseEvent) => {
    e.preventDefault();
    const y0 = e.clientY;
    const h0 = termPanel.getBoundingClientRect().height;
    const move = (ev: MouseEvent) => {
      termH = Math.round(Math.max(140, Math.min(window.innerHeight * 0.84, h0 - (ev.clientY - y0))));
      dock(true);
      doFit();
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      localStorage.setItem('jarvin-term-h', String(termH));
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  void backendInfo;
}

const latestCard = () => [...document.querySelectorAll<HTMLElement>('.cpcard:not(.done)')].pop() ?? null;
const voiceActions: VoiceActions = {
  isRunning: () => running,
  isActing: () => running && runUsedTools,
  abort: () => { userStopped = true; void jarvin.abort(); },
  interruptReply: async () => {
    if (!running) return;
    userStopped = true;
    await jarvin.abort();
    const deadline = Date.now() + 10000;
    while (running && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    if (running) throw new Error('The previous task is still stopping. Please try your request again.');
  },
  stopAll: () => { userStopped = true; void jarvin.killAll(); },
  clearInput: () => {
    input.value = '';
    autosize();
  },
  newChat: () => $('newChat').click(),
  approval: () => {
    const first = pendingAppr.values().next();
    return first.done ? null : first.value;
  },
  startUndo: () => {
    const b = latestCard()?.querySelector<HTMLButtonElement>('.cpundo');
    if (!b || b.hidden || b.disabled || b.textContent !== 'Undo') return 'none';
    b.click();
    return 'opened';
  },
  confirmUndo: () => {
    const b = latestCard()?.querySelector<HTMLButtonElement>('.cpundo');
    if (!b || b.hidden || b.disabled) return 'none';
    if (b.textContent === 'Confirm undo') {
      b.click();
      return 'done';
    }
    return b.textContent === 'Overwrite anyway' ? 'overwrite' : 'none';
  },
  openFile: (rel) => openFile(rel),
  closeTab: () => {
    if (!activeTab) return toast('No tab is open');
    if (activeTab.dirty) return toast('This file has unsaved changes. Save it or close it with the mouse.');
    closeTab(activeTab);
  },
  nextTab: () => tabs.length && activate(tabs[(tabs.indexOf(activeTab!) + 1) % tabs.length]),
  prevTab: () => tabs.length && activate(tabs[(tabs.indexOf(activeTab!) - 1 + tabs.length) % tabs.length]),
  openSettings: () => $('setBtn').click(),
  closeSettings: () => {
    if ($<HTMLDialogElement>('setDlg').open) $('setClose').click();
  },
  toggleSidebar: () => $('toggleSide').click(),
  scroll: (dir, amount) => msgs.scrollBy({ top: (dir === 'up' ? -1 : 1) * msgs.clientHeight * (amount === undefined ? 0.8 : amount * 0.25), behavior: 'smooth' }),
  focusInput: () => input.focus(),
  selection: () => {
    if (!activeTab || !monacoEditor || !editorModel) return null;
    const sel = monacoEditor.getSelection();
    if (!sel || sel.isEmpty()) return null;
    const text = editorModel.getValueInRange(sel);
    if (!text) return null;
    return { path: activeTab.path, text };
  },
  sendText: async (text) => {
    if (running) return toast('Jarvin is busy. Say "stop" first.');
    await send(text, { preserveDraft: true });
  },
};
const voiceCtl = initVoice({ jarvin, getSettings: () => settings, input, send: () => send(), toast, autosize, models: () => [...modelSel.options].map((o) => o.value), actions: voiceActions, files: () => jarvin.voiceFiles(), onSpeaking: (speaking) => { assistantSpeaking = speaking; publishAssistantState(); }, onMicLevel: (level, hearing) => {
  assistantMicLevel = level; assistantHearing = hearing;
  if (performance.now() - assistantLevelAt < 100) return;
  assistantLevelAt = performance.now(); publishAssistantState();
} });
const transcriber = initTranscribe({ jarvin, input, autosize, toast });
const traceUi = createTraceUi(jarvin, { toast });
function sendQueued(item: { text: string; images?: string[] }) {
  attachedImages = item.images ? [...item.images] : [];
  void send(item.text);
}
const tasksUi = createTasksUi(jarvin, {
  toast, openPreview: (u) => void openPreview(u), sendQueued,
  useRoutine: (routine, runNow) => {
    if (running) { toast('Stop or finish the current task before starting a routine.'); return false; }
    if (!settings.workspace) { toast('Open a folder before using a routine.'); return false; }
    if (input.value.trim() || attachedImages.length || attachedFiles.length) { toast('Send or clear your current draft and attachments first.'); return false; }
    const request = routineRequest(routine);
    if (runNow) void send(request);
    else { input.value = request; autosize(); input.focus(); toast('Review and edit the routine request before sending.'); }
    return true;
  },
  runRoutineSteps: (routine, scheduled) => {
    if (!settings.workspace) { toast('Open a folder before using a routine.'); return false; }
    const steps = routineStepRequests(routine);
    if (!running && (input.value.trim() || attachedImages.length || attachedFiles.length)) {
      toast(scheduled ? `Scheduled routine "${routine.name}" did not start because a draft is open. Run it from Tasks when ready.` : 'Send or clear your current draft and attachments first.');
      return false;
    }
    if (tasksUi.queued() + steps.length > 20) { toast(`Routine "${routine.name}" did not start: the queue is too full for its ${steps.length} steps.`); return false; }
    // While a run is active every step waits in the queue; otherwise step 1 starts now and the rest wait behind it.
    if (!running) void send(steps.shift()!, { preserveDraft: true });
    for (const step of steps) tasksUi.enqueue(step);
    if (scheduled) toast(`Scheduled routine "${routine.name}" started.`);
    return true;
  },
  reviewRun: (run) => {
    if (running) { toast('Stop or finish the current task before reviewing another.'); return false; }
    if (input.value.trim() || attachedImages.length || attachedFiles.length) { toast('Send or clear your current draft and attachments first.'); return false; }
    input.value = resumeRequest(run);
    autosize(); input.focus();
    toast('Review the draft and send it when ready. The original chat is not opened automatically.');
    return true;
  },
});
const imageUi = createImageUi(jarvin, { toast, attach: (b64) => { attachedImages.push(b64); } });
const gitUi = createGitUi(jarvin, { toast, refreshTree: () => { void refreshTree(); } });
const modelUi = createModelUi(jarvin, {
  getSettings: () => settings,
  setSettings: async (patch) => { settings = await jarvin.setSettings(patch); },
  reloadModels: () => loadModels(true),
  openWorkspace: () => openWorkspace(),
  toast,
});
wireVoiceMcpPanel(jarvin, toast);
initVoiceMcp({ jarvin, getSettings: () => settings, busy: () => voiceCtl.isBusy(), toast });
$('vTranscribeFile').onclick = () => { ($('setDlg') as HTMLDialogElement).close(); transcriber.open(); };
const voiceTestUi = initVoiceTest({ jarvin, getSettings: () => settings, setSettings: async (patch) => { settings = await jarvin.setSettings(patch); }, setListeningPaused: (paused) => voiceCtl.setVoiceTest(paused), toast });
$('vTestBtn').onclick = () => { ($('setDlg') as HTMLDialogElement).close(); void voiceTestUi.open(); };
/** After a crash or forced exit, continue the newest interrupted task once. The old record is removed first so a task that crashes the app cannot loop. */
async function maybeAutoResume() {
  if (settings.resumeTasks === false || new URLSearchParams(location.search).has('e2e') || !settings.workspace) return;
  const run = pickResumable(await jarvin.interruptedRuns().catch(() => []), Date.now());
  if (!run || running || input.value.trim() || attachedImages.length || attachedFiles.length) return;
  try { await jarvin.dismissRun(run.id); } catch { return; }
  toast('Continuing the task that was interrupted. Press Stop to cancel.');
  void send(resumeRequest(run));
  void tasksUi.refreshRecovered();
}
void init().then(() => {
  setTimeout(() => void maybeAutoResume(), 3000);
  initProactive({ jarvin, getSettings: () => settings, say: (text) => voiceCtl.speak(text), toast, isSpeaking: () => assistantSpeaking });
});
