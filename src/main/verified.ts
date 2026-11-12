import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SNAPSHOT_IGNORE } from './snapshot';
import { isSensitivePath } from './sandbox';

/** A private copy of the project the agent can change and test freely. Nothing reaches the real folder until it is applied. */
export interface Sandbox {
  id: string;
  dir: string;
  root: string;
  /** Hash of every copied file as it was when the copy was made. */
  base: Map<string, string>;
  createdAt: number;
  /** Files left out because they were too big. */
  skipped: number;
  /** Folders linked from the real project instead of copied (node_modules). */
  linked: string[];
}

export interface Change { path: string; status: 'modified' | 'added' | 'deleted' }
export interface ApplyResult { applied: Change[]; conflicts: { path: string; reason: string }[] }

const MAX_FILE = 5 * 1024 * 1024;
const MAX_FILES = 20_000;
const MAX_TOTAL = 400 * 1024 * 1024;
/** Tool and test output folders: never copied and never counted as the agent's changes. */
const SKIP = new Set([...SNAPSHOT_IGNORE, 'coverage', '.pytest_cache', '.nyc_output', '.turbo', '.parcel-cache', '.vite', '.mypy_cache', '.ruff_cache', '.gradle']);

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

async function walk(root: string, visit: (rel: string, abs: string, st: fs.Stats) => Promise<boolean | void>): Promise<void> {
  const stack = [''];
  while (stack.length) {
    const relDir = stack.pop()!;
    let es: fs.Dirent[] = [];
    try { es = await fs.promises.readdir(path.join(root, relDir), { withFileTypes: true }); } catch { continue; }
    for (const e of es) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP.has(e.name)) stack.push(rel); continue; }
      if (!e.isFile()) continue;
      let st: fs.Stats;
      try { st = await fs.promises.stat(path.join(root, rel)); } catch { continue; }
      if ((await visit(rel, path.join(root, rel), st)) === false) return;
    }
  }
}

