export type ReminderRepeat = 'daily' | 'weekly';

export interface Reminder {
  id: string;
  text: string;
  dueAt: number;
  createdAt: number;
  state: 'pending' | 'due';
  /** Absent = once. A repeating reminder schedules its next occurrence when it comes due. */
  repeat?: ReminderRepeat;
}

export const REPEATS: ReminderRepeat[] = ['daily', 'weekly'];

/**
 * The next time a repeating reminder is due after `now`, keeping its local clock time (so "every day at 09:00" stays at
 * 09:00 across a daylight-saving change, and occurrences missed while the PC was off are skipped, not replayed).
 */
export function nextOccurrence(dueAt: number, repeat: ReminderRepeat, now: number): number {
  const step = repeat === 'weekly' ? 7 : 1;
  const d = new Date(dueAt);
  do { d.setDate(d.getDate() + step); } while (d.getTime() <= now);
  return d.getTime();
}

export function repeatLabel(repeat: ReminderRepeat | undefined): string {
  return repeat === 'daily' ? 'every day' : repeat === 'weekly' ? 'every week' : '';
}
