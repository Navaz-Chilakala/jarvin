import test from 'node:test';
import assert from 'node:assert/strict';
import { Speaker } from '../src/renderer/voiceui';
import { voiceDefaults } from '../src/shared/voice';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
test('neural speech queues local audio in order and stops on cancellation', async () => {
  const synthDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'speechSynthesis');
  const contextDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  const starts: number[] = [], sources: any[] = [], states: boolean[] = [], phrases: string[] = [];
  try {
    Object.defineProperty(globalThis, 'speechSynthesis', { configurable: true, value: { cancel: () => {}, getVoices: () => [], pending: false, speaking: false } });
    Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: class {
      state = 'running'; currentTime = 0; destination = {};
      async resume() {}
      createBuffer(_channels: number, length: number, rate: number) { return { duration: length / rate, getChannelData: () => new Float32Array(length) }; }
      createBufferSource() { const source: any = { buffer: null, onended: null, connect: () => {}, start: (at: number) => starts.push(at), stop: () => { source.stopped = true; } }; sources.push(source); return source; }
    } });
    const neural = { status: async () => ({ available: true }), warm: async () => ({ ok: true }), synthesize: async (text: string) => { phrases.push(text); return { pcm: new Float32Array(22050).fill(.1), sampleRate: 22050 }; } };
    const speaker = new Speaker(() => ({ ...voiceDefaults, speak: 'full', ttsEngine: 'auto' }), () => {}, (state) => states.push(state), neural);
    speaker.push('First sentence. '); speaker.push('Second sentence. '); speaker.finish();
    for (let i = 0; i < 10 && starts.length < 2; i++) await flush();
    assert.deepEqual(phrases, ['First sentence.', 'Second sentence.']);
    assert.equal(starts.length, 2);
    assert.ok(starts[1] >= starts[0] + 1, 'audio chunks do not overlap');
    assert.ok(states.includes(true));
    speaker.stop();
    assert.ok(sources.every((source) => source.stopped));
    assert.equal(states.at(-1), false);
  } finally {
    if (synthDescriptor) Object.defineProperty(globalThis, 'speechSynthesis', synthDescriptor); else Reflect.deleteProperty(globalThis, 'speechSynthesis');
    if (contextDescriptor) Object.defineProperty(globalThis, 'AudioContext', contextDescriptor); else Reflect.deleteProperty(globalThis, 'AudioContext');
  }
});

test('a failed neural voice falls back to a local Windows voice', async () => {
  const synthDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'speechSynthesis');
  const utteranceDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'SpeechSynthesisUtterance');
  const spoken: string[] = [];
  try {
    Object.defineProperty(globalThis, 'speechSynthesis', { configurable: true, value: { cancel: () => {}, getVoices: () => [{ name: 'local', lang: 'en-US', localService: true }], speak: (u: any) => spoken.push(u.text), pending: false, speaking: false } });
    Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', { configurable: true, value: class { constructor(public text: string) {} } });
    const neural = { status: async () => ({ available: true }), warm: async () => ({ ok: true }), synthesize: async () => ({ error: 'test failure' }) };
    const speaker = new Speaker(() => ({ ...voiceDefaults, speak: 'full', ttsEngine: 'auto' }), () => {}, () => {}, neural);
    speaker.push('Hello there. '); speaker.finish();
    for (let i = 0; i < 10 && !spoken.length; i++) await flush();
    assert.deepEqual(spoken, ['Hello there.']);
    speaker.stop();
  } finally {
    if (synthDescriptor) Object.defineProperty(globalThis, 'speechSynthesis', synthDescriptor); else Reflect.deleteProperty(globalThis, 'speechSynthesis');
    if (utteranceDescriptor) Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', utteranceDescriptor); else Reflect.deleteProperty(globalThis, 'SpeechSynthesisUtterance');
  }
});

test('an interrupted neural synthesis never starts its late audio or resumes old tokens', async () => {
  const synthDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'speechSynthesis');
  const contextDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  let complete!: (value: any) => void; let starts = 0, calls = 0;
  try {
    Object.defineProperty(globalThis, 'speechSynthesis', { configurable: true, value: { cancel: () => {}, getVoices: () => [] } });
    Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: class {
      state = 'running'; currentTime = 0; destination = {};
      createBuffer(_c: number, length: number, rate: number) { return { duration: length / rate, getChannelData: () => new Float32Array(length) }; }
      createBufferSource() { return { connect: () => {}, start: () => { starts++; }, stop: () => {} }; }
    } });
    const audio = { pcm: new Float32Array(22050), sampleRate: 22050 };
    const speaker = new Speaker(() => ({ ...voiceDefaults, speak: 'full' }), () => {}, () => {}, {
      status: async () => ({ available: true }), warm: async () => ({ ok: true }),
      synthesize: async () => { calls++; return calls === 1 ? new Promise(resolve => { complete = resolve; }) : audio; },
    });
    speaker.push('Old response. ');
    while (!complete) await flush();
    speaker.interrupt(); speaker.push('Late old content. '); speaker.finish();
    complete(audio); await flush(); assert.equal(starts, 0); assert.equal(calls, 1);
    speaker.beginReply(); speaker.push('New reply. '); speaker.finish();
    for (let i = 0; i < 10 && !starts; i++) await flush();
    assert.equal(starts, 1); speaker.stop();
  } finally {
    if (synthDescriptor) Object.defineProperty(globalThis, 'speechSynthesis', synthDescriptor); else Reflect.deleteProperty(globalThis, 'speechSynthesis');
    if (contextDescriptor) Object.defineProperty(globalThis, 'AudioContext', contextDescriptor); else Reflect.deleteProperty(globalThis, 'AudioContext');
  }
});
