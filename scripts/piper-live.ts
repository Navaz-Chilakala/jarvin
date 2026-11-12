/** Tests the actual worker with the installed voice and Electron's Node runtime. */
import path from 'node:path';
import { PiperService } from '../src/main/piper';

const voice = new PiperService(path.resolve('dist/piper-worker.js'), path.join(process.env.APPDATA!, 'jarvin', 'models', 'piper'));
async function main() {
  try {
    const start = Date.now(); await voice.warm(); const loaded = Date.now();
    const first = await voice.synthesize('Hello, I am Jarvin. How can I help?'); const ended = Date.now();
    if (!(first.pcm instanceof Float32Array) || first.sampleRate !== 22050 || first.pcm.length < 2205 || !first.pcm.some((value) => Math.abs(value) > .005)) throw new Error('Natural voice did not return valid audio.');
    const second = await voice.synthesize('I can help you use your computer.');
    if (!(second.pcm instanceof Float32Array) || !second.pcm.length) throw new Error('Second speech chunk failed.');
    const faster = await voice.synthesize('I can help you use your computer.', 1.5);
    if (faster.pcm.length >= second.pcm.length) throw new Error('Speech rate did not affect generated audio.');
    console.log(`Natural local voice passed: warm-up ${((loaded - start) / 1000).toFixed(2)}s, first phrase ${((ended - loaded) / 1000).toFixed(2)}s, audio ${(first.pcm.length / first.sampleRate).toFixed(2)}s.`);
  } finally { await voice.dispose(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
