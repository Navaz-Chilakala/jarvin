import { execFile } from 'node:child_process';

export type OpenWindow = { process: string; title: string };

const LIST_PS = "Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { $_.ProcessName + '|' + $_.MainWindowTitle }";

/** Visible top-level windows (process + title). Windows only; any failure gives an empty list. */
export function listOpenWindows(platform: string = process.platform): Promise<OpenWindow[]> {
  if (platform !== 'win32') return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', LIST_PS], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(String(stdout).split(/\r?\n/).map((line) => {
        const i = line.indexOf('|');
        return i > 0 ? { process: line.slice(0, i).trim(), title: line.slice(i + 1).trim() } : null;
      }).filter((w): w is OpenWindow => !!w && !!w.title));
    });
  });
}

const key = (w: OpenWindow) => `${w.process.toLowerCase()}|${w.title}`;

/** After a launch: wait for a window that was not open before. Returns a sentence the model can act on. */
export async function confirmNewWindow(before: OpenWindow[], o: { list?: () => Promise<OpenWindow[]>; wait?: (ms: number) => Promise<void>; tries?: number } = {}): Promise<string> {
  const list = o.list ?? listOpenWindows;
  const wait = o.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const seen = new Set(before.map(key));
  for (let i = 0; i < (o.tries ?? 6); i++) {
    await wait(1000);
    const fresh = (await list()).filter((w) => !seen.has(key(w)) && !(w.process.toLowerCase() === 'electron' && /^jarvin/i.test(w.title)));
    if (fresh.length) return `A new window appeared: ${fresh.slice(0, 3).map((w) => `${w.process} "${w.title.slice(0, 60)}"`).join(', ')}.`;
  }
  return 'No new window was detected within 6 seconds (the app may have focused an existing window, or it did not open). Call desktop_list_windows to check before saying it is open.';
}

export type ListedWindow = { window_id: string; app: string; title: string };

const NAME_ALIASES: Record<string, string> = {
  calc: 'calculator', 'google chrome': 'chrome', 'microsoft edge': 'msedge', edge: 'msedge', 'file explorer': 'explorer', explorer: 'explorer',
  'vs code': 'code', vscode: 'code', 'visual studio code': 'code', 'task manager': 'taskmgr', 'windows settings': 'settings', 'command prompt': 'cmd',
};
const HOST_APPS = new Set(['applicationframehost', 'electron', 'explorer', 'textinputhost', 'shellexperiencehost']);

/** The already-open window an app name most likely means, or undefined. Jarvin's own windows never match. */
export function matchWindow(windows: ListedWindow[], target: string): ListedWindow | undefined {
  const raw = target.trim().toLowerCase().replace(/\.exe$/, '');
  if (!raw || raw.length < 3) return undefined;
  const want = NAME_ALIASES[raw] ?? raw;
  const others = windows.filter((w) => !/^jarvin/i.test(w.title) && !(w.app.toLowerCase() === 'electron'));
  const byApp = others.find((w) => w.app.toLowerCase() === want && !HOST_APPS.has(w.app.toLowerCase()));
  if (byApp) return byApp;
  const byTitle = others.find((w) => w.title.trim().toLowerCase() === want);
  if (byTitle) return byTitle;
  const byTitleEnd = others.find((w) => w.title.toLowerCase().endsWith(` - ${want}`) || w.title.toLowerCase().endsWith(` — ${want}`));
  if (byTitleEnd) return byTitleEnd;
  return want.length >= 4 ? others.find((w) => w.title.toLowerCase().includes(want) && !HOST_APPS.has(w.app.toLowerCase()) || (HOST_APPS.has(w.app.toLowerCase()) && w.title.toLowerCase() === want)) : undefined;
}
