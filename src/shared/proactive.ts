/** Things Jarvin may say without being asked. It only speaks or shows a notice; it never acts on the PC by itself. */
export interface ProactiveSettings {
  /** Master switch. Off by default: unprompted speech is opt-in. */
  enabled: boolean;
  lowBattery: boolean;
  speakReminders: boolean;
  downloads: boolean;
  commands: boolean;
  meetings: boolean;
  /** Local "HH:MM". Between these times notices are shown silently. Equal values = no quiet hours. */
  quietFrom: string;
  quietTo: string;
}

export const PROACTIVE_DEFAULTS: ProactiveSettings = { enabled: false, lowBattery: true, speakReminders: true, downloads: false, commands: false, meetings: false, quietFrom: '22:00', quietTo: '07:00' };
export const MAX_SPOKEN_PER_HOUR = 4;
export const LOW_BATTERY = 0.2;
const REARM_BATTERY = 0.25;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function proactiveSettings(saved: Partial<ProactiveSettings> | undefined): ProactiveSettings {
  const s = { ...PROACTIVE_DEFAULTS, ...(saved ?? {}) };
  if (!HHMM.test(s.quietFrom)) s.quietFrom = PROACTIVE_DEFAULTS.quietFrom;
  if (!HHMM.test(s.quietTo)) s.quietTo = PROACTIVE_DEFAULTS.quietTo;
  return s;
}

/** True inside the quiet window, which may cross midnight (22:00 to 07:00). */
export function inQuietHours(now: Date, from: string, to: string): boolean {
  if (!HHMM.test(from) || !HHMM.test(to) || from === to) return false;
  const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  const n = now.getHours() * 60 + now.getMinutes(), a = mins(from), b = mins(to);
  return a < b ? n >= a && n < b : n >= a || n < b;
}

/** Rate limit for spoken notices. Returns the updated history when speaking is allowed, or null when it is not. */
export function allowSpoken(history: number[], now: number, max = MAX_SPOKEN_PER_HOUR): number[] | null {
  const recent = history.filter((t) => now - t < 3_600_000);
  return recent.length >= max ? null : [...recent, now];
}

/** One warning each time the battery falls to 20% while unplugged; it re-arms on charging or at 25%. */
export function batteryStep(warned: boolean, level: number, charging: boolean): { warn: boolean; warned: boolean } {
  if (charging || level >= REARM_BATTERY) return { warn: false, warned: false };
  if (level <= LOW_BATTERY && !warned) return { warn: true, warned: true };
  return { warn: false, warned };
}

/** How one notice is delivered: spoken and shown, or shown only. */
export function delivery(s: ProactiveSettings, now: Date, history: number[], busySpeaking: boolean): { speak: boolean; history: number[] } {
  if (inQuietHours(now, s.quietFrom, s.quietTo) || busySpeaking) return { speak: false, history };
  const next = allowSpoken(history, now.getTime());
  return next ? { speak: true, history: next } : { speak: false, history };
}
