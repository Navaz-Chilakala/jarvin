import { ensureOllamaRunning } from './ollama-start';
import { runProblemChecks } from './problems';
import { HookTrust, loadHooks, loadPersonas, loadRules, runHooks } from './extensions';
import { personaAllows, personaPrompt, type Persona } from '../shared/ext';
import { autoFixPrompt } from '../shared/problems';
import { cleanCompletion, cleanEdit, completeMessages, editMessages } from '../shared/inline';
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, Notification, powerMonitor, screen, session, shell, Tray } from 'electron';
import { allowReload, isBackgroundStart, loginItem } from './background';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { readMemoryIndex, listManagedMemories, readManagedMemory, updateManagedMemory, deleteManagedMemory } from './memory';
import { loadSettings, saveSettings, mcpConfigPath } from './settings';
import { chatOnce, primeChat, type OMsg } from './ollama';
import { setProviderApiKey, hasProviderApiKey, setOllamaModels } from './openai';
import { ollamaStatus, localModels, pullModel, cancelPull, cancelAllPulls, deleteModel, pulling } from './modelmgr';
import { validModelName } from '../shared/models';
import { createUpdater } from './updater';
import { GitRepo } from './git';
import { chatOnce as routedChat } from './openai';
import { COMMIT_SYSTEM, PR_SYSTEM, commitUser, prUser, parseCommitMessage, parsePr, compareUrl } from '../shared/gitparse';
import { listTraces, readTrace, deleteTrace, clearTraces, validTraceId } from './traces';
import { PreviewWindow } from './preview';
import { jobs } from './jobs';
import { shortText } from '../shared/jobs';
import { dataUrl, IMAGE_MAX_BYTES, imageMime } from '../shared/images';
import { builtinTools, resolveSafe, IGNORE, type ToolDef, subagentWorktrees } from './tools';
import { isSensitivePath } from './sandbox';
import { redactLogValue } from './log-redaction';
import { RunJournal } from './run-journal';
import { ReminderStore } from './reminders';
import { RoutineStore } from './routines';
import { BrowserShare } from './browser-share';
import { AssistantWidget } from './assistant-widget';
import { folderFromArguments } from './cli';
import { WindowsAutomation, windowsUiaWorker } from './windows-uia';
import { VisualGrounding } from './visual-grounding';
import { PiperService } from './piper';
import { windowsReminderBackup } from './reminder-backup';
import { buildSystemPrompt } from './prompt';
import { history, ensureChatSession, loadActiveChat, saveActiveChat, createChatSession, deleteChatSession, renameChatSession, updateChatSession, readChatIndex, writeChatIndex, loadSessionMessages, saveSessionMessages, slugTitle, chatKey, chatRoot, chatIndexFile, sessionFile, type SessionMeta, type ChatIndex } from './chat-store';
import { shellFor, isDangerousCommand, interactiveShell, terminalEnv } from './terminal';
import { CheckpointStore, type Recorder } from './checkpoints';
import { applyPatch, listPatchHunks, filterPatch } from './patch';
import { workspaceSymbols } from './intelligence';
import { PermissionStore, decide, rulesFor, describeRule, validateRule, workspaceDeny, requiresFreshApproval, type FolderRules } from './permissions';
import { McpManager } from './mcp';
import { runAgent, toolSpecs } from './agent';
import * as pty from 'node-pty';
import { VoiceService } from './voice';
import { OverlayWindow } from './overlay';
import { pasteIntoActiveApp } from './paste';
import { detectActiveApp } from './activeapp';
import { VoiceMcpServer, WindowBridge } from './voicemcp';
import { verifiedChange, applyVerified, discardVerified, discardAllVerified, verifiedDiff, currentCard } from './verifiedrun';
import { sweepSandboxes, type Sandbox } from './verified';
import type { ActiveApp } from '../shared/apprules';
import type { OverlayMsg, VoiceStatus } from '../shared/voice';
import type { AgentEvent, Settings, TreeEntry } from '../shared/types';
import type { AssistantWidgetAction, AssistantWidgetState } from '../shared/assistant-widget';
import { VISIBLE_CHROME_PROMPT } from './browser-policy';
import { warmCompanionModels } from './companion-models';
import { ScreenObserver } from './screen-observer';
import { LiveScreenProvider } from './live-screen';
import { assertDisplayCaptureAllowed, setExclusionStatusListener, setScreenExclusions, setScreenLocked, setScreenObservationPaused, setVisibleWindowScanner } from './screen-privacy';
import { isCompanionRequest, routeToolNames } from '../shared/tool-routing';

let win: BrowserWindow | null = null;
let settings: Settings;
let running: AbortController | null = null;
let pauseRequested = false;
let contextBusy = false;
let activeDesktop: WindowsAutomation | null = null;
let activeVisual: VisualGrounding | null = null;
const pending = new Map<string, (d: 'allow' | 'always' | 'deny', args?: any) => void>();
const pendingQuestions = new Map<string, (answer: string) => void>();

function cancelCurrentRun(): void {
  running?.abort();
  for (const resolve of pending.values()) resolve('deny');
  pending.clear();
  for (const resolve of pendingQuestions.values()) resolve('Cancelled by user.');
  pendingQuestions.clear();
}

function stopCurrentRun(): void { pauseRequested = false; cancelCurrentRun(); }
function pauseCurrentRun(): void { if (running && !running.signal.aborted) { pauseRequested = true; cancelCurrentRun(); } }

function auditLog(decision: string, tool: string, args: any): void {
  try {
    const p = path.join(app.getPath('userData'), 'jarvin-audit.jsonl');
    fs.appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), decision, tool, args: redactLogValue(args) }) + '\n');
  } catch {
    /* ignore audit failures */
  }
}
const pendingArgs = new Map<string, any>();
const terminals = new Map<string, any>();
const subagentRuns = new Map<string, any>();
const mcp = new McpManager();
let perms: PermissionStore;
let checkpoints: CheckpointStore;
let runJournal: RunJournal | null = null;
let reminders: ReminderStore | null = null;
let routines: RoutineStore | null = null;
let reminderTimer: NodeJS.Timeout | null = null;
const browserShare = new BrowserShare((page) => {
  if (win && !win.isDestroyed()) { win.webContents.send('browser-share:page', page); raiseWindow(win); }
});
const privacyWorker = windowsUiaWorker(path.join(__dirname, 'windows-uia.ps1'));
setVisibleWindowScanner((signal) => privacyWorker({ op: 'privacy_scan' }, signal) as Promise<{ windows: { app: string; title: string }[]; truncated?: boolean; uncertain?: boolean }>);
const liveScreen = new LiveScreenProvider();
const screenObserver = new ScreenObserver(() => liveScreen.frame(), 600, available => assistantWidget.watching(available));
const assistantWidget = new AssistantWidget(() => {
  if (!win || win.isDestroyed() || win.isVisible() || (process.env.JARVIN_E2E === '1' && process.env.JARVIN_E2E_HEADLESS === '1')) return;
  screenObserver.stop();
  liveScreen.stop();
  raiseWindow(win);
}, handleAssistantWidgetAction);
setExclusionStatusListener((blocked) => assistantWidget.screenBlocked(blocked));

let quitting = false;
function compactAssistant(): void {
  if (!win || win.isDestroyed()) return;
  assistantWidget.show(); win.hide();
  if (settings.observationPaused) screenObserver.stop();
  else { screenObserver.start(); screenObserver.invalidate(); }
}

function applyObservationPause(paused: boolean): void {
  setScreenObservationPaused(paused);
  assistantWidget.observationPaused(paused);
  if (paused) {
    screenObserver.stop();
    liveScreen.stop();
    if (running && !running.signal.aborted) {
      stopCurrentRun();
      if (win && !win.isDestroyed()) win.webContents.send('assistant:action', 'stop');
    }
  } else if (win && !win.isDestroyed() && !win.isVisible()) {
    screenObserver.start();
    screenObserver.invalidate();
  }
}

function applyScreenExclusions(): void {
  setScreenExclusions(settings.excludedApps ?? [], settings.excludedWindowTitles ?? []);
  liveScreen.stop();
  screenObserver.invalidate();
  assistantWidget.watching(false);
  if (running && !running.signal.aborted) {
    stopCurrentRun();
    if (win && !win.isDestroyed()) win.webContents.send('assistant:action', 'stop');
  }
}

function handleAssistantWidgetAction(action: AssistantWidgetAction): void {
  if (action === 'quit') { app.quit(); return; }
  if (action === 'observation') {
    settings = saveSettings(settings, { observationPaused: !settings.observationPaused });
    applyObservationPause(settings.observationPaused === true);
    return;
  }
  if (action === 'stop') { stopCurrentRun(); if (win && !win.isDestroyed()) win.webContents.send('assistant:action', 'stop'); assistantWidget.clearAttention(); return; }
  if (action === 'pause') { pauseCurrentRun(); if (win && !win.isDestroyed()) win.webContents.send('assistant:action', 'stop'); assistantWidget.clearAttention(); return; }
  if (!win || win.isDestroyed()) return;
  if (action === 'voice' || action === 'mute') { win.webContents.send('assistant:action', action); return; }
  screenObserver.stop(); liveScreen.stop(); assistantWidget.watching(false);
  assistantWidget.hide();
  if (!(process.env.JARVIN_E2E === '1' && process.env.JARVIN_E2E_HEADLESS === '1')) { raiseWindow(win); }
  win.webContents.send('assistant:action', action);
}

/** Hands routines whose daily time has arrived to the window, which runs them step by step like a typed request. */
function checkRoutines(): void {
  if (!routines || !win || win.isDestroyed()) return;
  try { for (const routine of routines.takeDue()) { applog(`scheduled routine: ${routine.name}`); win.webContents.send('routines:due', routine); } }
  catch (e: any) { applog(`routine schedule check failed: ${String(e?.message ?? e)}`); }
}

function checkReminders(): void {
  checkRoutines();
  if (!reminders) return;
  try {
    const due = reminders.markDue();
    if (!due.length) return;
    if (win && !win.isDestroyed()) win.webContents.send('reminders:update');
    for (const reminder of due) {
      try {
        if (!Notification.isSupported()) continue;
        const n = new Notification({ title: 'Jarvin reminder', body: reminder.text });
        n.on('click', () => { if (win && !win.isDestroyed()) { raiseWindow(win); } });
        n.show();
      } catch { /* The due reminder remains available in Tasks. */ }
    }
  } catch (e: any) { applog(`reminder check failed: ${String(e?.message ?? e)}`); }
}
let wsWatcher: fs.FSWatcher | null = null;
let wsWatchTimer: NodeJS.Timeout | null = null;
function refreshWorkspaceWatcher() {
  if (wsWatcher) { try { wsWatcher.close(); } catch { /* ignore */ } wsWatcher = null; }
  if (wsWatchTimer) { clearTimeout(wsWatchTimer); wsWatchTimer = null; }
  const root = settings.workspace;
  if (!root) return;
  try {
    wsWatcher = fs.watch(root, { recursive: true }, () => {
      if (wsWatchTimer) clearTimeout(wsWatchTimer);
      wsWatchTimer = setTimeout(() => { emit({ type: 'fs_changed' }); preview.fsChanged(); }, 400);
    });
    wsWatcher.on('error', () => { /* ignore */ });
  } catch { /* ignore */ }
}
let voice: VoiceService;
let piper: PiperService;
/** A desktop notification, only when Jarvin is in the background and the user has not turned them off. */
function notifyUser(title: string, body: string) {
  try {
    if (settings.notifyDone === false || !win || win.isDestroyed() || win.isFocused() || !Notification.isSupported()) return;
    const n = new Notification({ title, body });
    n.on('click', () => { if (win && !win.isDestroyed()) { raiseWindow(win); } });
    n.show();
  } catch { /* notifications are best effort */ }
}
jobs.onChange((list) => { assistantWidget.jobs(list.filter((job) => job.status === 'running').length); if (win && !win.isDestroyed()) win.webContents.send('jobs:update', list); });
jobs.onFinished((j) => {
  if (j.status !== 'done' && j.status !== 'failed') return;
  win?.webContents.send('jobs:finished', j.status);
  notifyUser(j.status === 'done' ? 'Command finished' : 'Command failed', shortText(j.command, 80) + (j.status === 'failed' && j.exitCode !== null ? ` (exit ${j.exitCode})` : ''));
});
const overlay = new OverlayWindow();
const preview = new PreviewWindow({
  workspace: () => settings.workspace,
  offline: () => !!settings.offline,
  toChat: (m) => { win?.webContents.send('preview:toChat', m); if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.focus(); } },
  log: applog,
});
let hotkey: NonNullable<VoiceStatus['hotkey']> = { accelerator: '', registered: false };

