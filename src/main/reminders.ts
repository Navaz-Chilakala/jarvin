import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { REPEATS, nextOccurrence, type Reminder, type ReminderRepeat } from '../shared/reminders';

const TEN_YEARS = 10 * 366 * 24 * 60 * 60 * 1000;

function checkText(text: unknown): string {
  if (typeof text !== 'string' || !text.trim() || text.trim().length > 500) throw new Error('Enter reminder text of 1 to 500 characters.');
  return text.trim();
}
function checkDue(dueAt: unknown, now: number): number {
  if (typeof dueAt !== 'number' || !Number.isFinite(dueAt) || dueAt <= now || dueAt > now + TEN_YEARS) throw new Error('Choose a future date within 10 years.');
  return dueAt;
}
function checkRepeat(repeat: unknown): ReminderRepeat | undefined {
  if (repeat === undefined || repeat === null || repeat === '' || repeat === 'once') return undefined;
  if (!REPEATS.includes(repeat as ReminderRepeat)) throw new Error('Repeat must be once, daily or weekly.');
  return repeat as ReminderRepeat;
}

/** Reminders are local and stay visible until removed. A repeating one schedules its next occurrence when it comes due. */
export class ReminderStore {
  constructor(private file: string, private backup?: { create(r: Reminder): void; cancel(id: string): void }) { fs.mkdirSync(path.dirname(file), { recursive: true }); }

  private read(): Reminder[] {
    if (!fs.existsSync(this.file)) return [];
    const data: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (!Array.isArray(data) || !data.every((r) => r && typeof r.id === 'string' && typeof r.text === 'string' && Number.isFinite(r.dueAt) && Number.isFinite(r.createdAt) && (r.state === 'pending' || r.state === 'due') && (r.repeat === undefined || REPEATS.includes(r.repeat)))) throw new Error('Reminder data is invalid.');
    return data as Reminder[];
  }

  private write(records: Reminder[]): void {
    const tmp = `${this.file}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(tmp, JSON.stringify(records), { encoding: 'utf8', flag: 'wx' }); fs.renameSync(tmp, this.file); }
    finally { try { fs.unlinkSync(tmp); } catch { /* already moved */ } }
  }

  list(): Reminder[] { return this.read().sort((a, b) => a.dueAt - b.dueAt); }

  create(text: unknown, dueAt: unknown, repeatOrNow?: unknown, nowArg?: number): Reminder {
    // Older callers pass (text, dueAt, now). A number in the third place is that clock, not a repeat.
    const now = typeof repeatOrNow === 'number' ? repeatOrNow : nowArg ?? Date.now();
    const repeat = typeof repeatOrNow === 'number' ? undefined : checkRepeat(repeatOrNow);
    const records = this.read();
    if (records.length >= 1000) throw new Error('Remove some reminders before adding more.');
    const reminder: Reminder = { id: crypto.randomUUID(), text: checkText(text), dueAt: checkDue(dueAt, now), createdAt: now, state: 'pending', ...(repeat ? { repeat } : {}) };
    records.push(reminder); this.write(records); this.backup?.create(reminder); return reminder;
  }

  /** Change a reminder that has not fired yet. */
  update(id: unknown, text: unknown, dueAt: unknown, repeat?: unknown, now = Date.now()): Reminder {
    if (typeof id !== 'string') throw new Error('Invalid reminder.');
    const records = this.read();
    const record = records.find((r) => r.id === id);
    if (!record) throw new Error('Reminder not found.');
    if (record.state !== 'pending') throw new Error('This reminder is already due. Snooze or dismiss it instead.');
    record.text = checkText(text);
    record.dueAt = checkDue(dueAt, now);
    const again = checkRepeat(repeat);
    if (again) record.repeat = again; else delete record.repeat;
    this.write(records);
    this.backup?.create(record);
    return record;
  }

  /** Put a due reminder back to sleep for a while. */
  snooze(id: unknown, minutes: unknown, now = Date.now()): Reminder {
    if (typeof id !== 'string') throw new Error('Invalid reminder.');
    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 1 || minutes > 24 * 60) throw new Error('Snooze for 1 minute to 24 hours.');
    const records = this.read();
    const record = records.find((r) => r.id === id);
    if (!record) throw new Error('Reminder not found.');
    if (record.state !== 'due') throw new Error('Only a reminder that is due can be snoozed.');
    record.state = 'pending';
    record.dueAt = now + Math.round(minutes) * 60_000;
    this.write(records);
    this.backup?.create(record);
    return record;
  }

  remove(id: unknown): void {
    if (typeof id !== 'string') throw new Error('Invalid reminder.');
    const records = this.read();
    const next = records.filter((r) => r.id !== id);
    if (next.length === records.length) throw new Error('Reminder not found.');
    this.write(next);
    this.backup?.cancel(id);
  }

  markDue(now = Date.now()): Reminder[] {
    const records = this.read();
    const due = records.filter((r) => r.state === 'pending' && r.dueAt <= now);
    if (!due.length) return due;
    const upcoming: Reminder[] = [];
    for (const r of due) {
      r.state = 'due';
      // The due one stays on screen as a single occurrence to dismiss or snooze; the series continues as a new entry.
      if (r.repeat) {
        const next: Reminder = { id: crypto.randomUUID(), text: r.text, dueAt: nextOccurrence(r.dueAt, r.repeat, now), createdAt: now, state: 'pending', repeat: r.repeat };
        delete r.repeat;
        records.push(next);
        upcoming.push(next);
      }
    }
    this.write(records);
    for (const r of due) this.backup?.cancel(r.id);
    for (const r of upcoming) this.backup?.create(r);
    return due;
  }
}
