import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { runAgent } from '../src/main/agent';
import type { Settings } from '../src/shared/types';

test('agent distinguishes a completed response from a step limit and cancellation', async () => {
  let useTool = false;
  const server = http.createServer((_req, res) => {
    const message = useTool ? { tool_calls: [{ function: { name: 'read', arguments: {} } }] } : { content: 'Done.' };
    res.end(JSON.stringify({ message, done: true }) + '\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const opts = (signal: AbortSignal) => ({
    settings: { baseUrl, model: 'test', numCtx: 4096, temperature: 0, maxSteps: 1 } as Settings,
    system: '', history: [{ role: 'user' as const, content: 'test' }],
    tools: [{ name: 'read', description: 'read', parameters: {}, risk: 'read' as const, run: async () => 'result' }],
    ctx: { root: '.', signal }, emit: () => {}, approve: async () => true,
  });
  try {
    assert.equal(await runAgent(opts(new AbortController().signal)), 'finished');
    useTool = true;
    assert.equal(await runAgent(opts(new AbortController().signal)), 'paused');
    const stopped = new AbortController(); stopped.abort();
    assert.equal(await runAgent(opts(stopped.signal)), 'stopped');
  } finally { await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }); }
});

test('agent executes reads after preceding writes in model call order', async () => {
  const server = http.createServer((_req, res) => {
    res.end(JSON.stringify({ message: { tool_calls: [
      { function: { name: 'write', arguments: {} } },
      { function: { name: 'read', arguments: {} } },
      { function: { name: 'write2', arguments: {} } },
    ] }, done: true }) + '\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const order: string[] = [];
  const tool = (name: string, risk: 'read' | 'write') => ({ name, risk, description: name, parameters: {}, run: async () => { order.push(name); return 'ok'; } });
  try {
    await runAgent({
      settings: { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, model: 'test', numCtx: 4096, temperature: 0, maxSteps: 1 } as Settings,
      system: '', history: [{ role: 'user', content: 'test' }], tools: [tool('write', 'write'), tool('read', 'read'), tool('write2', 'write')],
      ctx: { root: '.', signal: new AbortController().signal }, emit: () => {}, approve: async () => true,
    });
    assert.deepEqual(order, ['write', 'read', 'write2']);
  } finally { await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }); }
});
