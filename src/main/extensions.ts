import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { runShell } from './terminal';
import type { ShellChoice } from '../shared/types';
import { combineRules, mergePersonas, parseHooks, parsePersona, hooksFor, hookTarget, type Hook, type HookEvent, type Persona, type RuleSource } from '../shared/ext';

const home = () => path.join(os.homedir(), '.jarvin');
const readText = (p: string, max = 40_000): string | null => {
  try { return fs.readFileSync(p, 'utf8').slice(0, max); } catch { return null; }
};
const listMd = (dir: string, max = 40): string[] => {
  try { return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')).sort().slice(0, max); } catch { return []; }
};

export function ruleSources(root: string): RuleSource[] {
  const out: RuleSource[] = [];
  const g = readText(path.join(home(), 'rules.md'));
  if (g) out.push({ label: 'Your global rules (~/.jarvin/rules.md)', text: g });
  for (const n of ['AGENTS.md', 'JARVIN.md', 'CLAUDE.md']) {
    const t = root ? readText(path.join(root, n)) : null;
    if (t) { out.push({ label: n, text: t }); break; }
  }
  if (root) for (const f of listMd(path.join(root, '.jarvin', 'rules'))) {
    const t = readText(path.join(root, '.jarvin', 'rules', f));
    if (t) out.push({ label: `.jarvin/rules/${f}`, text: t });
  }
  return out;
}

export function loadRules(root: string) { return combineRules(ruleSources(root)); }

export function loadPersonas(root: string): Persona[] {
  const custom: Persona[] = [];
  for (const dir of [path.join(home(), 'modes'), root ? path.join(root, '.jarvin', 'modes') : '']) {
    if (!dir) continue;
    for (const f of listMd(dir)) {
      const t = readText(path.join(dir, f));
      const p = t ? parsePersona(f.replace(/\.md$/i, ''), t) : null;
      if (p) custom.push(p);
    }
  }
  return mergePersonas(custom);
}

// ---------- hooks ----------

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export interface HooksState {
  /** Hooks that will run now (user-level always; workspace-level only when trusted). */
  active: Hook[];
  /** Workspace hooks waiting for the user's trust. */
  pending: Hook[];
  errors: string[];
  file: string;
  hash: string;
}

export class HookTrust {
  constructor(private file: string) {}
  private read(): Record<string, string> {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return {}; }
  }
  isTrusted(root: string, hash: string) { return this.read()[root] === hash; }
  trust(root: string, hash: string) {
    const m = this.read();
    m[root] = hash;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(m, null, 2));
  }
}

export function loadHooks(root: string, trust: HookTrust): HooksState {
  const errors: string[] = [];
  const active: Hook[] = [];
  let pending: Hook[] = [];
  let hash = '';
  const file = root ? path.join(root, '.jarvin', 'hooks.json') : '';
  const userText = readText(path.join(home(), 'hooks.json'));
  if (userText) { const r = parseHooks(userText); active.push(...r.hooks); errors.push(...r.errors.map((e) => `~/.jarvin/hooks.json: ${e}`)); }
  const wsText = file ? readText(file) : null;
  if (wsText) {
    hash = sha(wsText);
    const r = parseHooks(wsText);
    errors.push(...r.errors.map((e) => `.jarvin/hooks.json: ${e}`));
    if (trust.isTrusted(root, hash)) active.push(...r.hooks); else pending = r.hooks;
  }
  return { active, pending, errors, file, hash };
}

export interface HookRun { hook: Hook; code: number | null; output: string; timedOut: boolean }

export async function runHooks(hooks: Hook[], event: HookEvent, tool: string, args: any, o: { root: string; signal: AbortSignal; shell?: ShellChoice }): Promise<HookRun[]> {
  const out: HookRun[] = [];
  for (const h of hooksFor(hooks, event, tool, args)) {
    if (o.signal.aborted) break;
    const target = hookTarget(args);
    let argsJson = '';
    try { argsJson = JSON.stringify(args ?? {}).slice(0, 8000); } catch { /* ignore */ }
    const r = await runShell({
      command: h.command, cwd: o.root || process.cwd(), timeoutMs: h.timeout * 1000, signal: o.signal, shell: o.shell,
      env: { JARVIN_EVENT: event, JARVIN_TOOL: tool, JARVIN_FILE: typeof args?.path === 'string' ? args.path : '', JARVIN_COMMAND: typeof args?.command === 'string' ? args.command : target, JARVIN_WORKSPACE: o.root, JARVIN_ARGS: argsJson },
    });
    out.push({ hook: h, code: r.code, output: r.output.trim().slice(0, 4000), timedOut: r.timedOut });
  }
  return out;
}
