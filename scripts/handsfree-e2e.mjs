// Tests an isolated app against synthetic speech and the already-cached local Whisper model.
// It never opens the user's microphone or changes their settings.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

if (process.platform !== 'win32') throw new Error('This check needs Windows speech synthesis.');
const require = createRequire(import.meta.url);
const packagedMode = process.argv.includes('--packaged');
const electron = packagedMode ? process.env.JARVIN_TEST_EXE || path.join(process.cwd(), 'release', 'win-unpacked', 'Jarvin.exe') : require('electron');
const widgetMode = process.argv.includes('--widget');
const manualStopMode = process.argv.includes('--manual-stop');
const interruptMode = process.argv.includes('--interrupt') || manualStopMode;
const systemMode = process.argv.includes('--system');
const strongerMode = process.argv.includes('--stronger');
const fastMode = process.argv.includes('--fast');
// --wake: the name and the request in one breath. --wake-pause: the name, a pause, then the request.
const wakeMode = process.argv.includes('--wake');
const wakePause = process.argv.includes('--wake-pause');
const qwenMode = process.argv.includes('--qwen');
const speechSize = qwenMode ? 'qwen3-asr' : fastMode ? 'moonshine' : strongerMode ? 'distil-small' : 'base';
const modelParts = qwenMode ? ['sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25'] : fastMode ? ['onnx-community', 'moonshine-base-ONNX'] : strongerMode ? ['distil-whisper', 'distil-small.en'] : ['Xenova', 'whisper-base.en'];
const source = path.join(process.env.APPDATA, 'jarvin', 'models', ...modelParts);
if (!fs.existsSync(path.join(source, qwenMode ? 'encoder.int8.onnx' : 'onnx/encoder_model_quantized.onnx'))) throw new Error('The local speech model is not cached.');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-handsfree-e2e-'));
const data = path.join(root, 'profile');
const workspace = path.join(root, 'workspace');
fs.mkdirSync(data); fs.mkdirSync(workspace);
let child; let socket; let widgetSocket; let widgetEval; let requestText = ''; let recordingAt = 0; let requestAt = 0; let chatRequests = 0;
let interruptedResponseClosed = false;
const server = http.createServer((req, res) => {
  if (req.url === '/api/version') return void res.end(JSON.stringify({ version: 'test' }));
  if (req.url === '/api/tags') return void res.end(JSON.stringify({ models: [{ name: 'test', size: 1 }] }));
  if (req.url === '/api/chat') {
    chatRequests++;
    let raw = ''; req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw); requestText = (body.messages.findLast((m) => m.role === 'user')?.content || '').replace(/\n\n\[Current PC local date and time: [^\]]*\]$/, ''); // the agent appends the clock to the request it sends requestAt = Date.now();
      if (interruptMode && chatRequests === 1) {
        res.setHeader('Content-Type', 'application/x-ndjson');
        res.write(JSON.stringify({ message: { role: 'assistant', content: 'I am reading a long answer so this test can check that you can interrupt me while I am still speaking, and I will keep reading this sentence with several extra details until you start talking and ask me to stop and listen to your new request. ' }, done: false }) + '\n');
        const timer = setInterval(() => res.write(JSON.stringify({ message: { role: 'assistant', content: 'There is more to say. ' }, done: false }) + '\n'), 2000);
        res.on('close', () => { clearInterval(timer); interruptedResponseClosed = true; });
      } else res.end(JSON.stringify({ message: { role: 'assistant', content: 'Done.' }, done: true }) + '\n');
    });
    return;
  }
  res.writeHead(404); res.end();
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await sleep(200); }
  throw new Error(`Timed out waiting for ${label}.`);
}