/** (Re)register the system-wide voice hotkey from settings. Failures are reported in the voice status, never thrown. */
let voiceMcp: VoiceMcpServer | null = null;
const voiceBridge = new WindowBridge((ch, msg) => { if (!win || win.isDestroyed()) return false; win.webContents.send(ch, msg); return true; });
function syncVoiceMcp() {
  const v = settings.voice;
  void voiceMcp?.sync(!!v.mcpServer && !safeModeArgv(), v.mcpPort || 39517);
}

function registerHotkey() {
  globalShortcut.unregisterAll();
  const v = settings.voice;
  hotkey = { accelerator: v.hotkey, registered: false };
  if (!v.enabled || !v.hotkey) return;
  try {
    const ok = globalShortcut.register(v.hotkey, () => triggerHotkey());
    hotkey.registered = ok;
    if (!ok) hotkey.error = `${v.hotkey} is already used by another app. Pick a different shortcut in Settings → Voice.`;
  } catch (e: any) {
    hotkey.error = `Invalid shortcut "${v.hotkey}".`;
  }
  applog(`hotkey ${hotkey.accelerator} registered=${hotkey.registered}${hotkey.error ? ' ' + hotkey.error : ''}`);
}

/** The app that had focus when the dictation hotkey was pressed (looked up while recording starts). */
let dictationTarget: Promise<ActiveApp | null> = Promise.resolve(null);

function triggerHotkey(forceFocused?: boolean) {
  if (!win) return;
  const jarvinFocused = forceFocused ?? win.isFocused();
  dictationTarget = !jarvinFocused && settings.voice.insertIntoApp && settings.voice.appRules.trim() ? detectActiveApp() : Promise.resolve(null);
  if (!jarvinFocused && !settings.voice.insertIntoApp) {
    // Dictation will land in Jarvin's chat box, so bring the window forward.
    if (win.isMinimized()) win.restore();
    raiseWindow(win);
  }
  win.webContents.send('voice:hotkey', { jarvinFocused });
}

const logFile = process.env.JARVIN_E2E === '1' && process.env.JARVIN_E2E_DATA_DIR
  ? path.join(process.env.JARVIN_E2E_DATA_DIR, 'app.log')
  : path.join(__dirname, '..', 'app.log');
function applog(line: string) {
  try {
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* logging must never break the app */
  }
}
process.on('uncaughtException', (e) => applog(`uncaughtException: ${e?.stack ?? e}`));
process.on('unhandledRejection', (e) => applog(`unhandledRejection: ${e}`));

const emit = (e: AgentEvent) => {
  if (e.type === 'approval' || e.type === 'question') assistantWidget.attention();
  else if (e.type === 'done') assistantWidget.complete(e.outcome ?? 'finished');
  win?.webContents.send('agent:event', e);
};

function readMcpConfig(): string {
  try {
    return fs.readFileSync(mcpConfigPath(settings.workspace), 'utf8');
  } catch {
    const empty = JSON.stringify({ mcpServers: {} }, null, 2);
    fs.mkdirSync(path.dirname(mcpConfigPath(settings.workspace)), { recursive: true });
    fs.writeFileSync(mcpConfigPath(settings.workspace), empty);
    return empty;
  }
}

function safeModeArgv(argv: string[] = process.argv): boolean {
  return argv.some((a) => a === '--safe' || a === '--safe-mode' || process.env.JARVIN_SAFE_MODE === '1');
}

function cliFolderArgv(argv: string[] = process.argv, cwd = process.cwd()): string | null {
  return folderFromArguments(argv, cwd, !!process.defaultApp);
}

let hookTrust: HookTrust | null = null;
function trustStore() { return (hookTrust ??= new HookTrust(path.join(app.getPath('userData'), 'hooks-trust.json'))); }
function activePersona(): Persona | undefined {
  if (!settings.persona) return undefined;
  return loadPersonas(settings.workspace).find((p) => p.name === settings.persona);
}

function hasSecretLike(text: string): boolean {
  const patterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
    /\bsk-[A-Za-z0-9]{20,}\b/,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    /\bAIza[0-9A-Za-z_-]{30,}\b/,
    /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/,
  ];
  return patterns.some((r) => r.test(String(text ?? '')));
}

function systemPrompt(root = settings.workspace, companion = false): string { return buildSystemPrompt(settings, root, companion); }

function allTools(): ToolDef[] {
  // This companion operates from pictures. Keep accessibility-tree and raw
  // coordinate-click alternatives out of the model's action catalogue.
  let tools = [...builtinTools, ...mcp.tools()].filter(t => !['desktop_inspect_window', 'desktop_control', 'mouse_click'].includes(t.name));
  // Plan mode: expose only read-only tools so nothing can be changed or run.
  if (settings.mode === 'plan') tools = tools.filter((t) => t.risk === 'read');
  // Custom mode (persona) may limit tools further.
  const persona = activePersona();
  if (persona) tools = tools.filter((t) => personaAllows(persona, t));
  // Offline switch: block network tools.
  if (settings.offline) tools = tools.filter((t) => !['web_search', 'web_fetch', 'research_web', 'open_website', 'chrome_search', 'browser_open', 'browser_read', 'browser_click', 'browser_type', 'browser_close'].includes(t.name));
  return tools;
}

/** Saved rules plus any block rules the project ships. */
function effectiveRules(ws: string): FolderRules {
  const r = perms.get(ws);
  return { allow: r.allow, deny: [...r.deny, ...workspaceDeny(ws)] };
}
const permLists = () => ({ ...perms.get(settings.workspace), shared: workspaceDeny(settings.workspace) });

async function approve(tool: ToolDef, args: any, id: string): Promise<boolean> {
  const ws = settings.workspace;
  if (tool.name === 'run_command' && typeof args?.command === 'string' && isDangerousCommand(args.command)) {
    emit({ type: 'note', text: `Blocked by command safety policy: ${args.command}` });
    return false;
  }
  const sensitive =
    tool.risk === 'write' &&
    (
      (typeof args?.path === 'string' && isSensitivePath(args.path)) ||
      (typeof args?.content === 'string' && hasSecretLike(args.content)) ||
      (typeof args?.new_string === 'string' && hasSecretLike(args.new_string))
    );
  const verdict = decide({ tool: tool.name, risk: tool.risk, args, mode: settings.mode, rules: effectiveRules(ws), sensitive, root: ws });
  if (verdict === 'allow') { auditLog('allow', tool.name, args); return true; }
  if (verdict === 'deny') {
    emit({ type: 'note', text: `Blocked by a deny rule: ${tool.name}` });
    auditLog('deny_rule', tool.name, args);
    return false;
  }
  const saved = sensitive ? null : rulesFor(tool.name, tool.risk, args);
  let actionSummary = tool.summarize ? tool.summarize(args) : JSON.stringify(args, null, 2);
  if (['desktop_inspect_window', 'see_window', 'focus_window'].includes(tool.name)) actionSummary = `${tool.name === 'see_window' ? 'Capture and visually examine' : tool.name === 'focus_window' ? 'Bring to the foreground' : 'Read accessibility controls from'}:\n${activeDesktop?.describeWindow(args?.window_id) ?? 'Unknown window'}`;
  if (tool.name === 'desktop_control') actionSummary = `${String(args?.action ?? 'Desktop action')}\n${activeDesktop?.describeControl(args?.snapshot_id, args?.control_ref) ?? 'Unknown control'}${args?.action === 'set_value' ? `\nText: ${String(args?.text ?? '').slice(0, 500)}` : ''}`;
  if (tool.name === 'click_visual_target') actionSummary = `Click visual target:\n${activeVisual?.describe(args?.target_id) ?? 'Unknown target'}`;
  const summary = (sensitive ? '⚠ Sensitive path (secrets, CI or config)\n' : requiresFreshApproval(tool.name, args) ? 'Requires approval each time\n' : '') + actionSummary;
  emit({ type: 'approval', id, name: tool.name, summary, always: saved ? saved.map(describeRule).join(', ') : undefined });
  const d = await new Promise<'allow' | 'always' | 'deny'>((res) => pending.set(id, (decision, modifiedArgs) => {
    if (modifiedArgs && typeof modifiedArgs === 'object') pendingArgs.set(id, modifiedArgs);
    res(decision);
  }));
  pending.delete(id);
  const modified = pendingArgs.get(id);
  pendingArgs.delete(id);
  if (d !== 'deny' && modified && typeof modified === 'object') Object.assign(args, modified);
  if (d === 'always' && saved) perms.addAllow(ws, saved);
  auditLog(d === 'deny' ? 'deny' : d, tool.name, args);
  return d !== 'deny';
}

async function reloadMcp(): Promise<void> {
  try {
    await mcp.load(readMcpConfig(), settings.workspace);
  } catch (e) {
    console.error('MCP load failed', e);
  }
}

/** Windows refuses focus to a window that is not in front; briefly pin it on top so it really appears. */
function raiseWindow(w: BrowserWindow | null | undefined) {
  if (!w || w.isDestroyed()) return;
  if (w.isMinimized()) w.restore();
  w.show();
  if (process.platform === 'win32') {
    w.setAlwaysOnTop(true);
    w.focus();
    w.moveTop();
    app.focus({ steal: true });
    setTimeout(() => { if (!w.isDestroyed()) w.setAlwaysOnTop(false); }, 400);
  } else w.focus();
}

const backgroundStart = isBackgroundStart(process.argv);
let openedOnce = !backgroundStart;
let tray: Tray | null = null;
let reloads: number[] = [];

function warmModels(): void {
  if (!settings.voice.enabled || process.env.JARVIN_E2E) return;
  void warmCompanionModels({ baseUrl: settings.baseUrl, model: settings.model, visionModel: settings.visionModel, numCtx: settings.numCtx, signal: AbortSignal.timeout(120_000) })
    .then(models => { if (models.length) applog(`Local companion models ready: ${models.join(', ')}`); if (models.includes(settings.model)) primePrompt(); })
    .catch(error => applog(`Local model warm-up: ${String(error?.message ?? error)}`));
}

/** Reads the everyday desktop prompt (companion rules plus the core tools) into the model's cache, unless a request is already running. */
function primePrompt(): void {
  if (running) return;
  try {
    const tools = allTools();
    const selected = new Set(routeToolNames(tools.map(t => t.name), 'assistant', 'open the window'));
    void primeChat({ baseUrl: settings.baseUrl, model: settings.model, numCtx: settings.numCtx, system: systemPrompt(settings.workspace, true), tools: toolSpecs(tools.filter(t => selected.has(t.name))) })
      .then(ms => applog(`prompt primed in ${ms} ms`))
      .catch(error => applog(`prompt priming skipped: ${String(error?.message ?? error)}`));
  } catch (error: any) { applog(`prompt priming skipped: ${String(error?.message ?? error)}`); }
}

/** Brings the main window forward. After a hidden start, the first open also starts the microphone and warms the models. */
function openMainWindow(): void {
  if (!win || win.isDestroyed()) return;
  assistantWidget.hide();
  screenObserver.stop(); liveScreen.stop(); assistantWidget.watching(false);
  raiseWindow(win);
}

function applyLoginItem(): void {
  if (process.env.JARVIN_E2E) return;
  try { app.setLoginItemSettings(loginItem(settings.startAtLogin === true, { packaged: app.isPackaged, execPath: process.execPath, appPath: app.getAppPath() })); }
  catch (e: any) { applog(`start at sign-in could not be set: ${String(e?.message ?? e)}`); }
}

function createTray(): void {
  if (process.env.JARVIN_E2E || tray) return;
  try {
    tray = new Tray(path.join(__dirname, '..', 'assets', 'icon.png'));
    tray.setToolTip('Jarvin');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Jarvin', click: openMainWindow },
      { label: 'Mute or unmute microphone', click: () => { if (win && !win.isDestroyed()) win.webContents.send('assistant:action', 'mute'); } },
      { label: 'Pause or resume screen observation', click: () => handleAssistantWidgetAction('observation') },
      { type: 'separator' },
      { label: 'Quit Jarvin', click: () => app.quit() },
    ]));
    tray.on('click', openMainWindow);
  } catch (e: any) { tray = null; applog(`tray icon unavailable: ${String(e?.message ?? e)}`); }
}

