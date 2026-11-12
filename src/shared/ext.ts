/** Pure helpers for project rules, custom modes and hooks (no file or process access, so they can be unit tested). */

export interface Front { meta: Record<string, string>; body: string }

/** Split optional `---` frontmatter (simple `key: value` lines) from the body. */
export function parseFront(text: string): Front {
  const t = String(text ?? '').replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = t.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: t.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const k = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (k) meta[k[1].toLowerCase()] = k[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: t.slice(m[0].length).trim() };
}

export const RULES_BUDGET = 12_000;

export interface RuleSource { label: string; text: string }

/** Join rule files into one prompt block, newest-last, within a size budget. Files marked `enabled: false` are skipped. */
export function combineRules(sources: RuleSource[], budget = RULES_BUDGET): { text: string; used: string[]; truncated: string[] } {
  const used: string[] = [];
  const truncated: string[] = [];
  let out = '';
  for (const s of sources) {
    const { meta, body } = parseFront(s.text);
    if (!body || /^(false|no|off)$/i.test(meta.enabled ?? '')) continue;
    const head = `\n\n### ${s.label}\n`;
    const room = budget - out.length - head.length;
    if (room < 200) { truncated.push(s.label); continue; }
    let b = body;
    if (b.length > room) { b = b.slice(0, room) + '\n…[truncated]'; truncated.push(s.label); }
    out += head + b;
    used.push(s.label);
  }
  return { text: out ? `\n\nProject rules (follow these):${out}` : '', used, truncated };
}

export interface Persona {
  name: string;
  description: string;
  /** 'all', 'read-only', or an explicit list of tool names. */
  tools: 'all' | 'read-only' | string[];
  model?: string;
  prompt: string;
  builtin?: boolean;
}

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

export function parsePersona(name: string, text: string): Persona | null {
  if (!NAME_RE.test(name)) return null;
  const { meta, body } = parseFront(text);
  if (!body) return null;
  const t = (meta.tools ?? 'all').trim();
  const tools: Persona['tools'] = /^all$/i.test(t) || !t ? 'all' : /^read[- ]?only$/i.test(t) ? 'read-only' : t.split(/[,\s]+/).filter(Boolean);
  return { name, description: meta.description ?? '', tools, model: meta.model || undefined, prompt: body.slice(0, 6000) };
}

export const BUILTIN_PERSONAS: Persona[] = [
  { name: 'reviewer', builtin: true, description: 'Read-only code review: finds bugs and risks, changes nothing', tools: 'read-only',
    prompt: 'You are in reviewer mode. You cannot change files or run commands. Read the relevant code and report findings as a list: file, line, severity (high/medium/low), the problem, and a concrete fix. Do not praise; be specific and brief.' },
  { name: 'debugger', builtin: true, description: 'Reproduce, find the root cause, then make the smallest fix', tools: 'all',
    prompt: 'You are in debugger mode. First reproduce the problem (run the failing command or test). Form a hypothesis, confirm it with evidence (logs, a small experiment), and only then make the smallest fix that addresses the root cause. Re-run the failing check to prove it is fixed. State the root cause in one or two sentences.' },
  { name: 'architect', builtin: true, description: 'Read-only design help: trade-offs and a step-by-step plan', tools: 'read-only',
    prompt: 'You are in architect mode. You cannot change files. Study the existing structure, then propose a design: options with trade-offs, a recommendation, the files that would change, and an ordered implementation plan. Keep the plan small enough to do in steps.' },
  { name: 'tester', builtin: true, description: 'Writes and runs tests; avoids changing production code', tools: 'all',
    prompt: 'You are in tester mode. Write focused tests for the behavior asked about, following the existing test style. Run them. Do not change production code unless a test reveals a real bug; in that case report it and ask before fixing.' },
];

/** Custom personas override built-ins with the same name. */
export function mergePersonas(custom: Persona[]): Persona[] {
  const by = new Map<string, Persona>(BUILTIN_PERSONAS.map((p) => [p.name, p]));
  for (const p of custom) by.set(p.name, p);
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function personaPrompt(p: Persona | undefined): string {
  return p ? `\n\nACTIVE MODE "${p.name}": ${p.prompt}` : '';
}

/** Which tools the persona may use. The caller still applies plan/offline filters. */
export function personaAllows(p: Persona | undefined, tool: { name: string; risk: string }): boolean {
  if (!p || p.tools === 'all') return true;
  if (p.tools === 'read-only') return tool.risk === 'read';
  return p.tools.includes(tool.name);
}

// ---------------- hooks ----------------

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'Stop';
export interface Hook { event: HookEvent; tool?: string; match?: string; command: string; timeout: number }

const EVENTS: HookEvent[] = ['PreToolUse', 'PostToolUse', 'Stop'];

/** Validate a hooks.json document. Bad entries are reported, not thrown. */
export function parseHooks(json: string): { hooks: Hook[]; errors: string[] } {
  const errors: string[] = [];
  let raw: any;
  try { raw = JSON.parse(json); } catch (e: any) { return { hooks: [], errors: [`hooks.json is not valid JSON: ${e?.message ?? e}`] }; }
  const list = Array.isArray(raw) ? raw : raw?.hooks;
  if (!Array.isArray(list)) return { hooks: [], errors: ['hooks.json needs a "hooks" array.'] };
  const hooks: Hook[] = [];
  list.slice(0, 30).forEach((h: any, i: number) => {
    const where = `hook #${i + 1}`;
    if (!h || typeof h !== 'object') return void errors.push(`${where}: not an object.`);
    if (!EVENTS.includes(h.event)) return void errors.push(`${where}: event must be one of ${EVENTS.join(', ')}.`);
    if (typeof h.command !== 'string' || !h.command.trim()) return void errors.push(`${where}: "command" is required.`);
    for (const k of ['tool', 'match'] as const) {
      if (h[k] === undefined) continue;
      try { new RegExp(h[k]); } catch { return void errors.push(`${where}: "${k}" is not a valid regular expression.`); }
    }
    const timeout = Math.min(Math.max(Number(h.timeout) || 30, 1), 120);
    hooks.push({ event: h.event, tool: h.tool, match: h.match, command: h.command, timeout });
  });
  return { hooks, errors };
}

/** What a tool call targets, for `match`: a path or a command line. */
export function hookTarget(args: any): string {
  if (!args || typeof args !== 'object') return '';
  return String(args.path ?? args.file ?? args.command ?? args.url ?? '');
}

export function hooksFor(hooks: Hook[], event: HookEvent, tool: string, args: any): Hook[] {
  const target = hookTarget(args);
  return hooks.filter((h) => {
    if (h.event !== event) return false;
    if (event !== 'Stop' && h.tool && !new RegExp(`^(?:${h.tool})$`).test(tool)) return false;
    if (event !== 'Stop' && h.match && !new RegExp(h.match).test(target)) return false;
    return true;
  });
}
