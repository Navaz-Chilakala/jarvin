import fs from 'node:fs';
import path from 'node:path';
import type { Mode, PermissionRule } from '../shared/types';

export type Verdict = 'allow' | 'deny' | 'ask';
export interface FolderRules {
  allow: PermissionRule[];
  deny: PermissionRule[];
}

/** First words that may never be turned into a saved "always allow" rule. */
const NEVER_SAVE = new Set([
  'rm', 'del', 'erase', 'rmdir', 'rd', 'remove-item', 'ri', 'format', 'diskpart', 'sudo', 'su', 'runas', 'chmod', 'chown', 'reg',
  'regedit', 'shutdown', 'taskkill', 'kill', 'curl', 'wget', 'iwr', 'invoke-webrequest', 'iex', 'invoke-expression', 'powershell',
  'pwsh', 'cmd', 'bash', 'sh', 'zsh', 'wsl', 'eval', 'ssh', 'scp', 'nc', 'ncat', 'start', 'start-process',
]);
const INLINE_CODE_FLAGS = new Set(['-e', '-c', '--eval', '-command', '-encodedcommand', '-enc', '-ec', '/c', '/k']);
/** Tools whose second word is a sub-command, so the rule is "npm test", not "npm". */
const SUBCOMMAND_TOOLS = new Set(['npm', 'npx', 'yarn', 'pnpm', 'git', 'cargo', 'go', 'docker', 'kubectl', 'pip', 'pip3', 'dotnet', 'make', 'gradle', 'mvn', 'poetry', 'uv', 'bun']);

interface Parsed {
  segments: string[][];
}

/**
 * Split a shell command into simple commands (on && || ; | & and newlines) and tokens.
 * Returns null when the command uses anything that could hide another command:
 * redirects, command substitution, backticks, variable braces, or unbalanced quotes.
 */
export function parseCommand(cmd: string): Parsed | null {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let cur = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  const endToken = () => {
    if (has) tokens.push(cur);
    cur = '';
    has = false;
  };
  const endSegment = () => {
    endToken();
    if (tokens.length) segments.push(tokens);
    tokens = [];
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
      continue;
    }
    if (c === '`' || (c === '$' && (cmd[i + 1] === '(' || cmd[i + 1] === '{'))) return null;
    if (quote === '"') {
      if (c === '"') quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
      continue;
    }
    if (c === '>' || c === '<' || c === '(' || c === ')') return null;
    if (c === '\n' || c === ';' || c === '|' || c === '&') {
      endSegment();
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endToken();
      continue;
    }
    cur += c;
    has = true;
  }
  if (quote) return null;
  endSegment();
  return segments.length ? { segments } : null;
}

const norm = (t: string) => t.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');

/** The rule prefix for one simple command, e.g. ["npm","test"], or null if it must not be saved. */
export function prefixFor(tokens: string[]): string[] | null {
  if (!tokens.length) return null;
  const first = norm(tokens[0]);
  if (/[\\/]/.test(first) || NEVER_SAVE.has(first)) return null;
  if (tokens.some((t) => INLINE_CODE_FLAGS.has(t.toLowerCase()))) return null;
  if (SUBCOMMAND_TOOLS.has(first)) return tokens[1] && !tokens[1].startsWith('-') ? [first, tokens[1].toLowerCase()] : null;
  return [first];
}

function segmentMatches(prefix: string[], tokens: string[]): boolean {
  if (tokens.length < prefix.length) return false;
  return prefix.every((p, i) => (i === 0 ? norm(tokens[0]) : tokens[i].toLowerCase()) === p);
}

function commandVerdict(rules: PermissionRule[], command: string): 'all' | 'some' | 'none' {
  const parsed = parseCommand(command);
  if (!parsed) return 'none';
  const hit = parsed.segments.map((seg) =>
    rules.some((r) => r.tool === 'run_command' && r.match && segmentMatches(r.match.toLowerCase().split(/\s+/), seg)),
  );
  return hit.every(Boolean) ? 'all' : hit.some(Boolean) ? 'some' : 'none';
}

