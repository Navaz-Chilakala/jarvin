import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isGreen, isNoWorse, runLoop, retryPrompt, type TestRun } from '../src/shared/verifyloop';
import { unifiedDiff } from '../src/shared/udiff';

const run = (o: Partial<TestRun> = {}): TestRun => ({ command: 'npm test', code: 0, timedOut: false, aborted: false, failures: [], tail: '', ms: 5, ...o });
const red = (f: string[] = ['a.test.ts:3'], extra: Partial<TestRun> = {}) => run({ code: 1, failures: f, failed: f.length, tail: 'boom', ...extra });

test('green means exit 0, nothing less', () => {
  assert.equal(isGreen(run()), true);
  assert.equal(isGreen(red()), false);
  assert.equal(isGreen(run({ timedOut: true })), false);
});

test('"no worse" compares with failures that were there before', () => {
  const base = red(['x:1', 'y:2'], { failed: 2 });
  assert.equal(isNoWorse(red(['x:1']), base), true);
  assert.equal(isNoWorse(red(['x:1', 'z:9']), base), false);
  assert.equal(isNoWorse(red([], { failed: 0 }), base), false, 'a non-zero exit with nothing named is not trusted');
  assert.equal(isNoWorse(run(), base), false);
  assert.equal(isNoWorse(red(['x:1']), null), false);
});

const loop = async (results: (TestRun | null)[], max = 3, stopAt = -1) => {
  const prompts: string[] = [];
  let t = 0;
  let calls = 0;
  const r = await runLoop({
    task: 'fix it', maxAttempts: max, command: 'npm test', baseline: null,
    edit: async (p, n) => { prompts.push(p); return `try ${n}`; },
    test: async () => results[t++] ?? results[results.length - 1],
    stopped: () => ++calls === stopAt,
  });
  return { r, prompts };
};

test('stops on the first green attempt', async () => {
  const { r, prompts } = await loop([run()]);
  assert.equal(r.state, 'green');
  assert.equal(r.attempts.length, 1);
  assert.equal(prompts.length, 1);
});

test('feeds failures back and succeeds on a later attempt', async () => {
  const { r, prompts } = await loop([red(['a.test.ts:3']), run()]);
  assert.equal(r.state, 'green');
  assert.equal(r.attempts.length, 2);
  assert.match(prompts[1], /attempt 1 of 3/);
  assert.match(prompts[1], /a\.test\.ts:3/);
  assert.match(prompts[1], /boom/);
});

test('gives up after the attempt limit and reports red', async () => {
  const { r, prompts } = await loop([red()], 3);
  assert.equal(r.state, 'red');
  assert.equal(prompts.length, 3);
});

test('a failing baseline does not make a still-failing run "verified"', async () => {
  const base = red(['a:1']);
  let t = 0;
  const r = await runLoop({ task: 'x', maxAttempts: 4, command: 'npm test', baseline: base, edit: async () => 'tried', test: async () => [red(['a:1']), red(['a:1']), run()][t++] ?? run(), stopped: () => false });
  assert.equal(r.attempts[0].green, false);
  assert.equal(r.state, 'red', 'two tries with no progress stop early');
  assert.equal(r.noWorse, true);
  assert.equal(r.baselineRed, true);
  assert.equal(r.attempts.length, 2);
});

test('baseline red and then fixed is green', async () => {
  let t = 0;
  const r = await runLoop({ task: 'x', maxAttempts: 4, command: 'npm test', baseline: red(['a:1', 'b:2']), edit: async () => 'tried', test: async () => [red(['a:1']), run()][t++] ?? run(), stopped: () => false });
  assert.equal(r.state, 'green');
  assert.equal(r.attempts.length, 2);
});

test('no way to check means unverified after one try', async () => {
  const { r } = await loop([null]);
  assert.equal(r.state, 'unverified');
  assert.equal(r.attempts.length, 1);
});

test('stop request ends the loop', async () => {
  const { r } = await loop([red()], 3, 3);
  assert.equal(r.state, 'stopped');
});

test('retry prompt tells the agent not to weaken tests and trims long output', () => {
  const p = retryPrompt(1, 3, red(['q:1'], { tail: 'x'.repeat(20000) }), null, 500);
  assert.match(p, /weaken tests/);
  assert.ok(p.length < 1500);
});

test('unified diff shows only changed lines with context', () => {
  const a = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
  const b = a.replace('line 10', 'LINE TEN');
  const d = unifiedDiff(a, b, 'f.txt');
  assert.match(d, /^--- a\/f\.txt\n\+\+\+ b\/f\.txt\n@@ -8,7 \+8,7 @@/);
  assert.match(d, /-line 10\n\+LINE TEN/);
  assert.ok(!d.includes('line 0'));
  assert.equal(unifiedDiff('same', 'same', 'f'), '');
});

test('unified diff for new and deleted files', () => {
  assert.match(unifiedDiff(null, 'a\nb', 'n.txt'), /--- \/dev\/null\n\+\+\+ b\/n\.txt\n@@ -0,0 \+1,2 @@\n\+a\n\+b/);
  assert.match(unifiedDiff('a', null, 'n.txt'), /\+\+\+ \/dev\/null\n@@ -1,1 \+0,0 @@\n-a/);
});
