import { runShell, type ShellChoice } from './terminal';
import { detectVerificationCommand, parseVerificationFailures, parseVerificationStats } from './verify';
import { runProblemChecks } from './problems';
import { formatProblems } from '../shared/problems';
import { createSandbox, discardSandbox, changesOf, applyChanges, sandboxText, originalText, type Sandbox, type Change, type ApplyResult } from './verified';
import { runLoop, testLine, type Attempt, type LoopResult, type TestRun } from '../shared/verifyloop';
import { unifiedDiff } from '../shared/udiff';
import type { OMsg } from './openai';

/** Everything the loop needs from the app. Kept as plain functions so the loop does not know about windows or models. */
export interface VerifiedDeps {
  root: string;
  signal: AbortSignal;
  shell?: ShellChoice;
  /** Runs the coding agent with this history inside the private copy; `onTool` reports each tool call for live progress. */
  runEditAgent(sb: Sandbox, history: OMsg[], onTool: (name: string, args: any) => void): Promise<void>;
  emit(card: VerifiedCard): void;
}

export interface VerifiedCard {
  type: 'verified';
  id: string;
  task: string;
  state: 'preparing' | 'baseline' | 'editing' | 'testing' | 'done';
  attempt?: number;
  max: number;
  command: string | null;
  activity?: string;
  attempts: { n: number; summary: string; line: string; green: boolean }[];
  result?: LoopResult['state'];
  baselineRed?: boolean;
  noWorse?: boolean;
  files: Change[];
  warnings: string[];
  applied?: { applied: number; conflicts: { path: string; reason: string }[] };
  skipped?: number;
}

interface Rec { id: string; task: string; sb: Sandbox; card: VerifiedCard }
const store = new Map<string, Rec>();
const TEST_TIMEOUT = 300_000;
const isTestFile = (p: string) => /(^|\/)(tests?|__tests__|spec)\//i.test(p) || /\.(test|spec)\.[a-z]+$/i.test(p) || /(^|\/)test_[^/]+\.py$|_test\.(py|go)$/i.test(p);

async function runTests(d: VerifiedDeps, sb: Sandbox, command: string | null): Promise<TestRun | null> {
  const t0 = Date.now();
  if (command) {
    const r = await runShell({ command, cwd: sb.dir, timeoutMs: TEST_TIMEOUT, signal: d.signal, shell: d.shell });
    const stats = parseVerificationStats(r.output);
    if (process.env.JARVIN_E2E) console.log(`[e2e] tests in ${sb.dir}: code=${r.code} ${String(r.output).slice(-700)}`);
    return {
      command, code: r.code, timedOut: !!r.timedOut, aborted: !!r.aborted,
      passed: stats.passed, failed: stats.failed,
      failures: parseVerificationFailures(r.output, 40).map((f) => f.location),
      tail: String(r.output ?? '').slice(-8000), ms: Date.now() - t0,
    };
  }
  // No test command: fall back to the project's type and lint checks.
  const res = await runProblemChecks(sb.dir, { signal: d.signal, shell: d.shell });
  if (!res.checks.length) return null;
  const errors = res.problems.filter((p) => p.severity === 'error');
  return {
    command: res.checks.map((c) => c.name).join(' + '),
    code: d.signal.aborted ? null : errors.length ? 1 : 0, timedOut: false, aborted: d.signal.aborted,
    failed: errors.length, failures: errors.slice(0, 40).map((p) => `${p.file}:${p.line}`),
    tail: errors.length ? formatProblems(errors, 40) : 'No errors.', ms: Date.now() - t0,
  };
}

export async function verifiedChange(d: VerifiedDeps, a: { task?: string; test_command?: string; max_attempts?: number }): Promise<string> {
  const task = String(a?.task ?? '').trim();
  if (!task) throw new Error('A task description is required.');
  const max = Math.min(6, Math.max(1, Math.round(Number(a?.max_attempts)) || 3));
  const explicit = String(a?.test_command ?? '').trim();
  const command = explicit || detectVerificationCommand(d.root)?.command || null;
  const card: VerifiedCard = { type: 'verified', id: '', task, state: 'preparing', max, command, attempts: [], files: [], warnings: [] };
  const push = () => d.emit({ ...card, attempts: [...card.attempts], files: [...card.files], warnings: [...card.warnings] });

  const sb = await createSandbox(d.root);
  card.id = sb.id;
  if (sb.skipped) card.warnings.push(`${sb.skipped} file${sb.skipped === 1 ? ' was' : 's were'} over 5 MB and left out of the copy.`);
  push();
  try {
    card.state = 'baseline';
    push();
    const baseline = await runTests(d, sb, command);
    if (d.signal.aborted) throw new Error('Stopped.');
    const hist: OMsg[] = [];
    const result = await runLoop({
      task, maxAttempts: max, command: baseline?.command ?? command, baseline,
      stopped: () => d.signal.aborted,
      edit: async (prompt, n) => {
        card.state = 'editing';
        card.attempt = n;
        card.activity = 'Reading the code…';
        push();
        hist.push({ role: 'user', content: prompt });
        await d.runEditAgent(sb, hist, (name, args) => {
          card.activity = `${name}${args?.path ? ' ' + String(args.path).slice(0, 60) : args?.command ? ' ' + String(args.command).slice(0, 60) : args?.query ? ' ' + String(args.query).slice(0, 60) : ''}`;
          push();
        });
        const last = [...hist].reverse().find((m: any) => m.role === 'assistant' && m.content);
        card.state = 'testing';
        card.activity = baseline ? `Running ${baseline.command}…` : 'Checking…';
        push();
        return String(last?.content ?? '(no summary)').slice(0, 4000);
      },
      test: () => runTests(d, sb, command),
      onAttempt: (at: Attempt) => {
        card.attempts.push({ n: at.n, summary: at.summary.slice(0, 600), line: at.tests ? testLine(at.tests) : 'nothing to check with', green: at.green });
        push();
      },
    });
    const files = await changesOf(sb);
    const edited = files.filter((f) => f.status !== 'added' && isTestFile(f.path));
    if (edited.length) card.warnings.push(`Test files were changed (${edited.map((f) => f.path).slice(0, 4).join(', ')}). Check that tests were not weakened to pass.`);
    if (result.state === 'unverified') card.warnings.push('There was no test command or type/lint check to run, so this change is not verified.');
    if (result.baselineRed && result.state === 'green') card.warnings.push('The tests were already failing before the change; now they pass.');
    if (result.baselineRed && result.state === 'red') card.warnings.push(result.noWorse ? 'The tests were already failing before the change, and nothing new fails now. Check whether the remaining failures are unrelated.' : 'The tests were already failing before the change, and the change did not fix them.');
    card.state = 'done';
    card.result = result.state;
    card.baselineRed = result.baselineRed;
    card.noWorse = result.noWorse;
    card.files = files;
    card.activity = undefined;
    card.skipped = sb.skipped;
    store.set(sb.id, { id: sb.id, task, sb, card });
    push();
    return report(card, result, sb);
  } catch (e) {
    discardSandbox(sb);
    card.state = 'done';
    card.result = 'stopped';
    card.activity = undefined;
    push();
    throw e;
  }
}

