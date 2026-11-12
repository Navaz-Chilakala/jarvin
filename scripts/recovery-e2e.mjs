// Real Electron process, isolated workspace/user data and a local fake Ollama.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

if (typeof WebSocket !== 'function') throw new Error('This optional check needs Node with a built-in WebSocket client.');
const require = createRequire(import.meta.url);
const electron = require('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-recovery-e2e-'));
const data = path.join(root, 'profile');
const workspace = path.join(root, 'workspace');
const other = path.join(root, 'other');
fs.mkdirSync(data); fs.mkdirSync(workspace); fs.mkdirSync(other);
let child = null;
let socket = null;
let chatRequests = 0;
const chatBodies = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, description, timeout = 25_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

const server = http.createServer((req, res) => {
  if (req.url === '/api/version') return void res.end(JSON.stringify({ version: 'test' }));
  if (req.url === '/api/tags') return void res.end(JSON.stringify({ models: [{ name: 'test', size: 1 }] }));
  if (req.url === '/api/chat') {
    chatRequests++;
    const number = chatRequests;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      chatBodies[number] = JSON.parse(body);
      if (number === 1) return void res.end(JSON.stringify({ message: { tool_calls: [{ function: { name: 'write_file', arguments: { path: 'marker.txt', content: 'once' } } }] }, done: true }) + '\n');
      if (number === 2) return; // Keep this turn open until the app is killed.
      if (number === 3) return void res.end(JSON.stringify({ message: { tool_calls: [{ function: { name: 'create_reminder', arguments: { text: 'Agent test reminder', minutes_from_now: 5 } } }] }, done: true }) + '\n');
      if (number === 5) return void res.end(JSON.stringify({ message: { tool_calls: [{ function: { name: 'write_file', arguments: { path: 'routine-marker.txt', content: 'should not be written' } } }] }, done: true }) + '\n');
      return void res.end(JSON.stringify({ message: { role: 'assistant', content: 'Done.' }, done: true }) + '\n');
    });
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ workspace, baseUrl, model: 'test', mode: 'auto-edit', offline: true, setupDone: true, autoCheck: false, notifyDone: false, voice: { enabled: false } }));

function stopChild() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else child.kill('SIGKILL');
}

async function launch() {
  const portFile = path.join(data, 'DevToolsActivePort');
  try { fs.unlinkSync(portFile); } catch { /* first run */ }
  child = spawn(electron, ['.', `--user-data-dir=${data}`, '--remote-debugging-port=0', '--remote-allow-origins=*', workspace], {
    cwd: process.cwd(), windowsHide: true, stdio: 'ignore',
    env: { ...process.env, JARVIN_E2E: '1', JARVIN_E2E_HEADLESS: '1', JARVIN_E2E_DATA_DIR: root, JARVIN_SAFE_MODE: '1' },
  });
  let spawnError = null;
  child.once('error', (error) => { spawnError = error; });
  const port = await until(() => {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`Electron exited early: ${child.exitCode}`);
    try { return Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]) || null; } catch { return null; }
  }, 'Electron debugging port');
  const target = await until(async () => {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return pages.find((p) => p.type === 'page' && /renderer\/index\.html/.test(p.url));
    } catch { return null; }
  }, 'Jarvin renderer');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const entry = pending.get(message.id); pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result);
  });
  const evaluate = async (expression) => {
    const id = ++sequence;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Renderer did not respond.')); }, 10_000);
      pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    });
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    const response = await promise;
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || 'Renderer evaluation failed.');
    return response.result.value;
  };
  await until(() => evaluate("Boolean(window.jarvin && document.getElementById('taskChip')?.onclick)"), 'app initialization');
  return evaluate;
}

