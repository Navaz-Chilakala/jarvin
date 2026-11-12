import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmNewWindow } from '../src/main/window-check';

const w = (process: string, title: string) => ({ process, title });

test('confirmNewWindow reports a window that was not open before', async () => {
  const before = [w('explorer', 'Desktop')];
  const out = await confirmNewWindow(before, { list: async () => [w('explorer', 'Desktop'), w('SystemSettings', 'Settings')], wait: async () => {} });
  assert.match(out, /new window appeared: SystemSettings "Settings"/);
});

test('confirmNewWindow says so when nothing new shows up', async () => {
  const out = await confirmNewWindow([w('a', 'A')], { list: async () => [w('a', 'A')], wait: async () => {}, tries: 3 });
  assert.match(out, /No new window was detected/);
});

import { matchWindow } from '../src/main/window-check';
const lw = (app: string, title: string) => ({ window_id: `${app}:${title}`, app, title });
const wins = [lw('electron', 'Jarvin companion'), lw('ApplicationFrameHost', 'Calculator'), lw('Notepad', 'notes.txt - Notepad'), lw('chrome', 'Inbox - Google Chrome'), lw('SystemSettings', 'Settings'), lw('explorer', 'Program Manager')];

test('matchWindow finds an already-open app by name, alias, process or title', () => {
  assert.equal(matchWindow(wins, 'Calculator')?.title, 'Calculator');
  assert.equal(matchWindow(wins, 'calc')?.title, 'Calculator');
  assert.equal(matchWindow(wins, 'notepad')?.app, 'Notepad');
  assert.equal(matchWindow(wins, 'Google Chrome')?.app, 'chrome');
  assert.equal(matchWindow(wins, 'Settings')?.title, 'Settings');
});

test('matchWindow never matches Jarvin itself or unrelated names', () => {
  assert.equal(matchWindow(wins, 'jarvin companion'), undefined);
  assert.equal(matchWindow(wins, 'Spotify'), undefined);
  assert.equal(matchWindow(wins, 'ab'), undefined);
});
