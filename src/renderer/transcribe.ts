import type { JarvinApi } from '../shared/types';
import { MAX_FILE_MB, formatTranscript, planSegments, type TimedText } from '../shared/transcribe';

const RATE = 16000;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Decode any audio/video file the browser engine understands into 16 kHz mono samples. */
export async function decodeTo16k(buf: ArrayBuffer): Promise<Float32Array> {
  const ctx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(buf);
  } catch {
    throw new Error('This file could not be decoded. Try converting it to mp3 or wav.');
  } finally {
    void ctx.close();
  }
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * RATE)), RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const out = await off.startRendering();
  return out.getChannelData(0);
}

export function initTranscribe(d: { jarvin: JarvinApi; input: HTMLTextAreaElement; autosize: () => void; toast: (m: string) => void; segmentSec?: number }) {
  const dlg = $<HTMLDialogElement>('trDlg');
  const status = $('trStatus');
  const bar = $('trBar');
  const wrap = $('trBarWrap');
  const text = $<HTMLTextAreaElement>('trText');
  const stamps = $<HTMLInputElement>('trStamps');
  const fileEl = $<HTMLInputElement>('trFile');
  const stopBtn = $<HTMLButtonElement>('trCancel');
  let parts: TimedText[] = [];
  let name = 'transcript';
  let stop = false;
  let busy = false;

  const render = () => { text.value = formatTranscript(parts, stamps.checked); };
  const setStatus = (t: string, bad = false) => { status.textContent = t; status.style.color = bad ? 'var(--err, #f14c4c)' : ''; };

  async function run(file: File) {
    if (busy) return;
    busy = true;
    stop = false;
    parts = [];
    name = file.name.replace(/\.[^.]+$/, '') || 'transcript';
    text.value = '';
    bar.style.width = '0';
    wrap.hidden = true;
    try {
      if (file.size > MAX_FILE_MB * 1048576) throw new Error(`That file is ${Math.round(file.size / 1048576)} MB. The limit is ${MAX_FILE_MB} MB; split it into parts first.`);
      const st = await d.jarvin.voiceStatus();
      if (!st.available) throw new Error(st.error ?? 'Speech engine is not installed.');
      if (!st.cached) throw new Error('The speech model is not downloaded yet. Open Settings → Voice and click “Download model”, then try again.');
      setStatus('Reading the file…');
      const audio = await decodeTo16k(await file.arrayBuffer());
      const segs = planSegments(audio, RATE, d.segmentSec ?? 60);
      if (!segs.length) throw new Error('The file has no audio.');
      wrap.hidden = false;
      stopBtn.hidden = false;
      const t0 = Date.now();
      for (let i = 0; i < segs.length; i++) {
        if (stop) break;
        setStatus(`Transcribing part ${i + 1} of ${segs.length}…`);
        const piece = audio.slice(segs[i].start, segs[i].end);
        const r = await d.jarvin.voiceTranscribePiece(piece);
        if ('error' in r) throw new Error(r.error);
        parts.push({ startSec: segs[i].start / RATE, text: r.text });
        render();
        bar.style.width = `${Math.round(((i + 1) / segs.length) * 100)}%`;
      }
      const words = text.value.split(/\s+/).filter(Boolean).length;
      setStatus(stop ? `Stopped. ${words} words so far.` : words ? `Done: ${words} words in ${Math.round((Date.now() - t0) / 1000)}s.` : 'No speech was found in this file.');
    } catch (e) {
      setStatus(String((e as Error).message ?? e), true);
    } finally {
      busy = false;
      stopBtn.hidden = true;
    }
  }

  fileEl.onchange = () => { const f = fileEl.files?.[0]; if (f) void run(f); };
  stamps.onchange = render;
  stopBtn.onclick = () => { stop = true; };
  $('trCopy').onclick = async () => { await navigator.clipboard.writeText(text.value); d.toast('Transcript copied'); };
  $('trSave').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text.value], { type: 'text/plain' }));
    a.download = `${name}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };
  $('trChat').onclick = () => {
    if (!text.value.trim()) return d.toast('Nothing to send yet');
    const cur = d.input.value.trim();
    d.input.value = `${cur ? cur + '\n\n' : ''}Transcript of "${name}":\n\n${text.value}`;
    d.autosize();
    dlg.close();
    d.input.focus();
  };
  $('trClose').onclick = () => { stop = true; dlg.close(); };
  dlg.addEventListener('close', () => { stop = true; });

  return {
    open() {
      if (!busy) { fileEl.value = ''; text.value = ''; parts = []; setStatus(''); wrap.hidden = true; }
      if (!dlg.open) dlg.showModal();
    },
    /** Test hook: transcribe a File object directly. */
    run,
  };
}

/** Transcribe a whole recording piece by piece. Throws on the first error. */
export async function transcribeAudio(
  jarvin: JarvinApi,
  audio: Float32Array,
  o: { segmentSec?: number; timestamps?: boolean; shouldStop?: () => boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<string> {
  const segs = planSegments(audio, RATE, o.segmentSec ?? 60);
  const parts: TimedText[] = [];
  for (let i = 0; i < segs.length; i++) {
    if (o.shouldStop?.()) break;
    const r = await jarvin.voiceTranscribePiece(audio.slice(segs[i].start, segs[i].end));
    if ('error' in r) throw new Error(r.error);
    parts.push({ startSec: segs[i].start / RATE, text: r.text });
    o.onProgress?.(i + 1, segs.length);
  }
  return formatTranscript(parts, !!o.timestamps);
}
