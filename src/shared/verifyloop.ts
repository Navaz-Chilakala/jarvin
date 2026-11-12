/**
 * The retry loop behind "verified change": let the agent edit an isolated copy, run the tests itself, show the agent the
 * failures and try again until they pass. Pure, so the logic can be tested without a model or a project.
 */
export interface TestRun {
  command: string;
  code: number | null;
  timedOut: boolean;
  aborted: boolean;
  passed?: number;
  failed?: number;
  failures: string[];
  tail: string;
  ms: number;
}

export interface Attempt {
  n: number;
  /** What the agent said it did. */
  summary: string;
  tests: TestRun | null;
  green: boolean;
}

export type LoopState = 'green' | 'red' | 'unverified' | 'stopped';

export interface LoopResult {
  state: LoopState;
  attempts: Attempt[];
  /** The checks were already failing before the change. */
  baselineRed: boolean;
  /** Still failing, but nothing that did not already fail before the change. Only meaningful when baselineRed. */
  noWorse: boolean;
}

/** Green means the checks exit with code 0. Nothing less counts as verified. */
export function isGreen(run: TestRun): boolean {
  return !run.timedOut && !run.aborted && run.code === 0;
}

/** Not green, but also nothing failing that was not already failing before the change. */
export function isNoWorse(run: TestRun, baseline: TestRun | null): boolean {
  if (run.timedOut || run.aborted || run.code === 0) return false;
  if (!baseline || baseline.code === 0 || baseline.timedOut || baseline.aborted) return false;
  if (!run.failures.length) return false;
  const was = new Set(baseline.failures);
  if (run.failures.some((f) => !was.has(f))) return false;
  if (typeof run.failed === 'number' && typeof baseline.failed === 'number' && run.failed > baseline.failed) return false;
  return true;
}

export function testLine(r: TestRun): string {
  const counts = typeof r.passed === 'number' || typeof r.failed === 'number' ? `${r.passed ?? 0} passed, ${r.failed ?? 0} failed` : r.code === 0 ? 'passed' : `exit ${r.code}`;
  return r.timedOut ? 'timed out' : r.aborted ? 'stopped' : counts;
}

export function firstPrompt(task: string, command: string | null, baseline: TestRun | null): string {
  const lines = [
    task.trim(),
    '',
    'You are working in an isolated copy of the project, so edits here do not touch the real files yet.',
    '1. Find the relevant code first (search and read files). Do not guess at file names or APIs.',
    '2. Make the smallest change that does the job.',
    command ? `3. The change is checked by running: ${command}. You can run it yourself too.` : '3. No test command was found, so check your work with the available type and lint checks.',
    '4. Never make tests pass by deleting or weakening them. If a test is wrong for the new behaviour, say so and change it deliberately.',
    '5. When done, reply with a short summary of what you changed and why.',
  ];
  if (baseline && baseline.code !== 0) lines.push('', `Note: before your change the checks already failed (${testLine(baseline)}). Fix the failures your task is about. If some failures are unrelated and were already there, you may leave them, but say so in your summary.`);
  return lines.join('\n');
}

export function retryPrompt(n: number, max: number, run: TestRun, baseline: TestRun | null, limit = 6000): string {
  const failing = run.failures.length ? `Failing places:\n${run.failures.slice(0, 20).map((f) => `- ${f}`).join('\n')}\n\n` : '';
  const why = run.timedOut ? 'The checks timed out. Look for an endless loop or a hang.' : 'The checks failed after your change.';
  return [
    `${why} This was attempt ${n} of ${max}. (${testLine(run)})`,
    '',
    failing + `Output (end):\n${run.tail.slice(-limit)}`,
    '',
    'Read the failing code, find the cause, and fix it in the project files. Do not weaken tests to make them pass. Then reply with a short summary of this fix.',
    baseline && baseline.code !== 0 ? 'Some failures were already there before your change; leave unrelated ones alone and say so.' : '',
  ]
    .filter((l, i, a) => l !== '' || a[i - 1] !== '')
    .join('\n');
}

export interface LoopOpts {
  task: string;
  maxAttempts: number;
  command: string | null;
  baseline: TestRun | null;
  /** Runs the agent in the isolated copy with this prompt; resolves with its summary. */
  edit(prompt: string, n: number): Promise<string>;
  /** Runs the checks; null when the project has nothing to check with. */
  test(): Promise<TestRun | null>;
  stopped(): boolean;
  onAttempt?(a: Attempt): void;
}

export async function runLoop(o: LoopOpts): Promise<LoopResult> {
  const attempts: Attempt[] = [];
  const max = Math.min(6, Math.max(1, Math.round(o.maxAttempts) || 3));
  let prompt = firstPrompt(o.task, o.command, o.baseline);
  const red = !!o.baseline && o.baseline.code !== 0;
  let prevFailures = '';
  for (let n = 1; n <= max; n++) {
    if (o.stopped()) return { state: 'stopped', attempts, baselineRed: red, noWorse: false };
    const summary = await o.edit(prompt, n);
    if (o.stopped()) return { state: 'stopped', attempts, baselineRed: red, noWorse: false };
    const tests = await o.test();
    if (!tests) {
      const a = { n, summary, tests: null, green: false };
      attempts.push(a);
      o.onAttempt?.(a);
      return { state: 'unverified', attempts, baselineRed: false, noWorse: false };
    }
    const green = isGreen(tests);
    const a = { n, summary, tests, green };
    attempts.push(a);
    o.onAttempt?.(a);
    if (green) return { state: 'green', attempts, baselineRed: red, noWorse: false };
    if (tests.aborted) return { state: 'stopped', attempts, baselineRed: false, noWorse: false };
    // Already failing before we started and no progress between two tries: more rounds will not help.
    const key = tests.failures.join('|');
    if (red && n >= 2 && key === prevFailures && isNoWorse(tests, o.baseline)) return { state: 'red', attempts, baselineRed: true, noWorse: true };
    prevFailures = key;
    prompt = retryPrompt(n, max, tests, o.baseline);
  }
  const last = attempts[attempts.length - 1]?.tests;
  return { state: 'red', attempts, baselineRed: red, noWorse: !!last && isNoWorse(last, o.baseline) };
}
