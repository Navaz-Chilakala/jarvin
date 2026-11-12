import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { persistentDesktopWorker } from '../src/main/desktop-worker';

function childFixture() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false, kill() { this.killed = true; return true; } });
  const requests: any[] = [];
  child.stdin.on('data', chunk => requests.push(JSON.parse(chunk.toString())));
  return { child: child as unknown as ChildProcessWithoutNullStreams, requests, reply(id: number, result: any) { child.stdout.write(JSON.stringify({ id, result }) + '\n'); } };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('one native worker serves serialized requests and preserves Unicode as data', async () => {
  const fixture = childFixture(); let starts = 0;
  const worker = persistentDesktopWorker(() => { starts++; return fixture.child; });
  try {
    const first = worker({ op: 'ping' }, new AbortController().signal);
    const second = worker({ op: 'text', text: 'hello\nनमस्ते $(data)' }, new AbortController().signal);
    await tick(); assert.equal(fixture.requests.length, 1);
    fixture.reply(1, { ready: true }); assert.deepEqual(await first, { ready: true });
    await tick(); assert.equal(fixture.requests[1].request.text, 'hello\nनमस्ते $(data)');
    fixture.reply(2, { sent: true }); await second;
    assert.equal(starts, 1);
  } finally { worker.dispose?.(); }
  assert.equal(fixture.child.killed, true);
  await assert.rejects(worker({ op: 'ping' }, new AbortController().signal), /ended/);
});

test('cancellation kills the active worker, does not retry input, and rejects cancelled queued work', async () => {
  const fixture = childFixture(); let starts = 0;
  const worker = persistentDesktopWorker(() => { starts++; return fixture.child; });
  const controller = new AbortController();
  const first = worker({ op: 'click' }, controller.signal);
  const second = worker({ op: 'type' }, controller.signal);
  const outcomes = Promise.allSettled([first, second]);
  await tick(); controller.abort();
  assert.deepEqual((await outcomes).map(x => x.status), ['rejected', 'rejected']);
  assert.equal(fixture.child.killed, true); assert.equal(fixture.requests.length, 1); assert.equal(starts, 1);
  worker.dispose?.();
});

test('protocol mismatch and stalled native input fail without replay', async () => {
  const fixture = childFixture();
  const worker = persistentDesktopWorker(() => fixture.child, 50);
  const first = worker({ op: 'click' }, new AbortController().signal);
  const rejected = assert.rejects(first, /did not match/);
  await tick(); fixture.reply(999, { sent: true }); await rejected;
  assert.equal(fixture.child.killed, true); worker.dispose?.();
  const stalled = childFixture(); const waiting = persistentDesktopWorker(() => stalled.child, 20);
  await assert.rejects(waiting({ op: 'click' }, new AbortController().signal), /timed out/);
  assert.equal(stalled.requests.length, 1); assert.equal(stalled.child.killed, true); waiting.dispose?.();
});