function report(c: VerifiedCard, r: LoopResult, sb: Sandbox): string {
  const head =
    r.state === 'green' ? `Verified: ${c.command} passed on attempt ${r.attempts.length} of ${c.max}.`
    : r.state === 'red' ? `NOT verified: ${c.command} still fails after ${r.attempts.length} attempts.`
    : r.state === 'unverified' ? 'Changed, but could not be verified (nothing to run).'
    : 'Stopped before finishing.';
  const last = r.attempts[r.attempts.length - 1];
  const files = c.files.length ? c.files.map((f) => `  ${f.status === 'added' ? '+' : f.status === 'deleted' ? '-' : '~'} ${f.path}`).join('\n') : '  (no files changed)';
  const fails = r.state === 'red' && last?.tests ? `\nLast failures:\n${last.tests.failures.slice(0, 10).map((f) => `  - ${f}`).join('\n') || last.tests.tail.slice(-1200)}` : '';
  return [
    `Verified change id: ${sb.id}`,
    head,
    '',
    `Attempts:\n${c.attempts.map((a) => `  ${a.n}. ${a.line}${a.green ? ' ✓' : ''} - ${a.summary.split('\n')[0].slice(0, 160)}`).join('\n')}`,
    '',
    `Files changed in the private copy (not applied yet):\n${files}`,
    c.warnings.length ? `\nWarnings:\n${c.warnings.map((w) => '  - ' + w).join('\n')}` : '',
    fails,
    '',
    r.state === 'green' || r.state === 'unverified'
      ? 'Nothing has been changed in the real project. Tell the user what you found, then call apply_verified_change with this id if they want it applied (or they can use the Apply button on the card).'
      : 'Do not apply this. Explain what is still failing; the user can still apply it from the card or ask you to try again.',
  ].filter((x) => x !== '').join('\n');
}

export const verifiedList = () => [...store.values()].map((r) => r.card);

export async function verifiedDiff(id: string, file?: string): Promise<string> {
  const rec = store.get(id);
  if (!rec) throw new Error('This change is no longer available.');
  const files = file ? rec.card.files.filter((f) => f.path === file) : rec.card.files;
  const parts: string[] = [];
  for (const f of files.slice(0, 60)) {
    const before = f.status === 'added' ? null : await originalText(rec.sb, f.path) ?? '';
    const after = f.status === 'deleted' ? null : await sandboxText(rec.sb, f.path);
    parts.push(unifiedDiff(before, after, f.path) || `(binary or unchanged: ${f.path})\n`);
  }
  return parts.join('\n').slice(0, 300_000);
}

/** Copy the verified change into the real project. `beforeWrite` lets the caller record each file for Undo. */
export async function applyVerified(id: string, beforeWrite?: (abs: string) => void, only?: string[]): Promise<ApplyResult & { id: string; card: VerifiedCard }> {
  const rec = store.get(id);
  if (!rec) throw new Error('This change is no longer available (the app was restarted or it was already applied).');
  const r = await applyChanges(rec.sb, beforeWrite, only);
  rec.card = { ...rec.card, applied: { applied: (rec.card.applied?.applied ?? 0) + r.applied.length, conflicts: r.conflicts } };
  rec.card.files = rec.card.files.filter((f) => !r.applied.some((a) => a.path === f.path));
  if (!rec.card.files.length && !r.conflicts.length) { discardSandbox(rec.sb); store.delete(id); }
  return { ...r, id, card: rec.card };
}

export function discardVerified(id: string): boolean {
  const rec = store.get(id);
  if (!rec) return false;
  discardSandbox(rec.sb);
  store.delete(id);
  return true;
}

export function discardAllVerified() {
  for (const r of store.values()) discardSandbox(r.sb);
  store.clear();
}

export function currentCard(id: string): VerifiedCard | null {
  return store.get(id)?.card ?? null;
}
