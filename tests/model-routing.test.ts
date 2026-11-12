import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatOnce, setOllamaModels } from '../src/main/openai';

test('Ollama model names containing slashes stay on the configured Ollama endpoint', async () => {
  const original = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    seen.push(String(input));
    return new Response(JSON.stringify({ message: { content: 'ok' } }), { status: 200 });
  }) as typeof fetch;
  try {
    setOllamaModels(['hf.co/user/model:Q4']);
    const output = await chatOnce({ baseUrl: 'http://127.0.0.1:11434', model: 'hf.co/user/model:Q4', messages: [], timeoutMs: 1000 });
    assert.equal(output, 'ok');
    assert.deepEqual(seen, ['http://127.0.0.1:11434/api/chat']);
  } finally {
    setOllamaModels([]);
    globalThis.fetch = original;
  }
});
