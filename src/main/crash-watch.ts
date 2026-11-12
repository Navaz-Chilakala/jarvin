import { spawn } from 'node:child_process';
import { allowReload } from './background';

// This process lives only for the current Windows session. The main process
// terminates it on Quit or session end. A broken IPC pipe signals a main crash.
if (process.send) {
  process.on('disconnect', () => {
    const prior = (process.env.JARVIN_CRASH_TIMES ?? '').split(',').map(Number).filter(Number.isFinite);
    const history = allowReload(prior, Date.now());
    if (!history) return;
    const env: NodeJS.ProcessEnv = { ...process.env, JARVIN_CRASH_TIMES: history.join(',') };
    delete env.ELECTRON_RUN_AS_NODE;
    setTimeout(() => {
      const app = spawn(process.execPath, process.argv.slice(2), { detached: true, stdio: 'ignore', windowsHide: true, env });
      app.on('error', () => { process.exitCode = 1; });
      app.unref();
    }, 1500);
  });
}
