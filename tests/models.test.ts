import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RECOMMENDED, formatBytes, isRemoteModelId, parsePullLine, parseTags, pickDefaultModel, setupStage, suggestChatModel, validModelName } from '../src/shared/models';
import { cancelPull, deleteModel, localModels, ollamaStatus, pullModel } from '../src/main/modelmgr';

test('model names: safe characters only', () => {
  for (const ok of ['qwen3:8b', 'llama3.1:8b', 'nomic-embed-text', 'hf.co/user/repo:Q4_K_M', 'library/qwen3:latest']) assert.equal(validModelName(ok), true, ok);
  for (const bad of ['', '-rf', 'a b', 'x;rm', 'a\nb', '../x', 'x'.repeat(200), 'a$(b)', 42, null]) assert.equal(validModelName(bad as any), false, String(bad));
});

test('sizes read well', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(950), '950 B');
  assert.equal(formatBytes(4_700_000_000), '4.7 GB');
  assert.equal(formatBytes(274_000_000), '274 MB');
});

test('pull lines become progress', () => {
  assert.equal(parsePullLine('m', ''), null);
  assert.equal(parsePullLine('m', 'not json'), null);
  const p = parsePullLine('m', JSON.stringify({ status: 'pulling abc', total: 200, completed: 50 }))!;
  assert.equal(p.pct, 25);
  assert.equal(p.done, false);
  assert.equal(parsePullLine('m', JSON.stringify({ status: 'pulling manifest' }))!.pct, undefined);
  assert.equal(parsePullLine('m', JSON.stringify({ status: 'success' }))!.done, true);
  const e = parsePullLine('m', JSON.stringify({ error: 'pull model manifest: file does not exist' }))!;
  assert.equal(e.done, true);
  assert.match(e.error!, /does not exist/);
  assert.equal(parsePullLine('m', JSON.stringify({ status: 'x', total: 10, completed: 99 }))!.pct, 100);
});

test('tags are parsed and bad entries skipped', () => {
  const m = parseTags({ models: [{ name: 'b:1', size: 5, remote_host: 'https://ollama.com', details: { parameter_size: '7B', quantization_level: 'Q4' } }, { nope: 1 }, { model: 'a:2' }] });
  assert.deepEqual(m.map((x) => x.name), ['a:2', 'b:1']);
  assert.equal(m[1].params, '7B');
  assert.equal(m[1].remoteHost, 'https://ollama.com');
  assert.deepEqual(parseTags(null), []);
  assert.deepEqual(parseTags({ models: 'x' }), []);
});

test('default model: local first, never a cloud id without a key, never an embedding model', () => {
  const all = ['nomic-embed-text:latest', 'qwen/qwen3-coder:free', 'llama3.1:8b', 'qwen2.5-coder:7b'];
  assert.equal(pickDefaultModel(all, false), 'qwen2.5-coder:7b');
  assert.equal(pickDefaultModel(['qwen/qwen3-coder:free', 'meta/llama:free'], false), '');
  assert.equal(pickDefaultModel(['qwen/qwen3-coder:free'], true), 'qwen/qwen3-coder:free');
  assert.equal(pickDefaultModel(['nomic-embed-text'], true), '');
  assert.equal(pickDefaultModel(['x-cloud', 'llama3:8b'], false), 'llama3:8b');
  assert.equal(pickDefaultModel(['qwen2.5-coder:1.5b', 'qwen3:4b'], false), 'qwen3:4b', 'a tiny model is not preferred');
  assert.equal(pickDefaultModel(['qwen2.5-coder:1.5b'], false), 'qwen2.5-coder:1.5b', 'but it is still better than nothing');
  assert.equal(isRemoteModelId('a/b'), true);
  assert.equal(isRemoteModelId('qwen3:8b'), false);
  assert.equal(pickDefaultModel(['hf.co/user/qwen:4b'], false, ['hf.co/user/qwen:4b']), 'hf.co/user/qwen:4b');
});

test('suggestion follows memory', () => {
  assert.equal(suggestChatModel(4).name, 'qwen3:4b');
  assert.equal(suggestChatModel(8).name, 'qwen3:4b');
  assert.equal(suggestChatModel(16).name, 'qwen3:8b');
  assert.equal(suggestChatModel(32).name, 'qwen3:14b');
  assert.ok(RECOMMENDED.every((r) => validModelName(r.name)));
});

test('setup stage: local Ollama is the default path', () => {
  const f = { ollamaUp: false, localModels: [] as string[], hasKey: false, model: '', workspace: '' };
  assert.equal(setupStage(f), 'ollama');
  assert.equal(setupStage({ ...f, ollamaUp: true }), 'model');
  assert.equal(setupStage({ ...f, ollamaUp: true, localModels: ['nomic-embed-text'] }), 'model', 'an embedding model cannot chat');
  assert.equal(setupStage({ ...f, ollamaUp: true, localModels: ['qwen3:8b'] }), 'folder');
  assert.equal(setupStage({ ...f, ollamaUp: true, localModels: ['qwen3:8b'], workspace: '/p' }), 'ready');
  assert.equal(setupStage({ ...f, hasKey: true, model: 'qwen/qwen3:free' }), 'folder', 'a key and a cloud model skip Ollama');
  assert.equal(setupStage({ ...f, hasKey: true, model: '' }), 'ollama', 'a key alone is not a model');
  assert.equal(setupStage({ ...f, hasKey: false, model: 'qwen/qwen3:free', workspace: '/p' }), 'ollama', 'a cloud model without a key does not count');
});

