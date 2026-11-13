import type { ProblemsResult } from './problems';
import type { LocalModel, PullProgress } from './models';
import type { UpdateState } from './updatecfg';
import type { Trace, TraceSummary } from './trace';
import type { VoiceSettings, VoiceStatus, VoiceProgress, VoiceResult, VoiceHistoryEntry, OverlayMsg } from './voice';
import type { MemoryInfo, MemoryContent } from '../main/memory';
import type { RunRecord } from './run-journal';
import type { Reminder } from './reminders';
import type { Routine } from './routines';
import type { ProactiveSettings } from './proactive';
import type { SharedBrowserPage } from './browser-share';
import type { AssistantWidgetAction, AssistantWidgetState } from './assistant-widget';
export type Mode = 'ask' | 'auto-edit' | 'auto' | 'plan';
export type ShellChoice = 'auto' | 'powershell' | 'cmd';

export interface ModelsDetails {
  ollama: { up: boolean; version?: string; error?: string };
  models: LocalModel[];
  pulling: string[];
  hasKey: boolean;
  ramGB: number;
  baseUrl: string;
  offline: boolean;
}

export interface Settings {
  baseUrl: string;
  providerApiKey?: string;
  model: string;
  embeddingModel: string;
  codingModel?: string;
  reasoningModel?: string;
  visionModel?: string;
  /** Ghost-text autocomplete while typing in the editor (off by default: it uses the model on every pause). */
  autocomplete?: boolean;
  /** Model used for autocomplete; blank = chat model. A small fast local model works best. */
  completionModel?: string;
  /** After the agent edits files, run the project's checks and let it fix errors it caused. Default on. */
  autoCheck?: boolean;
  /** Name of the active custom mode (see .jarvin/modes); empty = none. */
  persona?: string;
  numCtx: number;
  temperature: number;
  mode: Mode;
  workspace: string;
  maxSteps: number;
  shell: ShellChoice;
  offline: boolean;
  /** Stop built-in screen/window capture until explicitly resumed. Persists across restarts. */
  observationPaused?: boolean;
  /** Process names to exclude from desktop control and full-display capture. */
  excludedApps?: string[];
  /** Case-insensitive title fragments to exclude from desktop control and full-display capture. */
  excludedWindowTitles?: string[];
  /** True once the first-run guide was finished or skipped. */
  setupDone?: boolean;
  /** Address of the folder on the web that holds latest.yml and the installer. Empty = no update checks. */
  updateUrl?: string;
  /** Check quietly at start-up when an address is set. Default on. */
  updateAuto?: boolean;
  /** Desktop notification when a long run or background command ends while Jarvin is in the background. Default on. */
  notifyDone?: boolean;
  /** Continue the newest interrupted task once when Jarvin starts again after a crash or forced exit. Default on. */
  resumeTasks?: boolean;
  /** Start Jarvin hidden when the user signs in to Windows. Default off. */
  startAtLogin?: boolean;
  /** Unprompted spoken notices (low battery, due reminders). Off unless enabled. */
  proactive?: Partial<ProactiveSettings>;
  voice: VoiceSettings;
}

export interface PermissionRule {
  tool: string;
  /** run_command: a command prefix such as "npm test". Omitted for whole-tool rules. */
  match?: string;
  /** Other tools: a path glob such as "src/**" the rule is limited to. Omitted = every path. */
  path?: string;
}
export interface PermissionLists { allow: PermissionRule[]; deny: PermissionRule[]; shared: PermissionRule[] }

export interface CheckpointSummary {
  id: string;
  files: { path: string; status: 'created' | 'modified' | 'deleted' }[];
}
export interface HookInfo { event: string; tool: string; match: string; command: string }
export interface ExtStatus {
  personas: { name: string; description: string; tools: string; builtin: boolean }[];
  active: string;
  rules: { used: string[]; truncated: string[] };
  hooks: { active: HookInfo[]; pending: HookInfo[]; errors: string[] };
}
export interface RewindPreview {
  files: { path: string; action: 'restore' | 'delete'; conflict: boolean }[];
  /** Newer checkpoints that are undone together with this one. */
  laterTurns: number;
}
export interface RewindResult {
  ok: boolean;
  restored: number;
  deleted: number;
  conflicts: string[];
  error?: string;
}

export interface TreeEntry {
  name: string;
  path: string;
  dir: boolean;
}

