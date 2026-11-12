/** Runs local speech recognition off the app thread. Loaded by stt.ts. */
import { parentPort } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { QWEN_ASR_DIR, QWEN_ASR_MODEL, speechDecodeOptions } from '../shared/voice';

type InMsg =
  | { t: 'init'; cacheDir: string; offline: boolean; model: string }
  | { t: 'run'; id: number; audio: Float32Array; language?: string; task?: 'transcribe' | 'translate'; vad?: boolean }
  | { t: 'probe'; id: number; audio: Float32Array };
export type OutMsg =
  | { t: 'progress'; state: 'downloading' | 'loading'; pct?: number; file?: string }
  | { t: 'ready'; model: string }
  | { t: 'result'; id: number; text: string }
  | { t: 'probeResult'; id: number; speech: boolean | null }
  | { t: 'error'; id?: number; message: string };

// Qwen runs in a forked Node process: its ONNX DLL must not share Electron's
// process with the separate ONNX runtime used by the natural Piper voice.
const send = (m: OutMsg) => parentPort ? parentPort.postMessage(m) : process.send?.(m);

let pipe: any = null;
let qwen: any = null;
let qwenVad: any = null;
let loaded = '';
let loading: Promise<void> | null = null;

/** The automatic listener uses this detector after its fast volume segmenter.
 * Keep it in the isolated native worker and reuse the loaded model across clips. */
function containsVoice(audio: Float32Array): boolean {
  if (!qwenVad) return true; // missing detector must not disable dictation
  try {
    qwenVad.reset();
    for (let offset = 0; offset < audio.length; offset += 512) {
      const remaining = audio.length - offset;
      const frame = remaining >= 512 ? audio.subarray(offset, offset + 512) : new Float32Array(512);
      if (remaining < 512) frame.set(audio.subarray(offset));
      qwenVad.acceptWaveform(frame);
      if (qwenVad.isDetected() || !qwenVad.isEmpty()) return true;
    }
    qwenVad.flush();
    return qwenVad.isDetected() || !qwenVad.isEmpty();
  } catch {
    qwenVad = null;
    return true;
  }
}

async function load(cacheDir: string, offline: boolean, model: string) {
  if ((pipe || qwen) && loaded === model) return;
  if (pipe?.dispose) await pipe.dispose();
  pipe = null;
  qwen = null;
  qwenVad = null;
  if (model === QWEN_ASR_MODEL) {
    const sherpa = require('sherpa-onnx-node');
    const root = path.join(cacheDir, QWEN_ASR_DIR);
    send({ t: 'progress', state: 'loading' });
    qwen = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        qwen3Asr: {
          convFrontend: path.join(root, 'conv_frontend.onnx'),
          encoder: path.join(root, 'encoder.int8.onnx'),
          decoder: path.join(root, 'decoder.int8.onnx'),
          tokenizer: path.join(root, 'tokenizer'), hotwords: '',
          maxTotalLen: 512, maxNewTokens: 128,
        },
        tokens: '', numThreads: 4, provider: 'cpu', debug: 0,
      },
    });
    try {
      const vadModel = path.join(__dirname, '..', 'assets', 'voice', 'silero-vad-v6.2.onnx');
      if (fs.existsSync(vadModel)) qwenVad = new sherpa.Vad({
        sileroVad: { model: vadModel, threshold: 0.45, minSilenceDuration: 0.25, minSpeechDuration: 0.15, windowSize: 512, maxSpeechDuration: 12 },
        sampleRate: 16000, numThreads: 1, provider: 'cpu', debug: false,
      }, 15);
    } catch { qwenVad = null; }
    loaded = model;
    return;
  }
  let tf: any;
  try {
    tf = require('@huggingface/transformers');
  } catch {
    throw new Error('Speech engine is not installed. Run "npm install" in the Jarvin folder, then restart.');
  }
  tf.env.cacheDir = cacheDir;
  // The cache is laid out as <cacheDir>/<model>/<file>. Offline mode must permit
  // local files; otherwise Transformers rejects the configuration before checking the cache.
  tf.env.allowLocalModels = true;
  tf.env.localModelPath = cacheDir;
  tf.env.allowRemoteModels = !offline;
  tf.env.useFSCache = true;
  const files = new Map<string, { loaded: number; total: number }>();
  send({ t: 'progress', state: 'loading' });
  pipe = await tf.pipeline('automatic-speech-recognition', model, {
    dtype: 'q8',
    progress_callback: (p: any) => {
      if (p?.status === 'progress' && p.file) {
        files.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 });
        let l = 0;
        let t = 0;
        for (const f of files.values()) {
          l += f.loaded;
          t += f.total;
        }
        send({ t: 'progress', state: 'downloading', pct: t ? Math.min(99, Math.round((l / t) * 100)) : undefined, file: p.file });
      }
    },
  });
  loaded = model;
}

const onMessage = async (m: InMsg) => {
  try {
    if (m.t === 'init') {
      loading = load(m.cacheDir, m.offline, m.model);
      await loading;
      send({ t: 'ready', model: m.model });
    } else if (m.t === 'probe') {
      await loading;
      const speech = qwenVad ? containsVoice(m.audio) : null;
      send({ t: 'probeResult', id: m.id, speech: qwenVad ? speech : null });
    } else if (m.t === 'run') {
      await loading;
      if (qwen) {
        if (m.vad && !containsVoice(m.audio)) {
          send({ t: 'result', id: m.id, text: '' });
          return;
        }
        const stream = qwen.createStream();
        stream.acceptWaveform({ sampleRate: 16000, samples: m.audio });
        qwen.decode(stream);
        send({ t: 'result', id: m.id, text: String(qwen.getResult(stream).text ?? '') });
      } else {
        if (!pipe) throw new Error('Speech model is not loaded.');
        const opts = speechDecodeOptions(loaded, m.audio.length, m.language, m.task);
        const out = await pipe(m.audio, opts);
        send({ t: 'result', id: m.id, text: String(Array.isArray(out) ? out.map((o: any) => o.text).join(' ') : out?.text ?? '') });
      }
    }
  } catch (e: any) {
    loading = null;
    send({ t: 'error', id: m.t === 'run' || m.t === 'probe' ? m.id : undefined, message: String(e?.message ?? e) });
  }
};
if (parentPort) parentPort.on('message', onMessage);
else process.on('message', onMessage);
