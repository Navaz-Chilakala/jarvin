import { isEchoOfOwnSpeech } from '../shared/echo';
import { icon } from './icons';
import { esc } from './markdown';
import { pickVoice } from '../shared/voicepick';
import { SAMPLE_RATE, acceleratorFromKey, resolveSpokenFile, speechLevel, VOICE_LANGUAGES, WHISPER_SIZES, isEnglishOnly, QWEN_ASR_MODEL, type OverlayMsg, type VoiceResult, type VoiceSettings } from '../shared/voice';
import type { JarvinApi, Settings } from '../shared/types';
import { scrollVoiceDestination, speakable, voiceApproval, type VoiceCommand } from '../shared/voicecmd';
import { createHandsFree, type HandsFreeState } from './handsfree';

/** What spoken commands can do in the app. Implemented in renderer.ts, where the tabs, chat and cards live. */
export interface VoiceActions {
  isRunning(): boolean;
  /** True while the current run is carrying out a task (it has used a tool), as opposed to only replying. */
  isActing?(): boolean;
  abort(): void;
  /** Cancel the interrupted reply and wait until its run has actually stopped. */
  interruptReply(): Promise<void>;
  stopAll(): void;
  clearInput(): void;
  newChat(): void;
  /** The tool call waiting for approval, if any. */
  approval(): { tool: string; decide(d: 'allow' | 'deny'): void } | null;
  /** Opens the undo preview of the latest checkpoint card. */
  startUndo(): 'opened' | 'none';
  /** Finishes a previewed undo. 'overwrite' means files changed since, which only a click may confirm. */
  confirmUndo(): 'done' | 'overwrite' | 'none';
  openFile(rel: string): Promise<void>;
  closeTab(): void;
  nextTab(): void;
  prevTab(): void;
  openSettings(): void;
  closeSettings(): void;
  toggleSidebar(): void;
  scroll(dir: 'up' | 'down', amount?: number): void;
  focusInput(): void;
  /** Selected text in the code editor. */
  selection(): { path: string; text: string } | null;
  sendText(text: string): Promise<void>;
}

interface NeuralVoice {
  status(): Promise<{ available: boolean }>;
  warm(): Promise<{ ok: boolean; error?: string }>;
  synthesize(text: string, rate?: number): Promise<{ pcm: Float32Array; sampleRate: number } | { error: string }>;
}