/** Workspace-relative, forward-slash form of a path argument, or null when it points outside the workspace. */
export function relPath(p: unknown, root?: string): string | null {
  if (typeof p !== 'string' || !p || p.includes('\0')) return null;
  let s = p.replace(/\\/g, '/');
  if (root) {
    const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
    if (s.toLowerCase().startsWith(r.toLowerCase() + '/')) s = s.slice(r.length + 1);
  }
  if (/^([a-zA-Z]:)?\//.test(s)) return null;
  s = path.posix.normalize(s).replace(/^\.\//, '');
  return s === '..' || s.startsWith('../') ? null : s;
}

/** Glob with `**` (any folders), `*` (inside one folder) and `?`. */
export function globMatch(glob: string, rel: string, ci = true): boolean {
  let re = '';
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, ci ? 'i' : '').test(rel);
}

const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

function toolRuleHit(r: PermissionRule, tool: string, args: any, root: string | undefined, deny: boolean): boolean {
  if (r.tool !== tool) return false;
  if (!r.path) return true;
  const rel = relPath(args?.path, root);
  return rel !== null && globMatch(r.path, rel, deny || CASE_INSENSITIVE_FS);
}

function ruleHits(rules: PermissionRule[], tool: string, args: any, root?: string): boolean {
  if (tool === 'run_command') return typeof args?.command === 'string' && commandVerdict(rules, args.command) === 'all';
  return rules.some((r) => toolRuleHit(r, tool, args, root, false));
}

function denyHits(rules: PermissionRule[], tool: string, args: any, root?: string): boolean {
  if (tool === 'run_command') return typeof args?.command === 'string' && commandVerdict(rules, args.command) !== 'none';
  return rules.some((r) => toolRuleHit(r, tool, args, root, true));
}

export interface DecideInput {
  tool: string;
  risk: 'read' | 'write' | 'exec';
  args: any;
  mode: Mode;
  rules: FolderRules;
  sensitive: boolean;
  /** Workspace folder, so absolute path arguments can be matched against path rules. */
  root?: string;
}

/** These operations always need fresh user consent, even in automatic mode. */
export function requiresFreshApproval(tool: string, args: any): boolean {
  return ['screen_capture', 'screenshot', 'delete_file', 'apply_verified_change'].includes(tool)
    || (tool === 'apply_patch' && typeof args?.patch === 'string' && /^\*\*\* (?:Delete File|Move to):/m.test(args.patch));
}

/** Narrow browser operations are routine in the desktop assistant's auto-edit mode. */
function routineDesktopAction(tool: string, args: any): boolean {
  if (['desktop_list_windows', 'focus_window', 'window_manage', 'desktop_scroll', 'desktop_inspect_window', 'desktop_control', 'click_controls', 'see_window', 'inspect_screen', 'list_displays', 'traverse_ui', 'visual_click', 'visual_type', 'locate_screen_target', 'click_visual_target', 'mouse_move', 'mouse_click', 'keyboard_type', 'keyboard_press', 'save_document'].includes(tool)) return true;
  if (tool === 'chrome_search') return typeof args?.query === 'string' && !!args.query.trim() && args.query.trim().length <= 500 && !args.query.includes('\0');
  if (tool === 'open_website') {
    if (typeof args?.url !== 'string') return false;
    try {
      const url = new URL(args.url);
      return ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password;
    } catch { return false; }
  }
  if (tool !== 'launch_app' || typeof args?.app !== 'string') return false;
  if (args.args !== undefined && (!Array.isArray(args.args) || args.args.length !== 0)) return false;
  return new Set(['chrome', 'google chrome', 'google-chrome', 'chrome.exe', 'edge', 'microsoft edge', 'msedge.exe', 'firefox', 'firefox.exe']).has(args.app.trim().toLowerCase());
}

/** deny rules win, then sensitive paths always ask, then saved allow rules, then the approval mode. */
export function decide(i: DecideInput): Verdict {
  if (denyHits(i.rules.deny, i.tool, i.args, i.root)) return 'deny';
  if (i.sensitive || requiresFreshApproval(i.tool, i.args)) return 'ask';
  if (i.risk === 'read') return 'allow';
  if (ruleHits(i.rules.allow, i.tool, i.args, i.root)) return 'allow';
  if (i.mode === 'plan') return 'deny';
  if (i.mode === 'auto') return 'allow';
  if (i.mode === 'auto-edit' && routineDesktopAction(i.tool, i.args)) return 'allow';
  if (i.risk === 'write' && i.mode === 'auto-edit') return 'allow';
  return 'ask';
}

/** The rules that "Always allow" would save for this call, or null when it must stay one-time. */
export function rulesFor(tool: string, risk: 'read' | 'write' | 'exec', args: any): PermissionRule[] | null {
  if (requiresFreshApproval(tool, args)) return null;
  if (tool === 'run_command') {
    const parsed = typeof args?.command === 'string' ? parseCommand(args.command) : null;
    if (!parsed) return null;
    const out: PermissionRule[] = [];
    for (const seg of parsed.segments) {
      const p = prefixFor(seg);
      if (!p) return null;
      const match = p.join(' ');
      if (!out.some((r) => r.match === match)) out.push({ tool, match });
    }
    return out;
  }
  return risk === 'read' ? null : [{ tool }];
}

export function describeRule(r: PermissionRule): string {
  return r.match ? `${r.tool}: ${r.match}` : r.path ? `${r.tool}: ${r.path}` : r.tool;
}

export type RuleCheck = { rule: PermissionRule } | { error: string };

/**
 * Check a rule typed by the user. Allow rules for commands go through the same safety filter as "Always allow" prompts,
 * so a rule can never allow rm, curl, shells and the like. Block rules accept any command prefix.
 */
export function validateRule(kind: 'allow' | 'deny', input: PermissionRule, knownTools: string[] = []): RuleCheck {
  const tool = String(input?.tool ?? '').trim();
  if (!tool) return { error: 'Choose a tool.' };
  if (knownTools.length && !knownTools.includes(tool)) return { error: `Unknown tool "${tool}".` };
  const text = String((tool === 'run_command' ? input?.match : input?.path) ?? '').trim();
  if (tool === 'run_command') {
    if (!text) return { error: kind === 'allow' ? 'Allowing every command is not possible. Enter a command prefix such as "npm test".' : 'Enter the command prefix to block, such as "git push".' };
    const parsed = parseCommand(text);
    if (!parsed || parsed.segments.length !== 1) return { error: 'Enter one simple command prefix, with no pipes, redirects or substitutions.' };
    const toks = parsed.segments[0];
    if (kind === 'deny') return { rule: { tool, match: toks.map((t) => t.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '')).join(' ') } };
    const p = prefixFor(toks);
    if (!p) return { error: `"${text}" cannot be always-allowed (too broad or risky). Try a specific tool command like "npm test".` };
    return { rule: { tool, match: p.join(' ') } };
  }
  if (!text) return { rule: { tool } };
  if (/\0/.test(text) || /^([a-zA-Z]:)?[\\/]/.test(text) || text.split(/[\\/]/).includes('..')) return { error: 'Use a path relative to the folder, such as "src/**". No absolute paths or "..".' };
  return { rule: { tool, path: text.replace(/\\/g, '/').replace(/^\.\//, '') } };
}

/** Block rules a project ships in .jarvin/permissions.json. Only block rules are read: a repo can restrict Jarvin, never loosen it. */
export function workspaceDeny(ws: string): PermissionRule[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ws, '.jarvin', 'permissions.json'), 'utf8'));
    const list: PermissionRule[] = Array.isArray(raw?.deny) ? raw.deny : [];
    const out: PermissionRule[] = [];
    for (const r of list.slice(0, 100)) {
      const v = validateRule('deny', { tool: r?.tool, match: r?.match, path: r?.path });
      if ('rule' in v) out.push(v.rule);
    }
    return out;
  } catch {
    return [];
  }
}

