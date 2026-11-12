import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import type { ToolCtx } from './tools';

export const IGNORE = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', 'target', '.cache', 'release']);

export async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!IGNORE.has(e.name)) yield* walk(full);
    } else if (e.isFile()) yield full;
  }
}

export const STOPWORDS = new Set(['the','and','for','with','this','that','from','are','was','were','has','have','had','not','but','you','your','can','will','use','using','into','onto','our','out','all','any','get','set','new','null','undefined','true','false','return','const','let','var','function','class','import','export','default','if','else','try','catch','throw','void','async','await']);
export function indexFile(root: string): string {
  const key = crypto.createHash('sha1').update(process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root)).digest('hex').slice(0, 24);
  return path.join(os.homedir(), '.jarvin', 'codebase-index', key + '.json');
}
export function tokenize(text: string): string[] {
  const normalized = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[^A-Za-z0-9_]+/g, ' ');
  return normalized.toLowerCase().split(/\s+/).filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}
export interface IndexEntry { path: string; mtime: number; size: number; tf: Record<string, number>; }
export interface CodebaseIndex { version: number; builtAt: number; root: string; files: IndexEntry[]; }
export async function buildCodebaseIndex(ctx: ToolCtx): Promise<CodebaseIndex> {
  const files: IndexEntry[] = [];
  for await (const f of walk(ctx.root)) {
    const rel = path.relative(ctx.root, f).split(path.sep).join('/');
    try {
      const stat = await fs.promises.stat(f);
      if (stat.size > 1_000_000) continue;
      const buf = await fs.promises.readFile(f);
      if (buf.includes(0)) continue;
      const text = buf.toString('utf8');
      const counts = new Map<string, number>();
      for (const t of tokenize(text)) counts.set(t, (counts.get(t) ?? 0) + 1);
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 800);
      const tf: Record<string, number> = {};
      for (const [t, c] of sorted) tf[t] = c;
      files.push({ path: rel, mtime: stat.mtimeMs, size: stat.size, tf });
    } catch { /* skip */ }
  }
  const index: CodebaseIndex = { version: 1, builtAt: Date.now(), root: ctx.root, files };
  const p = indexFile(ctx.root);
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  await fs.promises.writeFile(p, JSON.stringify(index));
  return index;
}
export async function loadCodebaseIndex(ctx: ToolCtx, force = false): Promise<CodebaseIndex> {
  const p = indexFile(ctx.root);
  if (!force) {
    try {
      const raw = await fs.promises.readFile(p, 'utf8');
      const idx = JSON.parse(raw) as CodebaseIndex;
      if (idx && idx.version === 1 && Array.isArray(idx.files) && idx.root === ctx.root) return idx;
    } catch { /* rebuild */ }
  }
  return buildCodebaseIndex(ctx);
}
export function isStaleIndex(ctx: ToolCtx, idx: CodebaseIndex): boolean {
  // Quick check of first 20 indexed mtimes.
  try {
    for (let i = 0; i < Math.min(20, idx.files.length); i++) {
      const e = idx.files[i];
      const st = fs.statSync(path.join(ctx.root, e.path));
      if (st.mtimeMs !== e.mtime) return true;
    }
  } catch { return true; }
  return false;
}

export interface SemanticChunk { file: string; startLine: number; text: string; embedding: number[]; }
export interface SemanticIndex { version: number; builtAt: number; model: string; root: string; chunks: SemanticChunk[]; }
export function semanticIndexFile(root: string): string {
  const key = crypto.createHash('sha1').update(process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root)).digest('hex').slice(0, 24);
  return path.join(os.homedir(), '.jarvin', 'semantic-index', key + '.json');
}
export async function ollamaEmbed(baseUrl: string, model: string, input: string): Promise<number[]> {
  const b = (baseUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
  try {
    const r = await fetch(`${b}/api/embed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, input }) });
    if (r.ok) {
      const j = (await r.json()) as any;
      const v = j?.embeddings?.[0] ?? j?.embedding;
      if (Array.isArray(v)) return v as number[];
    }
  } catch { /* fallback */ }
  const r = await fetch(`${b}/api/embeddings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, prompt: input }) });
  if (!r.ok) throw new Error(`Embedding failed: ${r.status}`);
  const j = (await r.json()) as any;
  if (!Array.isArray(j?.embedding)) throw new Error('Invalid embedding response.');
  return j.embedding as number[];
}
export function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : 0;
}
export async function buildSemanticIndex(ctx: ToolCtx): Promise<SemanticIndex> {
  const model = ctx.embeddingModel || 'nomic-embed-text';
  const chunks: SemanticChunk[] = [];
  for await (const f of walk(ctx.root)) {
    const rel = path.relative(ctx.root, f).split(path.sep).join('/');
    try {
      const stat = await fs.promises.stat(f);
      if (stat.size > 500_000) continue;
      const buf = await fs.promises.readFile(f);
      if (buf.includes(0)) continue;
      const text = buf.toString('utf8');
      const lines = text.split('\n');
      const chunkSize = 90;
      for (let i = 0; i < lines.length; i += chunkSize) {
        const slice = lines.slice(i, i + chunkSize).join('\n');
        if (!slice.trim()) continue;
        const embedding = await ollamaEmbed(ctx.baseUrl || 'http://127.0.0.1:11434', model, slice.slice(0, 8000));
        chunks.push({ file: rel, startLine: i + 1, text: slice.slice(0, 2000), embedding });
      }
    } catch { /* skip file */ }
  }
  const idx: SemanticIndex = { version: 1, builtAt: Date.now(), model, root: ctx.root, chunks };
  const p = semanticIndexFile(ctx.root);
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  await fs.promises.writeFile(p, JSON.stringify(idx));
  return idx;
}
export async function loadSemanticIndex(ctx: ToolCtx): Promise<SemanticIndex | null> {
  try {
    const raw = await fs.promises.readFile(semanticIndexFile(ctx.root), 'utf8');
    const idx = JSON.parse(raw) as SemanticIndex;
    if (idx && idx.version === 1 && Array.isArray(idx.chunks) && idx.root === ctx.root) return idx;
  } catch { /* none */ }
  return null;
}

