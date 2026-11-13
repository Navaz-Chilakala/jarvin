// Compares the trained speech detector with the loudness check, offline, on the recordings saved by the Voice test
// dialog and on generated non-speech sounds. Never opens the microphone.
//   npx esbuild scripts/vad-voice-check.ts --bundle --platform=node --packages=external --outfile=.test-out/vad-voice-check.cjs && node .test-out/vad-voice-check.cjs
import fs from 'node:fs';
import path from 'node:path';
import * as ort from 'onnxruntime-node';
import { Segmenter } from '../src/shared/handsfree';
import { speechLevel } from '../src/shared/voice';
import { VadStream, isSpeech, type VadModel } from '../src/shared/vad';

const RATE = 16000, CHUNK = 1024; // the microphone worklet delivers 64 ms chunks
const project = path.resolve(__dirname, '..');
const clipDir = path.join(process.env.APPDATA!, 'jarvin', 'voice-test');

const silence = (seconds: number) => new Float32Array(Math.round(seconds * RATE));
const join = (...parts: Float32Array[]) => { const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const mix = (a: Float32Array, b: Float32Array) => a.map((v, i) => v + (b[i] ?? 0));
// Deterministic noise so every run gives the same numbers.
let seed = 12345;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff * 2 - 1; };
const scale = (a: Float32Array, level: number) => { let s = 0; for (const v of a) s += v * v; const r = Math.sqrt(s / a.length) || 1; return a.map((v) => (v / r) * level); };

function fan(seconds: number, level: number) { const a = new Float32Array(Math.round(seconds * RATE)); let last = 0; for (let i = 0; i < a.length; i++) { last = last * 0.98 + rand() * 0.02; a[i] = last; } return scale(a, level); }
function hiss(seconds: number, level: number) { const a = new Float32Array(Math.round(seconds * RATE)); for (let i = 0; i < a.length; i++) a[i] = rand(); return scale(a, level); }
function typing(seconds: number) { const a = new Float32Array(Math.round(seconds * RATE)); for (let t = 0.3; t < seconds - 0.2; t += 0.13 + Math.abs(rand()) * 0.12) { const at = Math.round(t * RATE); for (let i = 0; i < 400 && at + i < a.length; i++) a[at + i] += rand() * 0.35 * Math.exp(-i / 60); } return a; }
function music(seconds: number, level: number) { const a = new Float32Array(Math.round(seconds * RATE)); const notes = [220, 277.18, 329.63, 440]; for (let i = 0; i < a.length; i++) { const t = i / RATE; const beat = 0.6 + 0.4 * Math.sin(2 * Math.PI * 2 * t); a[i] = notes.reduce((s, f, k) => s + Math.sin(2 * Math.PI * f * t) / (k + 1), 0) * beat; } return scale(a, level); }
function slam(seconds: number) { const a = new Float32Array(Math.round(seconds * RATE)); for (const t of [0.8, 2.4]) { const at = Math.round(t * RATE); for (let i = 0; i < RATE * 0.5 && at + i < a.length; i++) a[at + i] += (rand() * 0.5 + Math.sin(2 * Math.PI * 70 * i / RATE) * 0.5) * 0.7 * Math.exp(-i / 1800); } return a; }

async function main() {
  const session = await ort.InferenceSession.create(path.join(project, 'assets', 'voice', 'silero-vad-v6.2.onnx'), { intraOpNumThreads: 1, interOpNumThreads: 1 });
  const rate = new ort.Tensor('int64', BigInt64Array.from([16000n]), []);
  const model: VadModel = async (input, state) => {
    const out = await session.run({ input: new ort.Tensor('float32', input, [1, input.length]), state: new ort.Tensor('float32', state, [2, 1, 128]), sr: rate });
    return { probability: Number((out.output.data as Float32Array)[0]), state: out.stateN.data as Float32Array };
  };
  const options = { minLevel: speechLevel('high'), minSpeechMs: 250, endSilenceMs: 650 };

  /** Utterances each detector would hand to the recognizer, with their total length. */
  async function run(audio: Float32Array) {
    const loud = new Segmenter(options), neural = new Segmenter(options), vad = new VadStream(model);
    const result = { loudness: { count: 0, seconds: 0 }, neural: { count: 0, seconds: 0 }, ms: 0 };
    for (let at = 0; at + CHUNK <= audio.length; at += CHUNK) {
      const chunk = audio.slice(at, at + CHUNK);
      const a = loud.feed(chunk); if (a) { result.loudness.count++; result.loudness.seconds += a.length / RATE; }
      const started = performance.now();
      const p = await vad.score(chunk);
      result.ms += performance.now() - started;
      const b = neural.feed(chunk, isSpeech(p, neural.speaking)); if (b) { result.neural.count++; result.neural.seconds += b.length / RATE; }
    }
    return result;
  }

  const clips = fs.existsSync(clipDir) ? fs.readdirSync(clipDir).filter((f) => /^clip-\d+\.f32$/.test(f)).sort() : [];
  const speech = clips.map((f) => { const raw = fs.readFileSync(path.join(clipDir, f)); return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)); });
  console.log(`Recordings of the user's voice: ${speech.length}`);
  const tally = { loudness: 0, neural: 0 }; let scoreMs = 0, audioSeconds = 0;
  const withNoise = { loudness: 0, neural: 0 };
  for (const clip of speech) {
    const quiet = join(silence(1), clip, silence(1.3));
    const r = await run(quiet);
    if (r.loudness.count >= 1) tally.loudness++;
    if (r.neural.count >= 1) tally.neural++;
    scoreMs += r.ms; audioSeconds += quiet.length / RATE;
    const noisy = mix(quiet, fan(quiet.length / RATE, 0.01));
    const n = await run(noisy);
    if (n.loudness.count >= 1) withNoise.loudness++;
    if (n.neural.count >= 1) withNoise.neural++;
  }
  if (speech.length) {
    console.log(`  speech caught, quiet room:        loudness ${tally.loudness}/${speech.length}   trained ${tally.neural}/${speech.length}`);
    console.log(`  speech caught, with a fan running: loudness ${withNoise.loudness}/${speech.length}   trained ${withNoise.neural}/${speech.length}`);
    console.log(`  detector cost: ${(scoreMs / audioSeconds).toFixed(1)} ms of work per second of audio`);
  }

  console.log('Sounds that are not speech (utterances wrongly sent to the recognizer, and their length):');
  const sounds: [string, Float32Array][] = [
    ['fan starts, loud', join(silence(1), fan(8, 0.06), silence(1.5))],
    ['hiss / white noise', join(silence(1), hiss(8, 0.05), silence(1.5))],
    ['typing', join(silence(1), typing(8), silence(1.5))],
    ['music-like tones', join(silence(1), music(8, 0.06), silence(1.5))],
    ['door slams', join(silence(1), slam(4), silence(1.5))],
  ];
  let loudFalse = 0, neuralFalse = 0;
  for (const [name, audio] of sounds) {
    const r = await run(audio);
    loudFalse += r.loudness.count; neuralFalse += r.neural.count;
    console.log(`  ${name.padEnd(20)} loudness ${r.loudness.count} (${r.loudness.seconds.toFixed(1)} s)   trained ${r.neural.count} (${r.neural.seconds.toFixed(1)} s)`);
  }
  console.log(`  total false captures: loudness ${loudFalse}, trained ${neuralFalse}`);
}
main().catch((e) => { console.error(String(e?.message ?? e)); process.exitCode = 1; });
