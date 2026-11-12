import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandsFree } from '../src/renderer/handsfree';
import { Recorder } from '../src/renderer/voiceui';
import type { JarvinApi, Settings } from '../src/shared/types';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const audio = (amp: number) => Float32Array.from({ length: 2048 }, (_, i) => amp * Math.sin(i / 5));

test('hands-free starts only once and cancels an unfinished startup', async () => {
  let resolveStatus!: (v: any) => void;
  let checks = 0, recorders = 0;
  const settings = { voice: { enabled: true, handsFree: true } } as Settings;
  const hf = createHandsFree({
    jarvin: { voiceStatus: () => { checks++; return new Promise((resolve) => { resolveStatus = resolve; }); } } as unknown as JarvinApi,
    getSettings: () => settings, canListen: () => true, onResult: () => {}, onState: () => {},
    makeRecorder: () => { recorders++; return { level: 0, start: async () => {}, cancel: () => {} }; },
  });
  hf.sync(); hf.sync();
  assert.equal(checks, 1);
  hf.stop();
  resolveStatus({ available: true, cached: true });
  await flush();
  assert.equal(recorders, 0);
  assert.equal(hf.state, 'off');
});

test('a transcription error stops the mic and retry starts a fresh recorder', async () => {
  let onChunk: ((chunk: Float32Array, level: number) => void) | undefined;
  let created = 0, cancelled = 0;
  const settings = { voice: { enabled: true, handsFree: true } } as Settings;
  const hf = createHandsFree({
    jarvin: { voiceStatus: async () => ({ available: true, cached: true }), voiceWarm: async () => ({ ok: true }), voiceTranscribe: async () => ({ error: 'Speech worker failed' }) } as unknown as JarvinApi,
    getSettings: () => settings, canListen: () => true, onResult: () => {}, onState: () => {},
    makeRecorder: () => { created++; return { level: 0, start: async (cb) => { onChunk = cb; }, cancel: () => { cancelled++; } }; },
  });
  hf.sync(); await flush();
  assert.equal(hf.state, 'listening');
  for (let i = 0; i < 12; i++) onChunk!(audio(0.002), 0.002);
  for (let i = 0; i < 10; i++) onChunk!(audio(0.2), 0.2);
  for (let i = 0; i < 10; i++) onChunk!(audio(0.002), 0.002);
  await flush();
  assert.equal(hf.state, 'error');
  assert.equal(cancelled, 1);
  assert.equal(hf.on, false);
  hf.retry(); await flush();
  assert.equal(created, 2);
  assert.equal(hf.state, 'listening');
  hf.stop();
});

test('hands-free warms the cached speech model without delaying the microphone', async () => {
  let warmCalls = 0, recorders = 0;
  const settings = { voice: { enabled: true, handsFree: true } } as Settings;
  const hf = createHandsFree({
    jarvin: { voiceStatus: async () => ({ available: true, cached: true }), voiceWarm: () => { warmCalls++; return new Promise(() => {}); } } as unknown as JarvinApi,
    getSettings: () => settings, canListen: () => true, onResult: () => {}, onState: () => {},
    makeRecorder: () => { recorders++; return { level: 0, start: async () => {}, cancel: () => {} }; },
  });
  hf.sync(); await flush();
  assert.equal(warmCalls, 1);
  assert.equal(recorders, 1);
  assert.equal(hf.state, 'listening');
  hf.stop();
});

test('cancelling while microphone permission is pending stops the eventual stream', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let resolveStream!: (stream: any) => void;
  let stopped = 0;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: () => new Promise((resolve) => { resolveStream = resolve; }) } } });
  try {
    const recorder = new Recorder();
    const started = recorder.start();
    recorder.cancel();
    resolveStream({ getTracks: () => [{ stop: () => { stopped++; } }] });
    await assert.rejects(started, /cancelled/i);
    assert.equal(stopped, 1);
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});

test('listening starts without the old switch and sends speech without a wake word; mute closes the mic', async () => {
  let onChunk: ((chunk: Float32Array, level: number) => void) | undefined;
  let options: any, result: any, cancelled = 0;
  const settings = { voice: { enabled: true, handsFree: false } } as Settings;
  let wakeOn = false;
  const hf = createHandsFree({
    jarvin: { voiceStatus: async () => ({ available: true, cached: true }), voiceWarm: async () => ({ ok: true }), voiceTranscribe: async (_audio: any, o: any) => { options = o; return { text: 'Open Chrome', raw: 'Open Chrome', ms: 1, cleanup: 'basic' }; } } as unknown as JarvinApi,
    getSettings: () => settings, canListen: () => true, wake: () => wakeOn, onResult: r => { result = r; }, onState: () => {},
    makeRecorder: () => ({ level: 0, start: async cb => { onChunk = cb; }, cancel: () => { cancelled++; } }),
  });
  hf.sync(); await flush(); assert.equal(hf.state, 'listening');
  for (let i = 0; i < 12; i++) onChunk!(audio(.002), .002);
  for (let i = 0; i < 10; i++) onChunk!(audio(.2), .2);
  for (let i = 0; i < 10; i++) onChunk!(audio(.002), .002);
  await flush(); assert.deepEqual(options, { fast: true, wake: false, name: true }); assert.equal(result.text, 'Open Chrome');
  wakeOn = true;
  for (let i = 0; i < 12; i++) onChunk!(audio(.002), .002);
  for (let i = 0; i < 10; i++) onChunk!(audio(.2), .2);
  for (let i = 0; i < 10; i++) onChunk!(audio(.002), .002);
  await flush(); assert.deepEqual(options, { fast: true, wake: true, name: false }, 'the wake-word setting is passed to the transcriber');
  hf.toggleMute(); assert.equal(hf.state, 'off'); assert.equal(cancelled, 1);
  hf.toggleMute(); await flush(); assert.equal(hf.state, 'listening');
  hf.stop();
});

test('quiet sustained speech interrupts before transcription and retains the first words; a click does not', async () => {
  let onChunk: ((chunk: Float32Array, level: number) => void) | undefined;
  let starts = 0, transcriptions = 0, captured: Float32Array | undefined;
  const hf = createHandsFree({
    jarvin: { voiceStatus: async () => ({ available: true, cached: true }), voiceWarm: async () => ({ ok: true }), voiceTranscribe: async (audio: Float32Array) => { transcriptions++; captured = audio; return { text: 'Wait a moment', raw: 'Wait a moment', ms: 1, cleanup: 'basic' }; } } as unknown as JarvinApi,
    getSettings: () => ({ voice: { enabled: true, sensitivity: 'high' } }) as Settings,
    canListen: () => true, onSpeechStart: () => { starts++; }, onResult: () => {}, onState: () => {},
    makeRecorder: () => ({ level: 0, start: async cb => { onChunk = cb; }, cancel: () => {} }),
  });
  hf.sync(); await flush();
  const feed = (amp: number, n: number) => { for (let i = 0; i < n; i++) onChunk!(audio(amp), amp); };
  feed(.002, 15); feed(.1, 1); feed(.002, 10);
  assert.equal(starts, 0, 'one brief noise must not interrupt');
  feed(.012, 2); assert.equal(starts, 1, 'quiet speech is detected within 256 ms');
  assert.equal(transcriptions, 0, 'does not wait for Whisper or end-of-utterance');
  feed(.012, 5); feed(.002, 10); await flush();
  assert.equal(transcriptions, 1); assert.ok(captured!.length >= 7 * 2048, 'keeps the start of the interruption');
  hf.toggleMute(); feed(.2, 15); assert.equal(starts, 1, 'muted microphone cannot interrupt');
  hf.stop();
});
