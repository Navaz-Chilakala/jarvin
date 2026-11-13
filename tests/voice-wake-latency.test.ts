import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { VoiceService } from '../src/main/voice';
import { voiceDefaults } from '../src/shared/voice';
import type { Settings } from '../src/shared/types';

test('hands-free clean mode sends a command without a separate model cleanup request', async () => {
  let requests = 0;
  const server = http.createServer((_req, res) => { requests++; res.writeHead(500); res.end(); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const settings = { baseUrl: `http://127.0.0.1:${port}`, model: 'test', workspace: '', voice: { ...voiceDefaults, mode: 'clean', keepHistory: false } } as Settings;
    const voice = new VoiceService(() => settings, { appRoot: '', data: '', workerFile: '' }, () => {});
    voice.status = () => ({ available: true, cached: true, model: 'fake', sizeMB: 1 });
    (voice as any).stt = { transcribe: async () => 'Hey Jarvin what is the temperature outside today' };
    const result = await voice.process(new Float32Array(16000).fill(0.1), { wake: true });
    assert.match(result.text, /temperature outside today/i);
    assert.equal(result.cleanup, 'basic');
    (voice as any).stt = { transcribe: async () => 'what is the temperature outside today' };
    const companion = await voice.process(new Float32Array(16000).fill(0.1), { fast: true });
    assert.match(companion.text, /temperature outside today/i);
    assert.equal(companion.cleanup, 'basic');
    assert.equal(requests, 0, 'no extra LLM request before the command reaches the agent');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('high microphone sensitivity reaches transcription for speech rejected by the balanced threshold', async () => {
  const settings = { workspace: '', voice: { ...voiceDefaults, sensitivity: 'high', keepHistory: false } } as Settings;
  const voice = new VoiceService(() => settings, { appRoot: '', data: '', workerFile: '' }, () => {});
  voice.status = () => ({ available: true, cached: true, model: 'fake', sizeMB: 1 });
  let calls = 0;
  (voice as any).stt = { transcribe: async () => { calls++; return 'Please stop talking'; } };
  const faint = () => Float32Array.from({ length: 16000 }, (_, i) => .012 * Math.sin(i / 5));
  assert.match((await voice.process(faint(), { fast: true })).text, /stop talking/i);
  settings.voice.sensitivity = 'balanced';
  assert.equal((await voice.process(faint(), { fast: true })).silent, true);
  assert.equal(calls, 1);
});

test('a blocked Qwen speech module is tried a second time in a fresh worker before any fallback', async () => {
  const settings = { workspace: '', voice: { ...voiceDefaults, size: 'qwen3-asr', keepHistory: false } } as Settings;
  const voice = new VoiceService(() => settings, { appRoot: '', data: '', workerFile: '' }, () => {});
  let disposed = 0;
  (voice as any).stt = { dispose: async () => { disposed++; } };
  const models: string[] = [];
  const result = await (voice as any).withFallback(async (model: string) => {
    models.push(model);
    if (models.length === 1) throw new Error('Could not find sherpa-onnx-node. Tried ../build/Release/sherpa-onnx.node');
    return 'heard';
  });
  assert.equal(result, 'heard');
  assert.equal(models.length, 2);
  assert.equal(models[0], models[1], 'the second attempt uses the same accurate recognizer');
  assert.match(models[0], /qwen3-asr/);
  assert.equal(disposed, 1, 'the worker that failed is replaced');
  assert.equal(voice.fallbackNote(), undefined, 'no weaker-engine warning when the second attempt works');
  // An error that is not a module-load failure is passed on untouched, with no second attempt.
  await assert.rejects((voice as any).withFallback(async () => { throw new Error('Transcription timed out.'); }), /timed out/);
});
