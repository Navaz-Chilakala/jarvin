/** Local Piper ONNX synthesis in a worker thread. No network access is used. */
import { parentPort } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';

type Message = { t: 'init'; dir: string; kokoro?: string | null } | { t: 'speak'; id: number; text: string; rate: number };
const port = parentPort!;
let session: any, config: any, ort: any, phonemize: any, kokoro: any;
const KOKORO_SPEAKER = 3; // af_bella-style English voice in the v1.1 pack
let initialized: Promise<void> | null = null;
let queue = Promise.resolve();

async function init(dir: string, kokoroDir?: string | null) {
  if (kokoroDir) {
    try {
      const so = require('sherpa-onnx-node');
      const j = (f: string) => path.join(kokoroDir, f);
      kokoro = new so.OfflineTts({ model: { kokoro: { model: j('model.int8.onnx'), voices: j('voices.bin'), tokens: j('tokens.txt'), dataDir: j('espeak-ng-data'), lexicon: j('lexicon-us-en.txt'), dictDir: j('dict') }, debug: false, numThreads: 4, provider: 'cpu' }, maxNumSentences: 1 });
      return;
    } catch (error) {
      // Windows Smart App Control blocks the unsigned sherpa-onnx module on some PCs; the Piper voice below does not need it.
      kokoro = undefined;
      if (!fs.existsSync(path.join(dir, 'joe.onnx'))) throw error;
    }
  }
  ort = require('onnxruntime-node');
  ({ phonemize } = require('phonemizer'));
  config = JSON.parse(fs.readFileSync(path.join(dir, 'joe.onnx.json'), 'utf8'));
  if (config?.audio?.sample_rate !== 22050 || !config?.phoneme_id_map?.['^'] || !config?.phoneme_id_map?.['$'] || !config?.phoneme_id_map?.['_']) throw new Error('Natural voice configuration is invalid.');
  session = await ort.InferenceSession.create(path.join(dir, 'joe.onnx'), { executionProviders: ['cpu'], intraOpNumThreads: 4 });
}

async function speak(id: number, text: string, rate: number) {
  if (!initialized) throw new Error('Natural voice is not initialized.');
  await initialized;
  if (kokoro) {
    const a = kokoro.generate({ text, sid: KOKORO_SPEAKER, speed: rate });
    const k = Float32Array.from(a.samples);
    if (!k.length || k.length > a.sampleRate * 60) throw new Error('Natural voice returned invalid audio.');
    port.postMessage({ t: 'audio', id, pcm: k, sampleRate: a.sampleRate }, [k.buffer]);
    return;
  }
  const sounds = (await phonemize(text, config.espeak.voice)).join(' ').normalize('NFD');
  const map = config.phoneme_id_map;
  const ids: number[] = [...map['^']];
  for (const char of sounds) if (map[char]) ids.push(...map[char], ...map['_']);
  ids.push(...map['$']);
  if (ids.length < 4 || ids.length > 4000) throw new Error('Could not prepare this phrase for the natural voice.');
  const { noise_scale, length_scale, noise_w } = config.inference;
  const result = await session.run({
    input: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor('float32', Float32Array.from([noise_scale, length_scale / rate, noise_w]), [3]),
  });
  const pcm = Float32Array.from(result[session.outputNames[0]].data as Float32Array);
  if (!pcm.length || pcm.length > 22050 * 60) throw new Error('Natural voice returned invalid audio.');
  port.postMessage({ t: 'audio', id, pcm, sampleRate: 22050 }, [pcm.buffer]);
}

port.on('message', (message: Message) => {
  if (message.t === 'init') {
    initialized ??= init(message.dir, message.kokoro);
    void initialized.then(() => port.postMessage({ t: 'ready' }), (error) => port.postMessage({ t: 'error', message: String(error?.message ?? error) }));
  } else {
    queue = queue.then(() => speak(message.id, message.text, message.rate)).catch((error) => { port.postMessage({ t: 'error', id: message.id, message: String(error?.message ?? error) }); });
  }
});
