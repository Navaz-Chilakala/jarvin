/** Exercises the Windows adapter against a temporary test form only. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { WindowsAutomation, windowsUiaWorker } from '../src/main/windows-uia';
import { runAgent } from '../src/main/agent';
import { builtinTools } from '../src/main/tools';
import type { Settings } from '../src/shared/types';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-uia-test-'));
const stopFile = path.join(root, 'stop');
const title = `Jarvin test ${crypto.randomUUID()}`;
const signal = AbortSignal.timeout(process.argv.includes('--agent') ? 300_000 : 100_000);
let fixture: ChildProcess | null = null;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function run() {
  try {
    fixture = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('scripts/windows-uia-fixture.ps1')], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, JARVIN_FIXTURE_TITLE: title, JARVIN_FIXTURE_STOP: stopFile } });
    let error = ''; fixture.stderr?.on('data', (b: Buffer) => { error += b.toString('utf8'); });
    const raw = windowsUiaWorker(path.resolve('dist/windows-uia.ps1'));
    let diagnostic: any;
    const worker: typeof raw = async (request, s) => { const result = await raw(request, s); if (request.op === 'list') result.windows = result.windows.filter((w: any) => w.title === title); if (request.op === 'inspect') diagnostic = result; return result; };
    const desktop = new WindowsAutomation(worker);
    let windowId = '';
    for (let i = 0; i < 20 && !windowId; i++) {
      if (fixture.exitCode !== null) throw new Error(`Test window exited early: ${error}`);
      const list = JSON.parse(await desktop.list(signal)); windowId = list.windows[0]?.window_id || '';
      if (!windowId) await sleep(250);
    }
    if (!windowId) throw new Error(`Test window was not found: ${error}`);
    if (process.argv.includes('--agent')) {
      const names = new Map<string, string>();
      const completed: string[] = [];
      const settings = { baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:4b', numCtx: 16384, temperature: 0.2, maxSteps: 12 } as Settings;
      const result = await runAgent({
        settings,
        system: 'You are Jarvin. Use the desktop tools to complete the requested task. List windows, inspect the target, act on the current snapshot, and inspect again after each action. Never claim success without verifying it.',
        history: [{ role: 'user', content: 'In the Jarvin test window, enter hello jarvin into Test input, click Apply test, then inspect the window and verify the result.' }],
        tools: builtinTools.filter((t) => t.name.startsWith('desktop_')),
        ctx: { root, signal, desktop },
        approve: async (tool) => tool.name.startsWith('desktop_'),
        emit: (event) => {
          if (event.type === 'tool_start') { names.set(event.id, event.name); console.log(`Agent tool: ${event.name}`); }
          if (event.type === 'tool_result') { const name = names.get(event.id) || 'unknown'; if (event.ok) completed.push(name); else console.log(`Agent tool failed: ${name}: ${event.output}`); }
        },
      });
      const verifyList = JSON.parse(await desktop.list(signal));
      const verifyId = verifyList.windows[0]?.window_id;
      const verify = verifyId && JSON.parse(await desktop.inspect(verifyId, signal));
      const actionIndex = completed.lastIndexOf('desktop_control');
      if (result !== 'finished' || actionIndex < 0 || completed.lastIndexOf('desktop_inspect_window') < actionIndex || !verify?.controls.some((c: any) => c.name === 'Applied: hello jarvin')) throw new Error(`Agent did not complete and verify the fixture task: ${JSON.stringify({ result, completed, controls: verify?.controls })}`);
      console.log('Real Qwen agent passed the controlled desktop task and verified its result.');
      return;
    }
    let observation = JSON.parse(await desktop.inspect(windowId, signal));
    const input = observation.controls.find((c: any) => c.name === 'Test input' && c.role === 'Edit');
    if (!input?.can_set_value) throw new Error(`Input control unavailable: ${JSON.stringify({ controls: observation.controls, diagnostic })}`);
    const set = JSON.parse(await desktop.act(observation.snapshot_id, input.ref, 'set_value', 'hello jarvin', signal));
    if (!set.value_matches) throw new Error('The test input did not retain the value.');
    observation = JSON.parse(await desktop.inspect(windowId, signal));
    const button = observation.controls.find((c: any) => c.name === 'Apply test' && c.role === 'Button');
    if (!button) throw new Error(`Button unavailable: ${JSON.stringify(observation.controls)}`);
    await desktop.act(observation.snapshot_id, button.ref, 'click', undefined, signal);
    await sleep(250);
    observation = JSON.parse(await desktop.inspect(windowId, signal));
    if (!observation.controls.some((c: any) => c.name === 'Applied: hello jarvin')) throw new Error(`Could not verify the clicked result: ${JSON.stringify(observation.controls)}`);
    console.log('Windows UI Automation passed: found a test window, entered text, moved and clicked the mouse, and verified the result.');
  } finally {
    if (fixture && fixture.exitCode === null && fixture.signalCode === null) {
      fs.writeFileSync(stopFile, 'stop');
      const deadline = Date.now() + 5000;
      while (fixture.exitCode === null && fixture.signalCode === null && Date.now() < deadline) await sleep(100);
      if (fixture.exitCode === null && fixture.signalCode === null && fixture.pid) {
        spawnSync('taskkill.exe', ['/PID', String(fixture.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        const limit = Date.now() + 10000;
        while (fixture.exitCode === null && fixture.signalCode === null && Date.now() < limit) await sleep(100);
        if (fixture.exitCode === null && fixture.signalCode === null) throw new Error(`Test window did not exit; temporary files retained at ${root}.`);
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}
void run().catch((e) => { console.error(e); process.exitCode = 1; });
