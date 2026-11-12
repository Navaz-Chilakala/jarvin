// End-to-end check of the voice test in an isolated profile: generated speech stands in for the user's recordings,
// the dialog is opened, and every cached recognizer is scored. Run the build first.  node scripts/voice-test-e2e.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electron = require('electron');
const realModels = path.join(process.env.APPDATA, 'jarvin', 'models');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-voice-test-'));
const data = path.join(root, 'profile'); const workspace = path.join(root, 'workspace');
fs.mkdirSync(data); fs.mkdirSync(workspace);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(250); } throw new Error(`Timed out waiting for ${label}.`); }

function synth(text) {
  const file = path.join(root, `s${Math.random().toString(36).slice(2)}.wav`);
  const ps = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = -1; $f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono); $s.SetOutputToWaveFile($env:JV_WAV, $f); $s.Speak($env:JV_TEXT); $s.Dispose()`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { env: { ...process.env, JV_WAV: file, JV_TEXT: text }, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (r.status !== 0) throw new Error(`Speech synthesis failed: ${r.stderr}`);
  const wav = fs.readFileSync(file); let offset = 12;
  while (offset + 8 <= wav.length) { const name = wav.toString('ascii', offset, offset + 4); const size = wav.readUInt32LE(offset + 4); if (name === 'data') return wav.subarray(offset + 8, offset + 8 + size).toString('base64'); offset += 8 + size + (size % 2); }
  throw new Error('Synthesized WAV has no audio.');
}

let child; let socket;
try {
  // The isolated profile gets the same recognizers the real one has.
  for (const dir of ['Xenova', 'distil-whisper', 'onnx-community', 'sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25']) {
    const from = path.join(realModels, dir);
    if (!fs.existsSync(from)) continue;
    if (dir === 'onnx-community') { const m = path.join(from, 'moonshine-base-ONNX'); if (fs.existsSync(m)) fs.cpSync(m, path.join(data, 'models', dir, 'moonshine-base-ONNX'), { recursive: true }); }
    else fs.cpSync(from, path.join(data, 'models', dir), { recursive: true });
  }
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ workspace, baseUrl: 'http://127.0.0.1:9', model: 'test', mode: 'ask', setupDone: true, autoCheck: false, voice: { enabled: true, listenOnStart: false, wakeVersion: 2, wakeWord: true, size: 'base', language: 'english', offlineOnly: true, keepHistory: false, speak: 'off' } }));
  child = spawn(electron, ['.', `--user-data-dir=${data}`, '--remote-debugging-port=0', '--remote-allow-origins=*', '--mute-audio', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', workspace], { cwd: process.cwd(), windowsHide: true, stdio: 'ignore', env: { ...process.env, JARVIN_E2E: '1', JARVIN_E2E_HEADLESS: '1', JARVIN_E2E_DATA_DIR: root, JARVIN_SAFE_MODE: '1' } });
  const port = await until(() => { if (child.exitCode !== null) throw new Error(`App exited ${child.exitCode}`); try { return Number(fs.readFileSync(path.join(data, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { return null; } }, 'app debugging port');
  const target = await until(async () => { try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((p) => p.type === 'page' && /renderer\/index\.html/.test(p.url)); } catch { return null; } }, 'app renderer');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0; const pending = new Map();
  socket.addEventListener('message', (e) => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : m.result.exceptionDetails ? p.reject(new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 400))) : p.resolve(m.result.result.value); });
  const evaluate = (expression) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); socket.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })); });

  await until(() => evaluate("Boolean(document.getElementById('vTestBtn')?.onclick)"), 'voice test button', 30000);
  const status = await evaluate('window.jarvin.voiceTestStatus()');
  assert.equal(status.sentences.length, 20);
  assert.ok(status.models.length >= 2, `expected several recognizers, found ${status.models.join(', ')}`);

  // Six sentences, three with the wake phrase, spoken by the Windows voice.
  for (const index of [0, 1, 9, 10, 11, 14]) {
    const b64 = synth(status.sentences[index]);
    await evaluate(`(async () => { const b = atob(${JSON.stringify(b64)}); const a = new Float32Array(b.length / 2); for (let i = 0; i < a.length; i++) { let v = b.charCodeAt(2 * i) | (b.charCodeAt(2 * i + 1) << 8); if (v & 0x8000) v -= 0x10000; a[i] = v / 32768; } return (await window.jarvin.voiceTestSave(${index}, a)).length; })()`);
  }
  await assert.rejects(evaluate('window.jarvin.voiceTestSave(99, new Float32Array(16000))'), /Unknown test sentence/);
  await assert.rejects(evaluate('window.jarvin.voiceTestSave(2, new Float32Array(100))'), /too short/);

  // The dialog opens on the first sentence that is not recorded yet and pauses automatic listening.
  await evaluate("document.getElementById('vTestBtn').click()");
  await until(() => evaluate("document.getElementById('vtDlg')?.open === true"), 'voice test dialog');
  assert.match(await evaluate("document.getElementById('vtDlg').querySelector('#vtCount').textContent"), /Sentence 3 of 20 · 6 recorded/);
  assert.equal(await evaluate("document.getElementById('vtDlg').querySelector('#vtRun').disabled"), false);

  await evaluate("document.getElementById('vtDlg').querySelector('#vtRun').click()");
  await until(() => evaluate("document.getElementById('vtDlg').querySelector('#vtProgress').textContent === 'Done.' || /Could not|Error|failed/i.test(document.getElementById('vtDlg').querySelector('#vtProgress').textContent)"), 'the comparison to finish', 300000);
  const report = (await evaluate('window.jarvin.voiceTestStatus()')).report;
  assert.ok(report && report.clips === 6, 'a report for the six recordings');
  assert.ok(await evaluate("document.getElementById('vtDlg').querySelectorAll('#vtResults tbody tr').length >= 2"), 'results table is shown');
  console.log(`Voice test passed end to end with generated speech (${report.clips} recordings).`);
  for (const m of report.models) console.log(m.failed ? `  ${m.model}: could not run (${m.failed})` : `  ${m.model}: ${m.errors} wrong of ${m.words} words (${m.errorRate}%), exact ${m.exactSentences}/${m.lines.length}, name ${m.nameHeard}/${m.nameExpected}, ${(m.avgMs / 1000).toFixed(1)} s each`);
  const worst = report.models.find((m) => !m.failed && m.errors > 0);
  if (worst) for (const l of worst.lines.filter((x) => x.errors > 0).slice(0, 3)) console.log(`    e.g. ${worst.model.split('/').pop()}: "${l.expected}" -> "${l.heard}"`);

  await evaluate('window.jarvin.voiceTestClear()');
  assert.equal((await evaluate('window.jarvin.voiceTestStatus()')).recorded.length, 0, 'recordings can be deleted');
} finally {
  try { socket?.close(); } catch { /* ignore */ }
  if (child && child.exitCode === null) { try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch { /* ignore */ } }
  await sleep(800);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