async function fakeOllama(handler: (req: http.IncomingMessage, body: any, res: http.ServerResponse) => void) {
  const seen: { method?: string; url?: string; body: any }[] = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      let j: any;
      try { j = JSON.parse(b); } catch { /* none */ }
      seen.push({ method: req.method, url: req.url, body: j });
      handler(req, j, res);
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, seen, close: () => new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }) };
}

test('status, listing, pull progress and delete against a fake Ollama', async () => {
  const o = await fakeOllama((req, body, res) => {
    if (req.url === '/api/version') return void res.end(JSON.stringify({ version: '0.9.0' }));
    if (req.url === '/api/tags') return void res.end(JSON.stringify({ models: [{ name: 'qwen3:8b', size: 5_200_000_000 }] }));
    if (req.url === '/api/pull') {
      res.write(JSON.stringify({ status: 'pulling manifest' }) + '\n');
      res.write(JSON.stringify({ status: 'pulling abc', total: 100, completed: 40 }) + '\n');
      res.write(JSON.stringify({ status: 'pulling abc', total: 100, completed: 1 }).slice(0, 20));
      res.write(JSON.stringify({ status: 'pulling abc', total: 100, completed: 100 }).slice(0, 0));
      res.write('\n');
      return void res.end(JSON.stringify({ status: 'success' }) + '\n');
    }
    if (req.url === '/api/delete') return void res.end('');
    res.statusCode = 404;
    res.end('{}');
  });
  try {
    assert.deepEqual(await ollamaStatus(o.url), { up: true, version: '0.9.0' });
    assert.equal((await localModels(o.url))[0].name, 'qwen3:8b');
    const events: string[] = [];
    const r = await pullModel(o.url, 'qwen3:8b', (p) => events.push(`${p.status}:${p.pct ?? '-'}`));
    assert.equal(r.done, true);
    assert.equal(r.error, undefined);
    assert.ok(events.includes('pulling abc:40'));
    assert.equal(events.at(-1), 'success:-');
    await deleteModel(o.url, 'qwen3:8b');
    const del = o.seen.find((s) => s.url === '/api/delete')!;
    assert.equal(del.method, 'DELETE');
    assert.equal(del.body.model, 'qwen3:8b');
  } finally {
    await o.close();
  }
});

test('pull reports Ollama errors, rejects bad names and refuses a second pull of the same name', async () => {
  const o = await fakeOllama((req, _b, res) => {
    if (req.url === '/api/pull') {
      res.statusCode = 200;
      res.write(JSON.stringify({ status: 'pulling manifest' }) + '\n');
      return void setTimeout(() => res.end(JSON.stringify({ error: 'pull model manifest: file does not exist' }) + '\n'), 80);
    }
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'model is busy' }));
  });
  try {
    await assert.rejects(pullModel(o.url, 'bad name', () => {}), /valid model name/);
    const first = pullModel(o.url, 'nope:1b', () => {});
    await assert.rejects(pullModel(o.url, 'nope:1b', () => {}), /already downloading/);
    const r = await first;
    assert.match(r.error!, /does not exist/);
    await assert.rejects(deleteModel(o.url, 'x:1'), /busy/);
    await assert.rejects(deleteModel(o.url, '-bad'), /valid model name/);
  } finally {
    await o.close();
  }
});

test('a download can be cancelled, and a stream that just stops is an error', async () => {
  const o = await fakeOllama((req, _b, res) => {
    if (req.url === '/api/pull') {
      res.write(JSON.stringify({ status: 'pulling x', total: 100, completed: 5 }) + '\n');
      if (_b?.name === 'cut:1b') return void res.end(); // stops without saying success
      return; // hang until the client goes away
    }
    res.end('{}');
  });
  try {
    const events: string[] = [];
    const p = pullModel(o.url, 'slow:1b', (e) => events.push(e.status));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(cancelPull('slow:1b'), true);
    const r = await p;
    assert.equal(r.status, 'cancelled');
    assert.equal(cancelPull('slow:1b'), false);
    const cut = await pullModel(o.url, 'cut:1b', () => {});
    assert.match(cut.error!, /ended before/);
  } finally {
    await o.close();
  }
});

test('default chat model: a vision model never beats a text model for tool use', () => {
  assert.equal(pickDefaultModel(['qwen3-vl:4b-instruct', 'qwen3.5:4b', 'nomic-embed-text'], false), 'qwen3.5:4b');
  assert.equal(pickDefaultModel(['qwen3.5:4b', 'qwen3-vl:4b-instruct'], false), 'qwen3.5:4b');
  assert.equal(pickDefaultModel(['qwen3-vl:4b-instruct'], false), 'qwen3-vl:4b-instruct');
});
