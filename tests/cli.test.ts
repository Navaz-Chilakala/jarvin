import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { folderFromArguments } from '../src/main/cli';

test('Electron application argument is not mistaken for a workspace', () => {
  const cwd = path.resolve('test-cwd');
  assert.equal(folderFromArguments(['electron', '.'], cwd, true, () => true), null);
  assert.equal(folderFromArguments(['electron', '.', '--user-data-dir', 'profile'], cwd, true, () => true), null);
  assert.equal(folderFromArguments(['electron', '.', 'project'], cwd, true, () => true), path.join(cwd, 'project'));
  assert.equal(folderFromArguments(['jarvin.exe', 'project'], cwd, false, () => true), path.join(cwd, 'project'));
});
