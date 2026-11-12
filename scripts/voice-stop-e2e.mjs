// Checks the rule "while Jarvin is doing a task, only 'stop' interrupts it" with generated speech through a fake
// microphone, the real local Whisper recognizer, an isolated profile and a fake model. Run the build first.
//   node scripts/voice-stop-e2e.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electron = require('electron');
const modelParts = ['Xenova', 'whisper-base.en'];
const source = path.join(process.env.APPDATA, 'jarvin', 'models', ...modelParts);
if (!fs.existsSync(path.join(source, 'onnx/encoder_model_quantized.onnx'))) throw new Error('The local speech model is not cached.');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-voice-stop-'));
const data = path.join(root, 'profile'); const workspace = path.join(root, 'workspace');
fs.mkdirSync(data); fs.mkdirSync(workspace); fs.writeFileSync(path.join(workspace, 'notes.txt'), 'hello');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(250); } throw new Error(`Timed out waiting for ${label}.`); }

// The fake model: first it asks for a tool (so the run counts as "doing a task"), then it talks slowly without ending.
const userTexts = []; let chatRequests = 0; let slowClosed = false;
const server = http.createServer((req, res) => {
  if (req.url === '/api/version') return void res.end(JSON.stringify({ version: 'test' }));
  if (req.url === '/api/tags') return void res.end(JSON.stringify({ models: [{ name: 'test', size: 1 }] }));
  if (req.url === '/api/chat') {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw); chatRequests++;
      userTexts.push(String(body.messages.findLast((m) => m.role === 'user')?.content || ''));
      res.setHeader('Content-Type', 'application/x-ndjson');
      if (chatRequests === 1) return void res.end(JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'list_dir', arguments: { path: '.' } } }] }, done: true }) + '\n');
      if (chatRequests === 2) {
        res.write(JSON.stringify({ message: { role: 'assistant', content: 'Working on the files. ' }, done: false }) + '\n');
        const timer = setInterval(() => res.write(JSON.stringify({ message: { role: 'assistant', content: 'Still working. ' }, done: false }) + '\n'), 1500);
        res.on('close', () => { clearInterval(timer); slowClosed = true; });
        return;
      }
      res.end(JSON.stringify({ message: { role: 'assistant', content: 'Done.' }, done: true }) + '\n');
    });
    return;
  }
  res.writeHead(404); res.end();
});

function synth(text) {
  const file = path.join(root, `s${Math.random().toString(36).slice(2)}.wav`);
  const ps = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = -1; $f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono); $s.SetOutputToWaveFile($env:JV_WAV, $f); $s.Speak($env:JV_TEXT); $s.Dispose()`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { env: { ...process.env, JV_WAV: file, JV_TEXT: text }, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (r.status !== 0) throw new Error(`Speech synthesis failed: ${r.stderr}`);
  const wav = fs.readFileSync(file); let offset = 12;
  while (offset + 8 <= wav.length) { const name = wav.toString('ascii', offset, offset + 4); const size = wav.readUInt32LE(offset + 4); if (name === 'data') return wav.subarray(offset + 8, offset + 8 + size); offset += 8 + size + (size % 2); }
  throw new Error('Synthesized WAV has no audio.');
}
const silence = (seconds) => Buffer.alloc(16000 * 2 * seconds);

let child; let socket;
try {
  fs.mkdirSync(path.join(data, 'models', modelParts[0]), { recursive: true });
  fs.cpSync(source, path.join(data, 'models', ...modelParts), { recursive: true });
  // 16 s of quiet (time to start the task), an unrelated sentence, 9 s of quiet, then "stop", then a long quiet tail.
  const sound = Buffer.concat([silence(16), synth('Please tell me the weather in London.'), silence(9), synth('Stop that.'), silence(40)]);
  const header = Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(36 + sound.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(sound.length, 40);
  const fakeMic = path.join(root, 'microphone.wav'); fs.writeFileSync(fakeMic, Buffer.concat([header, sound]));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ workspace, baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'test', mode: 'auto', setupDone: true, autoCheck: false, voice: { enabled: true, listenOnStart: true, wakeVersion: 2, wakeWord: false, size: 'base', language: 'english', mode: 'clean', offlineOnly: true, keepHistory: false, speak: 'off' } }));
  child = spawn(electron, ['.', `--user-data-dir=${data}`, '--remote-debugging-port=0', '--remote-allow-origins=*', '--mute-audio', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fakeMic}`, workspace], { cwd: process.cwd(), windowsHide: true, stdio: 'ignore', env: { ...process.env, JARVIN_E2E: '1', JARVIN_E2E_HEADLESS: '1', JARVIN_E2E_DATA_DIR: root, JARVIN_SAFE_MODE: '1' } });
  const port = await until(() => { if (child.exitCode !== null) throw new Error(`App exited ${child.exitCode}`); try { return Number(fs.readFileSync(path.join(data, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { return null; } }, 'app debugging port');
  const target = await until(async () => { try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((p) => p.type === 'page' && /renderer\/index\.html/.test(p.url)); } catch { return null; } }, 'app renderer');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0; const pending = new Map();
  socket.addEventListener('message', (e) => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result.result.value); });
  const evaluate = (expression) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); socket.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })); });
  const voiceLog = () => evaluate("document.getElementById('vHfLog')?.textContent || ''");

  await until(() => evaluate("document.getElementById('hfBtn')?.dataset.state === 'listening'"), 'microphone listening', 40000);
  await evaluate("document.getElementById('input').value='List the files in this folder and describe them'; document.getElementById('input').dispatchEvent(new Event('input',{bubbles:true})); document.getElementById('composer').requestSubmit()");
  await until(() => chatRequests >= 2, 'the task to use a tool and keep working', 20000);

  // 1. Unrelated speech while the task runs must be heard, ignored, and must not stop or replace the task.
  await until(async () => /weather/i.test(await voiceLog()), 'the unrelated sentence to be transcribed', 60000);
  await sleep(1500);
  assert.equal((await evaluate('window.jarvin.chatStatus()')).running, true, 'the task keeps running after unrelated speech');
  assert.equal(slowClosed, false, 'the model reply was not cancelled by unrelated speech');
  assert.equal(userTexts.some((t) => /weather/i.test(t)), false, 'the unrelated sentence was not sent as a request');

  // 2. "Stop" must end the task.
  await until(async () => !(await evaluate('window.jarvin.chatStatus()')).running, '"stop" to end the task', 60000);
  assert.match(await voiceLog(), /stop/i, 'the stop word was transcribed');
  assert.equal(slowClosed, true, 'the model reply was cancelled by "stop"');
  assert.equal(userTexts.some((t) => /weather/i.test(t)), false, 'still no stray request');
  console.log(`Passed: unrelated speech was ignored while the task ran, and "stop" ended it. Voice log:\n${(await voiceLog()).split('\n').slice(-5).join('\n')}`);
} finally {
  try { socket?.close(); } catch { /* ignore */ }
  if (child && child.exitCode === null) { try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch { /* ignore */ } }
  server.close();
  await sleep(800);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
