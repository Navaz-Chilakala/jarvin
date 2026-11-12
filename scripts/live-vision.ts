/** Optional local-model check using the app's icon, not the user's screen. */
import fs from 'node:fs';
import { inspectWithOllama } from '../src/main/vision';

inspectWithOllama({
  baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:4b',
  image: fs.readFileSync('assets/icon.png').toString('base64'),
  question: 'Briefly describe this image.', signal: AbortSignal.timeout(120_000),
}).then((answer) => console.log(answer)).catch((error) => { console.error(error); process.exitCode = 1; });
