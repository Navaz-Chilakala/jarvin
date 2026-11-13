import type { JarvinApi, Settings } from '../shared/types';
import type { VoiceResult } from '../shared/voice';
import { speechLevel } from '../shared/voice';
import { Segmenter } from '../shared/handsfree';
import { isSpeech } from '../shared/vad';
import { Recorder } from './voiceui';

export type HandsFreeState = 'off' | 'starting' | 'listening' | 'paused' | 'working' | 'error';

export interface HandsFreeDeps {
  jarvin: JarvinApi;
  getSettings: () => Settings;
  /** Why Jarvin is not listening right now, for the trace. */
  busyReason?: () => string;
  /** False during manual recording or when an unsent draft must be protected. */
  canListen: () => boolean;
  /** True when speech must start with the wake word "Jarvin". */
  wake?: () => boolean;
  /** True when the microphone should stay off until the user switches it on. Read once, when settings are first available. */
  startMuted?: () => boolean;
  /** Speech was understood but not acted on because it did not start with the name. */
  onIgnored?: (heard: string) => void;
  /** The name was heard by itself; the next utterance will be taken as the request. */
  onWake?: () => void;
  /** Sustained speech onset, before waiting for transcription or sentence completion. */
  onSpeechStart?: () => void;
  /** A locally transcribed utterance is ready to run. */
  onResult: (r: VoiceResult) => void;
  onState: (s: HandsFreeState, msg?: string) => void;
  /** Plain-language trace of what hands-free is doing, for the Settings readout. Kept on screen only, never saved. */
  onLog?: (line: string) => void;
  /** Current microphone level and the level speech has to beat, a few times a second. */
  onLevel?: (level: number, threshold: number, speaking: boolean) => void;
  /** Injectable for lifecycle tests. */
  makeRecorder?: () => Pick<Recorder, 'start' | 'cancel' | 'level'>;
}

/**
 * Automatic listening while Jarvin is running. Audio is transcribed locally;
 * resulting requests are sent to the selected chat model.
 */
