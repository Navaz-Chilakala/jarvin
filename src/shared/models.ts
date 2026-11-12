// Renderer-safe model helpers: names, sizes, recommendations, pull progress and default-model choice.

export interface LocalModel {
  name: string;
  /** Bytes on disk. */
  size: number;
  /** ISO time the model was last changed. */
  modified?: string;
  params?: string;
  quant?: string;
  family?: string;
  /** Set by Ollama when inference is delegated to a remote host. */
  remoteHost?: string;
}

export interface PullProgress {
  name: string;
  status: string;
  total?: number;
  completed?: number;
  /** 0..100 when the size is known, otherwise undefined. */
  pct?: number;
  done?: boolean;
  error?: string;
}

export interface Recommended {
  name: string;
  label: string;
  note: string;
  /** Approximate download size in GB, for the button label. */
  gb: number;
  /** Rough memory the model wants to run comfortably. */
  ramGB: number;
  kind: 'chat' | 'autocomplete' | 'embedding';
}

/** Hints only. Ollama's own library is the source of truth; the box for a custom name is always there. */
export const RECOMMENDED: Recommended[] = [
  { name: 'qwen3:4b', label: 'Qwen3 4B', note: 'Small and quick. Fine for light edits on modest PCs.', gb: 2.6, ramGB: 6, kind: 'chat' },
  { name: 'qwen3:8b', label: 'Qwen3 8B', note: 'Good all-rounder with tool calling.', gb: 5.2, ramGB: 10, kind: 'chat' },
  { name: 'qwen2.5-coder:7b', label: 'Qwen2.5 Coder 7B', note: 'Tuned for code.', gb: 4.7, ramGB: 10, kind: 'chat' },
  { name: 'qwen3:14b', label: 'Qwen3 14B', note: 'Noticeably stronger. Wants a big GPU or lots of RAM.', gb: 9.3, ramGB: 18, kind: 'chat' },
  { name: 'qwen2.5-coder:1.5b', label: 'Qwen2.5 Coder 1.5B', note: 'Tiny and fast, for autocomplete.', gb: 1, ramGB: 3, kind: 'autocomplete' },
  { name: 'nomic-embed-text', label: 'Nomic Embed Text', note: 'Used to search your project by meaning.', gb: 0.3, ramGB: 1, kind: 'embedding' },
];

/** The chat model to suggest first for a machine with this much memory. */
export function suggestChatModel(ramGB: number): Recommended {
  const chat = RECOMMENDED.filter((r) => r.kind === 'chat');
  const fit = chat.filter((r) => r.name !== 'qwen2.5-coder:7b' && r.ramGB <= ramGB);
  return fit[fit.length - 1] ?? chat[0];
}

/** A model name Jarvin will pass to Ollama: letters, digits and . _ - / : @ only, no leading dash. */
export function validModelName(name: unknown): name is string {
  return typeof name === 'string' && name.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._\-/:@]*$/.test(name);
}

/** Same rule the chat router uses: provider-style ids go to OpenRouter, everything else to Ollama. */
export function isRemoteModelId(model: string): boolean {
  return model.includes('/') || model.endsWith(':free');
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1000 && i < u.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

/** Turns one NDJSON line from Ollama's /api/pull into a progress record. Returns null for blank lines. */
export function parsePullLine(name: string, line: string): PullProgress | null {
  if (!line.trim()) return null;
  let j: any;
  try {
    j = JSON.parse(line);
  } catch {
    return null;
  }
  if (j?.error) return { name, status: 'error', error: String(j.error), done: true };
  const status = String(j?.status ?? '');
  const total = typeof j?.total === 'number' ? j.total : undefined;
  const completed = typeof j?.completed === 'number' ? j.completed : undefined;
  const pct = total && completed !== undefined ? Math.max(0, Math.min(100, Math.floor((completed / total) * 100))) : undefined;
  return { name, status, total, completed, pct, done: status === 'success' };
}

/** What `/api/tags` returns, reduced to what the UI shows. Bad entries are skipped. */
export function parseTags(json: unknown): LocalModel[] {
  const list = (json as any)?.models;
  if (!Array.isArray(list)) return [];
  const out: LocalModel[] = [];
  for (const m of list) {
    const name = typeof m?.name === 'string' ? m.name : typeof m?.model === 'string' ? m.model : '';
    if (!name) continue;
    out.push({
      name,
      size: typeof m.size === 'number' ? m.size : 0,
      modified: typeof m.modified_at === 'string' ? m.modified_at : undefined,
      params: m.details?.parameter_size,
      quant: m.details?.quantization_level,
      family: m.details?.family,
      remoteHost: typeof m.remote_host === 'string' && m.remote_host ? m.remote_host : undefined,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Embedding-only models cannot chat. */
export function isEmbeddingModel(name: string): boolean {
  return /embed|bge-|minilm|e5-|arctic-embed/i.test(name);
}

const FAMILY_RANK = ['qwen', 'deepseek', 'codestral', 'llama', 'mistral', 'phi'];
export function scoreModel(m: string): number {
  const low = m.toLowerCase();
  let s = 0;
  for (const [rank, k] of FAMILY_RANK.entries()) s = Math.max(s, low.includes(k) ? 100 - rank * 10 : 0);
  if (low.includes('coder') || low.includes('code')) s += 20;
  if (low.includes('cloud')) s -= 30;
  if (/(^|[:\-_.])(vl|vision)([:\-_.]|$)|llava|moondream|minicpm-v/.test(low)) s -= 40; // vision models are for reading the screen, not for chat and tool calls
  const b = /[:\-_](\d+(?:\.\d+)?)b\b/.exec(low);
  if (b && Number(b[1]) < 3) s -= 25; // tiny models are for autocomplete, not for driving an agent
  if (isEmbeddingModel(low)) s -= 200;
  return s;
}

/**
 * Picks the chat model to select when the saved one is missing.
 * Without a provider key, cloud ids are never chosen: they would fail on the first message.
 */
export function pickDefaultModel(models: string[], hasKey: boolean, ollamaNames?: string[]): string {
  const isOllama = (m: string) => ollamaNames ? ollamaNames.includes(m) : !isRemoteModelId(m);
  const usable = models.filter((m) => !isEmbeddingModel(m) && (hasKey || isOllama(m)));
  const local = usable.filter(isOllama);
  const pool = local.length ? local : usable;
  return [...pool].sort((a, b) => scoreModel(b) - scoreModel(a) || a.localeCompare(b))[0] ?? '';
}

export type SetupStage = 'ollama' | 'model' | 'folder' | 'ready';

export interface SetupFacts {
  ollamaUp: boolean;
  localModels: string[];
  hasKey: boolean;
  /** The saved chat model, if any. */
  model: string;
  workspace: string;
}

/** Which step the guided setup should be on. With no cloud key, local Ollama is the default path. */
export function setupStage(f: SetupFacts): SetupStage {
  const cloudOk = f.hasKey && !!f.model && isRemoteModelId(f.model);
  const localOk = f.ollamaUp && f.localModels.some((m) => !isEmbeddingModel(m));
  if (!cloudOk && !f.ollamaUp) return 'ollama';
  if (!cloudOk && !localOk) return 'model';
  if (!f.workspace) return 'folder';
  return 'ready';
}
