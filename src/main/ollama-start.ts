import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

type Spawner = (file: string, args: string[]) => { unref(): void; once(event: 'error', cb: () => void): unknown };

export function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname);
  } catch { return false; }
}

/** Where Ollama is usually installed on Windows, first existing path wins; otherwise rely on PATH. */
export function ollamaExecutable(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fs.existsSync): string {
  const roots = [env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'), env.ProgramFiles && path.win32.join(env.ProgramFiles, 'Ollama', 'ollama.exe')].filter((p): p is string => !!p);
  return roots.find(exists) ?? 'ollama';
}

/** If a local Ollama server is not answering, start `ollama serve` hidden and let it run on its own. Returns what happened. */
export async function ensureOllamaRunning(baseUrl: string, o: { probe?: (url: string) => Promise<boolean>; spawnChild?: Spawner; platform?: string; env?: NodeJS.ProcessEnv; exists?: (p: string) => boolean } = {}): Promise<'running' | 'started' | 'remote' | 'unsupported'> {
  if ((o.platform ?? process.platform) !== 'win32') return 'unsupported';
  if (!isLocalBaseUrl(baseUrl)) return 'remote';
  const probe = o.probe ?? (async (url: string) => { try { return (await fetch(`${url.replace(/\/+$/, '')}/api/tags`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } });
  if (await probe(baseUrl)) return 'running';
  const run: Spawner = o.spawnChild ?? ((file, args) => spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true, shell: false }));
  const child = run(ollamaExecutable(o.env, o.exists), ['serve']);
  child.once('error', () => { /* Ollama is not installed; the setup guide explains how to get it */ });
  child.unref();
  return 'started';
}
