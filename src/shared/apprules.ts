/** Per-app dictation style: pick a tone/mode from the app that has focus. Pure, shared by main, renderer and tests. */
import type { VoiceMode, VoiceTone } from './voice';

export interface AppRule { match: string[]; tone?: VoiceTone; mode?: VoiceMode }
export interface ActiveApp { app: string; title: string }

const TONES = ['neutral', 'casual', 'formal', 'concise'];
const MODES = ['literal', 'clean', 'prompt', 'comment'];

/**
 * One rule per line: `slack, discord => casual`, `outlook, gmail => formal`, `code, cursor => comment`.
 * After `=>` give a tone, a mode, or both (`formal clean`). Names are matched inside the app name and the window title.
 */
export function parseAppRules(src: string): AppRule[] {
  const out: AppRule[] = [];
  for (const raw of String(src ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const l = raw.trim();
    if (!l || l.startsWith('#')) continue;
    const i = l.indexOf('=>');
    if (i < 0) continue;
    const match = l.slice(0, i).split(',').map((s) => s.trim().toLowerCase()).filter((s) => s.length >= 2);
    if (!match.length) continue;
    const rule: AppRule = { match };
    for (const w of l.slice(i + 2).toLowerCase().split(/[\s,]+/).filter(Boolean)) {
      if (TONES.includes(w)) rule.tone = w as VoiceTone;
      else if (MODES.includes(w)) rule.mode = w as VoiceMode;
    }
    if (rule.tone || rule.mode) out.push(rule);
    if (out.length >= 100) break;
  }
  return out;
}

/** First rule whose name appears in the app name or the window title. */
export function pickAppRule(rules: AppRule[], a: ActiveApp | null | undefined): AppRule | null {
  if (!a) return null;
  const hay = `${a.app}\n${a.title}`.toLowerCase();
  return rules.find((r) => r.match.some((m) => hay.includes(m))) ?? null;
}

/** PowerShell that prints `process name|window title` of the focused window. */
export const ACTIVE_APP_PS = `
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class JFG {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
}
"@
$h = [JFG]::GetForegroundWindow(); $p = 0
[void][JFG]::GetWindowThreadProcessId($h, [ref]$p)
$sb = New-Object System.Text.StringBuilder 300
[void][JFG]::GetWindowText($h, $sb, 300)
$n = (Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName
Write-Output ($n + '|' + $sb.ToString())
`;

export function parseActiveApp(stdout: string): ActiveApp | null {
  const line = String(stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
  if (!line) return null;
  const i = line.indexOf('|');
  const app = (i >= 0 ? line.slice(0, i) : line).trim();
  if (!app) return null;
  return { app, title: i >= 0 ? line.slice(i + 1).trim() : '' };
}

/** Short label for the UI, e.g. "casual for Slack". */
export function describeApply(rule: AppRule, a: ActiveApp): string {
  const what = [rule.tone, rule.mode].filter(Boolean).join(' ');
  return `${what} for ${a.app}`;
}