/** Speaks locally, preferring the optional neural voice and falling back to Windows voices. */
export class Speaker {
  private stream = '';
  private streaming = false;
  private streamedChars = 0;
  private pending: string[] = [];
  private voiceTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private neuralCheck: Promise<boolean> | null = null;
  private neuralFailed = false;
  private neuralBusy = false;
  private audioContext: AudioContext | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private playUntil = 0;
  private interrupted = false;
  private recentSpoken = '';
  private spokeAt = 0;
  /** True when `heard` is probably this speaker's own voice picked up by the microphone, shortly after it spoke. */
  heardOwnVoice(heard: string): boolean { return Date.now() - this.spokeAt < 15000 && isEchoOfOwnSpeech(heard, this.recentSpoken); }
  private audible = false;
  private setSpeaking(value: boolean) { this.audible = value; this.onSpeaking(value); }
  get speaking(): boolean { return this.audible; }
  /** Includes a reply whose text or audio is queued but has not become audible yet. */
  get activeReply(): boolean { return this.streaming || this.audible || this.pending.length > 0 || this.neuralBusy || this.sources.size > 0 || this.busy; }
  beginReply() { this.stop(); this.interrupted = false; }
  interrupt() { this.interrupted = true; this.stop(); }
  constructor(private getVoice: () => VoiceSettings, private onUnavailable: () => void = () => {}, private onSpeaking: (value: boolean) => void = () => {}, private neural?: NeuralVoice) { this.synth?.getVoices(); }
  private get synth(): SpeechSynthesis | null {
    return typeof speechSynthesis === 'undefined' ? null : speechSynthesis;
  }
  speak(markdown: string) {
    this.beginReply();
    this.enqueue(markdown);
  }
  /** Queue complete sentences as tokens arrive, without restarting speech on every token. */
  push(text: string) {
    if (this.interrupted) return;
    const v = this.getVoice();
    if ((!this.synth && !this.neural) || v.speak === 'off') return;
    if (!this.streaming) { this.generation++; this.setSpeaking(false); this.clearPending(); this.synth?.cancel(); this.streaming = true; this.stream = ''; this.streamedChars = 0; }
    const limit = v.speak === 'full' ? 4000 : 400;
    const accepted = text.slice(0, Math.max(0, limit - this.streamedChars));
    this.streamedChars += accepted.length;
    this.stream += accepted;
    for (;;) {
      const boundary = /[.!?](?:\s|$)|\n/.exec(this.stream);
      if (!boundary || (boundary.index + boundary[0].length === this.stream.length && !/\s/.test(boundary[0]))) break;
      const end = boundary.index + boundary[0].length;
      this.enqueue(this.stream.slice(0, end));
      this.stream = this.stream.slice(end);
    }
    if (this.stream.length > 240) {
      const split = this.stream.lastIndexOf(' ', 240);
      if (split > 50) { this.enqueue(this.stream.slice(0, split)); this.stream = this.stream.slice(split + 1); }
    }
  }
  flush() { if (this.streaming && this.stream) { this.enqueue(this.stream); this.stream = ''; } }
  finish() { this.flush(); this.streaming = false; this.streamedChars = 0; }
  private enqueue(markdown: string) {
    const v = this.getVoice();
    const synth = this.synth;
    if ((!synth && !this.neural) || v.speak === 'off') return;
    const text = speakable(markdown, v.speak === 'full' ? 4000 : 400);
    if (!text) return;
    this.recentSpoken = `${this.recentSpoken} ${text}`.slice(-1500); this.spokeAt = Date.now();
    let remaining = text;
    while (remaining.length > 450) {
      const space = remaining.lastIndexOf(' ', 450);
      const end = space > 200 ? space : 450;
      this.pending.push(remaining.slice(0, end)); remaining = remaining.slice(end).trimStart();
    }
    if (remaining) this.pending.push(remaining);
    this.drain();
  }
  private clearPending() {
    if (this.voiceTimer) clearTimeout(this.voiceTimer); this.voiceTimer = null; this.pending = [];
    for (const source of this.sources) { try { source.stop(); } catch { /* already stopped */ } }
    this.sources.clear(); this.playUntil = 0;
  }
  async warmNatural(): Promise<boolean> {
    if (!this.neural || this.getVoice()?.ttsEngine === 'system' || this.getVoice()?.speak === 'off') return false;
    if (!this.neuralCheck) this.neuralCheck = this.neural.status().then(async (status) => {
      if (!status.available) return false;
      const result = await this.neural!.warm();
      return result.ok;
    }).catch(() => false);
    return this.neuralCheck;
  }
  private drain(attempt = 0) {
    if (!this.pending.length || this.voiceTimer || this.neuralBusy) return;
    const synth = this.synth, v = this.getVoice();
    if (v.speak === 'off') { this.clearPending(); return; }
    if (this.neural && v.ttsEngine !== 'system' && !this.neuralFailed) { void this.drainNeural(); return; }
    if (!synth) { this.clearPending(); this.onUnavailable(); return; }
    const local = synth.getVoices().filter((voice) => voice.localService);
    const voice = pickVoice(local, v.speakVoice);
    if (!voice) {
      if (attempt >= 15) { this.clearPending(); this.onUnavailable(); return; }
      this.voiceTimer = setTimeout(() => { this.voiceTimer = null; this.drain(attempt + 1); }, 200);
      return;
    }
    for (const text of this.pending.splice(0)) {
      const generation = this.generation;
      const u = new SpeechSynthesisUtterance(text); u.rate = v.speakRate || 1; u.voice = voice;
      u.onstart = () => { if (generation === this.generation) this.setSpeaking(true); };
      const ended = () => { if (generation === this.generation && !synth.pending) this.setSpeaking(false); };
      u.onend = ended; u.onerror = ended;
      synth.speak(u);
    }
  }
  private async drainNeural() {
    if (!this.neural || this.neuralBusy) return;
    this.neuralBusy = true;
    const generation = this.generation;
    let current = '';
    try {
      if (!await this.warmNatural()) throw new Error('Natural voice unavailable.');
      while (generation === this.generation && this.pending.length && this.getVoice().speak !== 'off' && this.getVoice().ttsEngine !== 'system') {
        current = this.pending.shift()!;
        const result = await this.neural.synthesize(current, Math.min(2, Math.max(.5, this.getVoice().speakRate || 1)));
        if (generation !== this.generation) return;
        if ('error' in result || !(result.pcm instanceof Float32Array) || !result.pcm.length || result.sampleRate < 8000 || result.sampleRate > 48000) throw new Error('Natural voice could not synthesize this reply.');
        this.audioContext ??= new AudioContext();
        if (this.audioContext.state === 'suspended') await this.audioContext.resume();
        if (generation !== this.generation) return;
        if (this.audioContext.state !== 'running') throw new Error('Audio playback is unavailable.');
        const buffer = this.audioContext.createBuffer(1, result.pcm.length, result.sampleRate);
        buffer.getChannelData(0).set(result.pcm);
        const source = this.audioContext.createBufferSource(); source.buffer = buffer; source.connect(this.audioContext.destination);
        const start = Math.max(this.audioContext.currentTime + .02, this.playUntil);
        this.playUntil = start + buffer.duration;
        this.sources.add(source);
        source.onended = () => { this.sources.delete(source); if (generation === this.generation && !this.sources.size && !this.pending.length && !this.neuralBusy) { this.until = Date.now() + 900; this.setSpeaking(false); } };
        this.setSpeaking(true); source.start(start); current = '';
      }
    } catch {
      if (generation === this.generation) { if (current) this.pending.unshift(current); this.neuralFailed = true; }
    } finally {
      this.neuralBusy = false;
      if (this.pending.length) this.drain();
      else if (generation === this.generation && !this.sources.size) this.setSpeaking(false);
    }
  }
  stop() {
    this.generation++; this.setSpeaking(false); this.until = 0;
    this.stream = ''; this.streaming = false; this.streamedChars = 0;
    this.clearPending();
    this.synth?.cancel();
  }
  /** Playback and synthesis activity, including a short tail after audio ends. */
  get busy(): boolean {
    if (this.pending.length || this.neuralBusy || this.sources.size) return true;
    const s = this.synth;
    if (!s) return false;
    if (s.speaking || s.pending) {
      this.until = Date.now() + 900;
      return true;
    }
    return Date.now() < this.until;
  }
  private until = 0;
}


const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Captures the microphone as 16 kHz mono floats. Audio is kept in memory only. */
export class Recorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioNode | null = null;
  private scriptNode: ScriptProcessorNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private chunks: Float32Array[] = [];
  private generation = 0;
  level = 0;
  samples = 0;

  /** `keep: false` is for always-on listening: chunks go to `onChunk` and are not stored, so memory stays flat. */
  async start(onChunk?: (c: Float32Array, level: number) => void, keep = true) {
    const generation = ++this.generation;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (generation !== this.generation) { stream.getTracks().forEach((t) => t.stop()); throw new Error('Recording was cancelled.'); }
    this.stream = stream;
    try {
      this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      const src = this.ctx.createMediaStreamSource(stream);
      const receive = (d: Float32Array) => {
        if (generation !== this.generation) return;
        let s = 0;
        for (let i = 0; i < d.length; i++) s += d[i] * d[i];
        this.level = Math.sqrt(s / d.length);
        if (keep) this.chunks.push(d);
        this.samples += d.length;
        onChunk?.(d, this.level);
      };
      try {
        if (!this.ctx.audioWorklet) throw new Error('AudioWorklet is unavailable.');
        await this.ctx.audioWorklet.addModule(new URL('mic-worklet.js', location.href).toString());
        if (generation !== this.generation) throw new Error('Recording was cancelled.');
        const node = new AudioWorkletNode(this.ctx, 'jarvin-mic', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        node.port.onmessage = (event: MessageEvent<Float32Array>) => { if (event.data instanceof Float32Array) receive(event.data); };
        this.workletNode = node;
        this.node = node;
      } catch (error) {
        if (generation !== this.generation) throw error;
        const node = this.ctx.createScriptProcessor(1024, 1, 1);
        node.onaudioprocess = (event) => receive(new Float32Array(event.inputBuffer.getChannelData(0)));
        this.scriptNode = node;
        this.node = node;
      }
      const mute = this.ctx.createGain();
      mute.gain.value = 0;
      src.connect(this.node);
      this.node.connect(mute).connect(this.ctx.destination);
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      if (generation !== this.generation) throw new Error('Recording was cancelled.');
      if (this.ctx.state !== 'running') throw new Error('The audio system did not start.');
    } catch (error) { this.cancel(); throw error; }
  }

  /** Samples captured so far, without stopping. */
  peek(): Float32Array {
    const out = new Float32Array(this.samples);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }

  stop(): Float32Array {
    const out = this.peek();
    this.cancel();
    return out;
  }

  cancel() {
    this.generation++;
    if (this.scriptNode) this.scriptNode.onaudioprocess = null;
    if (this.workletNode) this.workletNode.port.onmessage = null;
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.node = null;
    this.scriptNode = null;
    this.workletNode = null;
    this.stream = null;
    this.ctx = null;
    this.chunks = [];
    this.samples = 0;
  }
}

