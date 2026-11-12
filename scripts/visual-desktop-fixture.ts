/** Real desktop input test: only a temporary, full-screen fixture may receive clicks or typing. */
import { app, BrowserWindow } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { builtinTools } from '../src/main/tools';
import { VisualGrounding } from '../src/main/visual-grounding';
import { WindowsAutomation, windowsUiaWorker } from '../src/main/windows-uia';

const root = process.env.JARVIN_VISUAL_TEST_ROOT!;
const ready = path.join(root, 'ready.json'), stateFile = path.join(root, 'state.json'), stop = path.join(root, 'stop');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const signal = AbortSignal.timeout(180_000);
const tool = (name: string) => { const item = builtinTools.find((t) => t.name === name); if (!item) throw new Error(`Missing ${name}`); return item; };

app.whenReady().then(async () => {
  if (process.argv.includes('--visual-target')) {
    const win = new BrowserWindow({ show: false, fullscreen: true, alwaysOnTop: true, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    const html = `<!doctype html><title>Jarvin visual input test</title><style>body{margin:0;background:#eaf1fa;color:#182841;font:28px Arial}main{padding:5vh 10vw}button,input{font:32px Arial;border-radius:12px;padding:24px}button{background:#1464bc;color:white;border:0;width:400px;height:120px}input{width:540px;border:3px solid #38668e}#status{font-size:34px;margin-top:50px}</style><main><h1>Jarvin test window</h1><p>Use the blue button, then type in the box.</p><button id="blue">BLUE BUTTON</button><p><label>TEST INPUT<br><input id="input" placeholder="Test input"></label></p><div id="status">Waiting for test</div></main><script>document.getElementById('blue').onclick=()=>{document.getElementById('status').textContent='Blue button clicked';document.title='fixture:clicked';};document.getElementById('input').addEventListener('keydown',e=>{if(e.key==='Enter'){document.getElementById('status').textContent='Typed: '+e.target.value;document.title='fixture:typed:'+e.target.value;}});</script>`;
    win.on('page-title-updated', (_event, title) => { if (title.startsWith('fixture:')) fs.writeFileSync(stateFile, title); });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    win.show(); win.focus();
    fs.writeFileSync(ready, JSON.stringify({ source: win.getMediaSourceId() }));
    const timer = setInterval(() => { if (fs.existsSync(stop)) { clearInterval(timer); win.destroy(); app.exit(0); } }, 100);
    setTimeout(() => app.exit(1), 200_000);
    return;
  }
  let child: ChildProcess | undefined, code = 0;
  try {
    child = spawn(process.execPath, [process.argv[1], `--user-data-dir=${path.join(root, 'target-profile')}`, '--visual-target'], { windowsHide: true, stdio: 'ignore', env: process.env });
    const deadline = Date.now() + 20_000;
    while (!fs.existsSync(ready) && child.exitCode === null && Date.now() < deadline) await sleep(100);
    if (!fs.existsSync(ready)) throw new Error('Controlled test window did not start.');
    const match = /^window:(\d+):\d+$/.exec(JSON.parse(fs.readFileSync(ready, 'utf8')).source);
    if (!match) throw new Error('Controlled test window has no usable handle.');
    const expectedHandle = match[1];
    const desktop = new WindowsAutomation(windowsUiaWorker(path.resolve('dist/windows-uia.ps1')));
    const pin = desktop.pinForeground.bind(desktop);
    desktop.pinForeground = async (s) => { const ref = await pin(s); if (await desktop.captureHandle(ref, s) !== expectedHandle) throw new Error('The fixture is not the foreground window. No test input was sent.'); return ref; };
    const ctx = { root, signal, desktop, visual: new VisualGrounding(), baseUrl: 'http://127.0.0.1:11434', visionModel: process.env.JARVIN_TEST_VISION_MODEL || 'qwen3.5:4b' };
    await sleep(700);
    const clickAndObserve = async (target: string, expected_result: string) => {
      const result = JSON.parse(await tool('visual_click').run({ target, expected_result }, ctx));
      if (!result.input_sent || result.observation_error) throw new Error(`Visual click could not be verified: ${JSON.stringify(result)}`);
      return String(result.observation);
    };
    const observation = await clickAndObserve('the large blue button labelled BLUE BUTTON', 'Blue button clicked');
    if (!/blue button clicked/i.test(observation)) throw new Error(`The new screen observation did not confirm the button: ${observation}`);
    await sleep(300);
    if (!fs.existsSync(stateFile) || fs.readFileSync(stateFile, 'utf8') !== 'fixture:clicked') throw new Error('The button click was not verified in the test window.');
    await clickAndObserve('the large text input box under the TEST INPUT label', 'the TEST INPUT field is focused');
    const foreground = await desktop.pinForeground(signal);
    await desktop.checkForeground(foreground, signal);
    await tool('keyboard_type').run({ text: 'hello jarvin' }, ctx);
    await desktop.checkForeground(foreground, signal);
    await tool('keyboard_press').run({ key: 'Enter' }, ctx);
    await sleep(300);
    if (fs.readFileSync(stateFile, 'utf8') !== 'fixture:typed:hello jarvin') throw new Error('Typing and Enter were not verified in the test window.');
    console.log('Real desktop test passed: local vision located two controls, the mouse clicked them, and typed text was verified in the isolated window.');
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