export class PermissionStore {
  private data: Record<string, FolderRules> = {};
  constructor(private file: string) {
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      /* first run */
    }
  }
  private key(ws: string) {
    const k = path.resolve(ws);
    return process.platform === 'win32' ? k.toLowerCase() : k;
  }
  get(ws: string): FolderRules {
    const r = this.data[this.key(ws)];
    return { allow: r?.allow ?? [], deny: r?.deny ?? [] };
  }
  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
  addAllow(ws: string, rules: PermissionRule[]) {
    const cur = this.get(ws);
    for (const r of rules) if (!cur.allow.some((x) => x.tool === r.tool && x.match === r.match)) cur.allow.push(r);
    this.data[this.key(ws)] = cur;
    this.save();
  }
  removeAllow(ws: string, index: number) {
    this.removeRule(ws, 'allow', index);
  }
  addRule(ws: string, kind: 'allow' | 'deny', rule: PermissionRule) {
    const cur = this.get(ws);
    const list = cur[kind];
    if (!list.some((x) => x.tool === rule.tool && x.match === rule.match && x.path === rule.path)) list.push(rule);
    this.data[this.key(ws)] = cur;
    this.save();
  }
  removeRule(ws: string, kind: 'allow' | 'deny', index: number) {
    const cur = this.get(ws);
    cur[kind].splice(index, 1);
    this.data[this.key(ws)] = cur;
    this.save();
  }
}
