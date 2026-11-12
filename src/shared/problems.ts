/** Parsers for compiler/linter output. Pure functions so they can be tested without running any tool. */

export type Severity = 'error' | 'warning' | 'info';
export interface Problem {
  file: string;
  line: number;
  col: number;
  severity: Severity;
  message: string;
  source: string;
  code?: string;
}
export interface CheckInfo {
  name: string;
  command: string;
  ran: boolean;
  ok: boolean;
  ms: number;
  count: number;
  error?: string;
}
export interface ProblemsResult {
  problems: Problem[];
  checks: CheckInfo[];
}

/** Workspace-relative path with forward slashes. */
export function relPath(file: string, root: string): string {
  let f = file.trim().replace(/\\/g, '/');
  const r = root.replace(/\\/g, '/').replace(/\/$/, '');
  if (r && f.toLowerCase().startsWith(r.toLowerCase() + '/')) f = f.slice(r.length + 1);
  return f.replace(/^\.\//, '');
}

/** `src/a.ts(12,5): error TS2322: Type ...` */
export function parseTsc(out: string, root = ''): Problem[] {
  const list: Problem[] = [];
  const re = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/;
  const lines = String(out ?? '').replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    let message = m[6];
    // tsc continues long messages on indented lines
    while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1])) message += ' ' + lines[++i].trim();
    list.push({ file: relPath(m[1], root), line: +m[2], col: +m[3], severity: m[4] as Severity, message, source: 'typescript', code: m[5] });
  }
  return list;
}

/** `path:line:col: message` (go vet, cargo --message-format short, ruff concise, gcc-style). */
export function parseColon(out: string, source: string, root = ''): Problem[] {
  const list: Problem[] = [];
  const re = /^((?:[A-Za-z]:)?[^:\n]+?):(\d+)(?::(\d+))?:\s+(.*)$/;
  for (const raw of String(out ?? '').replace(/\r/g, '').split('\n')) {
    const m = raw.match(re);
    if (!m) continue;
    const text = m[4];
    const sev: Severity = /^\s*(error|fatal)\b|\berror(\[|:)/i.test(text) ? 'error' : /^\s*warning\b|\bwarning(\[|:)/i.test(text) ? 'warning' : source === 'ruff' ? 'warning' : 'error';
    const code = text.match(/^(?:error|warning)\[(\w+)\]/)?.[1] ?? text.match(/^([A-Z]{1,4}\d{2,4})\b/)?.[1];
    list.push({ file: relPath(m[1], root), line: +m[2], col: m[3] ? +m[3] : 1, severity: sev, message: text.replace(/^(error|warning)(\[\w+\])?:\s*/i, ''), source, code });
  }
  return list;
}

/** `eslint -f json` */
export function parseEslintJson(out: string, root = ''): Problem[] {
  const start = out.indexOf('[');
  if (start < 0) return [];
  let data: any;
  try { data = JSON.parse(out.slice(start)); } catch { return []; }
  const list: Problem[] = [];
  for (const f of Array.isArray(data) ? data : []) {
    for (const m of f?.messages ?? []) {
      list.push({ file: relPath(String(f.filePath ?? ''), root), line: Number(m.line) || 1, col: Number(m.column) || 1, severity: m.severity === 2 ? 'error' : 'warning', message: String(m.message ?? ''), source: 'eslint', code: m.ruleId ?? undefined });
    }
  }
  return list;
}

/** `python -m py_compile` prints `  File "x.py", line 3` then the error type. */
export function parsePyCompile(out: string, root = ''): Problem[] {
  const list: Problem[] = [];
  const lines = String(out ?? '').replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/File "(.+?)", line (\d+)/);
    if (!m) continue;
    let msg = '';
    for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
      const e = lines[j].match(/^(\w*(?:Error|Exception)):\s*(.*)$/);
      if (e) { msg = `${e[1]}: ${e[2]}`.trim(); break; }
    }
    list.push({ file: relPath(m[1], root), line: +m[2], col: 1, severity: 'error', message: msg || 'Syntax error', source: 'python' });
  }
  return list;
}

export function dedupe(list: Problem[]): Problem[] {
  const seen = new Set<string>();
  return list.filter((p) => {
    const k = `${p.file}|${p.line}|${p.col}|${p.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function countBySeverity(list: Problem[]) {
  return { errors: list.filter((p) => p.severity === 'error').length, warnings: list.filter((p) => p.severity === 'warning').length };
}

export function formatProblems(list: Problem[], max = 30): string {
  const sorted = [...list].sort((a, b) => Number(b.severity === 'error') - Number(a.severity === 'error') || a.file.localeCompare(b.file) || a.line - b.line);
  const lines = sorted.slice(0, max).map((p) => `${p.file}:${p.line}:${p.col} ${p.severity}${p.code ? ' ' + p.code : ''} [${p.source}] ${p.message}`);
  if (sorted.length > max) lines.push(`… and ${sorted.length - max} more`);
  return lines.join('\n');
}

/** The follow-up message that sends errors back to the agent. */
export function autoFixPrompt(errors: Problem[], round: number): string {
  return [
    `[Automatic check ${round + 1}] After your edits, the project checks report ${errors.length} error${errors.length === 1 ? '' : 's'} in files you changed:`,
    '',
    formatProblems(errors, 25),
    '',
    'Read the affected lines, fix the real cause (do not silence the checker), then stop. Only change what is needed.',
  ].join('\n');
}