function createWindow() {
  win = new BrowserWindow({
    show: !(process.env.JARVIN_E2E === '1' && process.env.JARVIN_E2E_HEADLESS === '1') && !backgroundStart,
    width: 1480,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#121215',
    title: 'Jarvin',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? undefined : { color: '#121215', symbolColor: '#a1a1ad', height: 44 },
    trafficLightPosition: { x: 16, y: 14 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  win.on('session-end', stopCrashWatch);
  win.setMenuBarVisibility(false);
  win.once('ready-to-show', () => { if (!(process.env.JARVIN_E2E === '1' && process.env.JARVIN_E2E_HEADLESS === '1') && !backgroundStart) raiseWindow(win); });
  win.on('show', () => {
    if (openedOnce) return;
    openedOnce = true;
    applog('first open after background start');
    win?.webContents.send('window:first-open');
    warmModels();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  const wc = win.webContents;
  wc.on('did-fail-load', (_e, code, desc, url) => applog(`did-fail-load ${code} ${desc} ${url}`));
  wc.on('render-process-gone', (_e, d) => {
    applog(`render-process-gone ${d.reason}`);
    if (quitting || d.reason === 'clean-exit' || d.reason === 'killed' || process.env.JARVIN_E2E) return;
    const next = allowReload(reloads, Date.now());
    if (!next) { applog('window crashed again; not reloading (3 reloads in 10 minutes)'); return; }
    reloads = next;
    setTimeout(() => { if (win && !win.isDestroyed()) { applog('reloading the window after a crash'); wc.reload(); } }, 1000);
  });
  wc.on('preload-error', (_e, p, err) => applog(`preload-error ${p}: ${err}`));
  wc.on('console-message', (_e, level, message, line, src) => {
    if (level >= 2) applog(`renderer ${level === 3 ? 'error' : 'warn'}: ${message} (${src}:${line})`);
  });
  wc.on('did-finish-load', () => {
    applog('did-finish-load');
    setTimeout(() => {
      wc.executeJavaScript("JSON.stringify({elements: document.querySelectorAll('*').length, brand: (document.querySelector('.brand')||{}).textContent, model: document.getElementById('model') ? document.getElementById('model').options.length : -1, size: [innerWidth, innerHeight]})")
        .then((r) => applog(`ui ${r}`))
        .catch((e) => applog(`ui check failed: ${e}`));
    }, 2500);
  });
  win.on('minimize', () => compactAssistant());
  win.on('restore', () => { assistantWidget.hide(); screenObserver.stop(); liveScreen.stop(); assistantWidget.watching(false); });
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    compactAssistant();
  });
  win.on('closed', () => { preview.dispose(); assistantWidget.dispose(); win = null; });
  void win.loadFile(path.join(__dirname, 'renderer', 'index.html'), process.env.JARVIN_E2E ? { query: { e2e: '1' } } : !openedOnce ? { query: { background: '1' } } : undefined);
}

let orCache: { at: number; ids: string[] } | undefined;
async function listOpenRouterFreeModels(): Promise<string[]> {
  if (orCache && Date.now() - orCache.at < 10 * 60_000) return orCache.ids;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: Array<{ id?: string; pricing?: { prompt?: string | number } }> };
    const ids = (json.data ?? [])
      .filter((m) => {
        const id = String(m.id ?? '');
        const prompt = m.pricing?.prompt;
        return id && (id.endsWith(':free') || prompt === 0 || prompt === '0');
      })
      .map((m) => String(m.id))
      .sort();
    orCache = { at: Date.now(), ids };
    return ids;
  } catch {
    return [];
  }
}

// electron-updater is loaded only when needed, so Jarvin still starts if `npm install` has not been run since it was added.
const updater = createUpdater({
  load: () => require('electron-updater').autoUpdater,
  isPackaged: app.isPackaged,
  version: app.getVersion(),
  getUrl: () => settings?.updateUrl,
  emit: (s) => win?.webContents.send('update:state', s),
});

function registerIpc() {
  ipcMain.handle('assistant:compact', (e) => {
    if (!win || e.sender !== win.webContents) throw new Error('Not allowed.');
    compactAssistant();
  });
  ipcMain.handle('assistant:restore', (e) => {
    if (!win || e.sender !== win.webContents) throw new Error('Not allowed.');
    assistantWidget.hide();
    screenObserver.stop(); liveScreen.stop(); assistantWidget.watching(false);
    if (!(process.env.JARVIN_E2E === '1' && process.env.JARVIN_E2E_HEADLESS === '1')) { raiseWindow(win); }
  });
  ipcMain.on('assistant:state', (e, state: Pick<AssistantWidgetState, 'working' | 'mic' | 'speaking' | 'level' | 'hearing'>) => {
    if (!win || e.sender !== win.webContents || typeof state?.working !== 'boolean' || typeof state?.speaking !== 'boolean' || !['off', 'listening', 'recording', 'processing', 'paused', 'error'].includes(state?.mic)) return;
    screenObserver.setPaused(state.hearing === true || state.mic === 'recording' || state.mic === 'processing');
    assistantWidget.update({ working: state.working, speaking: state.speaking, mic: state.mic, level: Number.isFinite(state.level) ? Math.max(0, Math.min(1, state.level!)) : 0, hearing: state.hearing === true });
  });
  ipcMain.on('assistant-widget:action', (e, action: AssistantWidgetAction) => {
    if (!assistantWidget.owns(e.sender) || !['assistant', 'code', 'voice', 'mute', 'observation', 'stop', 'pause', 'tasks', 'quit'].includes(action)) return;
    handleAssistantWidgetAction(action);
  });
  ipcMain.on('assistant-widget:move', (e, point) => assistantWidget.move(e.sender, point));
  const traceDir = () => path.join(app.getPath('userData'), 'traces');
  ipcMain.handle('trace:list', () => listTraces(traceDir()));
  ipcMain.handle('trace:get', (_e, id: string) => readTrace(traceDir(), id));
  ipcMain.handle('trace:delete', (_e, id: string) => deleteTrace(traceDir(), id));
  ipcMain.handle('trace:clear', (_e, days: number) => clearTraces(traceDir(), Number(days) || 0));
  ipcMain.handle('trace:reveal', (_e, id?: string) => {
    if (id !== undefined && validTraceId(id)) shell.showItemInFolder(path.join(traceDir(), id + '.jsonl'));
    else shell.openPath(traceDir());
  });
  ipcMain.handle('update:state', () => updater.refresh());
  ipcMain.handle('update:check', () => updater.check());
  ipcMain.handle('update:download', () => updater.download());
  ipcMain.handle('update:install', () => updater.install());
  ipcMain.handle('open:external', (_e, url: string) => (/^https?:\/\//i.test(url) ? shell.openExternal(url) : undefined));
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('privacy:windows', async (e) => {
    if (!win || e.sender !== win.webContents) throw new Error('Not allowed.');
    const data = await privacyWorker({ op: 'privacy_scan' }, AbortSignal.timeout(6000));
    if (!Array.isArray(data.windows) || data.truncated) throw new Error('Could not list the open windows completely.');
    const seen = new Set<string>();
    return data.windows.filter((item: any) => item && typeof item.app === 'string' && typeof item.title === 'string' && (item.app || item.title)).filter((item: { app: string; title: string }) => { const key = `${item.app}\0${item.title}`; if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 100);
  });
  ipcMain.handle('memory:list', () => listManagedMemories());
  ipcMain.handle('memory:read', (_e, id: unknown) => readManagedMemory(id));
  ipcMain.handle('memory:save', (_e, id: unknown, revision: unknown, text: unknown) => updateManagedMemory(id, revision, text));
  ipcMain.handle('memory:delete', (_e, id: unknown, revision: unknown) => deleteManagedMemory(id, revision));
  ipcMain.handle('ext:status', () => {
    const root = settings.workspace;
    const hs = loadHooks(root, trustStore());
    const rules = loadRules(root);
    return {
      personas: loadPersonas(root).map((p) => ({ name: p.name, description: p.description, tools: p.tools === 'all' || p.tools === 'read-only' ? p.tools : p.tools.join(', '), builtin: !!p.builtin })),
      active: settings.persona ?? '',
      rules: { used: rules.used, truncated: rules.truncated },
      hooks: { active: hs.active.map((h) => ({ event: h.event, tool: h.tool ?? '', match: h.match ?? '', command: h.command })), pending: hs.pending.map((h) => ({ event: h.event, tool: h.tool ?? '', match: h.match ?? '', command: h.command })), errors: hs.errors },
    };
  });
  ipcMain.handle('ext:trustHooks', () => {
    const hs = loadHooks(settings.workspace, trustStore());
    if (!hs.hash) return false;
    trustStore().trust(settings.workspace, hs.hash);
    return true;
  });
  const gitRun = (args: string[]) => {
    if (!settings.workspace) throw new Error('No workspace open.');
    const r = spawnSync('git', args, { cwd: settings.workspace, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (r.error) throw r.error;
    return (r.stdout || '') + (r.stderr ? '\n' + r.stderr : '');
  };
  // The git panel. One entry point; every operation checks its own arguments (see ./git.ts for the commands).
  const askModel = async (system: string, user: string) => {
    if (!settings.model) throw new Error('Pick a model first.');
    return routedChat({ baseUrl: settings.baseUrl, model: settings.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], timeoutMs: 120_000, numCtx: Math.min(8192, settings.numCtx || 8192) });
  };
  ipcMain.handle('gitx', async (_e, op: string, a: any) => {
    if (typeof op !== 'string') throw new Error('Invalid request.');
    a = a && typeof a === 'object' ? a : {};
    if (!settings.workspace) throw new Error('Open a folder first.');
    if (op === 'init') { await GitRepo.init(settings.workspace); return true; }
    const repo = await GitRepo.open(settings.workspace);
    if (!repo) { if (op === 'status') return { repo: false }; throw new Error('This folder is not a git repository.'); }
    const net = () => { if (settings.offline) throw new Error('Offline mode is on. Turn it off in Settings to use the network.'); };
    switch (op) {
      case 'status': return { repo: true, root: repo.root, ...(await repo.status()) };
      case 'diff': return repo.diff({ path: a.path, kind: a.kind === 'staged' ? 'staged' : a.kind === 'untracked' ? 'untracked' : 'unstaged' });
      case 'stage': return repo.stage(Array.isArray(a.paths) ? a.paths : undefined);
      case 'unstage': return repo.unstage(Array.isArray(a.paths) ? a.paths : undefined);
      case 'hunks': return repo.hunks(a.path, (Array.isArray(a.indexes) ? a.indexes : []).filter((n: unknown) => Number.isInteger(n)), a.mode === 'unstage' ? 'unstage' : 'stage');
      case 'discard': return repo.discard(a.path);
      case 'branches': return repo.branches();
      case 'checkout': return repo.checkout(a.name, !!a.remote);
      case 'createBranch': return repo.createBranch(a.name, a.from || undefined);
      case 'deleteBranch': return repo.deleteBranch(a.name, !!a.force);
      case 'commit': return repo.commit(a.message, !!a.amend);
      case 'log': return repo.log(Number(a.n) || 50);
      case 'show': return repo.show(a.hash);
      case 'fetch': net(); return repo.fetch();
      case 'pull': net(); return repo.pull();
      case 'push': net(); return repo.push();
      case 'prInfo': {
        const [base, remote, st] = await Promise.all([repo.baseBranch(), repo.remoteUrl(), repo.status()]);
        const short = base.replace(/^origin\//, '');
        return { base, remote, head: st.branch, url: remote && short && st.branch ? compareUrl(remote, short, st.branch) : null };
      }
      case 'draftCommit': {
        const { stat, diff } = await repo.stagedContext();
        if (!diff.trim()) throw new Error('Nothing is staged, so there is nothing to describe. Stage some files first.');
        return parseCommitMessage(await askModel(COMMIT_SYSTEM, commitUser(diff, stat, await repo.recentSubjects())));
      }
      case 'draftPr': {
        const ctx = await repo.prContext(String(a.base ?? ''));
        if (!ctx.commits) throw new Error(`This branch has no commits that ${a.base} lacks, so there is nothing to describe.`);
        return { ...parsePr(await askModel(PR_SYSTEM, prUser(a.base, ctx.head, ctx.log, ctx.stat, ctx.diff))), commits: ctx.commits };
      }
      default: throw new Error('Unknown git operation.');
    }
  });
  ipcMain.handle('git:status', () => gitRun(['status', '--short', '--branch']));
  ipcMain.handle('git:statusPorcelain', () => gitRun(['status', '--porcelain=v1']));
  ipcMain.handle('git:diff', (_e, rel?: string) => gitRun(rel ? ['diff', '--', String(rel)] : ['diff']));
  ipcMain.handle('git:draftCommit', async () => {
    const diff = gitRun(['diff', '--cached']);
    if (!diff.trim()) return { message: 'No staged changes.' };
    try {
      const message = await chatOnce({
        baseUrl: settings.baseUrl, model: settings.model,
        messages: [
          { role: 'system', content: 'Write a concise git commit message (subject line only, imperative mood) for this diff. Output only the message.' },
          { role: 'user', content: diff.slice(0, 12000) },
        ],
        timeoutMs: 20000, numCtx: Math.min(4096, settings.numCtx || 4096),
      });
      return { message: message.trim().slice(0, 200) };
    } catch (e: any) {
      return { message: '', error: String(e?.message ?? e) };
    }
  });
  ipcMain.handle('git:branches', () => gitRun(['branch', '--format=%(refname:short)']));
  ipcMain.handle('git:checkout', (_e, branch: string) => { if (typeof branch !== 'string' || !branch.trim()) throw new Error('Invalid branch.'); return gitRun(['checkout', branch.trim()]); });
  ipcMain.handle('git:stage', (_e, rel?: string) => gitRun(rel ? ['add', '--', String(rel)] : ['add', '-A']));
  ipcMain.handle('git:unstage', (_e, rel?: string) => gitRun(rel ? ['reset', 'HEAD', '--', String(rel)] : ['reset', 'HEAD']));
  ipcMain.handle('git:commit', (_e, message: string) => { if (typeof message !== 'string' || !message.trim()) throw new Error('Commit message required.'); return gitRun(['commit', '-m', message.trim()]); });
  ipcMain.handle('settings:set', async (_e, patch: Partial<Settings>) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid settings.');
    if (patch.observationPaused !== undefined && typeof patch.observationPaused !== 'boolean') throw new Error('Invalid screen observation setting.');
    for (const entry of [patch.excludedApps, patch.excludedWindowTitles]) {
      if (entry !== undefined && (!Array.isArray(entry) || entry.length > 30 || entry.some((value) => typeof value !== 'string' || !value.trim() || value.length > 120))) throw new Error('Screen exclusions must be up to 30 nonempty names or title phrases, each at most 120 characters.');
    }
    const wsChanged = patch.workspace !== undefined && patch.workspace !== settings.workspace;
    if (wsChanged && (running || contextBusy)) throw new Error('Wait for the current task or chat operation before changing folders.');
    const before = `${settings.voice.hotkey}|${settings.voice.enabled}`;
    const wasObservationPaused = settings.observationPaused === true;
    const previousExclusions = JSON.stringify([settings.excludedApps ?? [], settings.excludedWindowTitles ?? []]);
    const wasAtLogin = settings.startAtLogin === true;
    settings = saveSettings(settings, patch);
    if (wasAtLogin !== (settings.startAtLogin === true)) applyLoginItem();
    if (wasObservationPaused !== (settings.observationPaused === true)) applyObservationPause(settings.observationPaused === true);
    if (previousExclusions !== JSON.stringify([settings.excludedApps ?? [], settings.excludedWindowTitles ?? []])) applyScreenExclusions();
    setProviderApiKey(settings.providerApiKey);
    if (before !== `${settings.voice.hotkey}|${settings.voice.enabled}`) registerHotkey();
    syncVoiceMcp();
    if (wsChanged) {
      if (settings.workspace) loadActiveChat(settings.workspace);
      else history.length = 0;
      refreshWorkspaceWatcher();
      await reloadMcp();
    }
    return settings;
  });
  ipcMain.handle('models:list', async () => {
    let error: string | undefined;
    let local: string[] = [];
    let ollamaCloud: string[] = [];
    try {
      const details = await localModels(settings.baseUrl);
      local = details.map((m) => m.name);
      ollamaCloud = details.filter((m) => !!m.remoteHost).map((m) => m.name);
      setOllamaModels(local);
    } catch (e: any) {
      error = `Cannot reach Ollama at ${settings.baseUrl} (${e?.message ?? e}).`;
    }
    const remote = settings.offline ? [] : await listOpenRouterFreeModels();
    const models = [...new Set([...local, ...remote])];
    if (!models.length && error) return { models: [], error: `${error} Is it running?` };
    return { models, local, ollamaCloud, hasKey: hasProviderApiKey(), error: error && local.length === 0 ? error : undefined };
  });
  ipcMain.handle('models:details', async () => {
    const st = await ollamaStatus(settings.baseUrl);
    let models: Awaited<ReturnType<typeof localModels>> = [];
    if (st.up) { try { models = await localModels(settings.baseUrl); } catch (e: any) { st.error = String(e?.message ?? e); } }
    return { ollama: st, models, pulling: pulling(), hasKey: hasProviderApiKey(), ramGB: Math.round((os.totalmem() / 2 ** 30) * 10) / 10, baseUrl: settings.baseUrl, offline: !!settings.offline };
  });
  ipcMain.handle('models:pull', async (_e, name: string) => {
    if (!validModelName(name)) throw new Error('That is not a valid model name.');
    if (settings.offline) throw new Error('Offline mode is on. Turn it off in Settings to download models.');
    return pullModel(settings.baseUrl, name, (p) => win?.webContents.send('models:progress', p));
  });
  ipcMain.handle('models:cancel', (_e, name: string) => cancelPull(String(name)));
  ipcMain.handle('models:delete', async (_e, name: string) => {
    await deleteModel(settings.baseUrl, name);
    if (settings.model === name) settings = saveSettings(settings, { model: '' });
  });
  ipcMain.handle('workspace:pick', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('fs:tree', async (_e, rel: string): Promise<TreeEntry[]> => {
    if (typeof rel !== 'string') throw new Error('Invalid path.');
    const dir = resolveSafe(settings.workspace, rel);
    const es = await fs.promises.readdir(dir, { withFileTypes: true });
    return es
      .filter((d) => !(d.isDirectory() && IGNORE.has(d.name)))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map((d) => ({ name: d.name, path: path.relative(settings.workspace, path.join(dir, d.name)).split(path.sep).join('/'), dir: d.isDirectory() }));
  });
  ipcMain.handle('fs:read', async (_e, rel: string) => {
    if (typeof rel !== 'string') throw new Error('Invalid path.');
    const file = resolveSafe(settings.workspace, rel);
    if ((await fs.promises.stat(file)).size > 2_000_000) throw new Error('File is larger than 2MB.');
    const text = await fs.promises.readFile(file, 'utf8');
    if (text.includes('\0')) throw new Error('Binary file.');
    return text;
  });
  ipcMain.handle('jobs:list', () => jobs.list());
  ipcMain.handle('jobs:start', (_e, command: string) => {
    if (typeof command !== 'string') throw new Error('Invalid command.');
    return jobs.start(command, settings.workspace, settings.shell, false);
  });
  ipcMain.handle('jobs:output', (_e, id: string) => { if (typeof id !== 'string') throw new Error('Invalid job.'); return jobs.output(id); });
  ipcMain.handle('jobs:stop', (_e, id: string) => jobs.stop(String(id)));
  ipcMain.handle('jobs:remove', (_e, id: string) => jobs.remove(String(id)));
  ipcMain.handle('jobs:clear', () => jobs.clearFinished());
  ipcMain.handle('reminders:list', () => { if (!reminders) throw new Error('Reminder storage is unavailable.'); return reminders.list(); });
  ipcMain.handle('reminders:create', (_e, text: unknown, dueAt: unknown, repeat: unknown) => { if (!reminders) throw new Error('Reminder storage is unavailable.'); return reminders.create(text, dueAt, repeat ?? null); });
  ipcMain.handle('reminders:update', (_e, id: unknown, text: unknown, dueAt: unknown, repeat: unknown) => { if (!reminders) throw new Error('Reminder storage is unavailable.'); return reminders.update(id, text, dueAt, repeat); });
  ipcMain.handle('reminders:snooze', (_e, id: unknown, minutes: unknown) => { if (!reminders) throw new Error('Reminder storage is unavailable.'); const updated = reminders.snooze(id, minutes); win?.webContents.send('reminders:update'); return updated; });
  ipcMain.handle('reminders:remove', (_e, id: unknown) => { if (!reminders) throw new Error('Reminder storage is unavailable.'); reminders.remove(id); win?.webContents.send('reminders:update'); });
  ipcMain.handle('routines:list', () => { if (!routines) throw new Error('Routine storage is unavailable.'); return routines.list(); });
  ipcMain.handle('routines:save', (_e, id: unknown, revision: unknown, name: unknown, steps: unknown, dailyAt: unknown) => { if (!routines) throw new Error('Routine storage is unavailable.'); return routines.save(id, revision, name, steps, dailyAt); });
  ipcMain.handle('routines:remove', (_e, id: unknown, revision: unknown) => { if (!routines) throw new Error('Routine storage is unavailable.'); routines.remove(id, revision); });
  ipcMain.handle('browser-share:start', () => browserShare.start());
  ipcMain.handle('browser-share:stop', () => browserShare.stop());
  ipcMain.handle('browser-share:folder', async () => {
    const folder = path.join(app.getAppPath(), 'browser-extension');
    const error = await shell.openPath(folder);
    if (error) throw new Error(error);
  });
  ipcMain.handle('runs:interrupted', () => {
    if (!runJournal) throw new Error('Task recovery storage is unavailable.');
    return runJournal.interrupted(settings.workspace);
  });
  ipcMain.handle('runs:dismiss', (_e, id: string) => {
    if (!runJournal || typeof id !== 'string') throw new Error('Task recovery storage is unavailable.');
    runJournal.dismiss(id, settings.workspace);
  });
  ipcMain.handle('runs:clearFinished', () => {
    if (!runJournal) throw new Error('Task recovery storage is unavailable.');
    return runJournal.clearFinished(settings.workspace);
  });
  ipcMain.handle('preview:open', (_e, target?: string) => preview.open(typeof target === 'string' ? target : undefined));
  ipcMain.handle('fs:image', async (_e, rel: string) => {
    if (typeof rel !== 'string') throw new Error('Invalid path.');
    const mime = imageMime(rel);
    if (!mime) throw new Error('That is not an image file.');
    const file = resolveSafe(settings.workspace, rel);
    const st = await fs.promises.stat(file);
    if (st.size > IMAGE_MAX_BYTES) throw new Error('Image is larger than 10 MB.');
    return dataUrl(mime, await fs.promises.readFile(file));
  });
  ipcMain.handle('fs:write', async (_e, rel: string, content: string) => {
    if (typeof rel !== 'string' || typeof content !== 'string') throw new Error('Invalid arguments.');
    await fs.promises.writeFile(resolveSafe(settings.workspace, rel), content);
  });
  ipcMain.handle('fs:search', async (_e, pattern: string) => {
    if (typeof pattern !== 'string' || !pattern) return [];
    let re: RegExp;
    try { re = new RegExp(pattern, 'i'); } catch { re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
    const root = settings.workspace;
    if (!root) return [];
    const out: { path: string; line: number; text: string }[] = [];
    const skip = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', 'target']);
    const walk = async (dir: string) => {
      if (out.length >= 300) return;
      let entries: fs.Dirent[];
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (skip.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else {
          try {
            const st = await fs.promises.stat(full);
            if (st.size > 1_000_000) continue;
            const text = await fs.promises.readFile(full, 'utf8');
            if (text.includes('\0')) continue;
            const lines = text.split(/\r?\n/);
            for (let i = 0; i < lines.length && out.length < 300; i++) {
              if (re.test(lines[i])) out.push({ path: path.relative(root, full).split(path.sep).join('/'), line: i + 1, text: lines[i].slice(0, 200) });
            }
          } catch { /* ignore */ }
        }
      }
    };
    await walk(root);
    return out;
  });

  ipcMain.handle('verified:diff', (_e, id: string, file?: string) => verifiedDiff(String(id), typeof file === 'string' ? file : undefined));
  ipcMain.handle('verified:discard', (_e, id: string) => {
    const ok = discardVerified(String(id));
    emit({ type: 'verified', id: String(id), state: 'done', discarded: true });
    return ok;
  });
  ipcMain.handle('verified:apply', async (_e, id: string, only?: string[]) => {
    if (running) throw new Error('Wait for the current run to finish first.');
    const ws = settings.workspace;
    if (!ws) throw new Error('Open a folder first.');
    const card = currentCard(String(id));
    const rec: Recorder = checkpoints.begin(ws, `Apply verified change: ${(card?.task ?? '').slice(0, 60)}`);
    try {
      const r = await applyVerified(String(id), (abs) => rec.beforeWrite(abs), Array.isArray(only) ? only.map(String) : undefined);
      emit({ ...r.card } as any);
      return { applied: r.applied.length, conflicts: r.conflicts };
    } finally {
      try { const summary = rec.finish(); if (summary) emit({ type: 'checkpoint', summary }); } catch (e) { applog(`checkpoint failed: ${e}`); }
      emit({ type: 'fs_changed' });
    }
  });
  ipcMain.handle('worktree:list', () => [...subagentWorktrees.values()]);
ipcMain.handle('subagent:runs', () => [...subagentRuns.values()].map((r: any) => ({
  id: r.id, kind: r.kind, task: r.task, state: r.state, startedAt: r.startedAt,
  completedAt: r.completedAt, error: r.error, path: r.path, branch: r.branch
})));
ipcMain.handle('subagent:cancel', (_e, id: string) => {
  const rec: any = subagentRuns.get(String(id));
  if (!rec) return false;
  rec.cancel?.();
  rec.state = 'cancelled';
  rec.completedAt = Date.now();
  return true;
});
ipcMain.handle('worktree:diff', (_e, id: string) => {
  const rec = subagentWorktrees.get(String(id));
  if (!rec) throw new Error('Unknown worktree.');
  const r = spawnSync('git', ['diff'], { cwd: rec.path, encoding: 'utf8' });
  return r.stdout || r.stderr || '(no diff)';
});
ipcMain.handle('worktree:discard', (_e, id: string) => {
  const rec = subagentWorktrees.get(String(id));
  if (!rec) throw new Error('Unknown worktree.');
  const root = String(spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: rec.path, encoding: 'utf8' }).stdout || '').trim();
  if (root) {
    spawnSync('git', ['worktree', 'remove', '--force', rec.path], { cwd: root, encoding: 'utf8' });
    spawnSync('git', ['branch', '-D', rec.branch], { cwd: root, encoding: 'utf8' });
  }
  subagentWorktrees.delete(String(id));
  try { fs.rmSync(rec.path, { recursive: true, force: true }); } catch { /* ignore */ }
  return { ok: true };
});
ipcMain.handle('worktree:keep', (_e, id: string) => {
  const rec = subagentWorktrees.get(String(id));
  if (!rec) throw new Error('Unknown worktree.');
  const workRoot = rec.path;
  const root = String(spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: workRoot, encoding: 'utf8' }).stdout || '').trim();
  if (!root) throw new Error('Could not resolve git root.');
  const statusMain = String(spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout || '').trim();
  if (statusMain) throw new Error(`Main workspace not clean:\n${statusMain}`);
  const diff = String(spawnSync('git', ['diff'], { cwd: workRoot, encoding: 'utf8' }).stdout || '');
  if (!diff.trim()) throw new Error('No changes to merge.');
  const patchPath = path.join(os.tmpdir(), `jarvin-${id}.patch`);
  fs.writeFileSync(patchPath, diff, 'utf8');
  const check = spawnSync('git', ['apply', '--check', patchPath], { cwd: root, encoding: 'utf8' });
  if (check.status !== 0) {
    return {
      ok: false,
      stage: 'preview',
      output: [check.stdout || '', check.stderr || ''].filter(Boolean).join('\n').trim() || 'Merge preview failed.',
    };
  }
  const applied = spawnSync('git', ['apply', '--3way', patchPath], { cwd: root, encoding: 'utf8' });
  if (applied.status !== 0) {
    const conflicted = String(spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout || '').trim();
    return {
      ok: false,
      stage: 'apply',
      output: [applied.stdout || '', applied.stderr || ''].filter(Boolean).join('\n').trim() || 'Merge apply failed.',
      conflicts: conflicted || undefined,
    };
  }
  let cleanup = '';
  try { spawnSync('git', ['worktree', 'remove', '--force', workRoot], { cwd: root, encoding: 'utf8' }); cleanup += 'worktree removed; '; } catch { cleanup += 'worktree remove failed; '; }
  try { spawnSync('git', ['branch', '-D', rec.branch], { cwd: root, encoding: 'utf8' }); cleanup += 'branch deleted'; } catch { cleanup += 'branch delete skipped'; }
  subagentWorktrees.delete(String(id));
  try { fs.rmSync(workRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  return {
    ok: true,
    stage: 'merged',
    output: [applied.stdout || '(applied)', cleanup].filter(Boolean).join('\n').trim(),
  };
});
ipcMain.handle('chat:message', async (_e, text: any, activePath: any, images?: any[], surface?: 'assistant' | 'code') => {
    if (typeof text !== 'string' || (activePath !== null && typeof activePath !== 'string')) throw new Error('Invalid arguments.');

    if (!Array.isArray(images)) images = [];
    if (running) return;
    const rejectRun = (message: string) => { emit({ type: 'error', message }); emit({ type: 'done', outcome: 'failed' }); };
    if (contextBusy) return rejectRun('Wait for the current chat operation to finish.');
    if (!settings.workspace) return rejectRun('Open a folder first.');
    if (!settings.model) return rejectRun('Pick an Ollama model first (is Ollama running?).');
    const msg: OMsg = { role: 'user', content: activePath ? `${text}\n\n[Active file: ${activePath}]` : text };
    if (images.length) msg.images = images;
    history.push(msg);
    const runWorkspace = settings.workspace;
    const sessionId = ensureChatSession(runWorkspace).active;
    saveActiveChat(runWorkspace);
    let journalId = '';
    let journalWarned = false;
    try {
      if (runJournal) journalId = runJournal.start({ request: text, workspace: runWorkspace, sessionId, model: settings.model, hadImages: images.length > 0, activePath: activePath || undefined }).id;
      else throw new Error('Task recovery storage is unavailable.');
    } catch {
      journalWarned = true;
      emit({ type: 'note', text: 'Task recovery is unavailable for this run.' });
    }
    const recordEvent = (event: any) => {
      if (!journalId || !runJournal) return;
      try {
        if (event?.type === 'tool_start') runJournal.toolStart(journalId, event.id, event.name);
        else if (event?.type === 'tool_result') runJournal.toolResult(journalId, event.id, !!event.ok);
      } catch {
        if (!journalWarned) { journalWarned = true; emit({ type: 'note', text: 'Task recovery could not record the latest activity.' }); }
      }
    };
    const runStart = Date.now();
    let runErr = '';
    let runPaused = false;
    let rec: Recorder;
    let tracePath: string;
    try {
      checkpoints.sweep(runWorkspace);
      rec = checkpoints.begin(runWorkspace, text.slice(0, 80));
      const traceDir = path.join(app.getPath('userData'), 'traces');
      fs.mkdirSync(traceDir, { recursive: true });
      tracePath = path.join(traceDir, `${crypto.randomUUID()}.jsonl`);
    } catch (e: any) {
      if (journalId && runJournal) { try { runJournal.finish(journalId, 'failed'); } catch { /* leave for recovery */ } }
      return rejectRun(`Could not start task: ${String(e?.message ?? e)}`);
    }
    pauseRequested = false;
    running = new AbortController();
    const runSignal = running.signal;
    const desktop = new WindowsAutomation(windowsUiaWorker(path.join(__dirname, 'windows-uia.ps1')));
    const visual = new VisualGrounding();
    activeDesktop = desktop;
    activeVisual = visual;
    // Tokens are written in batches (one line per token made huge files); everything else is written as it happens.
    let tokBuf = '';
    const traceWrite = (e: any) => {
      try { fs.appendFileSync(tracePath, JSON.stringify({ ts: new Date().toISOString(), event: redactLogValue(e) }) + '\n'); } catch { /* ignore */ }
    };
    const flushTok = () => { if (tokBuf) { traceWrite({ type: 'token', text: tokBuf }); tokBuf = ''; } };
    const tracedEmit = (e: any) => {
      recordEvent(e);
      if (e?.type === 'token') {
        tokBuf += String(e.text ?? '');
        if (tokBuf.length > 4000) flushTok();
      } else {
        flushTok();
        traceWrite(e);
      }
      emit(e);
    };
    traceWrite({ type: 'run', prompt: text.slice(0, 2000), model: settings.model, workspace: settings.workspace, mode: settings.mode, version: app.getVersion() });
    const runSubagent = async (task: string) => {
      const id = crypto.randomUUID().slice(0, 8);
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      running?.signal?.addEventListener('abort', onAbort, { once: true });
      const rec: any = { id, kind: 'inspect', task, state: 'running', startedAt: Date.now() };
      subagentRuns.set(id, rec);
      tracedEmit({ type: 'note', text: `[subagent] started (read-only) [${id}]: ${task.slice(0, 100)}` });
      const subHistory = [ { role: 'user' as const, content: task } ];
      try {
        await runAgent({
          settings,
          system: systemPrompt() + '\nYou are a read-only subagent. Do not modify files or run commands. Return a concise summary with cited files.',
          history: subHistory,
          tools: allTools().filter((t) => t.risk === 'read' && t.name !== 'subagent_inspect' && t.name !== 'subagent_edit'),
          ctx: { root: settings.workspace, signal: controller.signal, shell: settings.shell, baseUrl: settings.baseUrl, embeddingModel: settings.embeddingModel, subagent: () => Promise.resolve('nested subagents are disabled'), subagentEdit: () => Promise.resolve('nested subagents are disabled') },
          emit: (e: any) => { if (e?.type === 'note') tracedEmit({ type: 'note', text: `[subagent:${id}] ${e.text ?? ''}` }); },
          approve: async () => false,
        });
        rec.state = 'completed';
        rec.completedAt = Date.now();
        const last = [...subHistory].reverse().find((m: any) => m.role === 'assistant' && m.content);
        const summary = String(last?.content ?? '(no subagent output)').slice(0, 12000);
        rec.summary = summary;
        tracedEmit({ type: 'note', text: `[subagent] completed (read-only) [${id}]` });
        return summary;
      } catch (e: any) {
rec.state = controller.signal.aborted ? 'cancelled' : 'failed';
        rec.error = String(e?.message ?? e);
        tracedEmit({ type: 'note', text: `[subagent] ${rec.state} (read-only) [${id}]: ${rec.error}` });
        throw e;
      } finally {
        running?.signal?.removeEventListener('abort', onAbort);
      }
    }
const runEditSubagent = async (task: string) => {
      const id = crypto.randomUUID().slice(0, 8);
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      running?.signal?.addEventListener('abort', onAbort, { once: true });
      const gitRoot = String(spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: settings.workspace, encoding: 'utf8' }).stdout || '').trim();
      if (!gitRoot) return 'Subagent edit requires an existing Git repository.';
      const branch = `jarvin/subagent-${id}`;
      const workRoot = path.join(os.tmpdir(), 'jarvin-worktree', branch);
      fs.mkdirSync(path.dirname(workRoot), { recursive: true });
      const add = spawnSync('git', ['worktree', 'add', '-b', branch, workRoot], { cwd: gitRoot, encoding: 'utf8' });
      if (add.status !== 0) return `Could not create worktree: ${(add.stderr || add.stdout || '').trim()}`;
      const rec: any = { id, kind: 'edit', task, state: 'running', startedAt: Date.now(), path: workRoot, branch, cancel: () => controller.abort() };
      subagentRuns.set(id, rec);
      subagentWorktrees.set(id, { id, task, path: workRoot, branch });
      tracedEmit({ type: 'note', text: `[subagent-edit] started [${id}]: ${task.slice(0, 100)}` });
      try {
        const subHistory = [{ role: 'user' as const, content: `${task}\n\nWork only in this worktree and summarize the files you changed.` }];
        await runAgent({
          settings,
          system: systemPrompt() + '\nYou are an editing subagent in an isolated Git worktree. Make focused changes, then summarize them concisely with cited files.',
          history: subHistory,
          tools: allTools().filter((t) => t.name !== 'subagent_inspect' && t.name !== 'subagent_edit'),
          ctx: {
            root: workRoot,
            signal: controller.signal,
            shell: settings.shell,
            baseUrl: settings.baseUrl,
            embeddingModel: settings.embeddingModel,
            beforeWrite: () => {},
            subagent: undefined,
            subagentEdit: undefined,
          },
          emit: (e: any) => { if (e?.type === 'note') tracedEmit({ type: 'note', text: `[subagent-edit] ${e.text ?? ''}` }); },
          approve: async (tool, args, id) => approve(tool, args, id),
        });
        const diff = spawnSync('git', ['diff', '--stat'], { cwd: workRoot, encoding: 'utf8' }).stdout || '';
        const status = spawnSync('git', ['status', '--short'], { cwd: workRoot, encoding: 'utf8' }).stdout || '';
        const last = [...subHistory].reverse().find((m: any) => m.role === 'assistant' && m.content);
rec.state = 'completed';
        rec.completedAt = Date.now();
        return [`Summary:\n${String(last?.content ?? '(no output)').slice(0, 8000)}`, `Status:\n${status || '(clean)'}`, `Diff stat:\n${diff || '(no diff)'}`, `Worktree retained at: ${workRoot} (branch ${branch}) so you can inspect before keeping or removing it.`].join('\n\n');
      } catch (e: any) {
        rec.state = controller.signal.aborted ? 'cancelled' : 'failed';
        rec.error = String(e?.message ?? e);
        return `Subagent-edit failed: ${e?.message ?? e}`;
      }
    };
    const SANDBOX_EXCLUDE = new Set(['subagent_inspect', 'subagent_edit', 'subagent_graph', 'verified_change', 'apply_verified_change', 'ask_user', 'git_commit', 'worktree_list', 'worktree_diff', 'worktree_discard', 'worktree_keep', 'mouse_move', 'mouse_click', 'keyboard_type', 'keyboard_press', 'traverse_ui', 'visual_click', 'visual_type', 'locate_screen_target', 'click_visual_target', 'see_window', 'inspect_screen', 'list_displays', 'screen_capture', 'screenshot', 'desktop_list_windows', 'focus_window', 'window_manage', 'desktop_scroll', 'desktop_inspect_window', 'desktop_control', 'launch_app', 'chrome_search', 'open_path', 'open_website', 'reveal_in_explorer', 'clipboard_read', 'clipboard_write', 'notify', 'create_reminder']);
    const runSandboxAgent = async (sb: Sandbox, hist: OMsg[], onTool: (name: string, args: any) => void) => {
      await runAgent({
        settings: activePersona()?.model ? { ...settings, model: activePersona()!.model! } : settings,
        system: systemPrompt(sb.dir) + '\nYou are working in an isolated private copy of the project. Do not ask the user questions; make reasonable choices and say what you assumed in your summary.',
        history: hist,
        tools: allTools().filter((t) => !SANDBOX_EXCLUDE.has(t.name)),
        ctx: { root: sb.dir, signal: running!.signal, shell: settings.shell, baseUrl: settings.baseUrl, embeddingModel: settings.embeddingModel, beforeWrite: () => {} },
        emit: (e: any) => { if (e?.type === 'tool_start') onTool(String(e.name), e.args); },
        // The copy can be edited freely; anything that runs a command still goes through the normal safety policy.
        approve: async (tool, args, id) => (tool.risk === 'write' || tool.name === 'run_tests' ? true : approve(tool, args, id)),
      });
    };
    applog(`trace ${tracePath}`);
    try {
      const hookState = loadHooks(settings.workspace, trustStore());
      for (const e of hookState.errors) tracedEmit({ type: 'note', text: `Hook config problem: ${e}` });
      if (hookState.pending.length) tracedEmit({ type: 'note', text: `${hookState.pending.length} hook${hookState.pending.length === 1 ? '' : 's'} in .jarvin/hooks.json ${hookState.pending.length === 1 ? 'is' : 'are'} not active yet. Type /hooks to review and trust ${hookState.pending.length === 1 ? 'it' : 'them'}.` });
      const hookOpts = () => ({ root: settings.workspace, signal: running!.signal, shell: settings.shell });
      const hooks = hookState.active.length ? {
        pre: async (tool: string, args: any) => {
          for (const r of await runHooks(hookState.active, 'PreToolUse', tool, args, hookOpts())) {
            if (r.code === 2) return r.output || `hook "${r.hook.command}" refused this call`;
            if (r.code !== 0) tracedEmit({ type: 'note', text: `Hook "${r.hook.command}" failed (${r.timedOut ? 'timed out' : 'exit ' + r.code}) but did not block the call.` });
          }
          return null;
        },
        post: async (tool: string, args: any, ok: boolean) => {
          if (!ok) return '';
          const parts: string[] = [];
          for (const r of await runHooks(hookState.active, 'PostToolUse', tool, args, hookOpts())) {
            if (r.code !== 0 || r.output) parts.push(`[hook "${r.hook.command}"${r.code !== 0 ? ` exit ${r.timedOut ? 'timeout' : r.code}` : ''}] ${r.output}`.trim());
          }
          return parts.join('\n');
        },
      } : undefined;
      const runOnce = () => runAgent({
        hooks,
        settings: activePersona()?.model ? { ...settings, model: activePersona()!.model! } : settings,
        system: systemPrompt(settings.workspace, isCompanionRequest(surface === 'assistant' ? 'assistant' : 'code', text)),
        history,
        tools: (() => { const tools = allTools(); const selected = new Set(routeToolNames(tools.map(t => t.name), surface === 'assistant' ? 'assistant' : 'code', text)); return tools.filter(t => selected.has(t.name)); })(),
        ctx: {
          root: settings.workspace,
          signal: running!.signal,
          shell: settings.shell,
          baseUrl: settings.baseUrl,
          visionModel: settings.visionModel || '',
          screenFrame: async (fresh, displayId) => {
            if (!fresh) await assertDisplayCaptureAllowed(runSignal);
            const frame = !displayId || displayId === String(screen.getPrimaryDisplay().id) ? await screenObserver.frame(fresh) : await liveScreen.frame(displayId);
            await assertDisplayCaptureAllowed(runSignal);
            return frame;
          },
          screenInvalidate: () => screenObserver.invalidate(),
          embeddingModel: settings.embeddingModel,
          desktop,
          visual,
          desktopActivity: async (state) => {
            assistantWidget.desktop(state);
            // Reveal the actual desktop before a screenshot or input action. The
            // hidden renderer continues owning audio and the current conversation.
            if (state !== 'off' && win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()) {
              compactAssistant();
              await new Promise((resolve) => setTimeout(resolve, 180));
              screenObserver.invalidate();
            }
          },
          routines: {
            list: () => { if (!routines) throw new Error('Routine storage is unavailable.'); return routines.list(); },
            save: (name, steps) => {
              if (!routines) throw new Error('Routine storage is unavailable.');
              const ex = routines.list().find((r) => r.name.toLowerCase() === name.trim().toLowerCase());
              routines.save(ex ? ex.id : null, ex ? ex.revision : null, name, steps);
            },
          },
          createReminder: (text, dueAt, repeat) => {
            if (!reminders) throw new Error('Reminder storage is unavailable.');
            reminders.create(text, dueAt, repeat ?? null);
            if (win && !win.isDestroyed()) win.webContents.send('reminders:update');
          },
          beforeWrite: (abs) => rec.beforeWrite(abs),
          trackCommand: () => rec.trackCommand(),
subagent: runSubagent,
subagentEdit: runEditSubagent,
          verifiedChange: (a) => verifiedChange({ root: settings.workspace, signal: running!.signal, shell: settings.shell, runEditAgent: runSandboxAgent, emit: (c) => tracedEmit(c as any) }, a),
          applyVerified: async (id) => {
            const r = await applyVerified(id, (abs) => rec.beforeWrite(abs));
            tracedEmit({ ...r.card } as any);
            const lines = [`Applied ${r.applied.length} file${r.applied.length === 1 ? '' : 's'}: ${r.applied.map((c) => c.path).join(', ') || '(none)'}.`];
            if (r.conflicts.length) lines.push(`Not applied:\n${r.conflicts.map((c) => `  - ${c.path}: ${c.reason}`).join('\n')}`);
            lines.push('The user can undo this from the checkpoint card.');
            return lines.join('\n');
          },
          askUser: (question: string, options: string[]) => new Promise<string>((resolve) => {
            const id = crypto.randomUUID();
            tracedEmit({ type: 'question', id, question, options });
            pendingQuestions.set(id, resolve);
          }),
        },
        emit: tracedEmit,
        approve,
      });
      runPaused = (await runOnce()) === 'paused';
      // Auto-check: after the agent changed files, run the project's checks and hand errors it caused back to it (max 2 rounds).
      for (let round = 0; round < 2 && settings.autoCheck !== false && !running!.signal.aborted && !runPaused; round++) {
        const touched = rec.touchedPaths();
        if (!touched.length) break;
        tracedEmit({ type: 'note', text: round === 0 ? 'Checking your changes for errors…' : 'Re-checking after the fixes…' });
        const res = await runProblemChecks(settings.workspace, { signal: running!.signal, shell: settings.shell });
        tracedEmit({ type: 'problems', result: res });
        if (!res.checks.length) break; // nothing to check in this project
        const mine = res.problems.filter((p) => p.severity === 'error' && touched.includes(p.file));
        if (!mine.length) {
          const failedChecks = res.checks.filter((c) => c.ran && !c.ok && c.error);
          tracedEmit({ type: 'note', text: failedChecks.length ? `A check could not complete: ${failedChecks.map((c) => `${c.name}: ${c.error}`).join('; ')}` : 'No errors in the files I changed.' });
          break;
        }
        history.push({ role: 'user', content: autoFixPrompt(mine, round) });
        tracedEmit({ type: 'note', text: `Found ${mine.length} error${mine.length === 1 ? '' : 's'} in changed files. Fixing…` });
        runPaused = (await runOnce()) === 'paused';
      }
      // Stop hooks: exit code 2 hands the output back to the agent once; other output is only shown.
      if (hookState.active.some((h) => h.event === 'Stop') && !running!.signal.aborted && !runPaused) {
        const failed: string[] = [];
        for (const r of await runHooks(hookState.active, 'Stop', '', {}, hookOpts())) {
          if (r.code === 2) failed.push(`$ ${r.hook.command}\n${r.output}`);
          else if (r.code !== 0 || r.output) tracedEmit({ type: 'note', text: `Hook "${r.hook.command}"${r.code !== 0 ? ` (exit ${r.timedOut ? 'timeout' : r.code})` : ''}: ${r.output.slice(0, 600)}` });
        }
        if (failed.length) {
          history.push({ role: 'user', content: `A project hook found a problem after your work. Fix it, then stop.\n\n${failed.join('\n\n').slice(0, 4000)}` });
          tracedEmit({ type: 'note', text: 'A project hook asked for another pass. Fixing…' });
          runPaused = (await runOnce()) === 'paused';
        }
      }
    } catch (e: any) {
      if (running?.signal.aborted) tracedEmit({ type: 'note', text: pauseRequested ? 'Paused. Review the saved request in Tasks before continuing; earlier actions may already have happened.' : 'Stopped.' });
      else { runErr = String(e?.message ?? e); tracedEmit({ type: 'error', message: runErr }); }
    } finally {
      const pausedByUser = !!running?.signal.aborted && pauseRequested;
      const runStopped = !!running?.signal.aborted && !pausedByUser;
      pauseRequested = false;
      for (const r of pending.values()) r('deny');
      pending.clear();
      for (const q of pendingQuestions.values()) q('Cancelled by user.');
      pendingQuestions.clear();
      activeDesktop = null;
      desktop.dispose();
      activeVisual = null;
      assistantWidget.desktop('off');
      running = null;
      try {
        const summary = rec.finish();
        if (summary) tracedEmit({ type: 'checkpoint', summary });
        if (rec.trackingNote) tracedEmit({ type: 'note', text: rec.trackingNote });
      } catch (e) {
        applog(`checkpoint failed: ${e}`);
      }
      emit({ type: 'fs_changed' });
      if (settings.workspace) saveActiveChat(settings.workspace);
      if (journalId && runJournal) {
        try { runJournal.finish(journalId, runStopped ? 'stopped' : pausedByUser || runPaused ? 'paused' : runErr ? 'failed' : 'finished'); }
        catch { emit({ type: 'note', text: 'Task recovery could not record the final state.' }); }
      }
      tracedEmit({ type: 'done', outcome: runStopped ? 'stopped' : pausedByUser || runPaused ? 'paused' : runErr ? 'failed' : 'finished' });
      if (Date.now() - runStart >= 10_000 && !runStopped) notifyUser(pausedByUser || runPaused ? 'Jarvin paused' : runErr ? 'Jarvin hit a problem' : 'Jarvin finished', runErr ? shortText(runErr, 120) : shortText(text, 120));
    }
  });
  ipcMain.handle('chat:abort', () => stopCurrentRun());
  ipcMain.handle('kill:all', () => {
    stopCurrentRun();
    jobs.killAll();
    for (const t of terminals.values()) { try { t.kill?.(); } catch { /* ignore */ } }
    terminals.clear();
    return true;
  });
  ipcMain.handle('chat:reset', () => {
    if (running || contextBusy) throw new Error('Wait for the current task or chat operation before starting a new chat.');
    if (settings.workspace) createChatSession(settings.workspace, 'New chat');
    else history.length = 0;
  });
  ipcMain.handle('problems:run', async () => {
    if (!settings.workspace) return { problems: [], checks: [] };
    return runProblemChecks(settings.workspace, { signal: new AbortController().signal, shell: settings.shell });
  });
  ipcMain.handle('diagnostics:bundle', async () => {
    try {
      const p = path.join(app.getPath('userData'), 'jarvin-diagnostics.json');
      const auditPath = path.join(app.getPath('userData'), 'jarvin-audit.jsonl');
      let auditTail = '';
      try { const raw = fs.readFileSync(auditPath, 'utf8').split('\n'); auditTail = raw.slice(-50).join('\n'); } catch { /* no audit */ }
      const safeSettings = { ...settings, voice: { ...settings.voice } };
      const data = { app: 'Jarvin', version: app.getVersion(), platform: process.platform, generatedAt: new Date().toISOString(), settings: safeSettings, auditTail };
      fs.writeFileSync(p, JSON.stringify(data, null, 2));
      return { path: p };
    } catch (e: any) {
      return { path: '', error: String(e?.message ?? e) } as any;
    }
  });
  ipcMain.handle('chat:compact', async () => {
    if (running || contextBusy) return { ok: false, error: 'A run or chat operation is in progress.' };
    if (!history.length) return { ok: true };
    contextBusy = true;
    const transcript = history.map((m) => `[${m.role}] ${(m.content ?? '').slice(0, 1500)}`).join('\n');
    try {
      const summary = await chatOnce({
        baseUrl: settings.baseUrl,
        model: settings.model,
        messages: [
          { role: 'system', content: 'Summarize the conversation concisely, preserving facts, decisions, file paths and errors. Output only the summary.' },
          { role: 'user', content: transcript },
        ],
        timeoutMs: 30000,
        numCtx: Math.min(4096, settings.numCtx || 4096),
      });
      if (!summary.trim()) throw new Error('The model returned an empty summary.');
      history.length = 0;
      history.push({ role: 'assistant', content: `[Summary of earlier turns]\n${summary.slice(0, 4000)}` });
      emit({ type: 'note', text: 'Context compacted.' });
      if (settings.workspace) saveActiveChat(settings.workspace);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    } finally { contextBusy = false; }
  });
  ipcMain.handle('chat:history', () => history.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })));
  ipcMain.handle('chat:sessions', () => {
    if (!settings.workspace) return { active: '', sessions: [] };
    const idx = ensureChatSession(settings.workspace);
    return { active: idx.active, sessions: idx.sessions };
  });
  ipcMain.handle('chat:session:new', () => {
    if (running || contextBusy) throw new Error('Wait for the current task or chat operation before starting a new chat.');
    if (!settings.workspace) return { id: '', messages: [] };
    const c = createChatSession(settings.workspace, 'New chat');
    return { id: c.id, messages: [] };
  });
  ipcMain.handle('chat:session:fork', () => {
    if (running || contextBusy) throw new Error('Wait for the current task or chat operation before switching chats.');
    if (!settings.workspace) return { id: '', messages: [] };
    const root = settings.workspace;
    const cur = readChatIndex(root).active;
    const msgs = loadSessionMessages(root, cur);
    const index = readChatIndex(root);
    const id = crypto.randomUUID();
    const firstUser = msgs.find((m: any) => m.role === 'user');
    const meta: { id: string; title: string; updated: number } = { id, title: firstUser ? slugTitle((firstUser as any).content) + ' (fork)' : 'Forked chat', updated: Date.now() };
    index.sessions.push(meta as any);
    index.active = id;
    writeChatIndex(root, index);
    saveSessionMessages(root, id, msgs);
    history.length = 0;
    for (const m of msgs) history.push(m);
    return { id, messages: msgs.filter((m: any) => m.role === 'user' || m.role === 'assistant').map((m: any) => ({ role: m.role as 'user' | 'assistant', content: m.content })) };
  });
  ipcMain.handle('chat:session:load', async (_e, id: string) => {
    if (running || contextBusy) throw new Error('Wait for the current task or chat operation before switching chats.');
    if (!settings.workspace || typeof id !== 'string') return { id: '', messages: [] };
    const idx = readChatIndex(settings.workspace);
    if (!idx.sessions.some((s) => s.id === id)) return { id: '', messages: [] };
    idx.active = id;
    writeChatIndex(settings.workspace, idx);
    const msgs = loadSessionMessages(settings.workspace, id);
    history.length = 0;
    for (const m of msgs) history.push(m);
    // The agent compacts when the next request starts; loading a chat must not race a model call.
    return { id, messages: history.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })) };
  });
  ipcMain.handle('chat:session:rename', (_e, id: string, title: string) => {
    if (settings.workspace) renameChatSession(settings.workspace, id, title);
  });
  ipcMain.handle('chat:session:update', (_e, id: string, patch: { pinned?: boolean; archived?: boolean; title?: string }) => {
    if (settings.workspace) updateChatSession(settings.workspace, id, patch ?? {});
  });
  ipcMain.handle('chat:session:delete', (_e, id: string) => {
    if (running || contextBusy) throw new Error('Wait for the current task or chat operation before deleting a chat.');
    if (settings.workspace) deleteChatSession(settings.workspace, id);
  });
  ipcMain.handle('approval:respond', (_e, id: string, d: 'allow' | 'always' | 'deny', args?: any) => {
    if (typeof id !== 'string' || !['allow', 'always', 'deny'].includes(d)) return;
    if (pending.has(id)) assistantWidget.clearAttention();
    return pending.get(id)?.(d, args);
  });
  ipcMain.handle('question:answer', (_e, id: string, answer: string) => {
    if (typeof id !== 'string' || typeof answer !== 'string') return;
    if (pendingQuestions.has(id)) assistantWidget.clearAttention();
    pendingQuestions.get(id)?.(answer);
    pendingQuestions.delete(id);
  });
  ipcMain.handle('patch:hunks', (_e, patch: string) => listPatchHunks(String(patch ?? '')));
  ipcMain.handle('patch:filter', (_e, patch: string, keys: any) => filterPatch(String(patch ?? ''), Array.isArray(keys) ? keys : []));

  ipcMain.handle('cp:preview', (_e, id: string) => checkpoints.preview(settings.workspace, id));
  ipcMain.handle('cp:rewind', (_e, id: string, force: boolean) => {
    const pv = checkpoints.preview(settings.workspace, id);
    const r = checkpoints.rewind(settings.workspace, id, force);
    if (r.ok && !running)
      history.push({
        role: 'user',
        content: `[Jarvin: the user undid your file changes. These files were restored to their earlier state: ${pv.files.map((f) => f.path).join(', ')}. Re-read them before editing.]`,
      });
    return r;
  });
  ipcMain.handle('cp:rewindFile', (_e, id: string, filePath: string, force: boolean) => {
    const r = checkpoints.rewindFile(settings.workspace, id, filePath, force === true);
    if (r.ok && !running)
      history.push({
        role: 'user',
        content: `[Jarvin: the user reverted ${filePath} from a checkpoint. Re-read it before editing.]`,
      });
    return r;
  });
  ipcMain.handle('cp:baseline', (_e, id: string, filePath: string) => {
    if (!settings.workspace) return null;
    return checkpoints.baseline(settings.workspace, id, filePath);
  });
  let completeBusy = false;
  ipcMain.handle('code:complete', async (_e, req: { prefix: string; suffix: string; language: string; path?: string; manual?: boolean }) => {
    if (!req?.manual && !settings.autocomplete) return '';
    if (completeBusy && !req?.manual) return ''; // never queue up completions behind a slow model
    const prefix = String(req?.prefix ?? '').slice(-6000);
    const suffix = String(req?.suffix ?? '').slice(0, 2000);
    const lang = String(req?.language ?? 'text');
    const lastNl = prefix.lastIndexOf('\n');
    const linePrefix = prefix.slice(lastNl + 1);
    const lineSuffix = suffix.split('\n')[0] ?? '';
    completeBusy = true;
    try {
      const out = await chatOnce({
        baseUrl: settings.baseUrl,
        model: settings.completionModel?.trim() || settings.model,
        messages: completeMessages({ path: req?.path, language: lang, prefix, suffix }),
        timeoutMs: req?.manual ? 30000 : 8000,
        numCtx: Math.min(4096, settings.numCtx || 4096),
      });
      return cleanCompletion(String(out ?? ''), linePrefix, lineSuffix);
    } catch {
      return '';
    } finally {
      completeBusy = false;
    }
  });
  ipcMain.handle('code:editSelection', async (_e, req: { code: string; instruction: string; language: string; path?: string; before?: string; after?: string }) => {
    const code = String(req?.code ?? '').slice(0, 30000);
    const instruction = String(req?.instruction ?? '').trim();
    if (!instruction) return { text: '', error: 'Type what you want changed.' };
    const model = settings.codingModel?.trim() || settings.model;
    if (!model) return { text: '', error: 'No model selected. Pick one in the model list first.' };
    try {
      const out = await chatOnce({
        baseUrl: settings.baseUrl,
        model,
        messages: editMessages({ path: req?.path, language: String(req?.language ?? 'text'), instruction, before: String(req?.before ?? '').slice(-4000), code, after: String(req?.after ?? '').slice(0, 2000) }),
        timeoutMs: 120000,
        numCtx: Math.min(16384, settings.numCtx || 8192),
      });
      const text = cleanEdit(String(out ?? ''), code);
      if (!text.trim() && code.trim()) return { text: '', error: 'The model returned nothing. Try rephrasing or pick another model.' };
      return { text };
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      return { text: '', error: /timeout|aborted/i.test(msg) ? 'The model took too long. Try a smaller selection or a faster model.' : msg };
    }
  });
  ipcMain.handle('code:symbols', async (_e, query: string) => {
    if (!settings.workspace) return [];
    try { return await workspaceSymbols(settings.workspace, String(query ?? ''), 200); }
    catch { return []; }
  });
  ipcMain.handle('voice:status', () => ({ ...voice.status(), hotkey }));
  ipcMain.handle('voice:download', () => voice.download());
  ipcMain.handle('voice:warm', () => voice.warmCached());
  ipcMain.handle('voice:neural-status', (e) => ({ available: !!win && e.sender === win.webContents && !!piper?.available() }));
  ipcMain.handle('voice:neural-warm', async (e) => {
    if (!win || e.sender !== win.webContents) return { ok: false, error: 'Not allowed.' };
    try { await piper.warm(); return { ok: true }; } catch (error: any) { return { ok: false, error: String(error?.message ?? error) }; }
  });
  ipcMain.handle('voice:neural-synthesize', async (e, text: unknown, rate: unknown) => {
    if (!win || e.sender !== win.webContents || typeof text !== 'string' || (rate !== undefined && typeof rate !== 'number')) return { error: 'Not allowed.' };
    try { return await piper.synthesize(text, rate as number | undefined); } catch (error: any) { return { error: String(error?.message ?? error) }; }
  });
  ipcMain.handle('voice:transcribe', async (_e, audio: Float32Array, o?: { external?: boolean; wake?: boolean; fast?: boolean; name?: boolean }) => {
    try {
      return await voice.process(audio instanceof Float32Array ? audio : new Float32Array(audio as any), { external: !!o?.external, wake: !!o?.wake && !o?.external, fast: !!o?.fast && !o?.external, name: !!o?.name && !o?.external, app: o?.external ? await dictationTarget : null });
    } catch (e: any) {
      applog(`voice error: ${e?.message ?? e}`);
      return { error: String(e?.message ?? e) };
    }
  });
  ipcMain.handle('voice:transcribePiece', async (_e, audio: Float32Array) => {
    try {
      return { text: await voice.transcribePiece(audio instanceof Float32Array ? audio : new Float32Array(audio as any)) };
    } catch (e: any) {
      applog(`voice file error: ${e?.message ?? e}`);
      return { error: String(e?.message ?? e) };
    }
  });
  ipcMain.handle('voice:diagnose', async (_e, audio: Float32Array) => {
    try {
      return await voice.diagnose(audio instanceof Float32Array ? audio : new Float32Array(audio as any));
    } catch (e: any) {
      return { error: String(e?.message ?? e) };
    }
  });
  ipcMain.handle('voicemcp:info', () => voiceMcp?.info() ?? { running: false, port: 0, token: '' });
  ipcMain.handle('voicemcp:regen', async () => { voiceMcp?.regenerate(); return voiceMcp?.info(); });
  ipcMain.handle('voicemcp:reply', (_e, id: string, r: { text?: string; error?: string }) => voiceBridge.reply(String(id), r && typeof r === 'object' ? r : {}));
  ipcMain.handle('voice:partial', (_e, audio: Float32Array) => voice.partial(audio instanceof Float32Array ? audio : new Float32Array(audio as any)));
  ipcMain.handle('voice:overlay', (_e, m: OverlayMsg) => {
    if (settings.voice.overlay) overlay.update(m);
    else if (m.state === 'hidden') overlay.hide();
  });
  ipcMain.handle('voice:paste', (_e, text: string) => pasteIntoActiveApp(String(text ?? '')));
  // Lets the end-to-end tests press the hotkey (a real global shortcut can't be pressed on a headless display).
  ipcMain.handle('voice:hotkey:test', (_e, focused: boolean) => {
    if (process.env.JARVIN_E2E) triggerHotkey(focused);
  });
  ipcMain.handle('voice:files', () => voice.files());
  ipcMain.handle('voice:rewrite', async (_e, draft: string, instruction: string) => {
    try {
      return { text: await voice.rewrite(String(draft ?? ''), String(instruction ?? '')) };
    } catch (e: any) {
      return { error: String(e?.message ?? e) };
    }
  });
  ipcMain.handle('voice:history', () => voice.history());
  ipcMain.handle('voice:history:delete', (_e, id?: string) => voice.deleteHistory(id));
  ipcMain.handle('perm:list', () => permLists());
  ipcMain.handle('perm:remove', (_e, kind: string, i: number) => {
    if ((kind !== 'allow' && kind !== 'deny') || !Number.isInteger(i)) throw new Error('Invalid rule.');
    perms.removeRule(settings.workspace, kind, i);
    return permLists();
  });
  ipcMain.handle('perm:add', (_e, kind: string, rule: any) => {
    if (kind !== 'allow' && kind !== 'deny') throw new Error('Invalid rule type.');
    if (!settings.workspace) throw new Error('Open a folder first.');
    const v = validateRule(kind, { tool: rule?.tool, match: rule?.match, path: rule?.path }, [...builtinTools, ...mcp.tools()].map((t) => t.name));
    if ('error' in v) throw new Error(v.error);
    perms.addRule(settings.workspace, kind, v.rule);
    return permLists();
  });
  ipcMain.handle('fs:delete', async (_e, rel: string) => {
    if (typeof rel !== 'string') throw new Error('Invalid path.');
    const target = resolveSafe(settings.workspace, rel, { write: true });
    await fs.promises.rm(target, { recursive: true, force: true });
  });
  ipcMain.handle('fs:move', async (_e, from: string, to: string) => {
    if (typeof from !== 'string' || typeof to !== 'string') throw new Error('Invalid path.');
    const src = resolveSafe(settings.workspace, from, { write: true });
    const dst = resolveSafe(settings.workspace, to, { write: true });
    await fs.promises.mkdir(path.dirname(dst), { recursive: true });
    await fs.promises.rename(src, dst);
  });
  ipcMain.handle('fs:mkdir', async (_e, rel: string) => {
    if (typeof rel !== 'string') throw new Error('Invalid path.');
    await fs.promises.mkdir(resolveSafe(settings.workspace, rel, { write: true }), { recursive: true });
  });

  ipcMain.handle('mcp:get', () => ({ config: readMcpConfig(), status: mcp.status }));
  ipcMain.handle('mcp:set', async (_e, config: string) => {
    if (typeof config !== 'string') throw new Error('Invalid config.');
    try {
      JSON.parse(config);
    } catch (e: any) {
      return { status: mcp.status, error: `Invalid JSON: ${e.message}` };
    }
    fs.writeFileSync(mcpConfigPath(settings.workspace), config);
    try {
      await mcp.load(config, settings.workspace);
      return { status: mcp.status };
    } catch (e: any) {
      return { status: mcp.status, error: String(e?.message ?? e) };
    }
  });

  ipcMain.handle('term:create', (_e, cwd?: string, cols?: number, rows?: number) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sh = interactiveShell(settings.shell);
    const dims = { cols: Number.isFinite(cols) ? Math.max(20, Math.trunc(cols!)) : 100, rows: Number.isFinite(rows) ? Math.max(5, Math.trunc(rows!)) : 30 };
    const dir = cwd && typeof cwd === 'string' && fs.existsSync(cwd) ? cwd : settings.workspace && fs.existsSync(settings.workspace) ? settings.workspace : os.homedir();
    // ConPTY is Windows' own pseudo-console (the same one cmd and Windows Terminal use). Older winpty is only a fallback.
    const backends = process.platform === 'win32' ? [true, false] : [false];
    for (const conpty of backends) {
      try {
        const term = pty.spawn(sh.file, sh.args, { name: 'xterm-256color', ...dims, cwd: dir, env: terminalEnv() as any, ...(process.platform === 'win32' ? { useConpty: conpty } : {}) });
        term.onData((data: string) => win?.webContents.send('terminal:data', { id, data }));
        term.onExit(({ exitCode }: { exitCode: number }) => {
          applog(`term ${id} exit=${exitCode}`);
          terminals.delete(id);
          win?.webContents.send('terminal:exit', { id, exitCode });
        });
        terminals.set(id, term);
        applog(`term ${id} ${sh.label} backend=${process.platform === 'win32' ? (conpty ? 'conpty' : 'winpty') : 'pty'} ${dims.cols}x${dims.rows}`);
        return { id, label: sh.label, backend: process.platform === 'win32' ? (conpty ? 'conpty' : 'winpty') : null, build: Number(os.release().split('.')[2]) || 0 };
      } catch (e: any) {
        applog(`term create error (${conpty ? 'conpty' : 'fallback'}): ${e?.message ?? e}`);
      }
    }
    return null;
  });
  ipcMain.handle('term:write', (_e, id: string, data: string) => {
    if (typeof data === 'string' && data) terminals.get(String(id))?.write(data);
  });
  ipcMain.handle('term:resize', (_e, id: string, cols: number, rows: number) => {
    const t = terminals.get(id);
    if (t && Number.isFinite(cols) && Number.isFinite(rows)) t.resize(Math.max(10, Math.trunc(cols)), Math.max(5, Math.trunc(rows)));
  });
  ipcMain.handle('term:list', () => [...terminals.keys()]);
  ipcMain.handle('term:status', (_e, id: string) => ({ active: terminals.has(String(id)) }));
  ipcMain.handle('chat:status', () => ({ running: Boolean(running) }));
  ipcMain.handle('term:kill', (_e, id: string) => {
    const t = terminals.get(id);
    if (t) {
      try { t.kill(); } catch { /* ignore */ }
      terminals.delete(id);
    }
  });
}

