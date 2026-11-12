import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { RunRecord, RunState } from '../shared/run-journal';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REQUEST = 200_000;
const workspaceKey = (p: string) => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);

/** One file per run; recovery only records interruption and never replays actions. */
export class RunJournal {
  constructor(private dir: string) { fs.mkdirSync(dir, { recursive: true }); }

  private file(id: string): string {
    if (!ID.test(id)) throw new Error('Invalid task identifier.');
    return path.join(this.dir, `${id}.json`);
  }

  private read(id: string): RunRecord | null {
    try {
      const value = JSON.parse(fs.readFileSync(this.file(id), 'utf8')) as RunRecord;
      if (!value || value.id !== id || !['running', 'finished', 'failed', 'stopped', 'paused', 'interrupted'].includes(value.state) || typeof value.workspace !== 'string' || !value.workspace || typeof value.request !== 'string' || !Array.isArray(value.tools) || !Number.isFinite(value.startedAt) || !Number.isFinite(value.updatedAt)) return null;
      return value;
    } catch { return null; }
  }

  private write(record: RunRecord): void {
    const file = this.file(record.id);
    const tmp = path.join(this.dir, `${record.id}.${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(tmp, JSON.stringify(record), { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(tmp, file);
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* already moved or not created */ }
    }
  }

  start(input: { request: string; workspace: string; sessionId: string; model: string; hadImages: boolean; activePath?: string }): RunRecord {
    const now = Date.now();
    const record: RunRecord = {
      id: crypto.randomUUID(), state: 'running', request: input.request.slice(0, MAX_REQUEST),
      requestTruncated: input.request.length > MAX_REQUEST, workspace: input.workspace,
      sessionId: input.sessionId, model: input.model, hadImages: input.hadImages,
      ...(input.activePath ? { activePath: input.activePath } : {}),
      startedAt: now, updatedAt: now, tools: [],
    };
    this.write(record);
    return record;
  }

  toolStart(id: string, toolId: string, name: string): void {
    const record = this.read(id);
    if (!record || record.state !== 'running') return;
    record.tools.push({ id: toolId, name: name.slice(0, 120), state: 'requested' });
    record.tools = record.tools.slice(-50);
    record.updatedAt = Date.now();
    this.write(record);
  }

  toolResult(id: string, toolId: string, ok: boolean): void {
    const record = this.read(id);
    if (!record || record.state !== 'running') return;
    const tool = record.tools.find((item) => item.id === toolId);
    if (!tool) return;
    tool.state = ok ? 'reported' : 'failed';
    record.updatedAt = Date.now();
    this.write(record);
  }

  finish(id: string, state: Extract<RunState, 'finished' | 'failed' | 'stopped' | 'paused'>): void {
    const record = this.read(id);
    if (!record || record.state !== 'running') return;
    record.state = state;
    record.updatedAt = Date.now();
    this.write(record);
  }

  /** At start-up, marks runs cut off by a crash as interrupted. On a deliberate quit, pass 'paused' so they wait for review and never continue by themselves. */
  recover(state: 'interrupted' | 'paused' = 'interrupted'): number {
    let count = 0;
    for (const record of this.listAll()) {
      if (record.state !== 'running') continue;
      record.state = state;
      record.updatedAt = Date.now();
      this.write(record);
      count++;
    }
    return count;
  }

  private listAll(): RunRecord[] {
    return fs.readdirSync(this.dir)
      .filter((name) => name.endsWith('.json') && ID.test(name.slice(0, -5)))
      .map((name) => this.read(name.slice(0, -5)))
      .filter((record): record is RunRecord => record !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  interrupted(workspace: string): RunRecord[] {
    if (!workspace) return [];
    const key = workspaceKey(workspace);
    return this.listAll().filter((record) => ['interrupted', 'paused'].includes(record.state) && workspaceKey(record.workspace) === key).slice(0, 50);
  }

  dismiss(id: string, workspace: string): void {
    const record = this.read(id);
    if (!record || !['interrupted', 'paused'].includes(record.state) || !workspace || workspaceKey(record.workspace) !== workspaceKey(workspace)) throw new Error('Interrupted task not found in this folder.');
    fs.unlinkSync(this.file(id));
  }

  /** User-requested cleanup keeps running, paused and interrupted work intact. */
  clearFinished(workspace: string): number {
    if (!workspace) return 0;
    const key = workspaceKey(workspace);
    let removed = 0;
    for (const record of this.listAll()) {
      if (workspaceKey(record.workspace) !== key || !['finished', 'failed', 'stopped'].includes(record.state)) continue;
      fs.unlinkSync(this.file(record.id));
      removed++;
    }
    return removed;
  }
}
