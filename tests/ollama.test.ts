import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { streamChat, chatOnce, helperContext } from '../src/main/ollama';

test('local chat disables hidden thinking and preserves streamed text and tool calls', async () => {
  let body: any;
  const server = http.createServer((req, res) => {
    let text = ''; req.on('data', chunk => text += chunk);
    req.on('end', () => {
      body = JSON.parse(text);
      res.end(JSON.stringify({ message: { content: 'Opening it.', tool_calls: [{ function: { name: 'launch_app', arguments: { app: 'Chrome' } } }] } }) + '\n');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const tokens: string[] = [];
    const result = await streamChat({ baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, model: 'qwen3.5:4b', messages: [{ role: 'user', content: 'Open Chrome' }], tools: [], numCtx: 8192, temperature: .2, signal: AbortSignal.timeout(5000), onToken: t => tokens.push(t) });
    assert.equal(body.think, false);
    assert.equal(body.stream, true);
    assert.equal(body.options.num_ctx, 8192);
    assert.deepEqual(tokens, ['Opening it.']);
    assert.equal(result.toolCalls[0].function.arguments.app, 'Chrome');
    // A helper call on the same model must ask for the size it is already loaded with, or Ollama reloads it.
    await chatOnce({ baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, model: 'qwen3.5:4b', messages: [{ role: 'user', content: 'tidy' }], timeoutMs: 5000 });
    assert.equal(body.options.num_ctx, 8192);
    assert.equal(body.keep_alive, '15m');
    assert.equal(helperContext('some-other-model'), 4096);
    assert.equal(helperContext('some-other-model', 2048), 2048);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
