// Runs the voice-test comparison on the recordings already saved by the Voice test dialog, without opening Jarvin.
//   npx esbuild scripts/voice-test-run.ts --bundle --platform=node --packages=external --outfile=.test-out/voice-test-run.cjs && node .test-out/voice-test-run.cjs
// Run "npm run build" first: it uses dist/stt-worker.js. The report is written next to the recordings.
import path from 'node:path';
import { VoiceTest } from '../src/main/voice-test';
import { shortModelName } from '../src/shared/voicetest';

const project = path.resolve(__dirname, '..');
const data = path.join(process.env.APPDATA!, 'jarvin');
const test = new VoiceTest({ appRoot: project, data, workerFile: path.join(project, 'dist', 'stt-worker.js') });

// --only qwen limits the run to recognizers whose name contains that text, and does not overwrite the saved report.
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1].toLowerCase() : '';
test.run(() => undefined, only ? (m) => m.toLowerCase().includes(only) : undefined, !only).then((report) => {
  console.log(`Recordings: ${report.clips}`);
  for (const m of report.models) {
    if (m.failed) { console.log(`${shortModelName(m.model).padEnd(22)} could not run: ${m.failed}`); continue; }
    console.log(`${shortModelName(m.model).padEnd(22)} wrong ${String(m.errors).padStart(3)} of ${m.words} (${m.errorRate}%)  exact ${m.exactSentences}/${m.lines.length}  name ${m.nameHeard}/${m.nameExpected}  ${(m.avgMs / 1000).toFixed(1)} s each`);
  }
  if (process.argv.includes('--lines')) for (const m of report.models.filter((x) => !x.failed)) {
    console.log(`\n${shortModelName(m.model)} mistakes:`);
    for (const l of m.lines.filter((x) => x.errors > 0 || (x.nameExpected && !x.nameHeard))) console.log(`  said:  ${l.expected}\n  heard: ${l.heard || '(nothing)'}`);
  }
}).catch((e) => { console.error(String(e?.message ?? e)); process.exitCode = 1; });
