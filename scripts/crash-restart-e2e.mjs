// Windows acceptance check. Only the main process of this temporary profile is killed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const electron = createRequire(import.meta.url)('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-watch-'));
const log = path.join(root, 'app.log');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(read) {
  for (let n = 0; n < 150; n++) { const value = await read(); if (value) return value; await delay(200); }
  throw Error('Timed out waiting for ' + read);
}
async function evaluate(page, expression) {
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(Error('Renderer timeout')); }, 5000);
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    socket.onmessage = e => {
      const result = JSON.parse(e.data);
      if (result.id !== 1) return;
      clearTimeout(timer); socket.close();
      if (result.result?.exceptionDetails) reject(Error(result.result.exceptionDetails.text));
      else resolve(result.result?.result?.value);
    };
    socket.onerror = () => { clearTimeout(timer); reject(Error('Renderer connection failed')); };
  });
}
async function page(name) {
  return wait(async () => {
    try {
      const port = fs.readFileSync(path.join(root, 'DevToolsActivePort'), 'utf8').split('\n')[0];
      return (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find(p => p.url.includes(name));
    } catch { return null; }
  });
}
fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ setupDone: true, offline: true, observationPaused: true, voice: { enabled: false } }));
const child = spawn(electron, ['.', '--background', '--user-data-dir=' + root, '--remote-debugging-port=0'], {
  windowsHide: true, stdio: 'ignore', env: { ...process.env, JARVIN_E2E: '1', JARVIN_E2E_HEADLESS: '1', JARVIN_E2E_DATA_DIR: root, JARVIN_TEST_CRASH_WATCH: '1', JARVIN_SAFE_MODE: '1',
    // Leave two restarts available so the normal Quit check can detect a relaunch.
    JARVIN_CRASH_TIMES: String(Date.now()) },
});
const loads = () => fs.existsSync(log) ? (fs.readFileSync(log, 'utf8').match(/did-finish-load/g) ?? []).length : 0;
try {
  await wait(() => loads() === 1);
  const portFile = path.join(root, 'DevToolsActivePort');
  const firstEndpoint = fs.readFileSync(portFile, 'utf8');
  child.kill();
  await wait(() => fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8') !== firstEndpoint);
  const main = await page('renderer/index.html');
  await wait(() => evaluate(main, "Boolean(document.getElementById('uiCompact')?.onclick)"));
  await evaluate(main, "document.getElementById('uiCompact').click()");
  const widget = await page('assistant-widget.html');
  await evaluate(widget, "setTimeout(() => window.assistantWidget.act('quit'), 100)");
  await delay(3500);
  await assert.rejects(fetch(new URL('/json/list', widget.webSocketDebuggerUrl.replace('ws:', 'http:'))));
  assert.equal(loads(), 1);
  console.log('Isolated Windows app returned after its main process was killed. Quit was sent through the pet.');
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
} catch (e) { console.error('Isolated profile retained at', root); throw e; }