export interface VoiceDeps {
  jarvin: JarvinApi;
  getSettings: () => Settings;
  input: HTMLTextAreaElement;
  send: () => Promise<void>;
  toast: (m: string) => void;
  autosize: () => void;
  models: () => string[];
  actions: VoiceActions;
  /** Workspace file names, used to open files by spoken name. */
  files: () => Promise<string[]>;
  onSpeaking?: (speaking: boolean) => void;
  onMicLevel?: (level: number, hearing: boolean) => void;
}

const MAX_SECONDS = 180;
const LIVE_MS = 1500;
const LIVE_WINDOW_S = 20;

export function initVoice(d: VoiceDeps) {
  const mic = $<HTMLButtonElement>('mic');
  const stat = $('vstat');
  let state: 'idle' | 'starting' | 'recording' | 'working' | 'downloading' = 'idle';
  let rec: Recorder | null = null;
  let tick: ReturnType<typeof setInterval> | null = null;
  let hide: ReturnType<typeof setTimeout> | null = null;
  let target: 'jarvin' | 'external' = 'jarvin';
  let fastCommand = false;
  let liveTimer: ReturnType<typeof setInterval> | null = null;
  let liveBusy = false;
  let liveText = '';
  let diagnostic: Recorder | null = null;
  let diagnosticStarting = false;
  let diagnosticWorking = false;
  let diagnosticTimer: ReturnType<typeof setTimeout> | null = null;
  let diagnosticGeneration = 0;
  const overlay = (m: OverlayMsg) => {
    if (target === 'external') void d.jarvin.voiceOverlay(m);
  };

  const show = (html: string, ms = 0, cls = '') => {
    if (hide) clearTimeout(hide);
    stat.hidden = false;
    stat.className = 'vstat ' + cls;
    stat.innerHTML = html;
    if (ms) hide = setTimeout(() => (stat.hidden = true), ms);
  };
  const setState = (s: typeof state) => {
    state = s;
    mic.classList.toggle('rec', s === 'recording');
    mic.classList.toggle('busy', s === 'starting' || s === 'working' || s === 'downloading');
    mic.disabled = s === 'starting' || s === 'working' || s === 'downloading';
    mic.innerHTML = icon(s === 'recording' ? 'stop' : 'mic', 17);
  };
  const speaker = new Speaker(() => d.getSettings().voice, () => show('No local speech voice is available. Check Windows speech settings.', 9000, 'bad'), d.onSpeaking, { status: () => d.jarvin.neuralVoiceStatus(), warm: () => d.jarvin.neuralVoiceWarm(), synthesize: (text, rate) => d.jarvin.neuralVoiceSynthesize(text, rate) });
  let manualInterruption: Promise<string | null> | null = null;
  const voiceOn = () => d.getSettings()?.voice?.enabled ?? true;
  const syncVisibility = () => {
    mic.hidden = !voiceOn();
    hfBtn.hidden = !voiceOn();
  };

  d.jarvin.onVoiceProgress((p) => {
    if (state !== 'downloading') return;
    if (p.state === 'downloading') show(`Downloading speech model… ${p.pct ?? 0}%<span class="bar"><i style="width:${p.pct ?? 0}%"></i></span>`);
    else if (p.state === 'loading') show('Loading speech model…');
  });

  async function ensureModel(): Promise<boolean> {
    const st = await d.jarvin.voiceStatus();
    if (!st.available) {
      show(esc(st.error ?? 'Speech engine missing.'), 9000, 'bad');
      return false;
    }
    if (st.cached) return true;
    if (d.getSettings().voice.offlineOnly) {
      show('Offline lock is on and the speech model is not downloaded. Turn the lock off in Settings → Voice.', 9000, 'bad');
      return false;
    }
    return new Promise<boolean>((resolve) => {
      show(
        `Voice needs a one-time download of the speech model (<b>${esc(st.model)}</b>, about ${st.sizeMB} MB) from ${st.model === QWEN_ASR_MODEL ? 'the sherpa-onnx GitHub release' : 'huggingface.co'}. After that it works fully offline. <button type="button" class="vbtn" id="vOk">Download</button> <button type="button" class="vbtn ghost" id="vNo">Not now</button>`,
      );
      $('vNo').onclick = () => {
        stat.hidden = true;
        resolve(false);
      };
      $('vOk').onclick = async () => {
        setState('downloading');
        show('Starting download…');
        const r = await d.jarvin.voiceDownload();
        setState('idle');
        if (!r.ok) {
          show(esc(r.error ?? 'Download failed.'), 9000, 'bad');
          resolve(false);
        } else {
          show('Speech model ready. Click the mic to start.', 4000, 'ok');
          resolve(false);
        }
      };
    });
  }

  async function start(to: 'jarvin' | 'external' = 'jarvin', withLive = true) {
    if (diagnosticStarting || diagnostic || diagnosticWorking) return d.toast('Finish the microphone check first.');
    if (!voiceOn()) return d.toast('Voice is turned off in Settings → Voice');
    if (state !== 'idle') return;
    mic.classList.remove('err');
    setState('starting');
    target = to;
    fastCommand = to === 'jarvin' && !withLive;
    if (speaker.activeReply || d.actions.isRunning()) {
      speaker.interrupt();
      manualInterruption = d.actions.interruptReply().then(() => null, (error) => String(error?.message ?? error));
    } else speaker.stop();
    let modelReady = false;
    try { modelReady = await ensureModel(); }
    catch (error: any) { show(esc(String(error?.message ?? error)), 9000, 'bad'); }
    if (!modelReady) {
      manualInterruption = null;
      setState('idle');
      overlay({ state: 'error', text: 'Speech model is not ready. Open Jarvin to set it up.' });
      return;
    }
    // A pet command can load the cached recognizer while the user is speaking.
    if (fastCommand) void d.jarvin.voiceWarm().catch(() => {});
    try {
      rec = new Recorder();
      await rec.start();
    } catch (e: any) {
      manualInterruption = null;
      rec?.cancel();
      rec = null;
      setState('idle');
      mic.classList.add('err');
      overlay({ state: 'error', text: 'Could not open the microphone.' });
      show(esc(/denied|permission/i.test(String(e?.message)) ? 'Microphone access was blocked. Allow it in Windows Settings → Privacy → Microphone.' : `Could not open the microphone: ${e?.message ?? e}`), 0, 'bad');
      return;
    }
    setState('recording');
    liveText = '';
    const t0 = Date.now();
    let lastSpeech = t0;
    let n = 0;
    const draw = () => {
      const s = Math.floor((Date.now() - t0) / 1000);
      const lv = Math.min(100, Math.round((rec?.level ?? 0) * 600));
      const level = rec?.level ?? 0;
      if (level > 0.008) lastSpeech = Date.now();
      const silenceMs = Date.now() - lastSpeech;
      const hint = target === 'external' ? 'press the hotkey again to finish' : 'mic to finish · Esc cancels';
      const live = liveText ? `<span class="vlive">${esc(liveText.slice(-90))}</span>` : '';
      show(`<span class="recdot"></span>Listening… ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} <span class="meter"><i style="width:${lv}%"></i></span> <span class="vhint">${hint}</span>${live}`, 0, 'live');
      if (++n % 1 === 0) overlay({ state: 'listening', level, text: liveText });
      if (rec && rec.samples >= SAMPLE_RATE * 2 && silenceMs >= (fastCommand ? 850 : 1500)) void finish();
      if (s >= MAX_SECONDS) void finish();
    };
    draw();
    tick = setInterval(draw, 100);
    if (withLive && d.getSettings().voice.live) liveTimer = setInterval(() => void livePartial(), LIVE_MS);
  }

  /** Interim transcript of the last few seconds, shown while the user is still talking. Skipped while one is already running. */
  async function livePartial() {
    if (liveBusy || state !== 'recording' || !rec || rec.samples < SAMPLE_RATE * 1.5) return;
    liveBusy = true;
    try {
      const all = rec.peek();
      const tail = all.length > SAMPLE_RATE * LIVE_WINDOW_S ? all.subarray(all.length - SAMPLE_RATE * LIVE_WINDOW_S) : all;
      const t = await d.jarvin.voicePartial(tail);
      if (t && state === 'recording') liveText = t;
    } catch {
      /* live text is a nicety; the final transcript is what counts */
    } finally {
      liveBusy = false;
    }
  }

  function endTick() {
    if (tick) clearInterval(tick);
    if (liveTimer) clearInterval(liveTimer);
    tick = liveTimer = null;
  }

  function cancel() {
    endTick();
    manualInterruption = null;
    rec?.cancel();
    rec = null;
    setState('idle');
    overlay({ state: 'hidden' });
    show('Cancelled.', 1200);
  }

  async function finish() {
    if (state !== 'recording' || !rec) return;
    endTick();
    const audio = rec.stop();
    rec = null;
    setState('working');
    show('Transcribing…');
    overlay({ state: 'working' });
    const to = target;
    let r: VoiceResult | { error: string };
    try { r = await d.jarvin.voiceTranscribe(audio, { external: to === 'external', fast: fastCommand }); }
    catch (error: any) { r = { error: String(error?.message ?? error) }; }
    setState('idle');
    const stopped = manualInterruption;
    manualInterruption = null;
    if ('error' in r) {
      mic.classList.add('err');
      overlay({ state: 'error', text: r.error.slice(0, 80) });
      return show(esc(r.error), 0, 'bad');
    }
    const stopError = await stopped;
    if (stopError) return show(esc(stopError), 6000, 'bad');
    if (to === 'external') return handleExternal(r);
    await handle(r);
  }

  /** Dictation started from the system-wide hotkey while another app was focused: paste the text there. */
  async function handleExternal(r: VoiceResult) {
    if (r.silent || !r.text) {
      overlay({ state: 'error', text: "Didn't catch anything." });
      return show("Didn't catch anything. Try again a little closer to the mic.", 3000);
    }
    const p = await d.jarvin.voicePaste(r.text);
    if (p.ok && !p.copied) overlay({ state: 'done', text: r.text.slice(0, 60) });
    else overlay({ state: p.ok ? 'done' : 'error', text: p.error ?? 'Copied. Press Ctrl+V to paste.' });
    const how = r.applied ? ` · ${esc(r.applied)}` : '';
    show(p.error ? esc(p.error) : p.copied ? `Copied to the clipboard${how}. Press Ctrl+V to paste.` : `Pasted into the other app${how} · ${(r.ms / 1000).toFixed(1)}s`, 3500, p.error ? 'warn' : 'ok');
  }

  /** Runs a spoken command. Returns a short message, or null when the words should be typed as normal dictation instead. */
  async function runCommand(c: VoiceCommand, said: string): Promise<{ msg: string; cls?: string } | null> {
    const a = d.actions;
    const v = d.getSettings().voice;
    switch (c.type) {
      case 'stop':
        speaker.interrupt();
        if (a.isRunning()) a.abort();
        return { msg: 'Stopped.' };
      case 'stopAll':
        speaker.interrupt();
        a.stopAll();
        return { msg: 'Stopping active work.' };
      case 'send':
        if (!d.input.value.trim()) return { msg: 'Nothing to send yet.', cls: 'warn' };
        void d.send();
        return { msg: 'Sent.' };
      case 'clear':
        a.clearInput();
        return { msg: 'Cleared.' };
      case 'newChat':
        a.newChat();
        return { msg: 'New chat.' };
      case 'undo':
        return a.startUndo() === 'opened' ? { msg: 'Showing what undo will change. Say "confirm" to undo, or click Undo.' } : { msg: 'Nothing to undo.', cls: 'warn' };
      case 'confirm': {
        const r = a.confirmUndo();
        if (r === 'done') return { msg: 'Undoing…' };
        if (r === 'overwrite') return { msg: 'Some files changed since Jarvin wrote them. Click "Overwrite anyway" yourself to confirm.', cls: 'warn' };
        return { msg: 'Nothing waiting to confirm. Say "undo" first.', cls: 'warn' };
      }
      case 'approve':
      case 'deny': {
        const p = a.approval();
        if (!p) return { msg: 'Nothing is waiting for approval.', cls: 'warn' };
        if (c.type === 'deny') {
          p.decide('deny');
          return { msg: 'Denied.' };
        }
        if (!v.voiceApprove) return { msg: 'Approving by voice is off. Turn it on in Settings → Voice, or click Allow.', cls: 'warn' };
        if (voiceApproval(c, p.tool) === 'needs-phrase') return { msg: 'This one runs a command or tool. Say "approve command" to allow it.', cls: 'warn' };
        p.decide('allow');
        return { msg: 'Approved.', cls: 'ok' };
      }
      case 'openFile': {
        const rel = resolveSpokenFile(await d.files(), c.name);
        if (!rel) return null;
        await a.openFile(rel);
        return { msg: `Opened ${rel}` };
      }
      case 'closeTab':
        a.closeTab();
        return { msg: 'Closed tab.' };
      case 'nextTab':
        a.nextTab();
        return { msg: 'Next tab.' };
      case 'prevTab':
        a.prevTab();
        return { msg: 'Previous tab.' };
      case 'openSettings':
        a.openSettings();
        return { msg: 'Settings.' };
      case 'closeSettings':
        a.closeSettings();
        return { msg: 'Closed settings.' };
      case 'toggleSidebar':
        a.toggleSidebar();
        return { msg: 'Sidebar toggled.' };
      case 'scroll':
      case 'scrollChat':
        if (c.type === 'scroll' && c.amount === 0) return { msg: 'No scrolling requested.' };
        if (c.type === 'scroll' && c.amount !== undefined && c.amount > 10) return { msg: 'Please request between one and ten scroll steps.', cls: 'warn' };
        if (scrollVoiceDestination(c, document.hasFocus()) === 'desktop') {
          await a.sendText(`Scroll ${c.dir} in the currently focused application by ${c.type === 'scroll' ? c.amount ?? 3 : 3} steps.`);
          return { msg: `Sending scroll ${c.dir} to the active window.` };
        }
        a.scroll(c.dir, c.type === 'scroll' ? c.amount : undefined);
        return { msg: c.dir === 'up' ? 'Scrolled chat up.' : 'Scrolled chat down.' };
      case 'focusInput':
        a.focusInput();
        return { msg: 'Ready for typing.' };
      case 'edit': {
        const sel = a.selection();
        if (sel) {
          await a.sendText(`${c.instruction}\n\nThis applies to the selected text in ${sel.path}:\n\`\`\`\n${sel.text.slice(0, 6000)}\n\`\`\``);
          return { msg: 'Sent to Jarvin with your selection.' };
        }
        const draft = d.input.value.trim();
        if (!draft) return null;
        show('Rewriting your message…');
        const r = await d.jarvin.voiceRewrite(draft, c.instruction);
        if ('error' in r) return { msg: r.error, cls: 'bad' };
        d.input.value = r.text;
        d.autosize();
        return { msg: 'Updated your message.', cls: 'ok' };
      }
    }
    void said;
    return null;
  }

  async function handle(r: VoiceResult, automatic = false) {
    if (r.silent || !r.text) return show("Didn't catch anything. Try again a little closer to the mic.", 3000);
    if (r.command) {
      try {
        const out = await runCommand(r.command, r.text);
        if (out) return show(esc(out.msg), 3500, out.cls ?? 'ok');
      } catch (e: any) {
        return show(esc(String(e?.message ?? e)), 6000, 'bad');
      }
    }
    if (automatic) {
      await d.actions.sendText(r.text);
      return;
    }
    const cur = d.input.value;
    d.input.value = cur + (cur && !/\s$/.test(cur) ? ' ' : '') + r.text;
    d.autosize();
    d.input.focus();
    d.input.setSelectionRange(d.input.value.length, d.input.value.length);
    const label = r.cleanup === 'llm' ? 'cleaned by AI' : r.cleanup === 'basic' ? 'basic cleanup' : 'as spoken';
    show(r.note ? esc(r.note) : `Done in ${(r.ms / 1000).toFixed(1)}s · ${label}`, r.note ? 8000 : 2200, r.note ? 'warn' : 'ok');
    if (d.getSettings().voice.autoSend) void d.send();
  }

  /* ---- automatic listening ---- */
  const hfBtn = $<HTMLButtonElement>('hfBtn');
  const hfLog: string[] = [];
  /** Adds a line to the on-screen voice log (kept in memory only, last 14 lines). */
  const logVoice = (line: string) => {
    hfLog.push(line.startsWith('   →') ? line : `${new Date().toLocaleTimeString()}  ${line}`);
    if (hfLog.length > 14) hfLog.shift();
    const box = document.getElementById('vHfLog');
    if (box) box.textContent = hfLog.join('\n');
  };
  let lastIgnoredNote = 0;
  // Speech onset fires on any loud sound (keyboard, fan, other people) before a transcript exists, so it never
  // cancels a task. With the name required it does not even silence Jarvin's voice: only "Hey Jarvin …" or "stop"
  // does, once transcribed. Without the name requirement, onset silences Jarvin so it can hear you.
  const silenceOwnVoice = () => {
    if (!speaker.activeReply || d.getSettings().voice.wakeWord !== false) return;
    speaker.interrupt();
    show('Listening to you…', 1500, 'ok');
  };
  const hf = createHandsFree({
    jarvin: d.jarvin,
    getSettings: d.getSettings,
    // Even with the microphone on, Jarvin acts only on speech that starts with "Hey Jarvin" (or "Jarvin"/"Jarvis").
    // Everything else, including replies, room talk, music and TV, is ignored. There are no exceptions after a reply or
    // while Jarvin is speaking, because any such window would let stray sound through. "Stop" alone is still obeyed.
    wake: () => d.getSettings().voice.wakeWord !== false,
    startMuted: () => d.getSettings().voice.listenOnStart !== true,
    onWake: () => show('Yes? Listening…', 2500, 'ok'),
    // Ignored speech is noted quietly in the voice status line (and the voice log), not as a pop-up: with the name
    // required, room sound is ignored all the time and must not nag.
    onIgnored: (heard) => {
      if (heard.trim().split(/\s+/).length < 2 || Date.now() - lastIgnoredNote < 6000) return;
      lastIgnoredNote = Date.now();
      show(esc(`Ignored "${heard.slice(0, 50)}". Start with "Hey Jarvin".`), 4000, 'ok');
    },
    canListen: () => state === 'idle',
    busyReason: () => 'you are recording or Jarvin is transcribing',
    onSpeechStart: silenceOwnVoice,
    onLog: (line) => {
      // The accurate recognizer being blocked must never pass unnoticed: on the user's voice the fallback gets four
      // times as many words wrong and hears the name 4 times in 10 instead of 10.
      if (/could not load on this PC/.test(line)) { const warn = 'Windows blocked the accurate speech engine this time. Jarvin is using a weaker one and will mishear more. Restart Jarvin to try again.'; show(esc(warn), 15000, 'bad'); d.toast(warn); }
      logVoice(line);
    },
    onLevel: (level, thr, speaking) => {
      d.onMicLevel?.(Math.min(1, level / Math.max(thr * 3, .03)), speaking);
      const t = document.getElementById('vHfLevel');
      if (t) t.textContent = `Mic level ${level.toFixed(3)} · speech counts above ${thr.toFixed(3)}${speaking ? ' · hearing speech' : ''}`;
      const b = document.getElementById('vHfBar');
      if (b) (b as HTMLElement).style.width = `${Math.min(100, Math.round((level / Math.max(thr * 2, 0.02)) * 100))}%`;
    },
    onResult: (r) => {
      if (speaker.heardOwnVoice(r.text)) { logVoice('   → ignored: that was my own voice.'); show('Ignored my own voice.', 900, 'ok'); return; }
      // Once Jarvin is carrying out a task (it has used a tool), only "stop" interrupts it. Other speech and sounds
      // are left alone so the work continues. While it is only talking, speaking over it still replaces the reply.
      if (d.actions.isActing?.()) {
        const kind = r.command?.type;
        const isStop = kind === 'stop' || kind === 'stopAll' || /^(?:jarvin[,\s]+)?(?:please\s+)?(?:stop|cancel|abort|wait|pause|quiet|be quiet|enough)(?:\s+(?:it|that|now|please|everything|all))*[\s.!]*$/i.test(r.text.trim());
        if (!isStop) { logVoice('   → ignored: a task is running. Say "stop" to interrupt it.'); show('Working. Say "stop" to interrupt.', 2500, 'ok'); return; }
        logVoice('   → stopping the task.');
      } else logVoice('   → running it.');
      show(`Heard: ${esc(r.text.slice(0, 80))}`, 1200, 'ok');
      const stopped = d.actions.isRunning() || speaker.activeReply
        ? (speaker.interrupt(), d.actions.interruptReply().then(() => null, (error: any) => String(error?.message ?? error)))
        : null;
      void (async () => { const error = await stopped; if (error) throw new Error(error); await handle(r, true); })().catch((error: any) => show(esc(String(error?.message ?? error)), 6000, 'bad'));
    },
    onState: (s: HandsFreeState, msg?: string) => {
      const on = s !== 'off' && s !== 'error';
      hfBtn.classList.toggle('on', on);
      hfBtn.classList.toggle('paused', s === 'paused' || s === 'starting');
      hfBtn.classList.toggle('work', s === 'working');
      hfBtn.classList.toggle('err', s === 'error');
      hfBtn.setAttribute('aria-pressed', String(on));
      hfBtn.dataset.state = s;
      $('hfLabel').textContent = s === 'error' ? 'Retry mic' : s === 'starting' ? 'Starting mic…' : s === 'paused' ? 'Mic paused' : s === 'working' ? 'Hearing…' : on ? 'Listening' : 'Mic off';
      hfBtn.title =
        s === 'error' ? `Microphone stopped: ${msg} Click to retry.` : on ? 'Microphone is on. Click to turn it off.' : 'Microphone is off. Click to turn it on.';
      if (s === 'error' && msg) show(esc(msg), 9000, 'bad');
    },
  });
  const toggleListening = () => { if (hf.state === 'error') hf.retry(); else hf.toggleMute(); };
  hfBtn.onclick = toggleListening;
  const syncHandsFree = () => {
    hfBtn.hidden = !voiceOn();
    if (diagnosticStarting || diagnostic || diagnosticWorking || voiceTestOpen) hf.stop(); else hf.sync();
  };
  // While the voice test is open the user reads commands aloud on purpose, so automatic listening must be off.
  let voiceTestOpen = false;
  const setVoiceTest = (open: boolean) => { voiceTestOpen = open; syncHandsFree(); };

  const diagnosticButton = $<HTMLButtonElement>('vDiagBtn');
  const diagnosticState = $('vDiagState');
  const diagnosticResult = $<HTMLPreElement>('vDiagResult');
  const diagnosticBar = $<HTMLElement>('vDiagBar');
  const resetDiagnosticButton = () => { diagnosticButton.disabled = false; diagnosticButton.textContent = 'Start voice check'; diagnosticButton.setAttribute('aria-pressed', 'false'); diagnosticBar.style.width = '0%'; };
  const cancelDiagnostic = () => {
    diagnosticGeneration++;
    if (diagnosticTimer) clearTimeout(diagnosticTimer);
    diagnosticTimer = null;
    diagnostic?.cancel();
    diagnostic = null;
    diagnosticStarting = false;
    diagnosticWorking = false;
    resetDiagnosticButton();
    diagnosticState.textContent = 'Ready for a short phrase.';
    hf.sync();
  };
  const stopDiagnostic = async () => {
    const recorder = diagnostic;
    if (!recorder) return;
    const generation = diagnosticGeneration;
    diagnostic = null;
    if (diagnosticTimer) clearTimeout(diagnosticTimer);
    diagnosticTimer = null;
    const audio = recorder.stop();
    diagnosticWorking = true;
    diagnosticButton.disabled = true;
    diagnosticState.textContent = 'Checking speech locally…';
    try {
      const result = await d.jarvin.voiceDiagnose(audio);
      if (generation !== diagnosticGeneration) return;
      if ('error' in result) throw new Error(result.error);
      const heard = result.raw.trim() || '(nothing recognized)';
      const filtered = result.filtered.trim() || '(empty after noise filtering)';
      diagnosticResult.textContent = `Model output: ${heard}\nAfter noise filtering: ${filtered}\nAfter basic cleanup: ${result.basic || '(empty)'}\nAudio above threshold: ${result.voicedMs} ms total at ${result.threshold.toFixed(3)} · level gate: ${result.backendSpeech ? 'passed' : 'no sustained speech'}\nSilero voice check: ${result.vadSpeech === null ? 'unavailable for this model' : result.vadSpeech ? 'speech detected' : 'no speech detected'}\nInput level: ${result.level.toFixed(3)} RMS · peak ${result.peak.toFixed(3)}\nRecording: ${(result.durationMs / 1000).toFixed(1)} s · recognition: ${(result.decodeMs / 1000).toFixed(1)} s\nModel: ${result.model}`;
      diagnosticResult.hidden = false;
      diagnosticState.textContent = result.raw.trim() ? 'Compare “Model output” with what you said.' : 'No words recognized. Check the input level and try again.';
    } catch (error: any) {
      if (generation === diagnosticGeneration) diagnosticState.textContent = `Voice check failed: ${String(error?.message ?? error)}`;
    } finally {
      if (generation === diagnosticGeneration) { diagnosticWorking = false; resetDiagnosticButton(); hf.sync(); }
    }
  };
  diagnosticButton.onclick = async () => {
    if (diagnostic) return void stopDiagnostic();
    if (diagnosticStarting || diagnosticWorking || state !== 'idle' || d.actions.isRunning() || speaker.activeReply) {
      diagnosticState.textContent = 'Finish the current recording or reply first.';
      return;
    }
    const generation = ++diagnosticGeneration;
    diagnosticStarting = true;
    diagnosticButton.disabled = true;
    diagnosticState.textContent = 'Checking local speech model…';
    let status: Awaited<ReturnType<JarvinApi['voiceStatus']>>;
    try { status = await d.jarvin.voiceStatus(); }
    catch (error: any) {
      if (generation === diagnosticGeneration) { diagnosticStarting = false; resetDiagnosticButton(); diagnosticState.textContent = `Voice check unavailable: ${String(error?.message ?? error)}`; }
      return;
    }
    if (generation !== diagnosticGeneration) return;
    if (!status.available || !status.cached) { diagnosticStarting = false; resetDiagnosticButton(); diagnosticState.textContent = status.error ?? 'Download the selected speech model first.'; return; }
    diagnosticStarting = false;
    const recorder = new Recorder();
    diagnostic = recorder;
    diagnosticResult.hidden = true;
    diagnosticButton.disabled = true;
    diagnosticState.textContent = 'Opening microphone…';
    hf.stop();
    try {
      let updated = 0;
      await recorder.start((_chunk, level) => {
        if (generation !== diagnosticGeneration || performance.now() - updated < 80) return;
        updated = performance.now();
        diagnosticBar.style.width = `${Math.min(100, Math.round(level / Math.max(speechLevel(d.getSettings().voice.sensitivity) * 2, .02) * 100))}%`;
        diagnosticState.textContent = `Listening… input level ${level.toFixed(3)}. Press Stop when done.`;
      });
      if (generation !== diagnosticGeneration) return;
      diagnosticButton.disabled = false;
      diagnosticButton.textContent = 'Stop and show words';
      diagnosticButton.setAttribute('aria-pressed', 'true');
      diagnosticTimer = setTimeout(() => void stopDiagnostic(), 10_000);
    } catch (error: any) {
      if (generation !== diagnosticGeneration) return;
      diagnostic = null;
      recorder.cancel();
      resetDiagnosticButton();
      diagnosticState.textContent = `Could not open microphone: ${String(error?.message ?? error)}`;
      hf.sync();
    }
  };

  const toggle = (options?: { live?: boolean }) => {
    if (state === 'recording') void finish();
    else if (state === 'idle') void start('jarvin', options?.live !== false);
  };
  mic.onclick = () => toggle();
  d.jarvin.onVoiceHotkey(({ jarvinFocused }) => {
    if (state === 'recording') void finish();
    else if (state === 'idle') void start(jarvinFocused || !d.getSettings().voice.insertIntoApp ? 'jarvin' : 'external');
  });
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && state === 'recording') {
        e.stopPropagation();
        e.preventDefault();
        cancel();
      } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        toggle();
      }
    },
    true,
  );
  // End-to-end tests feed recognised speech in directly (a headless machine has no way to speak commands).
  if (new URLSearchParams(location.search).has('e2e')) (window as any).__voiceHandle = (r: VoiceResult, automatic = false) => handle(r, automatic);
  return { syncVisibility, syncHandsFree, setVoiceTest, toggle, toggleListening, cancelDiagnostic, beginSpeech: () => speaker.beginReply(), isBusy: () => state !== 'idle' || diagnosticStarting || !!diagnostic || diagnosticWorking, speak: (t: string) => speaker.speak(t), pushSpeech: (t: string) => speaker.push(t), flushSpeech: () => speaker.flush(), finishSpeech: () => speaker.finish(), stopSpeaking: () => speaker.interrupt(), warmNatural: () => speaker.warmNatural() };
}

