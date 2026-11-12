import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveSafe } from './sandbox';
import { TreeTracker } from './snapshot';
import type { CheckpointSummary, RewindPreview, RewindResult } from '../shared/types';

const MAX_FILE = 20 * 1024 * 1024;
const MAX_KEPT = 50;

interface Entry {
  path: string;
  existed: boolean;
  blob?: string;
  /** SHA-256 of the file after the turn, or null when it does not exist. */
  after: string | null;
}
interface Cp {
  id: string;
  seq: number;
  label: string;
  time: number;
  files: Entry[];
}

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const hashOf = (f: string): string | null => {
  try {
    return sha(fs.readFileSync(f));
  } catch {
    return null;
  }
};

export class Recorder {
  private entries = new Map<string, Entry>();
  private real: string;
  constructor(private store: CheckpointStore, private root: string, readonly id: string, private label: string) {
    this.real = fs.realpathSync.native(root);
  }

  /** Call right before a file is created, changed or overwritten. Only the first call per file counts. */
  beforeWrite(abs: string): void {
    const rel = path.relative(this.real, abs).split(path.sep).join('/');
    if (this.entries.has(rel)) return;
    let data: Buffer | null = null;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) throw new Error(`"${rel}" is not a regular file.`);
      if (st.size > MAX_FILE) throw new Error(`"${rel}" is larger than 20 MB and cannot be checkpointed, so Jarvin will not change it.`);
      data = fs.readFileSync(abs);
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }
    const entry: Entry = { path: rel, existed: data !== null, after: null };
    if (data) {
      entry.blob = `${this.entries.size}`;
      const dir = this.store.blobDir(this.root, this.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, entry.blob), data);
    }
    this.entries.set(rel, entry);
  }

  private tracker?: TreeTracker;
  /** Notes about terminal tracking (too large to snapshot, big files skipped), shown once to the user. */
  trackingNote = '';

  /**
   * Call before running a shell command. Returns a function to call after it finishes; any files the command created,
   * changed or deleted are then added to this checkpoint so they can be undone.
   */
  async trackCommand(): Promise<() => Promise<number>> {
    this.tracker ??= new TreeTracker(this.real, path.join(this.store.blobDir(this.root, this.id), '_pre'));
    const t = this.tracker;
    const ok = await t.begin();
    if (!ok) { this.trackingNote = t.disabled; return async () => 0; }
    if (t.skippedLarge && !this.trackingNote) this.trackingNote = `${t.skippedLarge} file(s) over 5 MB are not tracked by terminal-command undo.`;
    return async () => {
      const d = await t.diff();
      let added = 0;
      for (const rel of d.created) {
        if (this.entries.has(rel)) continue;
        this.entries.set(rel, { path: rel, existed: false, after: null });
        added++;
      }
      for (const rel of [...d.changed, ...d.deleted]) {
        if (this.entries.has(rel)) continue;
        const src = t.blobPath(rel);
        if (!src) continue;
        const entry: Entry = { path: rel, existed: true, after: null, blob: `${this.entries.size}` };
        const dir = this.store.blobDir(this.root, this.id);
        fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(src, path.join(dir, entry.blob!));
        this.entries.set(rel, entry);
        added++;
      }
      return added;
    };
  }

  /** Workspace-relative paths written so far this turn. */
  touchedPaths(): string[] {
    return [...this.entries.keys()];
  }

  /** Seal the checkpoint. Returns null when nothing was touched. */
  finish(): CheckpointSummary | null {
    this.tracker?.dispose();
    if (!this.entries.size) return null;
    const files = [...this.entries.values()];
    for (const e of files) e.after = hashOf(path.join(this.root, e.path));
    // files that were created and then removed again, or rewritten with identical bytes, are not changes
    const changed = files.filter((e) => !(e.after === null && !e.existed) && !(e.existed && e.after && e.blob && this.store.blobHash(this.root, this.id, e.blob) === e.after));
    if (!changed.length) {
      this.store.dropBlobs(this.root, this.id);
      return null;
    }
    this.store.add(this.root, { id: this.id, seq: 0, label: this.label, time: Date.now(), files: changed });
    return { id: this.id, files: changed.map((e) => ({ path: e.path, status: !e.existed ? 'created' : e.after === null ? 'deleted' : 'modified' })) };
  }
}

export class CheckpointStore {
  constructor(private base: string) {}