export type AgentEvent =
  | { type: 'token'; text: string }
  | { type: 'tool_start'; id: string; name: string; args: unknown }
  | { type: 'tool_output'; id: string; text: string }
  | { type: 'tool_result'; id: string; ok: boolean; output: string }
  | { type: 'approval'; id: string; name: string; summary: string; always?: string }
  | { type: 'question'; id: string; question: string; options: string[] }
  | { type: 'checkpoint'; summary: CheckpointSummary }
  | { type: 'tasks'; items: { content: string; status?: 'pending' | 'in_progress' | 'done' }[] }
  | { type: 'fs_changed' }
  | { type: 'problems'; result: ProblemsResult }
  | { type: 'verified'; id: string; [k: string]: any }
  | { type: 'note'; text: string }
  | { type: 'usage'; model: string; ms: number; promptTokens?: number; completionTokens?: number; sizes?: { system: number; tools: number; toolCount: number; history: number } }
  | { type: 'done'; outcome?: 'finished' | 'paused' | 'stopped' | 'failed' }
  | { type: 'error'; message: string };

export interface McpStatus {
  name: string;
  ok: boolean;
  tools: number;
  error?: string;
}

import type { JobInfo } from './jobs';

export interface JarvinApi {
  platform: string;
  assistantCompact(): Promise<void>;
  assistantRestore(): Promise<void>;
  assistantState(state: Pick<AssistantWidgetState, 'working' | 'mic' | 'speaking' | 'level' | 'hearing'>): void;
  onAssistantAction(cb: (action: AssistantWidgetAction) => void): () => void;
  /** Fires once when the window is first shown after a hidden start at sign-in. */
  onFirstOpen(cb: () => void): () => void;
  openExternal(url: string): Promise<void>;
  getSettings(): Promise<Settings>;
  setSettings(s: Partial<Settings>): Promise<Settings>;
  privacyWindows(): Promise<{ app: string; title: string }[]>;
  listModels(): Promise<{ models: string[]; error?: string; local?: string[]; ollamaCloud?: string[]; hasKey?: boolean }>;
  memoryList(): Promise<MemoryInfo[]>;
  memoryRead(id: string): Promise<MemoryContent>;
  memorySave(id: string, revision: string, text: string): Promise<void>;
  memoryDelete(id: string, revision: string): Promise<void>;
  modelsDetails(): Promise<ModelsDetails>;
  modelsPull(name: string): Promise<PullProgress>;
  modelsCancel(name: string): Promise<boolean>;
  modelsDelete(name: string): Promise<void>;
  onModelProgress(cb: (p: PullProgress) => void): () => void;
  jobsList(): Promise<JobInfo[]>;
  jobsStart(command: string): Promise<JobInfo>;
  jobsOutput(id: string): Promise<{ info: JobInfo; output: string }>;
  jobsStop(id: string): Promise<boolean>;
  jobsRemove(id: string): Promise<void>;
  jobsClear(): Promise<void>;
  remindersList(): Promise<Reminder[]>;
  remindersCreate(text: string, dueAt: number, repeat?: string): Promise<Reminder>;
  remindersUpdate(id: string, text: string, dueAt: number, repeat?: string): Promise<Reminder>;
  remindersSnooze(id: string, minutes: number): Promise<Reminder>;
  remindersRemove(id: string): Promise<void>;
  onReminders(cb: () => void): () => void;
  routinesList(): Promise<Routine[]>;
  routinesSave(id: string | null, revision: string | null, name: string, steps: string[], dailyAt?: string): Promise<Routine>;
  onRoutineDue(cb: (routine: Routine) => void): () => void;
  routinesRemove(id: string, revision: string): Promise<void>;
  browserShareStart(): Promise<{ code: string; expiresAt: number }>;
  browserShareStop(): Promise<void>;
  browserShareFolder(): Promise<void>;
  onBrowserShare(cb: (page: SharedBrowserPage) => void): () => void;
  interruptedRuns(): Promise<RunRecord[]>;
  dismissRun(id: string): Promise<void>;
  clearFinishedRuns(): Promise<number>;
  onCommandFinished(cb: (status: 'done' | 'failed') => void): () => void;
  onJobs(cb: (list: JobInfo[]) => void): () => void;
  /** Opens the preview window, optionally on a port, address or project file. */
  previewOpen(target?: string): Promise<{ ok: boolean; error?: string }>;
  onPreviewToChat(cb: (m: { kind: 'image'; base64: string; note: string } | { kind: 'text'; text: string }) => void): () => void;
  gitx<T = any>(op: string, args?: Record<string, unknown>): Promise<T>;
  traceList(): Promise<TraceSummary[]>;
  traceGet(id: string): Promise<Trace>;
  traceDelete(id: string): Promise<void>;
  traceClear(days: number): Promise<number>;
  traceReveal(id?: string): Promise<void>;
  updateState(): Promise<UpdateState>;
  updateCheck(): Promise<UpdateState>;
  updateDownload(): Promise<UpdateState>;
  updateInstall(): Promise<boolean>;
  onUpdate(cb: (s: UpdateState) => void): () => void;
  pickWorkspace(): Promise<string | null>;
  tree(rel: string): Promise<TreeEntry[]>;
  readFile(rel: string): Promise<string>;
  /** A project image as a data: URL (png, jpg, gif, webp, bmp, ico, svg, avif; up to 10 MB). */
  readImage(rel: string): Promise<string>;
  worktrees(): Promise<Array<{ id: string; task: string; path: string; branch: string }>>;
  subagentRuns(): Promise<Array<{ id: string; kind: string; task: string; state: string; startedAt: number; completedAt?: number; error?: string; path?: string; branch?: string }>>;
  subagentCancel(id: string): Promise<boolean>;
  worktreeDiff(id: string): Promise<string>;
  worktreeKeep(id: string): Promise<{ ok: boolean; stage: string; output: string; conflicts?: string }>;
  worktreeDiscard(id: string): Promise<{ ok: boolean }>;
  verifiedDiff(id: string, file?: string): Promise<string>;
  verifiedApply(id: string, only?: string[]): Promise<{ applied: number; conflicts: { path: string; reason: string }[] }>;
  verifiedDiscard(id: string): Promise<boolean>;
  searchWorkspace(pattern: string): Promise<{ path: string; line: number; text: string }[]>;
  writeFile(rel: string, content: string): Promise<void>;
  deletePath(rel: string): Promise<void>;
  movePath(from: string, to: string): Promise<void>;
  makeDir(rel: string): Promise<void>;
  send(text: string, activePath: string | null, images?: string[], surface?: 'assistant' | 'code'): Promise<void>;
  abort(): Promise<void>;
  reset(): Promise<void>;
  chatHistory(): Promise<{ role: 'user' | 'assistant'; content: string }[]>;
  clearChatHistory(): Promise<void>;
  compactChat(): Promise<{ ok: boolean; error?: string }>;
  diagnosticsBundle(): Promise<{ path: string }>;
  runProblems(): Promise<ProblemsResult>;
  extStatus(): Promise<ExtStatus>;
  trustHooks(): Promise<boolean>;
  chatSessions(): Promise<{ active: string; sessions: { id: string; title: string; updated: number; archived?: boolean; pinned?: boolean }[] }>;
  newChatSession(): Promise<{ id: string; messages: { role: 'user' | 'assistant'; content: string }[] }>;
  forkChatSession(): Promise<{ id: string; messages: { role: 'user' | 'assistant'; content: string }[] }>;
  gitStatus(): Promise<string>;
  gitStatusPorcelain(): Promise<string>;
  gitDiff(rel?: string): Promise<string>;
  gitDraftCommit(): Promise<{ message: string; error?: string }>;
  gitBranches(): Promise<string>;
  gitCheckout(branch: string): Promise<string>;
  gitStage(rel?: string): Promise<string>;
  gitUnstage(rel?: string): Promise<string>;
  gitCommit(message: string): Promise<string>;
  loadChatSession(id: string): Promise<{ id: string; messages: { role: 'user' | 'assistant'; content: string }[] }>;
  renameChatSession(id: string, title: string): Promise<void>;
  updateChatSession(id: string, patch: { pinned?: boolean; archived?: boolean; title?: string }): Promise<void>;
  deleteChatSession(id: string): Promise<void>;
  approve(id: string, decision: 'allow' | 'always' | 'deny', args?: any): Promise<void>;
  answerQuestion(id: string, answer: string): Promise<void>;
  killAll(): Promise<void>;
  patchHunks(patch: string): Promise<{ key: string; path: string; type: string; oldText: string; newText: string }[]>;
  patchFilter(patch: string, keys: string[]): Promise<string>;
  rewindPreview(id: string): Promise<RewindPreview>;
  rewind(id: string, force: boolean): Promise<RewindResult>;
  rewindFile(id: string, path: string, force: boolean): Promise<RewindResult>;
  checkpointBaseline(id: string, path: string): Promise<string | null>;
  codeComplete(req: { prefix: string; suffix: string; language: string; path?: string; manual?: boolean }): Promise<string>;
  codeEditSelection(req: { code: string; instruction: string; language: string; path?: string; before?: string; after?: string }): Promise<{ text: string; error?: string }>;
  workspaceSymbols(query: string): Promise<{ path: string; name: string; kind: string; line: number; column: number }[]>;
  voiceStatus(): Promise<VoiceStatus>;
  voiceDownload(): Promise<{ ok: boolean; error?: string }>;
  voiceWarm(): Promise<{ ok: boolean; error?: string; note?: string }>;
  /** Probability (0 to 1) that this chunk is speech, from the trained detector; null when it is unavailable. */
  voiceVad(audio: Float32Array, reset?: boolean): Promise<number | null>;
  neuralVoiceStatus(): Promise<{ available: boolean }>;
  neuralVoiceWarm(): Promise<{ ok: boolean; error?: string }>;
  neuralVoiceSynthesize(text: string, rate?: number): Promise<{ pcm: Float32Array; sampleRate: number } | { error: string }>;
  voiceTranscribe(audio: Float32Array, o?: { external?: boolean; wake?: boolean; fast?: boolean; name?: boolean }): Promise<VoiceResult | { error: string }>;
  voiceTranscribePiece(audio: Float32Array): Promise<{ text: string } | { error: string }>;
  voiceDiagnose(audio: Float32Array): Promise<import('./voice').VoiceDiagnostic | { error: string }>;
  voiceTestStatus(): Promise<{ sentences: string[]; recorded: number[]; models: string[]; running: boolean; report: import('./voicetest').VoiceTestReport | null }>;
  voiceTestSave(index: number, audio: Float32Array): Promise<number[]>;
  voiceTestClear(): Promise<void>;
  voiceTestRun(): Promise<import('./voicetest').VoiceTestReport>;
  onVoiceTestProgress(cb: (p: { model: string; done: number; total: number }) => void): () => void;
  voiceMcpInfo(): Promise<{ running: boolean; port: number; token: string; error?: string }>;
  voiceMcpRegen(): Promise<{ running: boolean; port: number; token: string; error?: string }>;
  voiceMcpReply(id: string, r: { text?: string; error?: string }): Promise<void>;
  onVoiceMcpRequest(cb: (m: { id: string; kind: 'listen' | 'speak' | 'transcribeFile'; payload: any }) => void): () => void;
  voicePartial(audio: Float32Array): Promise<string | null>;
  voiceOverlay(m: OverlayMsg): Promise<void>;
  voicePaste(text: string): Promise<{ ok: boolean; copied?: boolean; error?: string }>;
  voiceTestHotkey(focused: boolean): Promise<void>;
  onVoiceHotkey(cb: (p: { jarvinFocused: boolean }) => void): () => void;
  voiceFiles(): Promise<string[]>;
  voiceRewrite(draft: string, instruction: string): Promise<{ text: string } | { error: string }>;
  voiceHistory(): Promise<VoiceHistoryEntry[]>;
  voiceHistoryDelete(id?: string): Promise<VoiceHistoryEntry[]>;
  onVoiceProgress(cb: (p: VoiceProgress) => void): () => void;
  getPermissions(): Promise<PermissionLists>;
  removePermission(kind: 'allow' | 'deny', index: number): Promise<PermissionLists>;
  addPermission(kind: 'allow' | 'deny', rule: PermissionRule): Promise<PermissionLists>;
  getMcp(): Promise<{ config: string; status: McpStatus[] }>;
  setMcp(config: string): Promise<{ status: McpStatus[]; error?: string }>;
  onEvent(cb: (e: AgentEvent) => void): () => void;
  termCreate(cwd?: string, cols?: number, rows?: number): Promise<{ id: string; label: string; backend: 'conpty' | 'winpty' | null; build: number } | null>;
  termWrite(id: string, data: string): Promise<void>;
  termResize(id: string, cols: number, rows: number): Promise<void>;
  termKill(id: string): Promise<void>;
  termList(): Promise<string[]>;
  termStatus(id: string): Promise<{ active: boolean }>;
  chatStatus(): Promise<{ running: boolean }>;
  onTermData(cb: (p: { id: string; data: string }) => void): () => void;
  onTermExit(cb: (p: { id: string; exitCode: number }) => void): () => void;
}

declare global {
  interface Window {
    jarvin: JarvinApi;
  }
}