/* ---------------- settings dialog ---------------- */

const fill = (el: HTMLSelectElement, items: [string, string][], value: string) => {
  el.innerHTML = items.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
  el.value = value;
};

export function fillVoiceSettings(v: VoiceSettings, models: string[]) {
  $<HTMLInputElement>('vEnabled').checked = v.enabled;
  $<HTMLSelectElement>('vSensitivity').value = v.sensitivity || 'high';
  fill($<HTMLSelectElement>('vSize'), WHISPER_SIZES.map((s) => [s.id, `${s.label} (~${s.mb} MB)`]), v.size);
  fill($<HTMLSelectElement>('vLang'), VOICE_LANGUAGES, v.language);
  $<HTMLInputElement>('vTranslate').checked = v.translate;
  $<HTMLSelectElement>('vMode').value = v.mode;
  $<HTMLSelectElement>('vTone').value = v.tone;
  fill($<HTMLSelectElement>('vCleanModel'), [['', 'Same as chat model'], ...models.map((m) => [m, m] as [string, string])], v.cleanupModel);
  $<HTMLTextAreaElement>('vDict').value = v.dictionary ?? '';
  $<HTMLTextAreaElement>('vSnip').value = v.snippets ?? '';
  $<HTMLTextAreaElement>('vApps').value = v.appRules ?? '';
  $<HTMLInputElement>('vMcp').checked = !!v.mcpServer;
  $<HTMLInputElement>('vMcpMic').checked = !!v.mcpMic;
  $<HTMLInputElement>('vMcpPort').value = String(v.mcpPort || 39517);
  $<HTMLInputElement>('vCloud').checked = v.allowCloudCleanup;
  $<HTMLInputElement>('vAuto').checked = v.autoSend;
  $<HTMLInputElement>('vKeep').checked = v.keepHistory;
  $<HTMLInputElement>('vOffline').checked = v.offlineOnly;
  $<HTMLInputElement>('vHotkey').value = v.hotkey;
  $<HTMLInputElement>('vOverlay').checked = v.overlay;
  $<HTMLInputElement>('vLive').checked = v.live;
  $<HTMLInputElement>('vInsert').checked = v.insertIntoApp;
  $<HTMLInputElement>('vCommands').checked = v.commands;
  $<HTMLInputElement>('vApprove').checked = v.voiceApprove;
  $<HTMLInputElement>('vWake').checked = v.wakeWord !== false;
  $<HTMLSelectElement>('vSpeak').value = v.speak;
  $<HTMLSelectElement>('vSpeechEngine').value = v.ttsEngine || 'auto';
}

