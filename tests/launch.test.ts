import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { chromeSearchUrl, launchProgram } from '../src/main/launch';

test('Chrome search treats the query as text and encodes it into a Google search URL', () => {
  const url = new URL(chromeSearchUrl('India vs New Zealand & toss'));
  assert.equal(url.origin, 'https://www.google.com');
  assert.equal(url.pathname, '/search');
  assert.equal(url.searchParams.get('q'), 'India vs New Zealand & toss');
  assert.throws(() => chromeSearchUrl('   '));
  assert.throws(() => chromeSearchUrl('x'.repeat(501)));
});

test('Windows app launch passes arguments directly without invoking a shell', async () => {
  let launched: [string, string[]] | undefined;
  const result = await launchProgram('calculator', ['&', 'other-command'], {
    platform: 'win32', exists: () => false, openPath: async () => '',
    spawnChild: (program, args) => {
      launched = [program, args];
      const child = new EventEmitter() as ChildProcess;
      child.unref = () => {};
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });
  assert.deepEqual(launched, ['calc.exe', ['&', 'other-command']]);
  assert.match(result, /accepted the launch/);
});

test('Windows resolves Chrome aliases in common installation directories without a shell', async () => {
  const expected = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  for (const alias of ['chrome', 'google-chrome', 'Google Chrome', 'chrome.exe']) {
    let launched = '';
    await launchProgram(alias, [], {
      platform: 'win32', env: { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local' },
      exists: (p) => p === expected, openPath: async () => '',
      spawnChild: (file) => { launched = file; const child = new EventEmitter() as ChildProcess; child.unref = () => {}; queueMicrotask(() => child.emit('spawn')); return child; },
    });
    assert.equal(launched, expected);
  }
});

test('script interpreters and failed launches are reported', async () => {
  const options = { platform: 'win32' as const, exists: () => false, openPath: async () => '' };
  for (const name of ['cmd.exe', 'powershell', 'example.cmd', 'https://example.com']) {
    await assert.rejects(launchProgram(name, [], options));
  }
  await assert.rejects(launchProgram('missing.exe', [], { ...options, spawnChild: () => {
    const child = new EventEmitter() as ChildProcess;
    queueMicrotask(() => child.emit('error', new Error('not found')));
    return child;
  } }), /not found/);
});

function fakeSpawn(log: [string, string[]][], failFirst = false) {
  let n = 0;
  return (file: string, args: string[]) => {
    log.push([file, args]);
    const child = new EventEmitter() as ChildProcess;
    child.unref = () => {};
    const fail = failFirst && n++ === 0;
    queueMicrotask(() => fail ? child.emit('error', Object.assign(new Error('nf'), { code: 'ENOENT' })) : child.emit('spawn'));
    return child;
  };
}

test('Windows Settings and other system tools launch through explorer or their real executable', async () => {
  for (const [name, expected] of [['Settings', ['explorer.exe', ['ms-settings:']]], ['windows settings', ['explorer.exe', ['ms-settings:']]], ['ms-settings:display', ['explorer.exe', ['ms-settings:display']]], ['Control Panel', ['control.exe', []]], ['Task Manager', ['taskmgr.exe', []]]] as const) {
    const log: [string, string[]][] = [];
    await launchProgram(name, [], { platform: 'win32', exists: () => false, openPath: async () => '', spawnChild: fakeSpawn(log) });
    assert.deepEqual(log[0], expected);
  }
});

test('an unknown bare name is looked up in the Start menu and launched without a shell', async () => {
  const log: [string, string[]][] = [];
  const result = await launchProgram('Spotify', [], {
    platform: 'win32', exists: () => false, openPath: async () => '', spawnChild: fakeSpawn(log, true),
    findStartApp: async (n) => n === 'Spotify' ? { name: 'Spotify', appId: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify' } : null,
  });
  assert.deepEqual(log[1], ['explorer.exe', ['shell:AppsFolder\\SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify']]);
  assert.match(result, /Start menu/);
});

test('a name that cannot be found tells the model not to repeat the call', async () => {
  const log: [string, string[]][] = [];
  await assert.rejects(launchProgram('NoSuchApp', [], { platform: 'win32', exists: () => false, openPath: async () => '', spawnChild: fakeSpawn(log, true), findStartApp: async () => null }), /Do not retry the same name/);
});
