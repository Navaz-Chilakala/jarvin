// Measures the openWakeWord "hey jarvis" model, offline, on the recordings saved by the Voice test dialog:
// does it fire on the user's "Hey Jarvin, ..." sentences, and stay quiet on the sentences without the name?
//   npx esbuild scripts/wake-voice-check.ts --bundle --platform=node --packages=external --outfile=.test-out/wake-voice-check.cjs && node .test-out/wake-voice-check.cjs
// The three model files are not in the repository (non-commercial licence); see assets/voice/openwakeword/README.md.
import fs from 'node:fs';
import path from 'node:path';
import { WakeStream, WAKE_THRESHOLD } from '../src/shared/wake';
import { loadWakeModels } from '../src/main/wake-models';
import { VOICE_TEST_SENTENCES } from '../src/shared/voicetest';
import { matchWake } from '../src/shared/voicecmd';

const RATE = 16000;
const project = path.resolve(__dirname, '..');
const clipDir = path.join(process.env.APPDATA!, 'jarvin', 'voice-test');

async function main() {
  const models = await loadWakeModels(path.join(project, 'assets', 'voice', 'openwakeword'));
  if (!models) throw new Error('The wake-word model files are not installed (assets/voice/openwakeword).');
  let seed = 7; const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff * 2 - 1; };
  const peak = async (audio: Float32Array) => {
    const stream = new WakeStream(models);
    const padded = new Float32Array(RATE * 1.5 + audio.length + RATE); padded.set(audio, RATE * 1.5);
    let best = 0, ms = 0;
    for (let at = 0; at + 1024 <= padded.length; at += 1024) { const t = performance.now(); best = Math.max(best, await stream.feed(padded.slice(at, at + 1024))); ms += performance.now() - t; }
    return { best, cost: ms / (padded.length / RATE) };
  };
  const withName: number[] = [], without: number[] = []; let cost = 0, n = 0;
  for (let i = 0; i < VOICE_TEST_SENTENCES.length; i++) {
    const file = path.join(clipDir, `clip-${String(i).padStart(2, '0')}.f32`);
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file);
    const r = await peak(new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)));
    cost += r.cost; n++;
    const named = matchWake(VOICE_TEST_SENTENCES[i]) !== null;
    (named ? withName : without).push(r.best);
    console.log(`  ${named ? 'name   ' : 'no name'}  score ${r.best.toFixed(3)}  ${r.best >= WAKE_THRESHOLD ? 'FIRED' : '-    '}  ${VOICE_TEST_SENTENCES[i]}`);
  }
  const fired = (list: number[], bar: number) => list.filter((v) => v >= bar).length;
  console.log(`\nSentences that start with "Hey Jarvin": fired on ${fired(withName, WAKE_THRESHOLD)} of ${withName.length}`);
  console.log(`Sentences without the name:            fired on ${fired(without, WAKE_THRESHOLD)} of ${without.length} (should be 0)`);
  for (const bar of [0.3, 0.2, 0.1]) console.log(`  at a lower bar of ${bar}: ${fired(withName, bar)} of ${withName.length} with the name, ${fired(without, bar)} of ${without.length} without`);
  const noise = new Float32Array(RATE * 8); { let last = 0; for (let i = 0; i < noise.length; i++) { last = last * 0.98 + rand() * 0.02; noise[i] = last * 3; } }
  console.log(`Loud fan noise, 8 s: peak score ${(await peak(noise)).best.toFixed(3)}`);
  console.log(`Cost: ${(cost / n).toFixed(1)} ms of work per second of audio`);
}
main().catch((e) => { console.error(String(e?.message ?? e)); process.exitCode = 1; });
