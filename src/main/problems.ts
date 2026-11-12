import fs from 'node:fs';
import path from 'node:path';
import { runShell } from './terminal';
const IGNORE = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', 'target', '.cache', 'release']);
import { dedupe, parseColon, parseEslintJson, parsePyCompile, parseTsc, type CheckInfo, type Problem, type ProblemsResult } from '../shared/problems';
import type { ShellChoice } from '../shared/types';

interface Checker {
  name: string;
  command: string;
  parse: (out: string, root: string) => Problem[];
}

const exists = (root: string, ...p: string[]) => fs.existsSync(path.join(root, ...p));
const q = (s: string) => (/\s/.test(s) ? `"${s}"` : s);

function pythonFiles(root: string, limit = 120): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (out.length >= limit || depth > 6) return;
    let es: fs.Dirent[] = [];
    try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (out.length >= limit) return;
      if (e.isDirectory()) { if (!IGNORE.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1); }
      else if (e.name.endsWith('.py')) out.push(path.relative(root, path.join(dir, e.name)));
    }
  };
  walk(root, 0);
  return out;
}

/** Which checks make sense for this folder. Only tools that are already installed locally are used. */
export function detectCheckers(root: string): Checker[] {
  const list: Checker[] = [];
  if (exists(root, 'tsconfig.json') && exists(root, 'node_modules', 'typescript', 'bin', 'tsc')) {
    list.push({ name: 'TypeScript', command: 'node node_modules/typescript/bin/tsc --noEmit --pretty false', parse: (o, r) => parseTsc(o, r) });
  }
  const eslintBin = path.join('node_modules', 'eslint', 'bin', 'eslint.js');
  const hasEslintCfg = (() => { try { return fs.readdirSync(root).some((n) => /^(eslint\.config\.|\.eslintrc)/.test(n)); } catch { return false; } })();
  if (hasEslintCfg && exists(root, eslintBin)) {
    list.push({ name: 'ESLint', command: `node ${eslintBin.replace(/\\/g, '/')} -f json .`, parse: (o, r) => parseEslintJson(o, r) });
  }
  const py = pythonFiles(root);
  if (py.length) list.push({ name: 'Python', command: `python -m py_compile ${py.map((f) => q(f.replace(/\\/g, '/'))).join(' ')}`, parse: (o, r) => parsePyCompile(o, r) });
  if (exists(root, 'go.mod')) list.push({ name: 'Go vet', command: 'go vet ./...', parse: (o, r) => parseColon(o, 'go vet', r) });
  if (exists(root, 'Cargo.toml')) list.push({ name: 'Cargo check', command: 'cargo check --message-format short', parse: (o, r) => parseColon(o, 'cargo', r) });
  return list;
}

export async function runProblemChecks(root: string, o: { signal: AbortSignal; shell?: ShellChoice; timeoutMs?: number }): Promise<ProblemsResult> {
  const checks: CheckInfo[] = [];
  let problems: Problem[] = [];
  for (const c of detectCheckers(root)) {
    if (o.signal.aborted) break;
    const t0 = Date.now();
    const info: CheckInfo = { name: c.name, command: c.command, ran: true, ok: true, ms: 0, count: 0 };
    try {
      const r = await runShell({ command: c.command, cwd: root, timeoutMs: o.timeoutMs ?? 120_000, signal: o.signal, shell: o.shell });
      const found = c.parse(r.output, root);
      info.ms = Date.now() - t0;
      if (r.timedOut) { info.ran = false; info.error = 'Timed out'; }
      else if (r.aborted) { info.ran = false; info.error = 'Stopped'; }
      else if (!found.length && r.code !== 0 && /not recognized|command not found|No such file|ENOENT|cannot find the path/i.test(r.output)) {
        info.ran = false;
        info.error = `${c.name} is not installed or could not start.`;
      } else if (!found.length && r.code !== 0 && c.name !== 'Python') {
        // The tool failed without producing parseable findings: surface that rather than claiming success.
        info.ok = false;
        info.error = r.output.trim().split('\n').slice(-3).join(' | ').slice(0, 300) || `exit code ${r.code}`;
      }
      info.count = found.length;
      info.ok = info.ok && !found.some((p) => p.severity === 'error');
      problems = problems.concat(found);
    } catch (e: any) {
      info.ran = false;
      info.ms = Date.now() - t0;
      info.error = String(e?.message ?? e);
    }
    checks.push(info);
  }
  return { problems: dedupe(problems), checks };
}
