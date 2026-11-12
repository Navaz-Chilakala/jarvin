// Launches a separate headless Chrome profile; never attaches to the user's browser.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BrowserShare } = require('../.test-out/browser-share.cjs');
const chrome = process.env.JARVIN_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!fs.existsSync(chrome)) throw new Error('Chrome was not found; set JARVIN_TEST_CHROME to a test browser executable.');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-chrome-test-'));
const fixture = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<title>Test article</title><main>Public article text<input value="PRIVATE INPUT"><textarea>PRIVATE TEXTAREA</textarea><div contenteditable="true">PRIVATE EDIT</div><div hidden>PRIVATE HIDDEN</div><p>Second paragraph</p></main>'); });
let child;
let received;
const bridge = new BrowserShare((page) => { received = page; });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, description, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await sleep(100); }
  throw new Error(`Timed out waiting for ${description}.`);
}

try {
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const { code } = await bridge.start();
  child = spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', `--user-data-dir=${root}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  let startError;
  child.once('error', (error) => { startError = error; });
  let nextId = 0; let buffer = Buffer.alloc(0);
  const pending = new Map();
  child.stdio[4].on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf(0); if (end < 0) break;
      const message = JSON.parse(buffer.subarray(0, end).toString()); buffer = buffer.subarray(end + 1);
      const item = pending.get(message.id); if (!item) continue;
      pending.delete(message.id); clearTimeout(item.timer);
      message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
    }
  });
  const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (startError) return reject(startError);
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Chrome did not answer ${method}.`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
  const loaded = await cdp('Extensions.loadUnpacked', { path: path.resolve('browser-extension') });
  assert.equal(loaded.id, 'ajcaifjneljfomfaijmaeflbmaiikdin');
  const oldTabs = new Set((await cdp('Target.getTargets', { filter: [{ type: 'tab' }] })).targetInfos.map((t) => t.targetId));
  const { targetId } = await cdp('Target.createTarget', { url: `http://127.0.0.1:${fixture.address().port}/` });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  await until(async () => (await cdp('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, sessionId)).result?.value === 'Test article', 'fixture page');
  await cdp('Target.activateTarget', { targetId });
  const tab = await until(async () => (await cdp('Target.getTargets', { filter: [{ type: 'tab' }] })).targetInfos.find((t) => !oldTabs.has(t.targetId)), 'test tab target');
  await cdp('Extensions.triggerAction', { id: loaded.id, targetId: tab.targetId });
  const popup = await until(async () => (await cdp('Target.getTargets')).targetInfos.find((t) => t.url.startsWith(`chrome-extension://${loaded.id}/popup.html`)), 'extension popup');
  const attached = await cdp('Target.attachToTarget', { targetId: popup.targetId, flatten: true });
  await until(async () => (await cdp('Runtime.evaluate', { expression: "document.readyState === 'complete'", returnByValue: true }, attached.sessionId)).result?.value, 'popup load');
  await cdp('Runtime.evaluate', { expression: `document.getElementById('code').value = ${JSON.stringify(code)}; document.getElementById('share').click()`, userGesture: true }, attached.sessionId);
  const page = await until(() => received, 'extension page share', 10000).catch(async (error) => {
    const status = await cdp('Runtime.evaluate', { expression: "document.getElementById('status').textContent", returnByValue: true }, attached.sessionId).then((r) => r.result?.value, () => '(popup closed)');
    throw new Error(`${error.message} Popup status: ${status}`);
  });
  assert.equal(page.title, 'Test article');
  assert.match(page.text, /Public article text/);
  assert.match(page.text, /Second paragraph/);
  assert.doesNotMatch(page.text, /PRIVATE/);
  console.log('Real Chrome extension shared the active test tab; editable, input and hidden text were excluded.');
  await cdp('Browser.close').catch(() => {});
} finally {
  bridge.stop();
  await new Promise((resolve) => { fixture.closeAllConnections(); fixture.close(resolve); });
  if (child && child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill('SIGKILL');
    const exited = await until(() => child.exitCode !== null || child.signalCode !== null, 'test Chrome exit', 10000).then(() => true, () => false);
    if (!exited) throw new Error(`Test Chrome did not exit; temporary profile retained at ${root}.`);
  }
  fs.rmSync(root, { recursive: true, force: true });
}
