/** Process-wide screen observation switch. Every built-in capture path checks this. */
let observationPaused = false;
let screenLocked = false;
let excludedApps: string[] = [];
let excludedTitles: string[] = [];
type VisibleWindow = { app: string; title: string };
let scanWindows: ((signal: AbortSignal) => Promise<{ windows: VisibleWindow[]; truncated?: boolean; uncertain?: boolean }>) | null = null;
let onBlocked: ((blocked: boolean) => void) | null = null;
let screenBlocked = false;
function reportBlocked(blocked: boolean): void {
  if (screenBlocked === blocked) return;
  screenBlocked = blocked;
  onBlocked?.(blocked);
}

export function setScreenObservationPaused(paused: boolean): void {
  observationPaused = paused;
}

export function setScreenLocked(locked: boolean): void { screenLocked = locked; }

export function setScreenExclusions(apps: string[], titles: string[]): void {
  excludedApps = apps.map((value) => value.trim().toLocaleLowerCase().replace(/\.exe$/, '')).filter(Boolean);
  excludedTitles = titles.map((value) => value.trim().toLocaleLowerCase()).filter(Boolean);
  reportBlocked(false);
}

export function setVisibleWindowScanner(scanner: typeof scanWindows): void { scanWindows = scanner; }
export function setExclusionStatusListener(listener: typeof onBlocked): void { onBlocked = listener; }

export function screenExclusionRules(): { apps: string[]; titles: string[] } {
  return { apps: [...excludedApps], titles: [...excludedTitles] };
}

/** A persistent desktop stream is permitted only while no exclusion can appear in it. */
export function streamCaptureAllowed(): boolean {
  return !observationPaused && !screenLocked && excludedApps.length === 0 && excludedTitles.length === 0;
}

export function isExcludedWindow(window: VisibleWindow): boolean {
  const app = window.app.toLocaleLowerCase().replace(/\.exe$/, '');
  const title = window.title.toLocaleLowerCase();
  return excludedApps.includes(app) || excludedTitles.some((part) => title.includes(part));
}

export function assertScreenObservationAllowed(): void {
  if (screenLocked) throw new Error('Screen observation is unavailable while Windows is locked.');
  if (observationPaused) throw new Error('Screen observation is paused. Resume it from the floating pet or Privacy settings before using screen vision.');
}

/** Full-display capture is blocked if any excluded window is visible. */
export async function assertDisplayCaptureAllowed(signal: AbortSignal = AbortSignal.timeout(6000)): Promise<void> {
  assertScreenObservationAllowed();
  if (!excludedApps.length && !excludedTitles.length) { reportBlocked(false); return; }
  if (!scanWindows) { reportBlocked(true); throw new Error('Screen exclusions are configured, but the Windows privacy scanner is unavailable. Screen capture was blocked.'); }
  let result: Awaited<ReturnType<NonNullable<typeof scanWindows>>>;
  try { result = await scanWindows(signal); }
  catch (error) { if (!signal.aborted) reportBlocked(true); throw error; }
  if (result.truncated || result.uncertain || !Array.isArray(result.windows)) { reportBlocked(true); throw new Error('Could not fully check visible windows. Screen capture was blocked.'); }
  const excluded = result.windows.find(isExcludedWindow);
  if (excluded) { reportBlocked(true); throw new Error('An excluded app or window is visible. Whole-screen capture was blocked; hide it or change Privacy settings.'); }
  reportBlocked(false);
  assertScreenObservationAllowed();
}
