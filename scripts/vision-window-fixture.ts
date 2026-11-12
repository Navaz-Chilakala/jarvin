/** Captures an isolated window from a second process; no user window is sent to the model. */
import { app, BrowserWindow, desktopCapturer } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { builtinTools } from '../src/main/tools';

const root = process.env.JARVIN_VISION_FIXTURE_ROOT!;
const ready = path.join(root, 'ready.json'), stop = path.join(root, 'stop');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  if (process.argv.includes('--vision-target')) {
    const fixture = new BrowserWindow({ width: 640, height: 320, x: 20, y: 20, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    await fixture.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><title>Jarvin isolated vision fixture</title><body style="font: bold 42px Arial;background:white;color:black;padding:40px">The secret test color is VIOLET.</body>'));
    fixture.showInactive();
    fs.writeFileSync(ready, JSON.stringify({ source: fixture.getMediaSourceId() }));
    const timer = setInterval(() => { if (fs.existsSync(stop)) { clearInterval(timer); fixture.destroy(); app.exit(0); } }, 100);
    setTimeout(() => app.exit(1), 160_000);
    return;
  }
  let code = 0, child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, [process.argv[1], `--user-data-dir=${path.join(root, 'target-profile')}`, '--vision-target'], { windowsHide: true, stdio: 'ignore', env: process.env });
    const deadline = Date.now() + 20_000;
    while (!fs.existsSync(ready) && child.exitCode === null && Date.now() < deadline) await sleep(100);
    if (!fs.existsSync(ready)) throw new Error('Test window did not start.');
    const id = /^window:(\d+):\d+$/.exec(JSON.parse(fs.readFileSync(ready, 'utf8')).source);
    if (!id) throw new Error('Could not determine fixture window handle.');
    await sleep(500);
    const allSources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1600, height: 1000 } });
    const ownSources = allSources.filter((source) => source.id.split(':')[1] === id[1]);
    console.log(`Fixture handle ${id[1]}; matching capture sources: ${ownSources.length}`);
    const tool = builtinTools.find((t) => t.name === 'see_window');
    if (!tool) throw new Error('Window vision tool missing.');
    let checks = 0;
    const result = await tool.run({ window_id: 'fixture', question: 'Read the sentence and report the secret test color.' }, {
      root, signal: AbortSignal.timeout(120_000), baseUrl: 'http://127.0.0.1:11434', visionModel: 'qwen3.5:4b',
      desktop: { captureHandle: async (ref: unknown) => { if (ref !== 'fixture') throw new Error('Unexpected target.'); checks++; return id[1]; } } as any,
    });
    if (checks !== 2 || !/violet/i.test(result)) throw new Error(`Vision result was not verified: ${JSON.stringify({ checks, result })}`);
    console.log(`Window image capture and local vision passed: ${result}`);
  } catch (error) { console.error(error); code = 1; }
  finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      fs.writeFileSync(stop, 'stop');
      const deadline = Date.now() + 5000;
      while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await sleep(100);
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await sleep(1000); }
    }
    app.exit(code);
  }
});
