import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export type ShellChoice = 'auto' | 'powershell' | 'cmd';

export interface ShellSpec {
  file: string;
  args: string[];
  verbatim: boolean;
  /** Short name shown to the model, e.g. "Windows PowerShell 5.1". */
  label: string;
  /** One line telling the model how to write commands for this shell. */
  hint: string;
}

/** Find an executable on PATH (honours PATHEXT on Windows). */
export function which(name: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const exts = platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : [''];
  for (const d of dirs)
    for (const e of exts) {
      const f = path.join(d, name + e);
      try {
        if (fs.statSync(f).isFile()) return f;
      } catch {
        /* next */
      }
    }
  return null;
}

const PS_PREFIX = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$ProgressPreference='SilentlyContinue';";
const PS_SUFFIX = ';if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE } elseif (-not $?) { exit 1 } else { exit 0 }';

export function shellFor(
  command: string,
  choice: ShellChoice = 'auto',
  platform: NodeJS.Platform = process.platform,
  find: (n: string) => string | null = (n) => which(n, platform),
): ShellSpec {
  if (platform !== 'win32') {
    const bash = find('bash');
    return {
      file: bash ?? '/bin/sh',
      args: ['-c', command],
      verbatim: false,
      label: bash ? 'bash' : 'sh',
      hint: 'Use POSIX shell syntax. Chain commands with && .',
    };
  }
  if (choice !== 'cmd') {
    const pwsh = choice === 'auto' ? find('pwsh') : null;
    const file = pwsh ?? find('powershell') ?? 'powershell.exe';
    const encoded = Buffer.from(PS_PREFIX + command + PS_SUFFIX, 'utf16le').toString('base64');
    return {
      file,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      verbatim: false,
      label: pwsh ? 'PowerShell 7' : 'Windows PowerShell 5.1',
      hint: pwsh
        ? 'Use PowerShell syntax. Paths use backslashes; && and || work.'
        : 'Use PowerShell 5.1 syntax: chain commands with ; (NOT &&), use $env:NAME for variables, paths use backslashes.',
    };
  }
  return {
    file: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${command}"`],
    verbatim: true,
    label: 'cmd.exe',
    hint: 'Use cmd.exe syntax: chain with &&, use %NAME% for variables, dir/type instead of ls/cat.',
  };
}

export function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
export const stripAnsi = (s: string) => s.replace(ANSI, '');

/** Collapse carriage-return progress lines and normalise line endings. */
export function tidy(s: string): string {
  return stripAnsi(s)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => (l.includes('\r') ? l.slice(l.lastIndexOf('\r') + 1) || l.replace(/\r/g, '') : l))
    .join('\n');
}

/** Keep the start and the end of long output; errors usually sit at the end. */
export function capOutput(s: string, max = 20000): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.25);
  const tail = max - head;
  return `${s.slice(0, head)}\n…[${s.length - max} characters omitted]…\n${s.slice(-tail)}`;
}

export interface RunOpts {
  command: string;
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  shell?: ShellChoice;
  onOutput?: (chunk: string) => void;
  /** Extra environment variables for the child process. */
  env?: Record<string, string>;
}
export interface RunResult {
  code: number | null;
  output: string;
  timedOut: boolean;
  aborted: boolean;
}

const KEEP = 400_000;

export function runShell(o: RunOpts): Promise<RunResult> {
  return new Promise((resolve) => {
    const sh = shellFor(o.command, o.shell);
    const child = spawn(sh.file, sh.args, {
      cwd: o.cwd,
      detached: process.platform !== 'win32',
      windowsHide: true,
      windowsVerbatimArguments: sh.verbatim,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', GIT_TERMINAL_PROMPT: '0', PAGER: 'cat', GIT_PAGER: 'cat', npm_config_color: 'false', ...(o.env ?? {}) },
    });
    let buf = '';
    let dropped = 0;
    let timedOut = false;
    let aborted = false;
    let done = false;
    const push = (text: string) => {
      const t = stripAnsi(text);
      buf += t;
      if (buf.length > KEEP * 2) {
        dropped += buf.length - KEEP;
        buf = buf.slice(0, KEEP / 2) + buf.slice(-KEEP / 2);
      }
      o.onOutput?.(t);
    };
    for (const s of [child.stdout, child.stderr]) {
      const dec = new StringDecoder('utf8');
      s.on('data', (d: Buffer) => push(dec.write(d)));
      s.on('end', () => {
        const rest = dec.end();
        if (rest) push(rest);
      });
    }
    let backstop: NodeJS.Timeout | undefined;
    const kill = () => {
      killTree(child.pid);
      backstop ??= setTimeout(() => finish(null), 2000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, o.timeoutMs);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    if (o.signal.aborted) onAbort();
    else o.signal.addEventListener('abort', onAbort, { once: true });
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (backstop) clearTimeout(backstop);
      o.signal.removeEventListener('abort', onAbort);
      child.stdout.destroy();
      child.stderr.destroy();
      const output = tidy(buf).trim() + (dropped ? `\n…[${dropped} earlier characters dropped]` : '');
      resolve({ code, output, timedOut, aborted });
    };
    child.on('close', (code) => finish(code));
    child.on('error', (e) => {
      push(String(e));
      finish(-1);
    });
  });
}

export const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+-[^\n]*r[^\n]*f?[^\n]*\s+\/\s*$/i,
  /\brm\s+-rf\s+\/(\*?)\s*$/i,
  /\bdel\s+\/[sfq]+\s+[a-z]:\?/i,
  /\bformat\s+[a-z]:/i,
  /\bdiskpart\b/i,
  /\bcurl\b[^\n]*\|\s*(sh|bash|powershell|pwsh|cmd)\b/i,
  /\bwget\b[^\n]*\|\s*(sh|bash|powershell|pwsh|cmd)\b/i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
  /\bshutdown\b/i,
  /\breg\s+delete\b/i,
];

export function isDangerousCommand(command: string): boolean {
  const s = String(command ?? '');
  return DANGEROUS_PATTERNS.some((re) => re.test(s));
}

export interface InteractiveShell {
  file: string;
  args: string[];
  label: string;
}

/**
 * The shell for the integrated terminal panel. It follows the Settings → Terminal shell choice and, unlike the agent's
 * run_command shell, loads the user's profile so it behaves like a normal terminal window.
 */
export function interactiveShell(
  choice: ShellChoice = 'auto',
  platform: NodeJS.Platform = process.platform,
  find: (n: string) => string | null = (n) => which(n, platform),
  env: NodeJS.ProcessEnv = process.env,
): InteractiveShell {
  if (platform !== 'win32') {
    const file = env.SHELL || find('bash') || '/bin/sh';
    return { file, args: [], label: path.basename(file) };
  }
  if (choice === 'cmd') return { file: env.ComSpec || 'cmd.exe', args: [], label: 'cmd.exe' };
  const pwsh = choice === 'auto' ? find('pwsh') : null;
  return { file: pwsh ?? find('powershell') ?? 'powershell.exe', args: ['-NoLogo'], label: pwsh ? 'PowerShell 7' : 'Windows PowerShell' };
}

/** Environment for an interactive terminal: a real terminal type and none of the app's own Node/Electron switches. */
export function terminalEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string' && !/^(ELECTRON_|NODE_OPTIONS$|NODE_ENV$)/i.test(k)) out[k] = v;
  out.TERM = 'xterm-256color';
  out.COLORTERM = 'truecolor';
  out.TERM_PROGRAM = 'Jarvin';
  return out;
}
