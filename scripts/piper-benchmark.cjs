// Optional local Piper voice benchmark; downloads only the named test model to scratchpad.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const use = createRequire(path.resolve('scratchpad/kokoro-eval/package.json'));
const ort = require('onnxruntime-node');
const { phonemize } = use('phonemizer');
const root = path.resolve('scratchpad/kokoro-eval/piper');
const base = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/joe/medium/en_US-joe-medium.onnx';
async function download(url, file) {
  if (fs.existsSync(file)) return;
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
  const size = Number(response.headers.get('content-length') || 0);
  if (size > 150_000_000) throw new Error('Model exceeds the benchmark size limit.');
  const tmp = `${file}.partial`;
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(tmp, { flags: 'wx' }));
  fs.renameSync(tmp, file);
}
function wav(pcm, rate) {
  const data = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767))), i * 2);
  const header = Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
async function main() {
  fs.mkdirSync(root, { recursive: true });
  const model = path.join(root, 'joe.onnx'), config = `${model}.json`;
  await download(`${base}.json`, config); await download(base, model);
  const cfg = JSON.parse(fs.readFileSync(config, 'utf8'));
  let start = performance.now();
  const session = await ort.InferenceSession.create(model, { executionProviders: ['cpu'], intraOpNumThreads: 4 });
  const loadSeconds = (performance.now() - start) / 1000;
  const results = [];
  for (const text of ['Hello, I am Jarvin. What would you like me to do?', 'I can look at your screen and help you navigate.']) {
    start = performance.now();
    const sounds = (await phonemize(text, cfg.espeak.voice)).join(' ').normalize('NFD');
    const map = cfg.phoneme_id_map, ids = [...map['^'], ...map['_']];
    for (const char of sounds) { if (map[char]) ids.push(...map[char], ...map['_']); }
    ids.push(...map['$']);
    const infer = cfg.inference;
    const output = await session.run({ input: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]), input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]), scales: new ort.Tensor('float32', Float32Array.from([infer.noise_scale, infer.length_scale, infer.noise_w]), [3]) });
    const audio = output[session.outputNames[0]].data;
    results.push({ synthesisSeconds: +((performance.now() - start) / 1000).toFixed(2), audioSeconds: +(audio.length / cfg.audio.sample_rate).toFixed(2) });
    if (results.length === 1) fs.writeFileSync(path.join(root, 'preview.wav'), wav(audio, cfg.audio.sample_rate));
  }
  console.log(JSON.stringify({ loadSeconds: +loadSeconds.toFixed(2), results }));
  await session.release();
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
