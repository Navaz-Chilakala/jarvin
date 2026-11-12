/** Launch Chrome with a disposable profile and verify its process starts. */
import { launchProgram } from '../src/main/launch';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-chrome-launch-'));
let child: ChildProcess | null = null;
async function run() {
  try {
    await launchProgram('chrome', ['--headless=new', '--no-first-run', '--disable-gpu', `--user-data-dir=${root}`, 'about:blank'], {
      openPath: async () => '',
      spawnChild: (file, args) => { child = spawn(file, args, { windowsHide: true, stdio: 'ignore' }); return child; },
    });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    if (!child || (child as ChildProcess).exitCode !== null) throw new Error('Chrome exited immediately after launching.');
    console.log('Chrome was located and launched with an isolated temporary profile.');
  } finally {
    const proc = child as ChildProcess | null;
    if (proc?.pid && proc.exitCode === null) {
      spawnSync('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      const deadline = Date.now() + 10000;
      while (proc.exitCode === null && proc.signalCode === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
      if (proc.exitCode === null && proc.signalCode === null) throw new Error(`Test Chrome did not exit; temporary data retained at ${root}.`);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}
void run().catch((e) => { console.error(e); process.exitCode = 1; });
