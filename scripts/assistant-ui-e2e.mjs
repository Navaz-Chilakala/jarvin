// Isolated Electron profile and fake model. No real user tasks or microphone are touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electron = require('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-assistant-ui-'));
const data = path.join(root, 'profile'), workspace = path.join(data, 'assistant-workspace');
fs.mkdirSync(data);
let child; const connections = [];
let requests = 0;
const notices = process.argv.includes('--notices');
const server = http.createServer((req, res) => {
  if (req.url === '/api/version') return void res.end(JSON.stringify({ version: 'test' }));
  if (req.url === '/api/tags') return void res.end(JSON.stringify({ models: [{ name: 'test', size: 1 }] }));
  if (req.url === '/api/chat') {
    req.resume(); requests++;
    if (requests === 1) return void res.end(JSON.stringify({ message: { tool_calls: [{ function: { name: 'write_file', arguments: { path: 'not-written.txt', content: 'no' } } }] }, done: true }) + '\n');
    if (requests === 2) return void res.end(JSON.stringify({ message: { role: 'assistant', content: 'Action denied.' }, done: true }) + '\n');
    return; // Hold the next run open until the companion stops it.
  }
  res.writeHead(404); res.end();
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, timeout = 25000) { const end = Date.now() + timeout; while (Date.now() < end) { const r = await fn(); if (r) return r; await sleep(100); } throw new Error(`Timed out waiting for ${label}.`); }
async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl); connections.push(socket);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0; const pending = new Map();
  socket.addEventListener('message', (event) => { const msg = JSON.parse(event.data); const p = pending.get(msg.id); if (!p) return; pending.delete(msg.id); clearTimeout(p.timer); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); });
  const call = (method, params) => new Promise((resolve, reject) => { const n = ++id; const timer = setTimeout(() => { pending.delete(n); reject(new Error(`Timed out on ${method}`)); }, 10000); pending.set(n, { resolve, reject, timer }); socket.send(JSON.stringify({ id: n, method, params })); });
  return { eval: async (expression) => { const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'Renderer error'); return r.result.value; }, click: async (x, y) => { await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x, y }); await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x, y }); }, drag: async (x, y, dx, dy) => { await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x, y }); await call('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: x + dx, y: y + dy }); await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: x + dx, y: y + dy }); }, resize: (width, height) => call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }), capture: async (name) => { if (process.env.JARVIN_TEST_CAPTURE !== '1') return; const r = await call('Page.captureScreenshot', { format: 'png' }); fs.mkdirSync('.test-out', { recursive: true }); fs.writeFileSync(path.join('.test-out', name), Buffer.from(r.data, 'base64')); } };
}

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ workspace: '', baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'test', mode: 'ask', offline: !notices, setupDone: true, autoCheck: false, notifyDone: false, voice: { enabled: false }, proactive: { enabled: notices, lowBattery: false, commands: true, downloads: true, meetings: true } }));
  child = spawn(electron, ['.', `--user-data-dir=${data}`, '--remote-debugging-port=0', '--remote-allow-origins=*'], { cwd: process.cwd(), windowsHide: true, stdio: 'ignore', env: { ...process.env, JARVIN_E2E: '1', JARVIN_E2E_HEADLESS: '1', JARVIN_E2E_DATA_DIR: root, JARVIN_SAFE_MODE: '1' } });
  let spawnError; child.once('error', (e) => { spawnError = e; });
  const port = await until(() => { if (spawnError) throw spawnError; if (child.exitCode !== null) throw new Error(`Electron exited ${child.exitCode}`); try { return Number(fs.readFileSync(path.join(data, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { return null; } }, 'debug port');
  const targets = async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json());
  const mainTarget = await until(async () => (await targets()).find((t) => /renderer\/index\.html/.test(t.url)), 'main window');
  const main = await connect(mainTarget);
  await until(() => main.eval("Boolean(document.getElementById('uiCompact')?.onclick)"), 'assistant UI');
  if (process.env.JARVIN_TEST_LOCAL_VOICES === '1') {
    const voices = await until(() => main.eval("speechSynthesis.getVoices().filter(v => v.localService).map(v => v.name)" ).then((v) => v.length ? v : null), 'local speech voices', 15000);
    console.log(`Available local speech voices: ${voices.length}`);
  }
  assert.equal((await main.eval('window.jarvin.getSettings()')).workspace, workspace, 'a personal workspace is created when no folder is selected');
  assert.equal(await main.eval("document.getElementById('uiAssistant').getAttribute('aria-pressed')"), 'true');
  await main.capture('assistant-view.png');
  const lightColor = await main.eval("document.body.classList.add('light'); getComputedStyle(document.body).color");
  assert.equal(lightColor, 'rgb(237, 242, 255)', 'assistant text stays readable when the editor theme is light');
  await main.eval("document.body.classList.remove('light')");
  await main.resize(900, 650);
  await main.eval("document.getElementById('uiCode').click()");
  assert.equal(await main.eval("!document.getElementById('editor').hidden"), true);
  await main.capture('assistant-code-narrow.png');
  assert.equal(await main.eval("document.getElementById('setBtn').getBoundingClientRect().right <= innerWidth - 140"), true, 'coding toolbar stays clear of Windows window controls');
  await main.eval("document.getElementById('uiAssistant').click()");
  assert.equal(await main.eval("document.getElementById('editor').hidden"), true);
  await main.resize(1480, 920);
  await main.eval("document.getElementById('input').value = 'Perform the test task'; document.getElementById('input').dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('composer').requestSubmit()");
  await until(() => main.eval("Array.from(document.querySelectorAll('.tapprove button')).some(b => b.textContent === 'Deny')"), 'approval');
  await main.eval("document.getElementById('uiCompact').click()");
  const widgetTarget = await until(async () => (await targets()).find((t) => /assistant-widget\.html/.test(t.url)), 'companion window');
  const widget = await connect(widgetTarget);
  await until(() => widget.eval("document.getElementById('status')?.textContent === 'Needs your input'"), 'companion approval status');
  assert.equal((await main.eval('window.jarvin.chatStatus()')).running, true, 'task continues while compact');
  assert.equal(await widget.eval("Boolean(document.querySelector('#pet .robot'))"), true, 'the companion has a robot character');
  assert.equal(await widget.eval("document.querySelectorAll('button').length"), 2, 'the floating window holds the character and its microphone switch');
  assert.equal(await widget.eval("document.querySelector('.drag-handle').getBoundingClientRect().bottom <= document.getElementById('pet').getBoundingClientRect().top"), true, 'drag area does not cover the clickable character');
  await widget.capture('assistant-widget.png');
  await main.eval("document.getElementById('uiCode').click()");
  const petPoint = await widget.eval("(() => { const r = document.getElementById('pet').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
  const petBefore = await widget.eval('({ x: window.screenX, y: window.screenY })');
  await widget.drag(petPoint.x, petPoint.y, -48, -32);
  await until(async () => { const after = await widget.eval('({ x: window.screenX, y: window.screenY })'); return after.x < petBefore.x - 20 && after.y < petBefore.y - 10; }, 'pet body drag');
  assert.equal(await main.eval("document.getElementById('uiAssistant').getAttribute('aria-pressed')"), 'false', 'dragging must not open the assistant');
  await widget.click(petPoint.x, petPoint.y);
  await until(() => main.eval("document.getElementById('uiAssistant').getAttribute('aria-pressed') === 'true'"), 'assistant view from pet');
  await main.eval("Array.from(document.querySelectorAll('.tapprove button')).find(b => b.textContent === 'Deny').click()");
  await until(async () => !(await main.eval('window.jarvin.chatStatus()')).running, 'denied task to finish');
  assert.equal(await main.eval("getComputedStyle(document.querySelector('.composer-label')).display !== 'none'"), true, 'companion composer is visible');
  assert.equal(await main.eval("document.querySelector('.assistant-portrait').naturalWidth > 0"), true, 'companion portrait loaded');
  await main.capture('assistant-conversation.png');
  await main.eval("window.jarvin.assistantState({working:false,mic:'off',speaking:true})");
  await until(() => widget.eval("document.body.dataset.speaking === 'true'"), 'companion speaking state');
  assert.equal(await widget.eval("getComputedStyle(document.querySelector('#pet .robot')).animationName"), 'talk', 'the pet moves differently while speaking');
  assert.equal(await widget.eval("document.querySelector('#pet .robot').naturalWidth > 0"), true, 'the pet picture loaded');
  await main.eval("window.__petStopEvents = 0; window.jarvin.onAssistantAction(action => { if (action === 'stop') window.__petStopEvents++; })");
  await widget.eval("window.assistantWidget.act('stop')");
  await until(() => main.eval('window.__petStopEvents === 1'), 'companion stop delivered after a reply');
  await main.eval("window.jarvin.assistantState({working:false,mic:'off',speaking:false})");
  assert.equal(fs.existsSync(path.join(workspace, 'not-written.txt')), false);
  const job = await main.eval(`window.jarvin.jobsStart('node -e "setTimeout(()=>{},8000)"')`);
  await main.eval("document.getElementById('input').value = 'Wait for the test'; document.getElementById('input').dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('composer').requestSubmit()");
  await until(() => requests >= 3, 'background task');
  await main.eval("document.getElementById('uiCompact').click()");
  await until(() => widget.eval("document.getElementById('status').textContent === 'Working'"), 'working state');
  await widget.eval("window.assistantWidget.act('stop')");
  await until(async () => !(await main.eval('window.jarvin.chatStatus()')).running, 'companion stop');
  await until(() => widget.eval("document.getElementById('status').textContent === '1 background job'"), 'background job indicator');
  assert.equal(await main.eval(`window.jarvin.jobsStop(${JSON.stringify(job.id)})`), true);
  await until(() => widget.eval("document.getElementById('status').textContent === 'Stopped · mic off'"), 'background job stop');
  await widget.eval("window.assistantWidget.act('code')");
  await until(() => main.eval("document.getElementById('uiCode').getAttribute('aria-pressed') === 'true'"), 'code view from companion');
  console.log('Companion body dragging, click-to-open, code switching, background job, approval, and stop passed in isolated Electron.');
  if (notices) {
    await main.eval(`window.noticeLog = []; new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) if (node.classList?.contains('toast')) window.noticeLog.push(node.textContent);
    }).observe(document.body,{childList:true}); true`);
    const saw = (part) => main.eval(`window.noticeLog.some(t => t.includes(${JSON.stringify(part)}))`);
    await main.eval("window.jarvin.jobsStart('echo finished')");
    await until(() => saw('Background command finished'), 'command completion toast');
    const meeting = await main.eval("window.jarvin.remindersCreate('Fixture meeting', Date.now()+540000)");
    try { await until(() => saw('Fixture meeting'), 'meeting toast', 45_000); }
    finally { await main.eval(`window.jarvin.remindersRemove(${JSON.stringify(meeting.id)})`); }
    const url = new URL(process.env.JARVIN_TEST_PULL_URL);
    if (url.hostname !== '127.0.0.1') throw Error('Use an isolated loopback Ollama server.');
    await main.eval(`window.jarvin.setSettings({baseUrl:${JSON.stringify(url.origin)}})`);
    await main.eval("void window.jarvin.modelsPull('all-minilm:22m').then(p=>window.pullResult=p); true");
    await until(() => main.eval('Boolean(window.pullResult)'), 'isolated Ollama pull', 180_000);
    assert.equal((await main.eval('window.pullResult')).error, undefined);
    assert.ok(await saw('Model download finished: all-minilm:22m'));
    console.log('Observed completion, upcoming meeting, and real Ollama download notices.');
  }
} finally {
  for (const c of connections) try { c.close(); } catch { /* already closed */ }
  if (child && child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else child.kill('SIGKILL');
    const stopped = await until(() => child.exitCode !== null || child.signalCode !== null, 'test app exit', 10000).then(() => true, () => false);
    if (!stopped) throw new Error(`Test app did not exit; temporary data retained at ${root}.`);
  }
  await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  for (let attempt = 0; ; attempt++) {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); break; }
    catch (error) {
      if (attempt >= 19 || !['EPERM', 'EBUSY'].includes(error?.code)) throw error;
      await sleep(500);
    }
  }
}