  private dir(root: string) {
    const key = crypto.createHash('sha1').update(process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root)).digest('hex').slice(0, 16);
    return path.join(this.base, key);
  }
  blobDir(root: string, id: string) {
    return path.join(this.dir(root), 'blobs', id);
  }
  blobHash(root: string, id: string, blob: string) {
    return hashOf(path.join(this.blobDir(root, id), blob));
  }
  dropBlobs(root: string, id: string) {
    fs.rmSync(this.blobDir(root, id), { recursive: true, force: true });
  }
  private load(root: string): Cp[] {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir(root), 'index.json'), 'utf8'));
    } catch {
      return [];
    }
  }
  private save(root: string, list: Cp[]) {
    fs.mkdirSync(this.dir(root), { recursive: true });
    fs.writeFileSync(path.join(this.dir(root), 'index.json'), JSON.stringify(list));
  }

  begin(root: string, label: string): Recorder {
    return new Recorder(this, root, crypto.randomUUID(), label);
  }

  add(root: string, cp: Cp) {
    const list = this.load(root);
    cp.seq = (list.at(-1)?.seq ?? 0) + 1;
    list.push(cp);
    while (list.length > MAX_KEPT) this.dropBlobs(root, list.shift()!.id);
    this.save(root, list);
  }

  /** What an undo of checkpoint `id` (and everything after it) would do. */
  preview(root: string, id: string): RewindPreview {
    const plan = this.plan(root, id);
    if (!plan) return { files: [], laterTurns: 0 };
    return { files: plan.steps.map((s) => ({ path: s.entry.path, action: s.entry.existed ? 'restore' : 'delete', conflict: s.conflict })), laterTurns: plan.targets.length - 1 };
  }

  private plan(root: string, id: string) {
    const list = this.load(root);
    const at = list.findIndex((c) => c.id === id);
    if (at < 0) return null;
    const targets = list.slice(at).reverse(); // newest first
    const seen = new Set<string>();
    const steps: { cp: Cp; entry: Entry; conflict: boolean }[] = [];
    for (const cp of targets)
      for (const entry of cp.files) {
        const first = !seen.has(entry.path);
        seen.add(entry.path);
        let conflict = false;
        if (first) conflict = hashOf(path.join(root, entry.path)) !== entry.after;
        steps.push({ cp, entry, conflict });
      }
    return { list, at, targets, steps };
  }

  rewind(root: string, id: string, force = false): RewindResult {
    const plan = this.plan(root, id);
    if (!plan) return { ok: false, restored: 0, deleted: 0, conflicts: [], error: 'That checkpoint no longer exists.' };
    const conflicts = [...new Set(plan.steps.filter((s) => s.conflict).map((s) => s.entry.path))];
    if (conflicts.length && !force) return { ok: false, restored: 0, deleted: 0, conflicts };
    for (const { cp, entry } of plan.steps) {
      const abs = resolveSafe(root, entry.path, { write: true });
      if (entry.existed) {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, fs.readFileSync(path.join(this.blobDir(root, cp.id), entry.blob!)));
      } else {
        fs.rmSync(abs, { force: true });
        this.pruneEmptyDirs(root, path.dirname(abs));
      }
    }
    for (const cp of plan.targets) this.dropBlobs(root, cp.id);
    this.save(root, plan.list.slice(0, plan.at));
    // the oldest checkpoint touching a path decides its final state
    const final = new Map<string, boolean>();
    for (const { entry } of plan.steps) final.set(entry.path, entry.existed);
    const restored = [...final.values()].filter(Boolean).length;
    return { ok: true, restored, deleted: final.size - restored, conflicts: [] };
  }

  private pruneEmptyDirs(root: string, dir: string) {
    const rootReal = path.resolve(root);
    while (path.resolve(dir) !== rootReal && path.resolve(dir).startsWith(rootReal + path.sep)) {
      try {
        fs.rmdirSync(dir);
      } catch {
        return;
      }
      dir = path.dirname(dir);
    }
  }

  /** Undo one file from one checkpoint, leaving the rest of that turn intact. */
  rewindFile(root: string, id: string, targetPath: string, force = false): RewindResult {
    const list = this.load(root);
    const at = list.findIndex((c) => c.id === id);
    if (at < 0) return { ok: false, restored: 0, deleted: 0, conflicts: [], error: 'That checkpoint no longer exists.' };
    const cp = list[at];
    const entry = cp.files.find((e) => e.path === targetPath);
    if (!entry) return { ok: false, restored: 0, deleted: 0, conflicts: [], error: 'That file is not in this checkpoint.' };
    const later = list.slice(at + 1);
    if (later.some((c) => c.files.some((e) => e.path === targetPath)))
      return { ok: false, restored: 0, deleted: 0, conflicts: [], error: 'A later turn also changed this file; undo that turn first.' };
    const abs = resolveSafe(root, entry.path, { write: true });
    const conflict = hashOf(abs) !== entry.after;
    if (conflict && !force) return { ok: false, restored: 0, deleted: 0, conflicts: [entry.path] };
    if (entry.existed) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, fs.readFileSync(path.join(this.blobDir(root, cp.id), entry.blob!)));
    } else {
      fs.rmSync(abs, { force: true });
      this.pruneEmptyDirs(root, path.dirname(abs));
    }
    cp.files = cp.files.filter((e) => e.path !== targetPath);
    if (!cp.files.length) {
      this.dropBlobs(root, cp.id);
      list.splice(at, 1);
    }
    this.save(root, list);
    return { ok: true, restored: entry.existed ? 1 : 0, deleted: entry.existed ? 0 : 1, conflicts: [] };
  }

  /** Return the pre-change contents for one file in a checkpoint, or null if absent/unreadable. */
  baseline(root: string, id: string, targetPath: string): string | null {
    const list = this.load(root);
    const cp = list.find((c) => c.id === id);
    if (!cp) return null;
    const entry = cp.files.find((e) => e.path === targetPath);
    if (!entry || !entry.existed || !entry.blob) return entry && !entry.existed ? '' : null;
    try { return fs.readFileSync(path.join(this.blobDir(root, cp.id), entry.blob), 'utf8'); } catch { return null; }
  }

  /** Remove blob folders that no checkpoint refers to (left behind by a crash mid-turn). */
  sweep(root: string) {
    const keep = new Set(this.load(root).map((c) => c.id));
    const blobs = path.join(this.dir(root), 'blobs');
    try {
      for (const d of fs.readdirSync(blobs)) if (!keep.has(d)) fs.rmSync(path.join(blobs, d), { recursive: true, force: true });
    } catch {
      /* nothing to sweep */
    }
  }
}
