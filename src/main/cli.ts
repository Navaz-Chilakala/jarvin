import fs from 'node:fs';
import path from 'node:path';

/** The Electron development executable's app path is not a requested workspace. */
export function folderFromArguments(argv: string[], cwd: string, defaultApp: boolean, isDirectory = (p: string) => fs.statSync(p).isDirectory()): string | null {
  const candidates: string[] = [];
  const switchesWithValue = new Set(['--user-data-dir', '--remote-debugging-port', '--remote-allow-origins']);
  for (let i = defaultApp ? 2 : 1; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg.startsWith('-')) { if (switchesWithValue.has(arg)) i++; continue; }
    candidates.push(arg);
  }
  for (const arg of candidates.reverse()) {
    const absolute = path.resolve(cwd, arg);
    try { if (isDirectory(absolute)) return absolute; } catch { /* not a directory */ }
  }
  return null;
}
