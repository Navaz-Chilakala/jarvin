// Compare cached local recognizers using identical generated US/Indian English commands.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pipeline, env } from '@huggingface/transformers';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-speech-compare-'));
const models = process.argv.slice(2).length ? process.argv.slice(2) : ['Xenova/whisper-base.en', 'distil-whisper/distil-small.en'];
const phrases = ['Open Chrome and search for the latest cricket scores.', 'Go to the second paragraph and click the blue logo.', 'Stop talking and listen to me.', 'Open Visual Studio Code, then create a new file.'];
const words = text => text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
function distance(a, b) { let row = Array.from({ length: b.length + 1 }, (_, i) => i); for (let i = 1; i <= a.length; i++) { const next = [i]; for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); row = next; } return row[b.length]; }
const results = [];
try {
  const clips = [];
  for (const voice of ['Microsoft Ravi', 'Microsoft Heera', 'Microsoft Zira Desktop']) for (const phrase of phrases) {
    const file = path.join(root, 'test.wav');
    const command = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice($env:JARVIN_EVAL_VOICE); $f=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono); $s.SetOutputToWaveFile($env:JARVIN_EVAL_WAV,$f); $s.Speak($env:JARVIN_EVAL_TEXT); $s.Dispose()";
    const generated = spawnSync(process.env.JARVIN_EVAL_POWERSHELL || 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { env: { ...process.env, JARVIN_EVAL_WAV: file, JARVIN_EVAL_TEXT: phrase, JARVIN_EVAL_VOICE: voice }, windowsHide: true, timeout: 30000 });
    if (generated.status !== 0) throw new Error(`Could not generate ${voice} test audio: ${generated.stderr?.toString().slice(0, 400)}`);
    const wav = fs.readFileSync(file); let offset = 12, pcm;
    while (offset + 8 <= wav.length) { const name = wav.toString('ascii', offset, offset + 4), size = wav.readUInt32LE(offset + 4); if (name === 'data') { pcm = wav.subarray(offset + 8, offset + 8 + size); break; } offset += 8 + size + (size % 2); }
    if (!pcm) throw new Error('Generated audio has no PCM data.');
    const audio = Float32Array.from({ length: pcm.length / 2 }, (_, i) => pcm.readInt16LE(i * 2) / 32768);
    const rms = Math.sqrt(audio.reduce((n, v) => n + v * v, 0) / audio.length);
    for (const level of [.009, .05]) clips.push({ voice, phrase, level, audio: Float32Array.from(audio, value => value * level / rms) });
  }
  env.localModelPath = path.join(process.env.APPDATA, 'jarvin', 'models'); env.cacheDir = env.localModelPath; env.allowLocalModels = true; env.allowRemoteModels = false;
  for (const model of models) {
    const loadStart = performance.now(); const pipe = await pipeline('automatic-speech-recognition', model, { dtype: 'q8' });
    const loadSeconds = (performance.now() - loadStart) / 1000;
    for (const clip of clips) {
      const start = performance.now(); const output = await pipe(clip.audio, model.includes('moonshine') ? { max_new_tokens: Math.max(16, Math.ceil(clip.audio.length / 16000) * 8) } : { chunk_length_s: 30, stride_length_s: 5 });
      const item = { model, voice: clip.voice, level: clip.level, expected: clip.phrase, actual: output.text.trim(), errors: distance(words(clip.phrase), words(output.text)), words: words(clip.phrase).length, seconds: +((performance.now() - start) / 1000).toFixed(2) };
      results.push(item); console.log(JSON.stringify(item));
    }
    const mine = results.filter(r => r.model === model), errors = mine.reduce((n, r) => n + r.errors, 0), count = mine.reduce((n, r) => n + r.words, 0);
    console.log(JSON.stringify({ summary: model, clips: mine.length, wordErrors: errors, words: count, wordErrorRate: +(errors / count).toFixed(3), meanSeconds: +(mine.reduce((n, r) => n + r.seconds, 0) / mine.length).toFixed(2), loadSeconds: +loadSeconds.toFixed(2) }));
    await pipe.dispose();
  }
  fs.mkdirSync('.test-out', { recursive: true }); fs.writeFileSync(models.length === 1 ? `.test-out/speech-model-comparison-${models[0].split('/').pop()}.json` : '.test-out/speech-model-comparison.json', JSON.stringify(results, null, 2));
} finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); }
