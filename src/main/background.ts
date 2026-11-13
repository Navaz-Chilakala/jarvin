/** Per-user background mode (chosen over a Windows service, which cannot show windows or use the microphone in the user's session): start hidden at sign-in, and reload the window after a crash. */

export const BACKGROUND_FLAG = '--background';

/** True when Windows started Jarvin at sign-in: no window, no pet, no microphone and no model warm-up until first opened. */
export function isBackgroundStart(argv: string[]): boolean {
  return argv.includes(BACKGROUND_FLAG);
}

/** What to register as the sign-in item. Run from source, Electron needs the app folder as its first argument. */
export function loginItem(enabled: boolean, o: { packaged: boolean; execPath: string; appPath: string }): { openAtLogin: boolean; path: string; args: string[] } {
  return { openAtLogin: enabled, path: o.execPath, args: o.packaged ? [BACKGROUND_FLAG] : [o.appPath, BACKGROUND_FLAG] };
}

export const MAX_RELOADS = 3;
export const RELOAD_WINDOW_MS = 10 * 60_000;

/** A crashed window is reloaded at most 3 times in 10 minutes. Returns the updated history, or null when the limit is reached. */
export function allowReload(history: number[], now: number): number[] | null {
  const recent = history.filter((t) => now - t < RELOAD_WINDOW_MS);
  return recent.length >= MAX_RELOADS ? null : [...recent, now];
}