export function collectVoiceSettings(base: VoiceSettings): VoiceSettings {
  const lang = $<HTMLSelectElement>('vLang').value;
  const translate = $<HTMLInputElement>('vTranslate').checked && lang !== 'english';
  return {
    ...base,
    enabled: $<HTMLInputElement>('vEnabled').checked,
    sensitivity: $<HTMLSelectElement>('vSensitivity').value as VoiceSettings['sensitivity'],
    size: $<HTMLSelectElement>('vSize').value as VoiceSettings['size'],
    language: lang,
    translate,
    mode: $<HTMLSelectElement>('vMode').value as VoiceSettings['mode'],
    tone: $<HTMLSelectElement>('vTone').value as VoiceSettings['tone'],
    cleanupModel: $<HTMLSelectElement>('vCleanModel').value,
    dictionary: $<HTMLTextAreaElement>('vDict').value,
    snippets: $<HTMLTextAreaElement>('vSnip').value,
    appRules: $<HTMLTextAreaElement>('vApps').value,
    mcpServer: $<HTMLInputElement>('vMcp').checked,
    mcpMic: $<HTMLInputElement>('vMcpMic').checked,
    mcpPort: Math.min(65535, Math.max(1024, Number($<HTMLInputElement>('vMcpPort').value) || 39517)),
    allowCloudCleanup: $<HTMLInputElement>('vCloud').checked,
    autoSend: $<HTMLInputElement>('vAuto').checked,
    keepHistory: $<HTMLInputElement>('vKeep').checked,
    offlineOnly: $<HTMLInputElement>('vOffline').checked,
    hotkey: $<HTMLInputElement>('vHotkey').value.trim(),
    overlay: $<HTMLInputElement>('vOverlay').checked,
    live: $<HTMLInputElement>('vLive').checked,
    insertIntoApp: $<HTMLInputElement>('vInsert').checked,
    commands: $<HTMLInputElement>('vCommands').checked,
    voiceApprove: $<HTMLInputElement>('vApprove').checked,
    wakeWord: $<HTMLInputElement>('vWake').checked,
    speak: $<HTMLSelectElement>('vSpeak').value as VoiceSettings['speak'],
    ttsEngine: $<HTMLSelectElement>('vSpeechEngine').value as VoiceSettings['ttsEngine'],
  };
}

