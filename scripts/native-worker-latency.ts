/** Protocol/startup benchmark only: ping never reads the screen or sends input. */
import path from 'node:path';
import { windowsUiaWorker } from '../src/main/windows-uia';
async function main() {
  const worker = windowsUiaWorker(path.resolve('src/main/windows-uia.ps1'));
  try {
    for (let i = 0; i < 6; i++) {
      const start = performance.now();
      const result = await worker({ op: 'ping' }, AbortSignal.timeout(20_000));
      if (!result.ready) throw new Error('Native worker did not become ready');
      console.log(`${i ? 'warm' : 'cold'} native helper: ${(performance.now() - start).toFixed(1)} ms`);
    }
    // A malformed operation must fail the request but leave the transport usable.
    await worker({ op: 'invalid_test_operation' }, AbortSignal.timeout(5000)).then(() => { throw new Error('Unexpected success'); }, error => { if (!/Unsupported/.test(error.message)) throw error; });
    if (!(await worker({ op: 'ping' }, AbortSignal.timeout(5000))).ready) throw new Error('Worker did not recover');
  } finally { worker.dispose?.(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