try {
  fs.mkdirSync(path.join(data, 'models', ...modelParts.slice(0, -1)), { recursive: true });
  fs.cpSync(source, path.join(data, 'models', ...modelParts), { recursive: true });
  if (interruptMode && !systemMode) fs.cpSync(path.join(process.env.APPDATA, 'jarvin', 'models', 'piper'), path.join(data, 'models', 'piper'), { recursive: true });
  const speech = path.join(root, 'speech.wav');
  const powershell = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = -1; $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono); $s.SetOutputToWaveFile($env:JARVIN_SYNTH_WAV, $format); ${wakePause ? "$b = New-Object System.Speech.Synthesis.PromptBuilder; $b.AppendText('Jarvin.'); $b.AppendBreak([TimeSpan]::FromMilliseconds(1600)); $b.AppendText('Please tell me the weather in London.'); $s.Speak($b)" : wakeMode ? "$s.Speak('Jarvin, please tell me the weather in London.')" : "$s.Speak('Please tell me the weather in London.')"}; $s.Dispose()`;
  const synth = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', powershell], { env: { ...process.env, JARVIN_SYNTH_WAV: speech }, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (synth.status !== 0) throw new Error(`Speech synthesis failed: ${synth.stderr}`);
  const wav = fs.readFileSync(speech);
  let offset = 12, pcm;
  while (offset + 8 <= wav.length) { const name = wav.toString('ascii', offset, offset + 4); const size = wav.readUInt32LE(offset + 4); if (name === 'data') { pcm = wav.subarray(offset + 8, offset + 8 + size); break; } offset += 8 + size + (size % 2); }
  if (!pcm?.length) throw new Error('Synthesized WAV has no audio.');
  const leadingSilence = Buffer.alloc(16000 * 2 * (interruptMode ? 14 : 4));
  const trailingSilence = Buffer.alloc(16000 * 2 * 3);
  const sound = Buffer.concat([leadingSilence, pcm, trailingSilence]);
  const header = Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(36 + sound.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(sound.length, 40);
  const fakeMic = path.join(root, 'microphone.wav'); fs.writeFileSync(fakeMic, Buffer.concat([header, sound]));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ workspace, baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'test', mode: 'ask', setupDone: true, autoCheck: false, voice: { enabled: true, listenOnStart: true, handsFree: false, wakeWord: wakeMode || wakePause || process.argv.includes('--barge'), size: speechSize, language: 'english', mode: 'clean', autoSend: manualStopMode, offlineOnly: true, keepHistory: false, speak: interruptMode ? 'full' : 'off', ttsEngine: systemMode ? 'system' : 'auto', speakRate: systemMode ? .8 : 1 } }));
  child = spawn(electron, [...(packagedMode ? [] : ['.']), `--user-data-dir=${data}`, '--remote-debugging-port=0', '--remote-allow-origins=*', '--mute-audio', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fakeMic}`, workspace], { cwd: process.cwd(), windowsHide: true, stdio: 'ignore', env: { ...process.env, JARVIN_E2E: '1', JARVIN_E2E_HEADLESS: '1', JARVIN_E2E_DATA_DIR: root, JARVIN_SAFE_MODE: '1' } });
  let spawnError; child.once('error', (e) => { spawnError = e; });
  const port = await until(() => { if (spawnError) throw spawnError; if (child.exitCode !== null) throw new Error(`App exited ${child.exitCode}`); try { return Number(fs.readFileSync(path.join(data, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { return null; } }, 'app debugging port');
  const target = await until(async () => { try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((p) => p.type === 'page' && /renderer\/index\.html/.test(p.url)); } catch { return null; } }, 'app renderer');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0; const pending = new Map();
  socket.addEventListener('message', (e) => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result.result.value); });
  const evaluate = (expression) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); socket.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })); });
  if (interruptMode) {
    await until(() => evaluate("Boolean(document.getElementById('uiCompact')?.onclick)"), 'assistant UI');
    await evaluate("window.__audioStarted=0; window.__audioStopped=0; window.__firstAudioStart=0; window.__firstAudioDuration=0; window.__firstAudioStop=0; const start=AudioBufferSourceNode.prototype.start; const stop=AudioBufferSourceNode.prototype.stop; AudioBufferSourceNode.prototype.start=function(...args){ window.__audioStarted++; if(!window.__firstAudioStart){window.__firstAudioStart=performance.now();window.__firstAudioDuration=this.buffer.duration;} return start.apply(this,args); }; AudioBufferSourceNode.prototype.stop=function(...args){window.__audioStopped++;window.__firstAudioStop ||= performance.now();return stop.apply(this,args); }");
    if (systemMode) {
      await until(() => evaluate('speechSynthesis.getVoices().some(v=>v.localService)'), 'local Windows voice');
      await evaluate("const speak = speechSynthesis.speak.bind(speechSynthesis); const cancel = speechSynthesis.cancel.bind(speechSynthesis); speechSynthesis.speak = u => {const started=u.onstart;u.onstart=e=>{window.__audioStarted++;window.__firstAudioStart ||= performance.now();started?.(e);};return speak(u);};speechSynthesis.cancel=()=>{if(speechSynthesis.speaking){window.__audioStopped++;window.__firstAudioStop ||= performance.now();} return cancel();};");
    } else {
      const warm = await evaluate('window.jarvin.neuralVoiceWarm()');
      assert.equal(warm.ok, true, JSON.stringify(warm));
    }
    await evaluate("document.getElementById('input').value='Start the test reply'; document.getElementById('input').dispatchEvent(new Event('input',{bubbles:true})); document.getElementById('composer').requestSubmit()");
    await until(() => evaluate('window.__audioStarted > 0'), 'real neural speech to start');
    if (manualStopMode) await evaluate("document.getElementById('mic').click()");
  }
  if (widgetMode) {
    await until(() => evaluate("Boolean(document.getElementById('uiCompact')?.onclick)"), 'assistant UI');
    await evaluate("document.getElementById('uiCompact').click()");
    const widgetTarget = await until(async () => { try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((p) => /assistant-widget\.html/.test(p.url)); } catch { return null; } }, 'companion');
    widgetSocket = new WebSocket(widgetTarget.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { widgetSocket.addEventListener('open', resolve, { once: true }); widgetSocket.addEventListener('error', reject, { once: true }); });
    let widgetId = 0; const widgetPending = new Map();
    widgetSocket.addEventListener('message', (e) => { const m = JSON.parse(e.data); const p = widgetPending.get(m.id); if (!p) return; widgetPending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result.result.value); });
    widgetEval = (expression) => new Promise((resolve, reject) => { const n = ++widgetId; widgetPending.set(n, { resolve, reject }); widgetSocket.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, returnByValue: true } })); });
    await until(() => widgetEval("Boolean(window.assistantWidget)"), 'companion bridge');
    await until(() => widgetEval("document.body.dataset.mic === 'listening'"), 'companion listening');
    recordingAt = Date.now();
  }
  await until(() => interruptMode ? chatRequests >= 2 : requestText, 'automatic transcription', 90000).catch(async (error) => { const status = await evaluate("JSON.stringify({state:document.getElementById('hfBtn')?.dataset.state, log:document.getElementById('vHfLog')?.textContent, note:document.getElementById('vstat')?.textContent})"); throw new Error(`${error.message}: ${status}`); });
  assert.match(requestText, /weather.*london/i);
  if (wakeMode || wakePause) assert.doesNotMatch(requestText, /jarvi|jarva|jarve/i, 'the name is removed from the request');
  const recognizedRequest = requestText;
  const speechLog = await evaluate("document.getElementById('vHfLog')?.textContent || ''");
  const transcriptionMs = Number(/\((\d+) ms transcription;/.exec(speechLog)?.[1]);
  const segmentToResultMs = Number(/(\d+) ms since segment closed\)/.exec(speechLog)?.[1]);
  assert.ok(transcriptionMs > 0, 'the real local recognizer should report its processing time');
  assert.ok(segmentToResultMs >= transcriptionMs, 'segment-to-result time should include recognition');
  console.log(`Local ${speechSize} processing: ${transcriptionMs} ms; segment close to transcript: ${segmentToResultMs} ms (plus approximately 650 ms of end-silence detection).`);
  assert.equal(chatRequests, interruptMode ? 2 : 1, 'voice commands should not make a separate model cleanup request');
  if (interruptMode) {
    const playback = await evaluate('({stops:window.__audioStopped,elapsed:(window.__firstAudioStop-window.__firstAudioStart)/1000,duration:window.__firstAudioDuration})');
    assert.ok(playback.stops > 0 && playback.elapsed > 0 && (systemMode || playback.elapsed < playback.duration), `Audio should stop before the long sentence ends: ${JSON.stringify(playback)}`);
    assert.equal(interruptedResponseClosed, true, 'the old model response was cancelled before sending the new request');
    console.log(`${manualStopMode ? 'Manual microphone interruption' : 'Voice interruption'} passed: stopped active ${systemMode ? 'Windows' : 'neural'} audio, cancelled the old response, and sent the new spoken request.`);
  }
  await until(() => evaluate("document.getElementById('stop')?.hidden === true"), 'previous response to finish');
  await evaluate("document.getElementById('input').value = 'An unfinished draft'; document.getElementById('input').dispatchEvent(new Event('input', { bubbles: true }))");
  const beforeDraftRequest = chatRequests;
  await evaluate("window.__voiceHandle({text:'A separate spoken request',raw:'A separate spoken request',ms:1,cleanup:'basic'}, true)");
  assert.equal(await evaluate("document.getElementById('input').value"), 'An unfinished draft', 'automatic speech does not overwrite a draft');
  await until(() => chatRequests === beforeDraftRequest + 1, 'spoken request beside an unsent draft');
  assert.equal(requestText, 'A separate spoken request', 'spoken text is sent without the unsent draft');
  await evaluate("document.getElementById('input').value = ''; document.getElementById('input').dispatchEvent(new Event('input', { bubbles: true }))");
  if (widgetEval) {
    await widgetEval("document.getElementById('micToggle').click()");
    await until(() => widgetEval("document.body.dataset.mic === 'off'"), 'pet mute');
    await widgetEval("document.getElementById('micToggle').click()");
    await until(() => widgetEval("document.body.dataset.mic === 'listening'"), 'pet unmute');
  }
  console.log(`${widgetMode ? 'Floating companion' : 'Automatic listening'} recognized speech without a wake phrase through the real local ${speechSize} model: ${recognizedRequest}`);
  if (recordingAt && requestAt >= recordingAt) console.log(`Recording start to chat request: ${((requestAt - recordingAt) / 1000).toFixed(1)}s; synthetic speech: ${(pcm.length / 32000).toFixed(1)}s (elapsed also includes silence detection and transcription).`);
  const appLog = fs.readFileSync(path.join(root, 'app.log'), 'utf8');
  assert.doesNotMatch(appLog, /ScriptProcessorNode is deprecated/, 'microphone capture should use AudioWorklet instead of the fallback');
} finally {
  try { socket?.close(); } catch { /* ignore */ }
  try { widgetSocket?.close(); } catch { /* ignore */ }
  if (child && child.exitCode === null && child.signalCode === null) {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    const exited = await until(() => child.exitCode !== null || child.signalCode !== null, 'test app exit', 10000).then(() => true, () => false);
    if (!exited) throw new Error(`Test app did not exit; temporary data retained at ${root}.`);
  }
  await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  fs.rmSync(root, { recursive: true, force: true });
}
