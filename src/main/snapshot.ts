import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Folders never tracked: dependencies, build output, VCS internals. */
export const SNAPSHOT_IGNORE = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', 'target', '.cache', 'release', '.test-out']);
const MAX_FILE = 5 * 1024 * 1024;
const MAX_FILES = 20_000;
const MAX_TOTAL = 400 * 1024 * 1024;

interface Pre { size: number; mtimeMs: number; hash: string; blob: string }
export interface TreeDiff { created: string[]; changed: string[]; deleted: string[] }

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

async function walk(root: string, visit: (rel: string, abs: string, st: fs.Stats) => Promise<boolean | void>): Promise<void> {
  const stack = [''];
  while (stack.length) {
    const relDir = stack.pop()!;
    let es: fs.Dirent[] = [];
    try { es = await fs.promises.readdir(path.join(root, relDir), { withFileTypes: true }); } catch { continue; }
    for (const e of es) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SNAPSHOT_IGNORE.has(e.name)) stack.push(rel); continue; }
      if (!e.isFile()) continue; // symlinks and special files are left alone
      let st: fs.Stats;
      try { st = await fs.promises.stat(path.join(root, rel)); } catch { continue; }
      if ((await visit(rel, path.join(root, rel), st)) === false) return;
    }
  }
}

/**
 * Remembers what the workspace looked like before a terminal command, so changes the command made can be undone like
 * file-tool edits. Pre-state files are copied once per turn; later checks only look at files whose size/time changed.
 */
export class TreeTracker {
  private pre = new Map<string, Pre>();
  private started = false;
  /** Set when the folder is too big to snapshot; the command still runs, it just cannot be undone. */
  disabled = '';
  skippedLarge = 0;
  constructor(private root: string, private preDir: string) {}

  async begin(): Promise<boolean> {
    if (this.started) return !this.disabled;
    this.started = true;
    fs.mkdirSync(this.preDir, { recursive: true });
    let total = 0;
    let n = 0;
    await walk(this.root, async (rel, abs, st) => {
      if (st.size > MAX_FILE) { this.skippedLarge++; return; }
      n++;
      total += st.size;
      if (n > MAX_FILES || total > MAX_TOTAL) { this.disabled = `The folder is too large to snapshot (over ${MAX_FILES} files or ${Math.round(MAX_TOTAL / 1048576)} MB), so terminal changes in this turn cannot be undone.`; return false; }
      try {
        const data = await fs.promises.readFile(abs);
        const blob = String(this.pre.size);
        await fs.promises.writeFile(path.join(this.preDir, blob), data);
        this.pre.set(rel, { size: st.size, mtimeMs: st.mtimeMs, hash: sha(data), blob });
      } catch { /* unreadable or vanished: not tracked */ }
    });
    if (this.disabled) { this.pre.clear(); fs.rmSync(this.preDir, { recursive: true, force: true }); }
    return !this.disabled;
  }

  /** Compare the folder now with the snapshot. */
  async diff(): Promise<TreeDiff> {
    const d: TreeDiff = { created: [], changed: [], deleted: [] };
    if (!this.started || this.disabled) return d;
    const seen = new Set<string>();
    await walk(this.root, async (rel, abs, st) => {
      if (st.size > MAX_FILE) return;
      seen.add(rel);
      const p = this.pre.get(rel);
      if (!p) { d.created.push(rel); return; }
      if (p.size === st.size && p.mtimeMs === st.mtimeMs) return;
      try { if (sha(await fs.promises.readFile(abs)) !== p.hash) d.changed.push(rel); } catch { /* ignore */ }
    });
    for (const rel of this.pre.keys()) if (!seen.has(rel)) d.deleted.push(rel);
    return d;
  }

  /** Absolute path of the saved pre-command copy of a file, or null if it did not exist then. */
  blobPath(rel: string): string | null {
    const p = this.pre.get(rel);
    return p ? path.join(this.preDir, p.blob) : null;
  }

  dispose() {
    this.pre.clear();
    try { fs.rmSync(this.preDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