try {
  let evaluate = await launch();
  await evaluate("document.getElementById('tasksBtn').click()");
  await until(() => evaluate("document.getElementById('tasksDlg').open"), 'tasks dialog');
  await evaluate(`(() => {
    document.getElementById('tkRoutineName').value = 'Morning <check>';
    document.getElementById('tkRoutineSteps').value = 'Find news\\nSummarize sources';
    document.getElementById('tkRoutineSave').click();
  })()`);
  await until(async () => (await evaluate('window.jarvin.routinesList()')).length === 1, 'routine creation');
  await evaluate(`(() => {
    const next = new Date(Date.now() + 120000);
    const pad = n => String(n).padStart(2, '0');
    document.getElementById('tkReminderRepeat').value = 'daily'; document.getElementById('tkReminderText').value = 'Test reminder';
    document.getElementById('tkReminderWhen').value = next.getFullYear() + '-' + pad(next.getMonth() + 1) + '-' + pad(next.getDate()) + 'T' + pad(next.getHours()) + ':' + pad(next.getMinutes());
    document.getElementById('tkReminderAdd').click();
  })()`);
  await until(async () => (await evaluate('window.jarvin.remindersList()')).length === 1, 'reminder creation');
  assert.equal((await evaluate('window.jarvin.remindersList()'))[0].repeat, 'daily');
  await until(() => evaluate("Boolean(document.querySelector('#tkReminders [data-a=edit]'))"), 'edit button');
  await evaluate("document.querySelector('#tkReminders [data-a=edit]').click(); document.getElementById('tkReminderRepeat').value='weekly'; document.getElementById('tkReminderAdd').click()");
  await until(async () => (await evaluate('window.jarvin.remindersList()'))[0].repeat === 'weekly', 'weekly edit');
  await evaluate("document.getElementById('tkClose').click()");
  await evaluate("void window.jarvin.send('Create a marker for recovery testing', null)");
  const marker = path.join(workspace, 'marker.txt');
  await until(() => fs.existsSync(marker) && chatRequests >= 2, 'first action and pending second model turn');
  assert.equal(fs.readFileSync(marker, 'utf8'), 'once');
  const guarded = await evaluate(`(async () => { try { await window.jarvin.setSettings({ workspace: ${JSON.stringify(other)} }); return false; } catch { return true; } })()`);
  assert.equal(guarded, true, 'workspace cannot change while a task runs');
  socket.close();
  const first = child;
  stopChild();
  await until(() => first.exitCode !== null || first.signalCode !== null, 'first app exit');
  child = null; socket = null;

  // Simulate the scheduled time passing while the app is closed.
  const reminderFile = path.join(data, 'reminders.json');
  const savedReminders = JSON.parse(fs.readFileSync(reminderFile, 'utf8'));
  savedReminders[0].dueAt = Date.now() - 1000;
  fs.writeFileSync(reminderFile, JSON.stringify(savedReminders));

  evaluate = await launch();
  assert.deepEqual((await evaluate('window.jarvin.routinesList()'))[0].steps, ['Find news', 'Summarize sources']);
  const recovered = await evaluate('window.jarvin.interruptedRuns()');
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].state, 'interrupted');
  assert.equal(recovered[0].request, 'Create a marker for recovery testing');
  assert.ok(recovered[0].tools.some((tool) => tool.name === 'write_file'));
  await until(() => evaluate("document.getElementById('taskChip').textContent.includes('1 to review')"), 'recovery indicator');
  const reminder = await evaluate('window.jarvin.remindersList()');
  assert.equal(reminder[0].state, 'due', 'overdue reminder is marked due on restart');
  await evaluate("document.getElementById('taskChip').click()");
  await until(() => evaluate("Boolean(document.querySelector('#tkRecovered button[data-a=review]'))"), 'recovery card');
  await until(() => evaluate("document.getElementById('tkReminders').textContent.includes('Test reminder')"), 'overdue reminder in UI');
  assert.equal(reminder.length, 2);
  assert.equal(reminder[1].repeat, 'weekly');
  await evaluate("document.querySelector('#tkReminders button[data-a=snooze]').click()");
  await until(async () => (await evaluate('window.jarvin.remindersList()'))[0].state === 'pending', 'snooze');
  const snoozed = await evaluate('window.jarvin.remindersList()');
  assert.ok(Math.abs(snoozed[0].dueAt - Date.now() - 600000) < 5000);
  assert.equal(snoozed[1].dueAt, reminder[1].dueAt);
  for (const row of snoozed) {
    const selector = JSON.stringify('#tkReminders [data-id="'+row.id+'"] [data-a=remove]');
    await evaluate('document.querySelector('+selector+').click()');
    await until(async () => !(await evaluate('window.jarvin.remindersList()')).some(r => r.id === row.id), 'remove reminder');
  }
  await until(async () => (await evaluate('window.jarvin.remindersList()')).length === 0, 'reminder dismissal');
  await evaluate("document.querySelector('#tkRecovered button[data-a=review]').click()");
  const draft = await evaluate("document.getElementById('input').value");
  assert.match(draft, /Create a marker for recovery testing/);
  await sleep(700);
  assert.equal(chatRequests, 2, 'review must not start another model request');
  assert.equal(fs.readFileSync(marker, 'utf8'), 'once', 'the earlier side effect must not run again');
  console.log('Real Electron crash recovery passed: request and tool activity restored; review did not execute work.');
  console.log('Reminder UI passed: created, recovered overdue after restart, and dismissed.');
  await evaluate("void window.jarvin.send('Remind me in five minutes', null)");
  await until(async () => (await evaluate('window.jarvin.remindersList()')).some((r) => r.text === 'Agent test reminder'), 'agent-created reminder');
  await until(async () => chatRequests >= 4 && !(await evaluate('window.jarvin.chatStatus()')).running, 'reminder agent completion');
  console.log('Agent reminder tool passed with a fake local model.');
  await evaluate("window.jarvin.setSettings({ mode: 'ask' })");
  await evaluate("document.getElementById('input').value = ''; document.getElementById('tasksBtn').click()");
  await until(() => evaluate("Boolean(document.querySelector('#tkRoutines button[data-a=edit]'))"), 'saved routine after restart');
  assert.equal(await evaluate("Boolean(document.querySelector('#tkRoutines check'))"), false, 'routine text must not become HTML');
  await evaluate("document.querySelector('#tkRoutines button[data-a=edit]').click(); document.getElementById('tkRoutineSteps').value = 'Find news\\nSummarize verified sources'; document.getElementById('tkRoutineSave').click()");
  await until(async () => (await evaluate('window.jarvin.routinesList()'))[0].steps[1] === 'Summarize verified sources', 'routine update');
  await evaluate("document.querySelector('#tkRoutines button[data-a=review]').click()");
  assert.match(await evaluate("document.getElementById('input').value"), /1\. Find news\n2\. Summarize verified sources/);
  assert.equal(chatRequests, 4, 'review must not start a model request');
  await evaluate("document.getElementById('tasksBtn').click()");
  await until(() => evaluate("document.getElementById('tasksDlg').open"), 'tasks dialog reopened');
  await evaluate("document.querySelector('#tkRoutines button[data-a=run]').click()");
  await sleep(300);
  assert.equal(chatRequests, 4, 'an existing draft must not be overwritten by Run');
  await evaluate("document.getElementById('input').value = ''; document.querySelector('#tkRoutines button[data-a=run]').click()");
  await until(() => chatRequests >= 5 && chatBodies[5], 'routine agent request');
  assert.ok(chatBodies[5].messages.some((m) => m.role === 'user' && /1\. Find news\n2\. Summarize verified sources/.test(m.content)), 'saved steps must reach the normal agent');
  await until(() => evaluate("Array.from(document.querySelectorAll('.tapprove button')).some(b => b.textContent === 'Deny')"), 'routine action approval');
  assert.equal(fs.existsSync(path.join(workspace, 'routine-marker.txt')), false, 'action must wait for approval');
  await evaluate("Array.from(document.querySelectorAll('.tapprove button')).find(b => b.textContent === 'Deny').click()");
  await until(async () => !(await evaluate('window.jarvin.chatStatus()')).running, 'routine agent completion');
  assert.equal(fs.existsSync(path.join(workspace, 'routine-marker.txt')), false, 'denied routine action must not run');
  await evaluate("window.confirm = () => true; document.getElementById('tasksBtn').click()");
  await until(() => evaluate("Boolean(document.querySelector('#tkRoutines button[data-a=remove]'))"), 'routine delete button');
  await evaluate("document.querySelector('#tkRoutines button[data-a=remove]').click()");
  await until(async () => (await evaluate('window.jarvin.routinesList()')).length === 0, 'routine deletion');
  console.log('Routine UI passed: save, restart, edit, review, run through agent, deny action and delete.');
  await evaluate("document.getElementById('tkClose').click(); document.getElementById('browserShareBtn').click()");
  const code = await until(() => evaluate("/^\\d+:[a-f0-9]{64}$/.test(document.getElementById('bsCode').value) && document.getElementById('bsCode').value"), 'browser share code');
  const [port, token] = code.split(':');
  const beforeShare = chatRequests;
  const response = await fetch(`http://127.0.0.1:${port}/share`, { method: 'POST', headers: { Origin: 'chrome-extension://ajcaifjneljfomfaijmaeflbmaiikdin', 'Content-Type': 'application/json', 'X-Jarvin-Token': token }, body: JSON.stringify({ url: 'https://example.com/article', title: 'Test article', text: 'Shared sample content', truncated: false }) });
  assert.equal(response.status, 200);
  await until(() => evaluate("!document.getElementById('bsReview').hidden"), 'shared page review');
  assert.equal(await evaluate("document.getElementById('bsText').value"), 'Shared sample content');
  assert.equal(chatRequests, beforeShare, 'sharing a page must not send it to the model');
  await evaluate("document.getElementById('bsAttach').click(); document.getElementById('input').value = 'Summarize the attached page'; document.getElementById('input').dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('composer').requestSubmit()");
  await until(() => chatRequests > beforeShare && chatBodies[beforeShare + 1], 'attached browser page sent by user');
  assert.ok(chatBodies[beforeShare + 1].messages.some((m) => m.role === 'user' && m.content.includes('Shared sample content') && m.content.includes('https://example.com/article')));
  console.log('Browser share receiver and app UI passed with a simulated extension.');
} finally {
  try { socket?.close(); } catch { /* ignore */ }
  const last = child;
  stopChild();
  let stopped = true;
  if (last) stopped = await until(() => last.exitCode !== null || last.signalCode !== null, 'test app exit', 10_000).then(() => true, () => false);
  await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  if (!stopped) throw new Error(`The isolated test app did not exit; its temporary data was retained at ${root}.`);
  fs.rmSync(root, { recursive: true, force: true });
}
