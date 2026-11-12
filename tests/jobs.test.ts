import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendCapped, detectUrls, enqueue, fmtElapsed, jobLine, jobReport, lastLines, moveInQueue, nextInQueue, QUEUE_MAX, statusOf, type JobInfo } from '../src/shared/jobs';

const job = (o: Partial<JobInfo> = {}): JobInfo => ({ id: 'ab12', command: 'npm run dev', cwd: '/w', status: 'running', exitCode: null, startedAt: 1000, urls: [], tail: '', byAgent: true, ...o });

test('output buffer keeps the newest part', () => {
  let b = '';
  for (let i = 0; i < 50; i++) b = appendCapped(b, `line ${i} ` + 'x'.repeat(9990) + '\n');
  assert.ok(b.length <= 200_000);
  assert.ok(b.includes('line 49 '));
  assert.ok(!b.includes('line 0 '));
});

test('local addresses are found and tidied', () => {
  const out = '\x1b[32m  ➜  Local:   http://localhost:5173/\x1b[0m\n  ➜  Network: http://0.0.0.0:5173/\nserver at http://127.0.0.1:3000/api, ok.\nsee https://example.com:443/x';
  assert.deepEqual(detectUrls(out), ['http://localhost:5173/', 'http://localhost:3000/api']);
  assert.deepEqual(detectUrls('nothing here'), []);
  assert.equal(detectUrls('http://localhost:1 http://localhost:22 http://localhost:333 http://localhost:4444 http://localhost:5555', 2).length, 2);
});

test('status and timing text', () => {
  assert.equal(statusOf(0, false), 'done');
  assert.equal(statusOf(1, false), 'failed');
  assert.equal(statusOf(null, false, 'spawn ENOENT'), 'failed');
  assert.equal(statusOf(1, true), 'stopped');
  assert.equal(fmtElapsed(4200), '4s');
  assert.equal(fmtElapsed(125_000), '2m 05s');
  assert.equal(fmtElapsed(3_900_000), '1h 05m');
  assert.match(jobLine(job({ status: 'failed', exitCode: 2, endedAt: 6000 })), /failed after 5s \(exit 2\)/);
  assert.match(jobLine(job(), 61_000), /running 1m 00s/);
});

test('what the agent reads about a job', () => {
  const r = jobReport(job({ status: 'done', exitCode: 0, urls: ['http://localhost:5173/'] }), '\x1b[1mhello\x1b[0m\nworld\n', 1);
  assert.match(r, /finished \(exit 0\)/);
  assert.match(r, /Addresses seen: http:\/\/localhost:5173\//);
  assert.ok(r.endsWith('\n'), 'last line is the empty one after the final newline');
  assert.equal(lastLines('a\n\n b \r\nc\n', 2), ' b\nc');
});

test('queue adds, caps and orders', () => {
  let q: ReturnType<typeof enqueue>['queue'] = [];
  assert.equal(enqueue(q, '   ').added, false);
  for (const t of ['one', 'two', 'three']) q = enqueue(q, t).queue;
  assert.deepEqual(q.map((x) => x.text), ['one', 'two', 'three']);
  assert.equal(new Set(q.map((x) => x.id)).size, 3);
  q = moveInQueue(q, q[2].id, -1);
  assert.deepEqual(q.map((x) => x.text), ['one', 'three', 'two']);
  assert.equal(moveInQueue(q, q[0].id, -1), q);
  assert.equal(moveInQueue(q, 'nope', 1), q);
  let full = q;
  for (let i = 0; i < QUEUE_MAX; i++) full = enqueue(full, 'x' + i).queue;
  assert.equal(full.length, QUEUE_MAX);
  assert.equal(enqueue(full, 'more').added, false);
});

test('queue runs on after success and waits after a failure or stop', () => {
  const q = enqueue(enqueue([], 'a').queue, 'b').queue;
  const ok = nextInQueue(q, 'done');
  assert.equal(ok.item?.text, 'a');
  assert.deepEqual(ok.rest.map((x) => x.text), ['b']);
  for (const o of ['error', 'stopped', 'paused'] as const) {
    const r = nextInQueue(q, o);
    assert.equal(r.item, null);
    assert.equal(r.paused, true);
    assert.equal(r.rest.length, 2);
  }
  assert.deepEqual(nextInQueue([], 'done'), { item: null, rest: [], paused: false });
});