export function createHandsFree(d: HandsFreeDeps) {
  let rec: Pick<Recorder, 'start' | 'cancel' | 'level'> | null = null;
  let seg: Segmenter | null = null;
  let running = false;
  let starting = false;
  let working = false;
  /** One utterance can wait while the previous one is being transcribed; a newer one replaces it. */
  let pending: { audio: Float32Array; endedAt: number } | null = null;
  let gen = 0;
  let state: HandsFreeState = 'off';
  let muted = false;
  let mutedRead = false;
  let activeSensitivity: Settings['voice']['sensitivity'] | undefined;
  /** After the name alone is heard, the next utterance counts as addressed to Jarvin until this time. */
  let armedUntil = 0;
  const ARMED_MS = 10_000;

  const set =(s: HandsFreeState, msg?: string) => {
    state = s;
    d.onState(s, msg);
  };

  function fail(message: string) {
    running = false; starting = false; gen++;
    rec?.cancel(); rec = null; seg = null; pending = null; working = false;
    set('error', message);
  }

  async function segment(audio: Float32Array, my: number, endedAt = performance.now()) {
    if (!running || my !== gen) return;
    const secs = (audio.length / 16000).toFixed(1);
    if (working) {
      pending = { audio, endedAt };
      d.onLog?.(`Heard speech (${secs}s), waiting for the previous one to finish.`);
      return;
    }
    if (!d.canListen()) return d.onLog?.(`Heard speech (${secs}s) but skipped it: ${d.busyReason?.() ?? 'Jarvin is busy'}.`);
    d.onLog?.(`Heard speech (${secs}s), transcribing…`);
    working = true;
    set('working');
    try {
      const needName = d.wake?.() === true && performance.now() > armedUntil;
      const r = await d.jarvin.voiceTranscribe(audio, { fast: true, wake: needName, name: !needName });
      if (my !== gen) return;
      if ('error' in r) return fail(r.error);
      if (r.silent && r.wake) {
        // Only the name was said ("Jarvin…", then a pause). The next thing said is the request, with no name needed.
        armedUntil = performance.now() + ARMED_MS;
        d.onLog?.('Heard "Jarvin". Listening for your request (no need to say the name again).');
        d.onWake?.();
      } else if (!r.silent && r.text) {
        armedUntil = 0;
        // Only what was heard is logged here. Whether it is run, ignored or used to stop a task is logged by the receiver.
        d.onLog?.(`Heard "${r.text.slice(0, 60)}" (${r.ms} ms transcription; ${Math.round(performance.now() - endedAt)} ms since segment closed).`);
        d.onResult(r);
      } else if (r.why === 'nowake') { d.onLog?.(`Ignored (no "Jarvin" at the start): "${(r.heard ?? '').slice(0, 60)}"`); d.onIgnored?.(r.heard ?? ''); }
      else if (r.why === 'quiet') d.onLog?.('Too quiet to be speech, ignored. Check the level above.');
      else d.onLog?.('Transcribed nothing (noise), ignored.');
    } catch (e: any) {
      if (my === gen) fail(String(e?.message ?? e));
    } finally {
      if (my === gen) {
        working = false;
        if (running && state !== 'error') set(d.canListen() ? 'listening' : 'paused');
        const next = pending;
        pending = null;
        if (next && running) void segment(next.audio, my, next.endedAt);
      }
    }
  }

  async function start() {
    if (running || starting) return;
    starting = true;
    const my = ++gen;
    set('starting');
    try {
      const st = await d.jarvin.voiceStatus();
      if (my !== gen) return;
      if (!st.available || !st.cached) return fail('Automatic listening needs the local speech model. Open voice settings to download it, then retry.');
      // Start loading the already-cached model while the microphone starts. The
      // first spoken request can then reuse the warm worker instead of loading it.
      void d.jarvin.voiceWarm().then((result) => { if (my !== gen) return; if (!result.ok) d.onLog?.(`Speech model warm-up: ${result.error ?? 'unavailable'}`); else if (result.note) d.onLog?.(result.note); }).catch(() => {});
      running = true;
      activeSensitivity = d.getSettings().voice.sensitivity;
      seg = new Segmenter({ minLevel: speechLevel(activeSensitivity), minSpeechMs: 250, endSilenceMs: 650 });
      const r = d.makeRecorder?.() ?? new Recorder();
      rec = r;
      // `speech` is the trained detector's verdict for the chunk, or undefined to let loudness decide.
      const handle = (chunk: Float32Array, speech?: boolean) => {
        if (!running || my !== gen || !seg) return;
        d.onLevel?.(rec?.level ?? 0, seg.threshold, seg.speaking);
        if (!d.canListen()) {
          seg.reset();
          if (state === 'listening') set('paused');
          return;
        }
        if (state === 'paused') set('listening');
        const wasSpeaking = seg.speaking;
        const utt = seg.feed(chunk, speech);
        if (!wasSpeaking && seg.speaking) d.onSpeechStart?.();
        if (utt) void segment(utt, my);
      };
      // Each chunk is scored by the trained speech detector before the segmenter sees it. Chunks are handled strictly in
      // order. If the detector cannot run, listening carries on with the loudness check and says so once.
      let neural = d.getSettings().voice.detector !== 'loudness' && typeof d.jarvin.voiceVad === 'function';
      let scoring: Promise<void> = Promise.resolve();
      let first = true;
      await r.start((chunk) => {
        if (!neural) return handle(chunk);
        const reset = first; first = false;
        scoring = scoring.then(async () => {
          if (!neural) return handle(chunk);
          let probability: number | null = null;
          try { probability = await d.jarvin.voiceVad(chunk, reset); } catch { /* treated as unavailable */ }
          if (probability === null) {
            neural = false;
            if (my === gen) d.onLog?.('The trained speech detector is not available, so loud sounds are treated as speech (the older check).');
            return handle(chunk);
          }
          if (reset && my === gen) d.onLog?.('Speech detector: trained model (Silero). Fans, typing and music are not treated as speech.');
          handle(chunk, isSpeech(probability, seg?.speaking === true));
        });
      }, false);
      if (my === gen && running) set('listening');
      else r.cancel();
    } catch (e: any) {
      if (my === gen) fail(/denied|permission/i.test(String(e?.message)) ? 'Microphone access was blocked. Allow it in Windows Settings → Privacy → Microphone.' : `Could not open the microphone: ${e?.message ?? e}`);
    } finally { if (my === gen) starting = false; }
  }

  function stop() {
    running = false;
    starting = false;
    gen++;
    rec?.cancel();
    rec = null;
    seg = null;
    working = false;
    pending = null;
    set('off');
  }

  /** Match the running state to the setting. Call after the settings change and once at startup. */
  function sync() {
    const v = d.getSettings()?.voice;
    if (!mutedRead && v) { mutedRead = true; muted = d.startMuted?.() === true; }
    const want = !!v?.enabled && !muted;
    if (want && running && activeSensitivity !== v.sensitivity) stop();
    if (want && !running && !starting && state !== 'error') void start();
    else if (!want && (running || starting || state === 'error')) stop();
  }

  function retry() { if (state === 'error') { set('off'); sync(); } }
  function toggleMute() { muted = !muted; sync(); }
  return { sync, stop, retry, toggleMute, get muted() { return muted; }, get on() { return running; }, get state() { return state; } };
}
