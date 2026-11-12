import test from 'node:test';
import assert from 'node:assert/strict';
import { Speaker } from '../src/renderer/voiceui';
import { voiceDefaults } from '../src/shared/voice';

test('spoken replies queue completed sentences before the full reply finishes', () => {
  const synthDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'speechSynthesis');
  const utteranceDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'SpeechSynthesisUtterance');
  const spoken: string[] = []; let cancels = 0;
  try {
    Object.defineProperty(globalThis, 'speechSynthesis', { configurable: true, value: { cancel: () => { cancels++; }, speak: (utterance: { text: string; voice: { localService: boolean } }) => { assert.equal(utterance.voice.localService, true); spoken.push(utterance.text); }, getVoices: () => [{ name: 'remote', lang: 'en-US', localService: false }, { name: 'local', lang: 'en-US', localService: true }] } });
    Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', { configurable: true, value: class { constructor(public text: string) {} } });
    const speaker = new Speaker(() => ({ ...voiceDefaults, speak: 'full' }));
    speaker.push('Hello there. ');
    assert.deepEqual(spoken, ['Hello there.']);
    speaker.push('The answer is still arriving');
    assert.equal(spoken.length, 1);
    speaker.finish();
    assert.deepEqual(spoken, ['Hello there.', 'The answer is still arriving']);
    assert.equal(cancels, 1, 'starting a stream cancels earlier speech only once');
  } finally {
    if (synthDescriptor) Object.defineProperty(globalThis, 'speechSynthesis', synthDescriptor); else Reflect.deleteProperty(globalThis, 'speechSynthesis');
    if (utteranceDescriptor) Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', utteranceDescriptor); else Reflect.deleteProperty(globalThis, 'SpeechSynthesisUtterance');
  }
});

test('spoken replies do not use a remote voice when no local voice is available', () => {
  const synthDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'speechSynthesis');
  const utteranceDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'SpeechSynthesisUtterance');
  let calls = 0;
  try {
    Object.defineProperty(globalThis, 'speechSynthesis', { configurable: true, value: { cancel: () => {}, speak: () => { calls++; }, getVoices: () => [{ name: 'remote', lang: 'en-US', localService: false }] } });
    Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', { configurable: true, value: class { constructor(public text: string) {} } });
    const speaker = new Speaker(() => ({ ...voiceDefaults, speak: 'full' }));
    speaker.push('Hello there. ');
    assert.equal(calls, 0);
    speaker.stop();
  } finally {
    if (synthDescriptor) Object.defineProperty(globalThis, 'speechSynthesis', synthDescriptor); else Reflect.deleteProperty(globalThis, 'speechSynthesis');
    if (utteranceDescriptor) Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', utteranceDescriptor); else Reflect.deleteProperty(globalThis, 'SpeechSynthesisUtterance');
  }
});

test('companion speaking state follows audio and ignores stale completion events', () => {
  const synthDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'speechSynthesis');
  const utteranceDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'SpeechSynthesisUtterance');
  const utterances: any[] = [], states: boolean[] = [];
  try {
    Object.defineProperty(globalThis, 'speechSynthesis', { configurable: true, value: { pending: false, cancel: () => {}, speak: (u: any) => utterances.push(u), getVoices: () => [{ name: 'local', lang: 'en-US', localService: true }] } });
    Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', { configurable: true, value: class { constructor(public text: string) {} } });
    const speaker = new Speaker(() => ({ ...voiceDefaults, speak: 'full' }), () => {}, (state) => states.push(state));
    speaker.push('Hello. ');
    utterances[0].onstart();
    utterances[0].onend();
    assert.deepEqual(states, [false, true, false]);
    speaker.stop();
    utterances[0].onstart();
    assert.deepEqual(states, [false, true, false, false]);
  } finally {
    if (synthDescriptor) Object.defineProperty(globalThis, 'speechSynthesis', synthDescriptor); else Reflect.deleteProperty(globalThis, 'speechSynthesis');
    if (utteranceDescriptor) Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', utteranceDescriptor); else Reflect.deleteProperty(globalThis, 'SpeechSynthesisUtterance');
  }
});

test('interrupting Windows speech cancels playback and suppresses late tokens until the next reply', () => {
  const synthDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'speechSynthesis');
  const utteranceDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'SpeechSynthesisUtterance');
  const utterances: any[] = []; let cancelled = 0;
  try {
    Object.defineProperty(globalThis, 'speechSynthesis', { configurable: true, value: { pending: false, cancel: () => { cancelled++; }, speak: (u: any) => utterances.push(u), getVoices: () => [{ name: 'local', lang: 'en-US', localService: true }] } });
    Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', { configurable: true, value: class { constructor(public text: string) {} } });
    const speaker = new Speaker(() => ({ ...voiceDefaults, speak: 'full' }));
    speaker.push('First answer. ');
    assert.equal(speaker.speaking, false, 'Windows speech has not started yet');
    assert.equal(speaker.activeReply, true, 'queued speech can still be interrupted');
    utterances[0].onstart();
    assert.equal(speaker.speaking, true);
    assert.equal(speaker.activeReply, true);
    const before = cancelled;
    speaker.interrupt(); assert.equal(cancelled, before + 1); assert.equal(speaker.speaking, false);
    speaker.push('More late tokens. '); speaker.finish();
    utterances[0].onstart(); assert.equal(speaker.speaking, false);
    assert.equal(utterances.length, 1);
    speaker.beginReply(); speaker.push('New answer. '); speaker.finish();
    assert.equal(utterances.length, 2);
  } finally {
    if (synthDescriptor) Object.defineProperty(globalThis, 'speechSynthesis', synthDescriptor); else Reflect.deleteProperty(globalThis, 'speechSynthesis');
    if (utteranceDescriptor) Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', utteranceDescriptor); else Reflect.deleteProperty(globalThis, 'SpeechSynthesisUtterance');
  }
});