export async function refreshVoiceStatus(jarvin: JarvinApi, v: VoiceSettings) {
  const st = await jarvin.voiceStatus();
  const note = !isEnglishOnly(v) ? ' Multilingual model.' : '';
  const hk = $('vHotkeyStat');
  hk.textContent = !v.hotkey ? 'Hotkey is off.' : st.hotkey?.registered ? `Active: ${v.hotkey} works in any app.` : st.hotkey?.error ?? 'Not active yet. Save settings to apply.';
  hk.className = 'hint' + (v.hotkey && st.hotkey && !st.hotkey.registered ? ' bad' : '');
  $('vStatus').textContent = !st.available ? st.error ?? '' : st.cached ? `Model ready: ${st.model}.${note}` : `Model not downloaded yet (${st.model}, ~${st.sizeMB} MB).${note}`;
  $<HTMLButtonElement>('vDownload').hidden = !st.available || st.cached;
}

export async function renderVoiceHistory(jarvin: JarvinApi, list = null as import('../shared/voice').VoiceHistoryEntry[] | null) {
  const h = list ?? (await jarvin.voiceHistory());
  const box = $('vHist');
  box.innerHTML = h.length
    ? h
        .slice(0, 30)
        .map(
          (e) =>
            `<div class="permrow" data-id="${esc(e.id)}"><code title="${esc(e.raw)}">${esc(e.text.length > 90 ? e.text.slice(0, 90) + '…' : e.text)}</code><button type="button" class="btn sm" data-act="copy">Copy</button><button type="button" class="btn sm" data-act="del">Delete</button></div>`,
        )
        .join('')
    : '<div class="hint">Nothing yet.</div>';
  box.onclick = async (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('button[data-act]');
    if (!b) return;
    const id = b.closest<HTMLElement>('.permrow')!.dataset.id!;
    if (b.dataset.act === 'copy') {
      const e = h.find((x) => x.id === id);
      if (e) void navigator.clipboard.writeText(e.text);
    } else void renderVoiceHistory(jarvin, await jarvin.voiceHistoryDelete(id));
  };
}

/** Turns the hotkey field into a "press the keys" capture box. Esc clears; Backspace removes the shortcut. */
export function wireHotkeyField(onChange: () => void) {
  const f = $<HTMLInputElement>('vHotkey');
  f.readOnly = true;
  f.onkeydown = (e) => {
    if (e.key === 'Tab') return;
    e.preventDefault();
    if (e.key === 'Escape') return f.blur();
    if (e.key === 'Backspace' || e.key === 'Delete') f.value = '';
    else {
      const a = acceleratorFromKey(e);
      if (!a) return;
      f.value = a;
    }
    onChange();
  };
}
