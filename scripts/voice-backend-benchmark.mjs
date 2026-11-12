// Optional hardware benchmark. Uses a generated voice sample and the already-cached model only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const device = process.argv[2] || 'cpu';
if (!['cpu', 'dml'].includes(device)) throw new Error('Use cpu or dml.');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-stt-benchmark-'));
try {
  const wavFile = path.join(root, 'speech.wav');
  const command = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $format=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono); $s.SetOutputToWaveFile($env:JARVIN_BENCH_WAV,$format); $s.Speak('Hey Jarvin, click the blue button on the screen.'); $s.Dispose()";
  const synth = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { env: { ...process.env, JARVIN_BENCH_WAV: wavFile }, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (synth.status !== 0) throw new Error(`Speech synthesis failed: ${synth.stderr}`);
  const wav = fs.readFileSync(wavFile); let offset = 12, pcm;
  while (offset + 8 <= wav.length) { const name = wav.toString('ascii', offset, offset + 4), size = wav.readUInt32LE(offset + 4); if (name === 'data') { pcm = wav.subarray(offset + 8, offset + 8 + size); break; } offset += 8 + size + (size % 2); }
  if (!pcm?.length) throw new Error('No generated speech.');
  const audio = new Float32Array(pcm.length / 2); for (let i = 0; i < audio.length; i++) audio[i] = pcm.readInt16LE(i * 2) / 32768;
  const tf = await import('@huggingface/transformers');
  tf.env.allowLocalModels = true; tf.env.allowRemoteModels = false;
  tf.env.localModelPath = path.join(process.env.APPDATA, 'jarvin', 'models');
  tf.env.cacheDir = tf.env.localModelPath;
  let started = performance.now();
  const pipe = await tf.pipeline('automatic-speech-recognition', 'Xenova/whisper-base.en', { device, dtype: 'q8' });
  const loadMs = performance.now() - started;
  const timings = [];
  for (let i = 0; i < 2; i++) { started = performance.now(); const result = await pipe(audio, { chunk_length_s: 30, stride_length_s: 5 }); timings.push({ seconds: +((performance.now() - started) / 1000).toFixed(2), text: result.text }); }
  console.log(JSON.stringify({ device, sampleSeconds: +(audio.length / 16000).toFixed(2), loadSeconds: +(loadMs / 1000).toFixed(2), timings }));
  await pipe.dispose?.();
} finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); }
