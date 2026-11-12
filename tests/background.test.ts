import test from 'node:test';
import assert from 'node:assert/strict';
import { allowReload, isBackgroundStart, loginItem, RELOAD_WINDOW_MS } from '../src/main/background';
import { folderFromArguments } from '../src/main/cli';

test('the sign-in item starts Jarvin hidden, from the installed app or from source', () => {
  assert.deepEqual(loginItem(true, { packaged: true, execPath: 'C:\\Jarvin\\Jarvin.exe', appPath: 'x' }), { openAtLogin: true, path: 'C:\\Jarvin\\Jarvin.exe', args: ['--background'] });
  assert.deepEqual(loginItem(true, { packaged: false, execPath: 'C:\\e\\electron.exe', appPath: 'C:\\src\\jarvin' }).args, ['C:\\src\\jarvin', '--background']);
  assert.equal(loginItem(false, { packaged: true, execPath: 'a', appPath: 'b' }).openAtLogin, false);
  assert.equal(isBackgroundStart(['Jarvin.exe', '--background']), true);
  assert.equal(isBackgroundStart(['Jarvin.exe']), false);
  assert.equal(folderFromArguments(['Jarvin.exe', '--background'], 'C:\\', false, () => true), null, 'the flag is never taken for a folder to open');
});

test('a crashing window is reloaded at most three times in ten minutes', () => {
  let h: number[] = [];
  for (let i = 0; i < 3; i++) { const next = allowReload(h, 1000 + i); assert.ok(next); h = next; }
  assert.equal(allowReload(h, 2000), null);
  assert.ok(allowReload(h, 1000 + RELOAD_WINDOW_MS + 10));
});
