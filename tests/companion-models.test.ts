import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { warmCompanionModels } from '../src/main/companion-models';

test('companion warming only loads installed local models and sends no conversation', async () => {
  const calls: any[] = [];
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => raw += chunk);
    req.on('end', () => {
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'qwen3.5:4b' }, { name: 'qwen3-vl:4b-instruct' }, { name: 'remote', remote_host: 'https://example.com' }] }));
      calls.push(JSON.parse(raw)); res.end('{}');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, model: 'qwen3.5:4b', numCtx: 16384, signal: AbortSignal.timeout(5000) };
  try {
    // The chat model is warmed last so it is the one left loaded when both do not fit in VRAM.
    assert.deepEqual(await warmCompanionModels(config), ['qwen3-vl:4b-instruct', 'qwen3.5:4b']);
    assert.deepEqual(calls.map(c => c.messages), [[], []]);
    assert.deepEqual(calls.map(c => c.options.num_ctx), [4096, 16384]);
    assert.equal(calls[0].keep_alive, '15m');
    assert.deepEqual(await warmCompanionModels({ ...config, model: 'remote' }), []);
    assert.deepEqual(await warmCompanionModels({ ...config, baseUrl: 'https://example.com' }), []);
    assert.equal(calls.length, 2);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