try {
  fs.writeFileSync(logFile, '');
} catch {
  /* ignore */
}
applog(`start electron ${process.versions.electron} node ${process.versions.node} ${process.platform}`);
app.setAppUserModelId('ai.jarvin.app');
// The installed app and the run-from-source app share one data folder (settings, chats, traces).
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', path.join(app.getPath('appData'), 'jarvin'));
const gotLock = app.requestSingleInstanceLock();
let crashWatch: ChildProcess | undefined;
function stopCrashWatch() {
  crashWatch?.kill();
  crashWatch = undefined;
}
if (!gotLock) app.quit();
app.on('second-instance', (_e, argv, workingDirectory) => {
  const folder = cliFolderArgv(argv, workingDirectory);
  if (folder && !running && !contextBusy) {
    settings = saveSettings(settings, { workspace: folder });
    refreshWorkspaceWatcher();
    void emit({ type: 'fs_changed' as any });
  }
  else if (folder && (running || contextBusy)) emit({ type: 'note', text: 'Finish the current task or chat operation before changing folders.' });
  if (!win) return;
  openMainWindow();
});
app.whenReady().then(() => {
  sweepSandboxes();
  if (!gotLock) return;
  if (process.platform === 'win32' && (!process.env.JARVIN_E2E || process.env.JARVIN_TEST_CRASH_WATCH === '1')) {
    crashWatch = spawn(process.execPath, [path.join(__dirname, 'crash-watch.js'), ...process.argv.slice(1)], {
      detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    crashWatch.on('error', e => applog('Crash restart unavailable: ' + e.message));
  }
  settings = loadSettings();
  setScreenExclusions(settings.excludedApps ?? [], settings.excludedWindowTitles ?? []);
  applyObservationPause(settings.observationPaused === true);
  if (!settings.workspace) {
    try {
      const personalWorkspace = path.join(app.getPath('userData'), 'assistant-workspace');
      fs.mkdirSync(personalWorkspace, { recursive: true });
      settings = saveSettings(settings, { workspace: personalWorkspace });
    } catch (e: any) { applog(`default assistant workspace unavailable: ${String(e?.message ?? e)}`); }
  }
  try { runJournal = new RunJournal(path.join(app.getPath('userData'), 'run-journal')); runJournal.recover(); }
  catch (e: any) { runJournal = null; applog(`task recovery unavailable: ${String(e?.message ?? e)}`); }
  try { reminders = new ReminderStore(path.join(app.getPath('userData'), 'reminders.json'), windowsReminderBackup); reminders.list(); }
  catch (e: any) { reminders = null; applog(`reminder storage unavailable: ${String(e?.message ?? e)}`); }
  try { routines = new RoutineStore(path.join(app.getPath('userData'), 'routines.json')); routines.list(); }
  catch (e: any) { routines = null; applog(`routine storage unavailable: ${String(e?.message ?? e)}`); }
  setProviderApiKey(settings.providerApiKey);
  const cliFolder = cliFolderArgv();
  if (cliFolder) settings = saveSettings(settings, { workspace: cliFolder });
  if (settings.workspace) loadActiveChat(settings.workspace);
  checkpoints = new CheckpointStore(path.join(app.getPath('userData'), 'checkpoints'));
  perms = new PermissionStore(path.join(app.getPath('userData'), 'permissions.json'));
  voice = new VoiceService(
    () => settings,
    { appRoot: path.join(__dirname, '..'), data: app.getPath('userData'), workerFile: path.join(__dirname, 'stt-worker.js') },
    (p) => win?.webContents.send('voice:progress', p),
  );
  // A voice the user installed wins; otherwise the copy shipped in assets/voice/piper is used, so a fresh install speaks naturally.
  const userPiper = path.join(app.getPath('userData'), 'models', 'piper');
  const bundledPiper = path.join(__dirname, '..', 'assets', 'voice', 'piper');
  const piperDir = fs.existsSync(path.join(userPiper, 'joe.onnx')) || !fs.existsSync(path.join(bundledPiper, 'joe.onnx')) ? userPiper : bundledPiper;
  piper = new PiperService(path.join(__dirname, 'piper-worker.js'), piperDir, path.join(userPiper, '..', 'kokoro'));
  // Only the app's own page may use the microphone; everything else is denied.
  const own = (url: string) => url.startsWith('file://');
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    const types = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
    cb(permission === 'media' && own(wc.getURL()) && types.length > 0 && types.every((t) => t === 'audio'));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission) => permission === 'media' && !!wc && own(wc.getURL()));
  voiceMcp = new VoiceMcpServer({
    dataDir: app.getPath('userData'),
    ask: (kind, payload, ms) => voiceBridge.ask(kind, payload, ms),
    micAllowed: () => !!settings.voice.mcpMic,
    resolveFile: (rel) => { if (!settings.workspace) throw new Error('No folder is open in Jarvin.'); return resolveSafe(settings.workspace, rel); },
    log: applog,
  });
  registerIpc();
  const resetDisplayStream = () => { liveScreen.stop(); screenObserver.invalidate(); };
  screen.on('display-added', resetDisplayStream);
  screen.on('display-removed', resetDisplayStream);
  screen.on('display-metrics-changed', resetDisplayStream);
  const stopForInactiveSession = () => {
    setScreenLocked(true);
    screenObserver.stop();
    liveScreen.stop();
    if (running && !running.signal.aborted) stopCurrentRun();
  };
  powerMonitor.on('lock-screen', stopForInactiveSession);
  powerMonitor.on('suspend', stopForInactiveSession);
  const resumeForActiveSession = () => {
    setScreenLocked(false);
    if (win && !win.isDestroyed() && !win.isVisible() && !settings.observationPaused && openedOnce) screenObserver.start();
    checkReminders(); // catch up at once after sleep or unlock instead of waiting for the next 30 s tick
  };
  powerMonitor.on('unlock-screen', resumeForActiveSession);
  powerMonitor.on('resume', resumeForActiveSession);
  registerHotkey();
  if (app.isPackaged && settings.updateAuto !== false && settings.updateUrl) setTimeout(() => void updater.check(), 20_000);
  syncVoiceMcp();
  createWindow();
  if (!process.env.JARVIN_E2E) void ensureOllamaRunning(settings.baseUrl).then((r) => { if (r === 'started') applog('Ollama was not running; started it.'); }).catch(() => {});
  if (backgroundStart) applog('background start: window hidden, microphone and models wait for first open');
  else warmModels();
  createTray();
  applyLoginItem();
  checkReminders();
  reminderTimer = setInterval(checkReminders, 30_000);
  refreshWorkspaceWatcher();
  if (safeModeArgv()) {
    emit?.({ type: 'note', text: 'Safe mode: MCP servers and external integrations are disabled.' });
  } else {
    void reloadMcp();
  }
});
app.on('before-quit', () => { stopCrashWatch(); quitting = true; try { runJournal?.recover('paused'); } catch { /* start-up recovery handles it */ } });
app.on('will-quit', () => { tray?.destroy(); screenObserver.stop(); liveScreen.dispose(); privacyWorker.dispose?.(); browserShare.stop(); if (reminderTimer) clearInterval(reminderTimer); jobs.killAll(); globalShortcut.unregisterAll(); discardAllVerified(); cancelAllPulls(); });
app.on('window-all-closed', () => {
  overlay.dispose();
  void Promise.all([mcp.closeAll(), voice?.dispose(), piper?.dispose(), voiceMcp?.stop()]).finally(() => app.quit());
});