export async function createSandbox(root: string, tmp = os.tmpdir()): Promise<Sandbox> {
  const id = crypto.randomUUID().slice(0, 8);
  const dir = path.join(tmp, `jarvin-sandbox-${id}`);
  await fs.promises.mkdir(dir, { recursive: true });
  const sb: Sandbox = { id, dir, root, base: new Map(), createdAt: Date.now(), skipped: 0, linked: [] };
  let total = 0;
  let n = 0;
  let tooBig = '';
  await walk(root, async (rel, abs, st) => {
    if (st.size > MAX_FILE) { sb.skipped++; return; }
    n++;
    total += st.size;
    if (n > MAX_FILES || total > MAX_TOTAL) { tooBig = `This folder is too large to copy for a safe trial run (over ${MAX_FILES.toLocaleString()} files or ${Math.round(MAX_TOTAL / 1048576)} MB). Open a smaller folder.`; return false; }
    try {
      const data = await fs.promises.readFile(abs);
      const out = path.join(dir, rel);
      await fs.promises.mkdir(path.dirname(out), { recursive: true });
      await fs.promises.writeFile(out, data);
      sb.base.set(rel, sha(data));
    } catch { /* unreadable or vanished: left out */ }
  });
  if (tooBig) { discardSandbox(sb); throw new Error(tooBig); }
  // Reuse the installed dependencies instead of copying them. A junction needs no admin rights on Windows.
  const nm = path.join(root, 'node_modules');
  if (fs.existsSync(nm)) {
    try { fs.symlinkSync(nm, path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'); sb.linked.push('node_modules'); } catch { /* tests may fail to find packages; reported by the test run */ }
  }
  return sb;
}

export function discardSandbox(sb: Sandbox): void {
  try {
    // Remove the link first so deleting the copy can never reach into the real node_modules.
    const link = path.join(sb.dir, 'node_modules');
    if (sb.linked.includes('node_modules')) { try { fs.unlinkSync(link); } catch { try { fs.rmdirSync(link); } catch { /* ignore */ } } }
    fs.rmSync(sb.dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

/** Remove copies left behind by a crash or an earlier session. */
export function sweepSandboxes(tmp = os.tmpdir(), olderThanMs = 24 * 3600 * 1000): number {
  let n = 0;
  try {
    for (const name of fs.readdirSync(tmp)) {
      if (!name.startsWith('jarvin-sandbox-')) continue;
      const p = path.join(tmp, name);
      try {
        if (Date.now() - fs.statSync(p).mtimeMs < olderThanMs) continue;
        discardSandbox({ id: '', dir: p, root: '', base: new Map(), createdAt: 0, skipped: 0, linked: ['node_modules'] });
        n++;
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return n;
}

export async function changesOf(sb: Sandbox): Promise<Change[]> {
  const out: Change[] = [];
  const seen = new Set<string>();
  await walk(sb.dir, async (rel, abs, st) => {
    if (st.size > MAX_FILE) return;
    seen.add(rel);
    const was = sb.base.get(rel);
    let h: string;
    try { h = sha(await fs.promises.readFile(abs)); } catch { return; }
    if (was === undefined) out.push({ path: rel, status: 'added' });
    else if (was !== h) out.push({ path: rel, status: 'modified' });
  });
  for (const rel of sb.base.keys()) if (!seen.has(rel)) out.push({ path: rel, status: 'deleted' });
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

const readOr = async (p: string): Promise<string | null> => { try { return await fs.promises.readFile(p, 'utf8'); } catch { return null; } };
export const sandboxText = (sb: Sandbox, rel: string) => readOr(path.join(sb.dir, rel));
/** The file as it was when the copy was made. Read from the real folder when it has not changed since. */
export async function originalText(sb: Sandbox, rel: string): Promise<string | null> {
  if (!sb.base.has(rel)) return null;
  const real = await fs.promises.readFile(path.join(sb.root, rel)).catch(() => null);
  return real && sha(real) === sb.base.get(rel) ? real.toString('utf8') : null;
}

/**
 * Copy the sandbox changes into the real folder. A file is only touched when the real one is still exactly what was copied
 * (or still absent, for new files), so work done in the meantime is never overwritten.
 */
export async function applyChanges(sb: Sandbox, beforeWrite?: (abs: string) => void, only?: string[]): Promise<ApplyResult> {
  const res: ApplyResult = { applied: [], conflicts: [] };
  const list = (await changesOf(sb)).filter((c) => !only || only.includes(c.path));
  for (const c of list) {
    const real = path.join(sb.root, c.path);
    if (path.relative(sb.root, real).startsWith('..') || path.isAbsolute(c.path)) { res.conflicts.push({ path: c.path, reason: 'outside the project' }); continue; }
    if (isSensitivePath(c.path)) { res.conflicts.push({ path: c.path, reason: 'protected file (secrets, CI or Jarvin settings): change it by hand' }); continue; }
    let cur: Buffer | null = null;
    try { cur = await fs.promises.readFile(real); } catch { /* absent */ }
    const was = sb.base.get(c.path);
    if (c.status === 'added' ? cur !== null : cur === null || sha(cur) !== was) {
      res.conflicts.push({ path: c.path, reason: c.status === 'added' ? 'a file with this name appeared in your project meanwhile' : cur === null ? 'it was deleted in your project meanwhile' : 'it changed in your project meanwhile' });
      continue;
    }
    try {
      beforeWrite?.(real);
      if (c.status === 'deleted') await fs.promises.unlink(real);
      else {
        await fs.promises.mkdir(path.dirname(real), { recursive: true });
        await fs.promises.copyFile(path.join(sb.dir, c.path), real);
      }
      res.applied.push(c);
    } catch (e: any) {
      res.conflicts.push({ path: c.path, reason: String(e?.message ?? e) });
    }
  }
  return res;
}
