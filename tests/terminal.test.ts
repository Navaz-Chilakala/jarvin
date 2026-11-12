import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { shellFor, runShell, capOutput, tidy, interactiveShell, terminalEnv } from '../src/main/terminal';

const posix = process.platform !== 'win32';
const base = { cwd: os.tmpdir(), timeoutMs: 20000, signal: new AbortController().signal };

test('windows shell: pwsh preferred, 5.1 fallback, cmd choice', () => {
  const have = (...names: string[]) => (n: string) => (names.includes(n) ? `C:\\bin\\${n}.exe` : null);
  const a = shellFor('npm test && echo hi', 'auto', 'win32', have('pwsh', 'powershell'));
  assert.equal(a.label, 'PowerShell 7');
  assert.ok(a.file.endsWith('pwsh.exe'));
  const b = shellFor('echo hi', 'auto', 'win32', have('powershell'));
  assert.equal(b.label, 'Windows PowerShell 5.1');
  assert.match(b.hint, /NOT &&/);
  assert.equal(shellFor('echo hi', 'powershell', 'win32', have('pwsh', 'powershell')).label, 'Windows PowerShell 5.1');
  const enc = b.args[b.args.indexOf('-EncodedCommand') + 1];
  assert.match(Buffer.from(enc, 'base64').toString('utf16le'), /echo hi.*LASTEXITCODE/s);
  assert.ok(b.args.includes('-NonInteractive'));
  const c = shellFor('dir "a b"', 'cmd', 'win32');
  assert.deepEqual(c.args, ['/d', '/s', '/c', '"dir "a b""']);
  assert.ok(c.verbatim);
});

test('capOutput keeps head and tail', () => {
  const s = 'a'.repeat(10) + 'x'.repeat(50000) + 'END';
  const c = capOutput(s);
  assert.ok(c.length < 20100);
  assert.ok(c.startsWith('aaaaaaaaaa') && c.endsWith('END'));
  assert.match(c, /characters omitted/);
  assert.equal(capOutput('short'), 'short');
});

test('tidy strips colours and collapses progress lines', () => {
  assert.equal(tidy('\x1b[31mred\x1b[0m\r\nok'), 'red\nok');
  assert.equal(tidy('10%\r50%\r100%\ndone'), '100%\ndone');
});

test('streams output and reports exit code', { skip: !posix }, async () => {
  const chunks: string[] = [];
  const r = await runShell({ ...base, command: 'echo one; sleep 0.3; echo two >&2; exit 3', onOutput: (c) => chunks.push(c) });
  assert.equal(r.code, 3);
  assert.match(r.output, /one/);
  assert.match(r.output, /two/);
  assert.ok(chunks.length >= 2, 'arrives in more than one chunk');
});

test('closed stdin: a command that reads input does not hang', { skip: !posix }, async () => {
  const r = await runShell({ ...base, command: 'cat; echo after' });
  assert.equal(r.code, 0);
  assert.match(r.output, /after/);
});

test('timeout kills the whole process tree', { skip: !posix }, async () => {
  const t = Date.now();
  const r = await runShell({ ...base, timeoutMs: 700, command: 'sleep 60 & echo child=$!; wait' });
  assert.ok(r.timedOut);
  assert.ok(Date.now() - t < 4000);
  const pid = Number(/child=(\d+)/.exec(r.output)?.[1]);
  assert.ok(pid > 0);
  await new Promise((r) => setTimeout(r, 200));
  // killed processes may linger as zombies when nothing reaps them; a zombie is dead
  let alive = true;
  try {
    process.kill(pid, 0);
    alive = !/\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    alive = false;
  }
  assert.equal(alive, false, 'grandchild was killed');
});

test('abort (Stop) ends the command within 2 seconds', { skip: !posix }, async () => {
  const ac = new AbortController();
  const p = runShell({ ...base, signal: ac.signal, command: 'echo started; sleep 60' });
  setTimeout(() => ac.abort(), 400);
  const t = Date.now();
  const r = await p;
  assert.ok(r.aborted);
  assert.ok(Date.now() - t < 2500);
  assert.match(r.output, /started/);
});

test('huge output is bounded', { skip: !posix }, async () => {
  const r = await runShell({ ...base, command: 'yes line | head -n 300000' });
  assert.equal(r.code, 0);
  assert.ok(r.output.length < 900_000);
  assert.match(r.output, /earlier characters dropped/);
});

test('runs in the given folder', { skip: !posix }, async () => {
  const d = fs.mkdtempSync(os.tmpdir() + '/jt-');
  const r = await runShell({ ...base, cwd: d, command: 'pwd' });
  assert.equal(fs.realpathSync(r.output), fs.realpathSync(d));
});

test('terminal panel shell follows the setting and loads the profile', () => {
  const have = (...names: string[]) => (n: string) => (names.includes(n) ? `C:\\bin\\${n}.exe` : null);
  const env = { ComSpec: 'C:\\Windows\\System32\\cmd.exe' } as NodeJS.ProcessEnv;
  assert.equal(interactiveShell('cmd', 'win32', have(), env).file, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(interactiveShell('auto', 'win32', have('pwsh', 'powershell'), env).label, 'PowerShell 7');
  assert.equal(interactiveShell('auto', 'win32', have('powershell'), env).label, 'Windows PowerShell');
  assert.equal(interactiveShell('powershell', 'win32', have('pwsh', 'powershell'), env).label, 'Windows PowerShell');
  const ps = interactiveShell('auto', 'win32', have('powershell'), env);
  assert.ok(!ps.args.includes('-NoProfile'), 'profile must load like a normal terminal');
  assert.equal(interactiveShell('auto', 'linux', have('bash'), { SHELL: '/usr/bin/zsh' } as NodeJS.ProcessEnv).file, '/usr/bin/zsh');
});

test('terminal environment is a real terminal and drops app switches', () => {
  const e = terminalEnv({ PATH: '/bin', NODE_OPTIONS: '--x', ELECTRON_RUN_AS_NODE: '1', HOME: '/h' } as NodeJS.ProcessEnv);
  assert.equal(e.TERM, 'xterm-256color');
  assert.equal(e.PATH, '/bin');
  assert.ok(!('NODE_OPTIONS' in e) && !('ELECTRON_RUN_AS_NODE' in e));
});
