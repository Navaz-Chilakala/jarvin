import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { runAgent, waitForApproval } from '../src/main/agent';
import type { Settings } from '../src/shared/types';

test('cancelling releases a pending approval and never approves a late response', async () => {
  const controller = new AbortController();
  let reply!: (value: boolean) => void;
  const approval = new Promise<boolean>((resolve) => { reply = resolve; });
  const result = waitForApproval(approval, controller.signal);
  controller.abort();
  assert.equal(await result, false);
  reply(true);
  assert.equal(await result, false);
});

test('normal approval results and errors propagate', async () => {
  const signal = new AbortController().signal;
  assert.equal(await waitForApproval(Promise.resolve(true), signal), true);
  await assert.rejects(waitForApproval(Promise.reject(new Error('failed')), signal), /failed/);
  const stopped = new AbortController();
  stopped.abort();
  assert.equal(await waitForApproval(Promise.resolve(true), stopped.signal), false);
});

test('desktop input waits for the assistant to move aside and obeys cancellation during that wait', async () => {
  let prepared = false; let executed = false;
  const controller = new AbortController();
  const server = http.createServer((_req, res) => res.end(JSON.stringify({ message: { tool_calls: [{ function: { name: 'keyboard_type', arguments: { text: 'hello' } } }] }, done: true }) + '\n'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runAgent({
      settings: { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, model: 'test', numCtx: 4096, maxSteps: 2 } as Settings,
      system: 'test', history: [{ role: 'user', content: 'Type hello' }],
      tools: [{ name: 'keyboard_type', description: 'test', parameters: {}, risk: 'exec', run: async () => { executed = true; assert.equal(prepared, true); return 'typed'; } }],
      ctx: { root: '.', signal: controller.signal, desktopActivity: async state => { if (state === 'off') return; await new Promise(resolve => setTimeout(resolve, 20)); prepared = true; controller.abort(); } },
      approve: async () => true, emit: () => {},
    });
    assert.equal(prepared, true); assert.equal(executed, false); assert.equal(result, 'stopped');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('stopping a real agent loop while approval is pending prevents execution and another model turn', async () => {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    res.setHeader('content-type', 'application/x-ndjson');
    res.end(JSON.stringify({ message: { tool_calls: [{ function: { name: 'action', arguments: {} } }] }, done: true }) + '\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const controller = new AbortController();
  let ran = false;
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await runAgent({
      settings: { baseUrl, model: 'test', numCtx: 4096, temperature: 0, maxSteps: 4 } as Settings,
      system: 'test', history: [{ role: 'user', content: 'test' }],
      tools: [{ name: 'action', description: 'test', parameters: {}, risk: 'exec', run: async () => { ran = true; return 'done'; } }],
      ctx: { root: '.', signal: controller.signal },
      emit: () => {},
      approve: async () => { setTimeout(() => controller.abort(), 10); return new Promise<boolean>(() => {}); },
    });
    assert.equal(ran, false);
    assert.equal(requests, 1);
  } finally { await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }); }
});

test('stopping during context summarization aborts the request and preserves history', async () => {
  let requests = 0;
  let seen!: () => void;
  const requestSeen = new Promise<void>((resolve) => { seen = resolve; });
  const server = http.createServer((req, _res) => {
    requests++;
    req.resume();
    req.on('end', seen);
    // Simulate an unresponsive model until the user cancels.
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const controller = new AbortController();
  const history = Array.from({ length: 12 }, (_, i) => ({ role: 'user' as const, content: `${i}:` + 'x'.repeat(1000) }));
  const original = history.map((m) => ({ ...m }));
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const run = runAgent({
      settings: { baseUrl, model: 'test', numCtx: 1024, temperature: 0, maxSteps: 4 } as Settings,
      system: 'test', history, tools: [], ctx: { root: '.', signal: controller.signal },
      emit: () => {}, approve: async () => true,
    });
    await requestSeen;
    controller.abort();
    await Promise.race([run, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Cancellation timed out')), 1500))]);
    assert.equal(requests, 1);
    assert.deepEqual(history, original);
  } finally { await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }); }
});
