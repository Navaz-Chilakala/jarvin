// Optional local natural-voice benchmark. Installs are isolated under scratchpad/kokoro-eval.
const path = require('node:path');
const { createRequire } = require('node:module');
const use = createRequire(path.resolve('scratchpad/kokoro-eval/package.json'));
const { env, StyleTextToSpeech2Model, AutoTokenizer } = use('@huggingface/transformers');
const { KokoroTTS } = use('kokoro-js');
env.cacheDir = path.join(process.env.APPDATA, 'jarvin', 'models');
env.localModelPath = env.cacheDir; env.allowLocalModels = true; env.allowRemoteModels = true; env.useFSCache = true;
async function main() {
  const device = process.argv[2] || 'cpu';
  const threads = Number(process.argv[3] || 0);
  if (!['cpu', 'dml'].includes(device)) throw new Error('Use cpu or dml.');
  const start = performance.now();
  const modelId = 'onnx-community/Kokoro-82M-v1.0-ONNX';
  const options = { dtype: 'q8', device, ...(threads ? { session_options: { intraOpNumThreads: threads } } : {}), progress_callback: (p) => { if (p?.status === 'done') console.log(`Ready: ${p.file}`); } };
  const voice = threads ? new KokoroTTS(...await Promise.all([StyleTextToSpeech2Model.from_pretrained(modelId, options), AutoTokenizer.from_pretrained(modelId, options)])) : await KokoroTTS.from_pretrained(modelId, options);
  const loadSeconds = (performance.now() - start) / 1000;
  const result = [];
  const samples = process.argv.includes('--short') ? ['Hello, I am Jarvin.', 'Let me check that.', 'I can help you navigate.'] : ['Hello, I am Jarvin. What would you like me to do?', 'I can look at your screen and help you navigate.'];
  for (const text of samples) {
    const at = performance.now();
    const audio = await voice.generate(text, { voice: 'bm_george' });
    const seconds = (performance.now() - at) / 1000;
    result.push({ synthesisSeconds: +seconds.toFixed(2), audioSeconds: +(audio.audio.length / audio.sampling_rate).toFixed(2) });
    if (result.length === 1) await audio.save(path.resolve('scratchpad/kokoro-eval/preview.wav'));
  }
  console.log(JSON.stringify({ device, threads, loadSeconds: +loadSeconds.toFixed(2), result }));
  await voice.model?.dispose?.();
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
