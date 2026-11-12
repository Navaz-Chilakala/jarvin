import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

type Launcher = (file: string, args: string[]) => ChildProcess;
export type StartApp = { name: string; appId: string };

/** Windows pages and tools that cannot be launched by a bare executable name. */
const SETTINGS_ALIASES: Record<string, string> = {
  settings: 'ms-settings:', 'windows settings': 'ms-settings:', 'system settings': 'ms-settings:', 'ms-settings': 'ms-settings:', 'ms-settings.exe': 'ms-settings:', 'settings.exe': 'ms-settings:',
  'display settings': 'ms-settings:display', 'sound settings': 'ms-settings:sound', 'wifi settings': 'ms-settings:network-wifi', 'wi-fi settings': 'ms-settings:network-wifi',
  'bluetooth settings': 'ms-settings:bluetooth', 'network settings': 'ms-settings:network', 'apps settings': 'ms-settings:appsfeatures', 'windows update': 'ms-settings:windowsupdate',
};
const TOOL_ALIASES: Record<string, string> = {
  'control panel': 'control.exe', controlpanel: 'control.exe', control: 'control.exe', 'file explorer': 'explorer.exe', explorer: 'explorer.exe', 'windows explorer': 'explorer.exe',
  'task manager': 'taskmgr.exe', taskmanager: 'taskmgr.exe', notepad: 'notepad.exe', paint: 'mspaint.exe', 'ms paint': 'mspaint.exe', 'snipping tool': 'snippingtool.exe', wordpad: 'write.exe',
};
const SETTINGS_URI = /^ms-settings:[a-z0-9:_-]*$/i;

