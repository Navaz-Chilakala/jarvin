// Synthetic English commands only; measures recognition tradeoffs without using the microphone.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-asr-quality-'));
const phrases = ['Open Google Chrome and search for weather in London.', 'Scroll down to the second paragraph and click the blue logo.', 'Stop talking. I want you to open Visual Studio Code.'];
const normalize = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean);
function distance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) { const next = [i]; for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); row = next; }
  return row[b.length];
}
try {
  const tf = await import('@huggingface/transformers');
  tf.env.allowLocalModels = true; tf.env.allowRemoteModels = false;
  tf.env.localModelPath = path.join(process.env.APPDATA, 'jarvin', 'models'); tf.env.cacheDir = tf.env.localModelPath;
  const pipe = await tf.pipeline('automatic-speech-recognition', 'Xenova/whisper-base.en', { dtype: 'q8' });
  for (const phrase of phrases) {
    const file = path.join(dir, 'speech.wav');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $f=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono); $s.SetOutputToWaveFile($env:JARVIN_EVAL_WAV,$f); $s.Speak($env:JARVIN_EVAL_TEXT); $s.Dispose()"], { env: { ...process.env, JARVIN_EVAL_WAV: file, JARVIN_EVAL_TEXT: phrase }, windowsHide: true, timeout: 30000 });
    if (result.status !== 0) throw new Error('Could not generate test speech.');
    const wav = fs.readFileSync(file); let offset = 12, pcm;
    while (offset + 8 <= wav.length) { const name = wav.toString('ascii', offset, offset + 4), size = wav.readUInt32LE(offset + 4); if (name === 'data') { pcm = wav.subarray(offset + 8, offset + 8 + size); break; } offset += 8 + size + (size % 2); }
    const audio = Float32Array.from({ length: pcm.length / 2 }, (_, i) => pcm.readInt16LE(i * 2) / 32768);
    const rms = Math.sqrt(audio.reduce((n, v) => n + v * v, 0) / audio.length);
    for (let i = 0; i < audio.length; i++) audio[i] *= .009 / rms;
    for (const beams of [1, 3]) {
      const start = performance.now(); const output = await pipe(audio, { chunk_length_s: 30, stride_length_s: 5, num_beams: beams });
      console.log(JSON.stringify({ intended: phrase, beams, text: output.text.trim(), wordErrors: distance(normalize(phrase), normalize(output.text)), seconds: +((performance.now() - start) / 1000).toFixed(2), inputRms: .009 }));
    }
  }
  await pipe.dispose();
} finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); }
