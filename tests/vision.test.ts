import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chooseVisionModel, inspectWithOllama } from '../src/main/vision';

test('automatic vision selection is independent of the chat model and never chooses a remote model', () => {
  const models = [
    { name: 'cohere/chat:free' },
    { name: 'qwen3-vl:4b-instruct', remote_host: 'https://example.com' },
    { name: 'qwen3.5:4b' },
  ];
  assert.equal(chooseVisionModel(models, '')?.name, 'qwen3.5:4b');
  assert.equal(chooseVisionModel([{ name: 'qwen3-vl:4b-instruct' }, ...models], '')?.name, 'qwen3-vl:4b-instruct');
  assert.equal(chooseVisionModel(models, 'missing'), undefined, 'an explicit missing selection is not silently replaced');
  assert.equal(chooseVisionModel([{ name: 'text-only', capabilities: ['completion'] }], ''), undefined);
  // A chat model that can see is used for the screen too, so only one model has to stay loaded.
  const installed = [{ name: 'qwen3-vl:4b-instruct', capabilities: ['vision'] }, { name: 'qwen3.5:4b', capabilities: ['vision', 'tools'] }, { name: 'qwen3:8b', capabilities: ['tools'] }];
  assert.equal(chooseVisionModel(installed, '', 'qwen3.5:4b')?.name, 'qwen3.5:4b');
  assert.equal(chooseVisionModel(installed, '', 'qwen3:8b')?.name, 'qwen3-vl:4b-instruct', 'a text-only chat model still needs a separate vision model');
  assert.equal(chooseVisionModel(installed, 'qwen3-vl:4b-instruct', 'qwen3.5:4b')?.name, 'qwen3-vl:4b-instruct', 'an explicit choice wins');
});

test('screen images go to a checked local vision model and remote-host models are refused', async () => {
  const requests: Array<{ url?: string; body: any }> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ url: req.url, body: body ? JSON.parse(body) : null });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/tags') res.end(JSON.stringify({ models: [
        { name: 'local', capabilities: ['vision'] },
        { name: 'cloud', remote_host: 'https://example.com', capabilities: ['vision'] },
        { name: 'text-only', capabilities: ['completion'] },
      ] }));
      else res.end(JSON.stringify({ message: { content: 'A test screen.' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const input = { baseUrl, model: 'local', image: 'encoded-image', question: 'What is visible?', signal: new AbortController().signal };
  try {
    assert.equal(await inspectWithOllama(input), 'A test screen.');
    assert.equal(requests[1].body.messages[1].images[0], 'encoded-image');
    assert.equal(await inspectWithOllama({ ...input, model: '' }), 'A test screen.');
    assert.equal(requests.filter(r => r.url === '/api/chat').at(-1)?.body.model, 'local');
    await assert.rejects(inspectWithOllama({ ...input, model: 'cloud' }), /remote host/);
    await assert.rejects(inspectWithOllama({ ...input, model: 'text-only' }), /does not support vision/);
    await assert.rejects(inspectWithOllama({ ...input, baseUrl: 'https://example.com' }), /on this computer/);
    assert.equal(requests.filter((r) => r.url === '/api/chat').length, 2);
  } finally { await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }); }
});
