/** Offline comparison only: never opens the microphone or changes the live listener. */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Segmenter } from '../src/shared/handsfree';
import { speechLevel } from '../src/shared/voice';

const [modelArg, ...files] = process.argv.slice(2);
if (!modelArg || !files.length) throw new Error('Usage: node .test-out/vad-compare.cjs <silero-model.onnx> <16k-mono.wav> [...wav]');
const model = path.resolve(modelArg);
if (!fs.existsSync(model)) throw new Error('The Silero ONNX model was not found.');
// Load the native runtime only in this separate benchmark process.
const sherpa = require('sherpa-onnx-node') as any;
const config = { sileroVad: { model, threshold: 0.5, minSilenceDuration: 0.65, minSpeechDuration: 0.25, windowSize: 512, maxSpeechDuration: 12 }, sampleRate: 16000, numThreads: 1, provider: 'cpu', debug: false };
const limit = 16000 * 120;
for (const file of files) {
  const wav = sherpa.readWave(path.resolve(file), false);
  if (!wav || wav.sampleRate !== 16000 || !(wav.samples instanceof Float32Array) || !wav.samples.length || wav.samples.length > limit) throw new Error('Each WAV must contain up to 120 seconds of 16 kHz mono audio.');
  const baseline = new Segmenter({ minLevel: speechLevel('high'), minSpeechMs: 250, endSilenceMs: 650 });
  const vad = new sherpa.Vad(config, 125);
  let baselineStarts = 0, baselineSegments = 0, sileroStarts = 0, sileroSegments = 0;
  let baselineFirst: number | null = null, sileroFirst: number | null = null, detected = false;
  const started = performance.now();
  for (let offset = 0; offset < wav.samples.length; offset += 512) {
    const samples = wav.samples.subarray(offset, Math.min(offset + 512, wav.samples.length));
    const prior = baseline.speaking;
    if (baseline.feed(samples)) baselineSegments++;
    if (!prior && baseline.speaking) { baselineStarts++; baselineFirst ??= offset / 16000; }
    const input = samples.length === 512 ? samples : Float32Array.from({ length: 512 }, (_, i) => samples[i] ?? 0);
    vad.acceptWaveform(input);
    const current = Boolean(vad.isDetected());
    if (current && !detected) { sileroStarts++; sileroFirst ??= offset / 16000; }
    detected = current;
    while (!vad.isEmpty()) { sileroSegments++; vad.pop(); }
  }
  vad.flush();
  while (!vad.isEmpty()) { sileroSegments++; vad.pop(); }
  console.log(JSON.stringify({ file: path.basename(file), durationSeconds: +(wav.samples.length / 16000).toFixed(2), baseline: { speechStarts: baselineStarts, completedSegments: baselineSegments, firstStartSeconds: baselineFirst }, silero: { speechStarts: sileroStarts, completedSegments: sileroSegments, firstStartSeconds: sileroFirst }, processingMs: +(performance.now() - started).toFixed(1), note: 'Detection counts are not accuracy scores; compare against labeled speech and noise.' }));
}
