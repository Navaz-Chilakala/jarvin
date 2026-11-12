export interface Routine {
  id: string;
  name: string;
  steps: string[];
  revision: string;
  createdAt: number;
  updatedAt: number;
  /** Local time "HH:MM" (24-hour) to run every day while Jarvin is open; absent = only when asked. */
  dailyAt?: string;
  /** Local day "YYYY-MM-DD" of the last scheduled run, so a routine runs at most once a day. */
  lastScheduledDay?: string;
}

export const DAILY_AT = /^([01]\d|2[0-3]):[0-5]\d$/;
/** A scheduled routine that was missed by more than this (Jarvin closed, PC asleep) is skipped for the day. */
export const SCHEDULE_GRACE_MS = 15 * 60_000;

/** User-defined instructions remain user content and go through the ordinary agent flow. */
export function routineRequest(routine: Routine): string {
  return `Run my saved routine "${routine.name}" in the listed order. Report what you did and stop if a step fails or requires clarification.\n\n${routine.steps.map((step, i) => `${i + 1}. ${step}`).join('\n')}`;
}

/** One request per step, so each step is its own run: the queue shows what is left and pauses when a step fails or is stopped. */
export function routineStepRequests(routine: Routine): string[] {
  const n = routine.steps.length;
  return routine.steps.map((step, i) => `Routine "${routine.name}", step ${i + 1} of ${n}: ${step}`);
}

export function localDay(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** Routines whose daily time has just passed and that have not run today. */
export function dueRoutines(routines: Routine[], now: Date): Routine[] {
  const today = localDay(now);
  return routines.filter((r) => {
    if (!r.dailyAt || !DAILY_AT.test(r.dailyAt) || r.lastScheduledDay === today) return false;
    const [h, m] = r.dailyAt.split(':').map(Number);
    const late = now.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m).getTime();
    return late >= 0 && late <= SCHEDULE_GRACE_MS;
  });
}
