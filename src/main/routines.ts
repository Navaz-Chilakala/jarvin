import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DAILY_AT, dueRoutines, localDay, type Routine } from '../shared/routines';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validate(name: unknown, steps: unknown): { name: string; steps: string[] } {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100 || /[\r\n]/.test(name)) throw new Error('Enter a routine name of 1 to 100 characters on one line.');
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 20 || steps.some((s) => typeof s !== 'string' || !s.trim() || s.trim().length > 2000 || /[\r\n]/.test(s))) throw new Error('Enter 1 to 20 steps, each on one line and at most 2,000 characters.');
  return { name: name.trim(), steps: steps.map((s: string) => s.trim()) };
}

/** Shared across folders, persisted locally. Updates reject stale editor revisions. */
export class RoutineStore {
  constructor(private file: string) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
  private read(): Routine[] {
    if (!fs.existsSync(this.file)) return [];
    const value: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (!Array.isArray(value) || value.length > 500) throw new Error('Routine data is invalid.');
    const ids = new Set<string>();
    for (const item of value) {
      if (!item || !UUID.test(item.id) || !UUID.test(item.revision) || !Number.isFinite(item.createdAt) || !Number.isFinite(item.updatedAt) || ids.has(item.id)) throw new Error('Routine data is invalid.');
      if (item.dailyAt !== undefined && (typeof item.dailyAt !== 'string' || !DAILY_AT.test(item.dailyAt))) throw new Error('Routine data is invalid.');
      validate(item.name, item.steps); ids.add(item.id);
    }
    return value as Routine[];
  }
  private write(value: Routine[]): void {
    const tmp = `${this.file}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(tmp, JSON.stringify(value), { encoding: 'utf8', flag: 'wx' }); fs.renameSync(tmp, this.file); }
    finally { try { fs.unlinkSync(tmp); } catch { /* moved or not created */ } }
  }
  list(): Routine[] { return this.read().sort((a, b) => a.name.localeCompare(b.name)); }
  /** dailyAt: "HH:MM" sets a daily time, '' clears it, undefined keeps what the routine already has. */
  save(id: unknown, revision: unknown, name: unknown, steps: unknown, dailyAt?: unknown): Routine {
    const input: { name: string; steps: string[]; dailyAt?: string } = validate(name, steps);
    if (dailyAt !== undefined && dailyAt !== null && dailyAt !== '') {
      if (typeof dailyAt !== 'string' || !DAILY_AT.test(dailyAt)) throw new Error('Enter the daily time as HH:MM, for example 09:00.');
      input.dailyAt = dailyAt;
    }
    const routines = this.read();
    let record: Routine;
    if (id === null && revision === null) {
      if (routines.length >= 500) throw new Error('Remove a routine before adding another.');
      const now = Date.now();
      record = { id: crypto.randomUUID(), revision: crypto.randomUUID(), createdAt: now, updatedAt: now, ...input };
      routines.push(record);
    } else {
      if (typeof id !== 'string' || typeof revision !== 'string') throw new Error('Invalid routine.');
      const index = routines.findIndex((r) => r.id === id);
      if (index < 0) throw new Error('Routine no longer exists.');
      if (routines[index].revision !== revision) throw new Error('Routine changed since you opened it; reload it before saving.');
      record = { ...routines[index], ...input, revision: crypto.randomUUID(), updatedAt: Date.now() };
      if (dailyAt === '' || dailyAt === null) { delete record.dailyAt; delete record.lastScheduledDay; }
      routines[index] = record;
    }
    this.write(routines); return record;
  }
  /** Returns the routines due now and marks them as run for today, so each fires once even if the run itself fails. */
  takeDue(now = new Date()): Routine[] {
    const routines = this.read();
    const due = dueRoutines(routines, now);
    if (!due.length) return [];
    for (const r of due) r.lastScheduledDay = localDay(now);
    this.write(routines);
    return due;
  }
  remove(id: unknown, revision: unknown): void {
    if (typeof id !== 'string' || typeof revision !== 'string') throw new Error('Invalid routine.');
    const routines = this.read();
    const record = routines.find((r) => r.id === id);
    if (!record) throw new Error('Routine no longer exists.');
    if (record.revision !== revision) throw new Error('Routine changed since you opened it; reload it before deleting.');
    this.write(routines.filter((r) => r.id !== id));
  }
}
