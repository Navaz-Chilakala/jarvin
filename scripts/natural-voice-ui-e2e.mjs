// Exercise the real renderer, IPC, local Piper worker and Web Audio with isolated data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-neural-ui-'));
const data = path.join(root, 'profile');
const installed = path.join(process.env.APPDATA, 'jarvin', 'models', 'piper');
const sockets = [];
let child, finalSent = false;
const server = http.createServer((req, res) => {
  if (req.url === '/api/version') return void res.end(JSON.stringify({ version: 'test' }));
  if (req.url === '/api/tags') return void res.end(JSON.stringify({ models: [{ name: 'test', size: 1 }] }));
  if (req.url === '/api/chat') {
    req.resume();
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.write(JSON.stringify({ message: { role: 'assistant', content: 'Hello there. ' }, done: false }) + '\n');
    setTimeout(() => { finalSent = true; res.end(JSON.stringify({ message: { role: 'assistant', content: 'I can help.' }, done: true }) + '\n'); }, 6000);
    return;
  }
  res.writeHead(404); res.end();
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 25000) { const end = Date.now() + timeout; while (Date.now() < end) { const r = await fn(); if (r) return r; await sleep(100); } throw new Error(`Timed out waiting for ${label}`); }
async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl); sockets.push(socket);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0; const pending = new Map();
  socket.addEventListener('message', e => { const msg = JSON.parse(e.data); const p = pending.get(msg.id); if (!p) return; pending.delete(msg.id); clearTimeout(p.timer); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); });
  const call = (method, params) => new Promise((resolve, reject) => { const n = ++id; const timer = setTimeout(() => { pending.delete(n); reject(new Error(`Timed out on ${method}`)); }, 45000); pending.set(n, { resolve, reject, timer }); socket.send(JSON.stringify({ id: n, method, params })); });
  return { eval: async expression => { const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'Renderer error'); return r.result.value; } };
}
try {
  fs.mkdirSync(path.join(data, 'models', 'piper'), { recursive: true });
  for (const file of ['joe.onnx', 'joe.onnx.json']) fs.copyFileSync(path.join(installed, file), path.join(data, 'models', 'piper', file));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ workspace: '', baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'test', mode: 'ask', offline: true, setupDone: true, autoCheck: false, voice: { enabled: true, handsFree: false, speak: 'full', ttsEngine: 'auto' } }));
  child = spawn(require('electron'), ['.', `--user-data-dir=${data}`, '--remote-debugging-port=0', '--remote-allow-origins=*', '--mute-audio'], { cwd: process.cwd(), windowsHide: true, stdio: 'ignore', env: { ...process.env, JARVIN_E2E: '1', JARVIN_E2E_HEADLESS: '1', JARVIN_E2E_DATA_DIR: root, JARVIN_SAFE_MODE: '1' } });
  let spawnError; child.once('error', e => { spawnError = e; });
  const port = await until(() => { if (spawnError) throw spawnError; if (child.exitCode !== null) throw new Error(`Electron exited ${child.exitCode}`); try { return Number(fs.readFileSync(path.join(data, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { return null; } }, 'debug port');
  const targets = async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json());
  const main = await connect(await until(async () => (await targets()).find(t => /renderer\/index\.html/.test(t.url)), 'main window'));
  await until(() => main.eval("Boolean(document.getElementById('uiCompact')?.onclick)"), 'assistant UI');
  await main.eval("window.__naturalStarted = 0; window.__systemCalls = 0; const originalStart = AudioBufferSourceNode.prototype.start; AudioBufferSourceNode.prototype.start = function(...args) { window.__naturalStarted++; return originalStart.apply(this, args); }; speechSynthesis.speak = () => { window.__systemCalls++; }");
  assert.equal((await main.eval('window.jarvin.neuralVoiceWarm()')).ok, true, 'installed local voice warms');
  await main.eval("document.getElementById('uiCompact').click()");
  const widget = await connect(await until(async () => (await targets()).find(t => /assistant-widget\.html/.test(t.url)), 'companion'));
  await main.eval("document.getElementById('input').value = 'Say hello'; document.getElementById('input').dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('composer').requestSubmit()");
  await until(() => main.eval('window.__naturalStarted > 0'), 'neural audio playback', 20000);
  assert.equal(finalSent, false, 'speech starts before the model finishes responding');
  assert.equal(await main.eval('window.__systemCalls'), 0, 'neural voice is used rather than system fallback');
  await until(() => widget.eval("document.body.dataset.speaking === 'true'"), 'pet speaking state');
  await until(() => finalSent, 'completed response');
  await until(() => widget.eval("document.body.dataset.speaking === 'false'"), 'audio ended', 20000);
  console.log('Natural voice UI passed: local neural audio starts during the streamed reply and the pet follows playback.');
} finally {
  for (const socket of sockets) try { socket.close(); } catch {}
  if (child && child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else child.kill('SIGKILL');
    await until(() => child.exitCode !== null || child.signalCode !== null, 'test app exit', 10000);
  }
  await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  for (let attempt = 0; ; attempt++) { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); break; } catch (error) { if (attempt >= 19 || !['EPERM', 'EBUSY'].includes(error?.code)) throw error; await sleep(500); } }
}
