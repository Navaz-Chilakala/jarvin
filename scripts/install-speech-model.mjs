// Downloads only a known ONNX recognizer into Jarvin's normal local model cache.
import path from 'node:path';
import { pipeline, env } from '@huggingface/transformers';
const model = process.argv[2] || 'distil-whisper/distil-small.en';
if (!['distil-whisper/distil-small.en', 'Xenova/whisper-small.en', 'onnx-community/moonshine-base-ONNX'].includes(model)) throw new Error('Unsupported speech model.');
env.localModelPath = path.join(process.env.APPDATA, 'jarvin', 'models');
env.cacheDir = env.localModelPath; env.allowLocalModels = true; env.allowRemoteModels = true;
const reported = new Map();
const pipe = await pipeline('automatic-speech-recognition', model, { dtype: 'q8', progress_callback: p => {
  if (p.status === 'progress' && p.total > 0) {
    const percent = Math.floor(p.loaded / p.total * 10) * 10;
    if (reported.get(p.file) !== percent) { reported.set(p.file, percent); console.log(`${p.file}: ${percent}%`); }
  }
} });
console.log(`Installed and loaded ${model}`);
await pipe.dispose();
