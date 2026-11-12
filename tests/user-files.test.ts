import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { searchUserFiles, openBlocked } from '../src/main/user-files';

test('finds files by every word in the name, newest first, and skips junk folders', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uf-'));
  fs.mkdirSync(path.join(root, 'Work', 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Resume_Navaz_2026.pdf'), 'x');
  fs.writeFileSync(path.join(root, 'Work', 'navaz resume old.docx'), 'x');
  fs.writeFileSync(path.join(root, 'Work', 'node_modules', 'resume navaz.txt'), 'x');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'x');
  const found = await searchUserFiles('resume navaz', [root]);
  assert.deepEqual(found.map((f) => f.name).sort(), ['Resume_Navaz_2026.pdf', 'navaz resume old.docx']);
  assert.deepEqual(await searchUserFiles('', [root]), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('opening is limited to the user folders and never launches programs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uf-'));
  const ok = path.join(root, 'a.txt'); fs.writeFileSync(ok, 'x');
  const exe = path.join(root, 'setup.exe'); fs.writeFileSync(exe, 'x');
  assert.equal(openBlocked(ok, [root]), '');
  assert.match(openBlocked(exe, [root]), /runs code/);
  assert.match(openBlocked(path.join(os.tmpdir(), 'other.txt'), [root]), /Only files inside/);
  assert.match(openBlocked('a.txt', [root]), /full path/);
  assert.match(openBlocked(path.join(root, 'missing.txt'), [root]), /does not exist/);
  fs.rmSync(root, { recursive: true, force: true });
});
