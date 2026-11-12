/** Controlled Chrome acceptance check using Jarvin's real screen, mouse and keyboard tools. */
import { app } from 'electron';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { builtinTools } from '../src/main/tools';
import { VisualGrounding } from '../src/main/visual-grounding';
import { WindowsAutomation, windowsUiaWorker } from '../src/main/windows-uia';
import { runAgent } from '../src/main/agent';
import type { Settings } from '../src/shared/types';

const root = process.env.JARVIN_CHROME_VISUAL_ROOT!;
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const signal = AbortSignal.timeout(180_000);
const externalDocs = process.argv.includes('--external-docs');
const agentDocs = process.argv.includes('--agent-docs');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const tool = (name: string) => { const found = builtinTools.find(t => t.name === name); if (!found) throw new Error(`Missing ${name}`); return found; };

app.whenReady().then(async () => {
  let child: ReturnType<typeof spawn> | undefined;
  let desktop: WindowsAutomation | undefined;
  let code = 0;
  try {
    if (!fs.existsSync(chrome)) throw new Error('Google Chrome is not installed at the expected path.');
    const page = path.join(root, 'task.html');
    fs.writeFileSync(page, `<!doctype html><html><head><title>Jarvin Chrome Visual Fixture</title><style>body{font:26px Arial;background:#f1f5f9;color:#152438;margin:7vh 10vw}main{background:white;padding:40px;border-radius:16px}button,input{font:30px Arial;padding:18px}button{background:#1659bb;color:white;border:0;border-radius:12px}input{border:2px solid #1659bb;border-radius:8px}#result{margin-top:35px;font-weight:bold}</style></head><body><main><h1>Chrome visual task</h1><p>Click the BLUE BUTTON, then type in the TEST INPUT field.</p><button id="blue">BLUE BUTTON</button><p><label>TEST INPUT<br><input id="input" placeholder="Type here"></label></p><div id="result">RESULT: WAITING</div></main><script>document.getElementById('blue').onclick=()=>{document.getElementById('result').textContent='RESULT: BLUE BUTTON CLICKED';document.title='Jarvin Chrome Visual Fixture - clicked';};document.getElementById('input').onkeydown=e=>{if(e.key==='Enter'){document.getElementById('result').textContent='RESULT: TYPED '+e.target.value;document.title='Jarvin Chrome Visual Fixture - typed '+e.target.value;}};</script></body></html>`);
    child = spawn(chrome, [`--user-data-dir=${path.join(root, 'chrome-profile')}`, '--no-first-run', '--no-default-browser-check', '--new-window', 'about:blank'], { stdio: 'ignore', windowsHide: false });
    desktop = new WindowsAutomation(windowsUiaWorker(path.resolve('dist/windows-uia.ps1')));
    const deadline = Date.now() + 20_000;
    let chromeWindow: string | undefined;
    while (!chromeWindow && Date.now() < deadline) {
      const list = JSON.parse(await desktop.list(signal)) as { windows: { window_id: string; app: string; title: string; pid: number }[] };
      const matches = list.windows.filter(w => w.app.toLowerCase() === 'chrome' && w.pid === child?.pid);
      if (matches.length === 1) chromeWindow = matches[0].window_id;
      else await sleep(250);
    }
    if (!chromeWindow) throw new Error('Could not identify the fresh Chrome window.');
    await desktop.focus(chromeWindow, signal);
    const ctx = { root, signal, desktop, visual: new VisualGrounding(), baseUrl: 'http://127.0.0.1:11434', visionModel: process.env.JARVIN_TEST_VISION_MODEL || 'qwen3-vl:4b-instruct' };
    await tool('keyboard_press').run({ key: 'Ctrl+L' }, ctx);
    await tool('keyboard_type').run({ text: externalDocs || agentDocs ? 'https://docs.python.org/3/' : new URL(`file:///${page.replace(/\\/g, '/')}`).href }, ctx);
    await tool('keyboard_press').run({ key: 'Enter' }, ctx);
    await sleep(externalDocs || agentDocs ? 1800 : 900);
    const first = await tool('inspect_screen').run({ question: externalDocs || agentDocs ? 'What documentation site is visible, and is a Tutorial link present?' : 'Read the main heading and button label visible in this Chrome page.' }, ctx);
    if (externalDocs || agentDocs) {
      if (!/python/i.test(first)) throw new Error(`The external documentation page was not visually verified: ${first}`);
      if (agentDocs) {
        const history: any[] = [{ role: 'user', content: 'In the visible Chrome window, click the Tutorial link in the Python documentation, then tell me the heading of the page that opens.' }];
        const seen: string[] = [];
        const selected = builtinTools.filter(t => ['visual_click', 'inspect_screen'].includes(t.name));
        const settings = { baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:4b', numCtx: 16384, temperature: 0.2, maxSteps: 6 } as Settings;
        const result = await runAgent({ settings, history, tools: selected, ctx, approve: async () => true,
          system: 'You are Jarvin. Operate the visible page through screen images and the real mouse. Use visual_click for a requested click; it examines a fresh image afterward. Only report what the image confirms.',
          emit: event => { if (event.type === 'tool_start') { seen.push(event.name); console.log(`Agent requested: ${event.name}`); } },
        });
        if (result !== 'finished' || !seen.includes('visual_click')) throw new Error(`The local agent did not use visual clicking: ${JSON.stringify({ result, seen })}`);
        const after = await tool('inspect_screen').run({ question: 'Which Python documentation page is visible now? Read its main heading.' }, ctx);
        if (!/tutorial/i.test(after)) throw new Error(`The agent did not reach the Tutorial page: ${after}`);
        console.log('Autonomous Chrome docs task passed: local chat model selected the visual click, real mouse input opened Tutorial, and screen vision verified the page.');
        return;
      }
      const tutorial = JSON.parse(await tool('visual_click').run({ target: 'the Tutorial link in the Python documentation navigation', expected_result: 'the Python Tutorial page is open' }, ctx));
      if (!tutorial.input_sent || tutorial.observation_error) throw new Error(`External documentation click was not observed: ${JSON.stringify(tutorial)}`);
      await sleep(900);
      const after = await tool('inspect_screen').run({ question: 'Which Python documentation page is visible now? Read its main heading.' }, ctx);
      if (!/tutorial/i.test(after)) throw new Error(`The Python Tutorial page was not visually verified: ${after}`);
      console.log('External Chrome docs task passed: navigated with keyboard, used screen vision to click Tutorial, and read the resulting page.');
      return;
    }
    if (!/chrome visual task/i.test(first) || !/blue button/i.test(first)) throw new Error(`Chrome navigation was not visible to the vision model: ${first}`);
    const clicked = JSON.parse(await tool('visual_click').run({ target: 'the large BLUE BUTTON in the Chrome page', expected_result: 'RESULT: BLUE BUTTON CLICKED' }, ctx));
    if (!clicked.input_sent || !/blue button clicked/i.test(clicked.observation || '')) throw new Error(`Chrome click was not visually verified: ${JSON.stringify(clicked)}`);
    const field = JSON.parse(await tool('visual_click').run({ target: 'the TEST INPUT text box in the Chrome page', expected_result: 'the input is focused' }, ctx));
    if (!field.input_sent || field.observation_error) throw new Error(`Chrome input click failed: ${JSON.stringify(field)}`);
    await tool('keyboard_type').run({ text: 'hello jarvin' }, ctx);
    await tool('keyboard_press').run({ key: 'Enter' }, ctx);
    await sleep(200);
    const final = await tool('inspect_screen').run({ question: 'Read the RESULT text in this Chrome page.' }, ctx);
    if (!/typed hello jarvin/i.test(final)) throw new Error(`Chrome typing was not visually verified: ${final}`);
    console.log('Chrome visual task passed: navigated with keyboard, read the page, clicked the button, typed text and read the result from screen images.');
  } catch (error) { console.error(error); code = 1; }
  finally {
    desktop?.dispose();
    if (child?.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    app.exit(code);
  }
});
