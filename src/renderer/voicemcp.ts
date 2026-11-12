import type { JarvinApi, Settings } from '../shared/types';
import { SAMPLE_RATE } from '../shared/voice';
import { Recorder } from './voiceui';
import { decodeTo16k, transcribeAudio } from './transcribe';
import { clampListen, clientConfig } from '../shared/voicemcpcfg';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Fill the Settings → Voice agent-server panel with the current state. */
export async function refreshVoiceMcpPanel(jarvin: JarvinApi) {
  const info = await jarvin.voiceMcpInfo();
  const on = el<HTMLInputElement>('vMcp').checked;
  el('vMcpStat').textContent = info.error ? info.error : info.running ? `Running on 127.0.0.1:${info.port}` : on ? 'Starting… (save settings if this stays off)' : 'Off';
  el<HTMLTextAreaElement>('vMcpCfg').value = clientConfig(info.port || Number(el<HTMLInputElement>('vMcpPort').value) || 39517, info.token);
}

export function wireVoiceMcpPanel(jarvin: JarvinApi, toast: (m: string) => void) {
  el('vMcpCopy').onclick = async () => {
    const ta = el<HTMLTextAreaElement>('vMcpCfg');
    try {
      await navigator.clipboard.writeText(ta.value);
      toast('Config copied');
    } catch {
      ta.focus();
      ta.select();
      toast(document.execCommand('copy') ? 'Config copied' : 'Select the text and press Ctrl+C');
    }
  };
  el('vMcpRegen').onclick = async () => {
    if (!confirm('Make a new token? Agents using the old one will stop working until you give them the new config.')) return;
    await jarvin.voiceMcpRegen();
    await refreshVoiceMcpPanel(jarvin);
  };
}

/** Answers requests that other agents make through Jarvin's local voice MCP server. */
export function initVoiceMcp(d: { jarvin: JarvinApi; getSettings: () => Settings; busy: () => boolean; toast: (m: string) => void }) {
  async function listen(seconds: number): Promise<string> {
    if (d.busy()) throw new Error('The user is using the microphone in Jarvin right now. Try again in a moment.');
    const st = await d.jarvin.voiceStatus();
    if (!st.available) throw new Error(st.error ?? 'Speech engine is not installed.');
    if (!st.cached) throw new Error('The speech model is not downloaded yet. The user must download it in Jarvin: Settings → Voice.');
    const rec = new Recorder();
    try {
      await rec.start();
    } catch (e) {
      throw new Error(/denied|permission/i.test(String((e as Error)?.message)) ? 'Microphone access is blocked in Windows privacy settings.' : `Could not open the microphone: ${(e as Error)?.message ?? e}`);
    }
    d.toast('An agent is listening through your microphone…');
    const t0 = Date.now();
    let lastSpeech = t0;
    let spoke = false;
    const pill = () => d.jarvin.voiceOverlay({ state: 'listening', level: rec.level, text: 'An agent is listening' });
    await new Promise<void>((resolve) => {
      const tick = setInterval(() => {
        if (rec.level > 0.012) { lastSpeech = Date.now(); spoke = true; }
        void pill();
        const el = Date.now() - t0;
        if (el >= seconds * 1000 || (spoke && Date.now() - lastSpeech >= 1500 && rec.samples >= SAMPLE_RATE * 2)) { clearInterval(tick); resolve(); }
      }, 100);
    });
    const audio = rec.stop();
    void d.jarvin.voiceOverlay({ state: 'working' });
    try {
      const r = await d.jarvin.voiceTranscribePiece(audio);
      if ('error' in r) throw new Error(r.error);
      return r.text;
    } finally {
      void d.jarvin.voiceOverlay({ state: 'hidden' });
    }
  }

  function speak(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const synth = typeof speechSynthesis === 'undefined' ? null : speechSynthesis;
      if (!synth) return reject(new Error('This system has no speech voices.'));
      const v = d.getSettings().voice;
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = v.speakRate || 1;
      const voice = v.speakVoice ? synth.getVoices().find((x) => x.name === v.speakVoice) : undefined;
      if (voice) u.voice = voice;
      const guard = setTimeout(() => { synth.cancel(); resolve(); }, Math.max(8000, text.length * 120));
      u.onend = () => { clearTimeout(guard); resolve(); };
      u.onerror = (e) => { clearTimeout(guard); e.error === 'canceled' || e.error === 'interrupted' ? resolve() : reject(new Error(`Speech failed: ${e.error}`)); };
      synth.speak(u);
    });
  }

  return d.jarvin.onVoiceMcpRequest(async (m) => {
    try {
      if (m.kind === 'listen') return void (await d.jarvin.voiceMcpReply(m.id, { text: await listen(clampListen(m.payload?.seconds)) }));
      if (m.kind === 'speak') { await speak(String(m.payload?.text ?? '')); return void (await d.jarvin.voiceMcpReply(m.id, { text: 'ok' })); }
      if (m.kind === 'transcribeFile') {
        const st = await d.jarvin.voiceStatus();
        if (!st.available || !st.cached) throw new Error('The speech model is not ready. The user must download it in Jarvin: Settings → Voice.');
        const bytes: Uint8Array = m.payload.bytes;
        const audio = await decodeTo16k(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
        const text = await transcribeAudio(d.jarvin, audio, { timestamps: !!m.payload.timestamps });
        return void (await d.jarvin.voiceMcpReply(m.id, { text }));
      }
      await d.jarvin.voiceMcpReply(m.id, { error: `Unknown request ${m.kind}` });
    } catch (e) {
      await d.jarvin.voiceMcpReply(m.id, { error: String((e as Error)?.message ?? e) });
    }
  });
}
