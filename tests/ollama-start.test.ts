import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureOllamaRunning, isLocalBaseUrl, ollamaExecutable } from '../src/main/ollama-start';

const fakeSpawn = () => { const calls: string[][] = []; return { calls, spawnChild: (file: string, args: string[]) => { calls.push([file, ...args]); return { unref() {}, once() { return undefined; } }; } }; };

test('starts a hidden local Ollama only when it is not answering', async () => {
  const a = fakeSpawn();
  assert.equal(await ensureOllamaRunning('http://127.0.0.1:11434', { platform: 'win32', probe: async () => true, spawnChild: a.spawnChild }), 'running');
  assert.equal(a.calls.length, 0);
  const b = fakeSpawn();
  assert.equal(await ensureOllamaRunning('http://localhost:11434', { platform: 'win32', probe: async () => false, spawnChild: b.spawnChild, env: {}, exists: () => false }), 'started');
  assert.deepEqual(b.calls, [['ollama', 'serve']]);
});

test('never starts anything for a remote server or another OS', async () => {
  const a = fakeSpawn();
  assert.equal(await ensureOllamaRunning('http://192.168.1.5:11434', { platform: 'win32', probe: async () => false, spawnChild: a.spawnChild }), 'remote');
  assert.equal(await ensureOllamaRunning('http://127.0.0.1:11434', { platform: 'linux', probe: async () => false, spawnChild: a.spawnChild }), 'unsupported');
  assert.equal(a.calls.length, 0);
  assert.equal(isLocalBaseUrl('http://evil.example.com:11434'), false);
});

test('uses the installed ollama.exe when present', () => {
  const p = ollamaExecutable({ LOCALAPPDATA: 'C:\\Users\\U\\AppData\\Local' }, (x) => x.endsWith('Programs\\Ollama\\ollama.exe'));
  assert.equal(p, 'C:\\Users\\U\\AppData\\Local\\Programs\\Ollama\\ollama.exe');
});