/** Look up an installed app (desktop or Store) by name through the Start menu list. The name is passed in the environment, never in a command line. */
export function findStartApp(name: string): Promise<StartApp | null> {
  const query = name.trim();
  if (!query || query.length > 80 || !/^[\w .+\-()&']+$/.test(query)) return Promise.resolve(null);
  const script = "$q=$env:JARVIN_APP_QUERY; $a=Get-StartApps | Where-Object { $_.Name -ieq $q } | Select-Object -First 1; if(-not $a){ $a=Get-StartApps | Where-Object { $_.Name -like ('*'+$q+'*') } | Select-Object -First 1 }; if($a){ $a | ConvertTo-Json -Compress }";
  return new Promise((resolve) => {
    let out = '';
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { env: { ...process.env, JARVIN_APP_QUERY: query }, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve(null); }, 10_000);
    child.stdout?.on('data', (d) => { out += String(d); });
    child.once('error', () => { clearTimeout(timer); resolve(null); });
    child.once('close', () => {
      clearTimeout(timer);
      try {
        const v = JSON.parse(out.trim()) as { Name?: unknown; AppID?: unknown };
        if (typeof v.Name === 'string' && typeof v.AppID === 'string' && /^[\w.!{}\-\\: ()]+$/.test(v.AppID)) resolve({ name: v.Name, appId: v.AppID });
        else resolve(null);
      } catch { resolve(null); }
    });
  });
}

/** Build a visible Chrome search without treating the query as a shell command or URL. */
export function chromeSearchUrl(query: string): string {
  const q = query.trim();
  if (!q || q.length > 500 || q.includes('\0')) throw new Error('Provide a search query of 1–500 characters.');
  const url = new URL('https://www.google.com/search');
  url.searchParams.set('q', q);
  return url.toString();
}

/** Start a program without passing model-provided arguments through a shell. */
export async function launchProgram(target: string, args: string[], options: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (p: string) => boolean;
  spawnChild?: Launcher;
  openPath: (p: string) => Promise<string>;
  findStartApp?: (name: string) => Promise<StartApp | null>;
}): Promise<string> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? fs.existsSync;
  let name = target.trim();
  let launchArgs = args;
  if (!name || name.includes('\0')) throw new Error('A valid application name is required.');
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(name)) throw new Error('Use open_website for websites.');
  if (platform === 'win32') {
    const alias = name.toLowerCase();
    if (['calculator', 'calc'].includes(alias)) name = 'calc.exe';
    const settingsUri = SETTINGS_ALIASES[alias] ?? (SETTINGS_URI.test(name) ? name.toLowerCase() : undefined);
    if (settingsUri) { name = 'explorer.exe'; launchArgs = [settingsUri]; }
    else if (TOOL_ALIASES[alias]) name = TOOL_ALIASES[alias];
    const knownBrowsers: Record<string, { executable: string; suffix: string[] }> = {
      chrome: { executable: 'chrome.exe', suffix: ['Google', 'Chrome', 'Application', 'chrome.exe'] },
      'google chrome': { executable: 'chrome.exe', suffix: ['Google', 'Chrome', 'Application', 'chrome.exe'] },
      'google-chrome': { executable: 'chrome.exe', suffix: ['Google', 'Chrome', 'Application', 'chrome.exe'] },
      'chrome.exe': { executable: 'chrome.exe', suffix: ['Google', 'Chrome', 'Application', 'chrome.exe'] },
      edge: { executable: 'msedge.exe', suffix: ['Microsoft', 'Edge', 'Application', 'msedge.exe'] },
      'microsoft edge': { executable: 'msedge.exe', suffix: ['Microsoft', 'Edge', 'Application', 'msedge.exe'] },
      'msedge.exe': { executable: 'msedge.exe', suffix: ['Microsoft', 'Edge', 'Application', 'msedge.exe'] },
      firefox: { executable: 'firefox.exe', suffix: ['Mozilla Firefox', 'firefox.exe'] },
      'firefox.exe': { executable: 'firefox.exe', suffix: ['Mozilla Firefox', 'firefox.exe'] },
    };
    const browser = knownBrowsers[alias];
    if (browser) {
      const roots = [env.LOCALAPPDATA, env.ProgramFiles, env['ProgramFiles(x86)']].filter((p): p is string => !!p);
      name = roots.map((root) => path.win32.join(root, ...browser.suffix)).find(exists) || browser.executable;
    }
    if (['vs code', 'vscode', 'visual studio code', 'code'].includes(alias)) {
      const candidate = path.win32.join(env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe');
      if (exists(candidate)) name = candidate;
    }
    const lower = path.win32.basename(name).toLowerCase();
    if (/\.(cmd|bat|ps1|vbs|js|jse|wsf|hta)$/i.test(lower) || /^(cmd|powershell|pwsh|wscript|cscript|mshta)(\.exe)?$/i.test(lower)) {
      throw new Error('Scripts and command interpreters must use the command tool and its approval policy.');
    }
    if (exists(name) && !/\.exe$/i.test(name)) {
      if (launchArgs.length) throw new Error('Opening a document with arguments is not supported.');
      const error = await options.openPath(name);
      if (error) throw new Error(error);
      return `Asked Windows to open ${name}.`;
    }
  }
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? name : 'xdg-open';
  const commandArgs = platform === 'darwin' ? ['-a', name, ...launchArgs] : platform === 'win32' ? launchArgs : [name, ...launchArgs];
  const run = options.spawnChild ?? ((file, argv) => spawn(file, argv, { detached: true, stdio: 'ignore', shell: false }));
  const start = async (file: string, argv: string[]): Promise<void> => {
    const child = run(file, argv);
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', resolve);
    });
    child.unref();
  };
  try {
    await start(command, commandArgs);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
    // A bare name such as "Calculator" or "Spotify" is usually a Start-menu app, not an executable on PATH.
    if (platform === 'win32' && !/[\\/]/.test(target) && launchArgs.length === 0) {
      const app = await (options.findStartApp ?? findStartApp)(target);
      if (app) {
        await start('explorer.exe', [`shell:AppsFolder\\${app.appId}`]);
        return `Started ${app.name} from the Start menu; the operating system accepted the launch.`;
      }
    }
    throw new Error(`Could not find an application named "${target}". Do not retry the same name. Try the exact name shown in the Start menu, a full .exe path, or look at the screen (desktop_list_windows / see_window) and open it with the mouse and keyboard.`);
  }
  return `Started ${name}; the operating system accepted the launch.`;
}
