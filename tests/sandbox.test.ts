import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveSafe, checkRawPath, isInside, isSensitivePath } from '../src/main/sandbox';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-sbx-'));
const ws = path.join(tmp, 'ws');
const outside = path.join(tmp, 'outside');
fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
fs.mkdirSync(outside);
fs.writeFileSync(path.join(ws, 'src', 'a.ts'), 'x');
fs.writeFileSync(path.join(outside, 'secret.txt'), 's');
let symlinks = true;
try {
  fs.symlinkSync(outside, path.join(ws, 'linkdir'), 'dir');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(ws, 'linkfile'));
  fs.symlinkSync(path.join(tmp, 'nowhere'), path.join(ws, 'dangling'));
  fs.symlinkSync(path.join(ws, 'src'), path.join(ws, 'inner-link'), 'dir');
} catch {
  symlinks = false;
}
const bad = (p: string, re = /outside|broken|blocked/) => assert.throws(() => resolveSafe(ws, p, { write: true }), re);

test('allows normal paths, including new files in new folders', () => {
  assert.equal(resolveSafe(ws, 'src/a.ts'), path.join(ws, 'src', 'a.ts'));
  assert.equal(resolveSafe(ws, '.'), ws);
  assert.equal(resolveSafe(ws, 'new/deep/file.txt'), path.join(ws, 'new', 'deep', 'file.txt'));
  assert.equal(resolveSafe(ws, path.join(ws, 'src', 'a.ts')), path.join(ws, 'src', 'a.ts'));
});

test('blocks .. traversal and absolute paths outside', () => {
  bad('../outside/secret.txt');
  bad('src/../../outside/secret.txt');
  bad(path.join(outside, 'secret.txt'));
  bad('/etc/passwd');
});

test('blocks symlinks and broken symlinks that leave the workspace', { skip: !symlinks }, () => {
  bad('linkdir/secret.txt');
  bad('linkdir/new.txt');
  bad('linkfile');
  bad('dangling');
  bad('dangling/child.txt');
});

test('allows symlinks that stay inside the workspace', { skip: !symlinks }, () => {
  assert.doesNotThrow(() => resolveSafe(ws, 'inner-link/a.ts'));
});

test('blocks writes inside .git but allows reads', () => {
  assert.throws(() => resolveSafe(ws, '.git/hooks/pre-commit', { write: true }), /\.git/);
  assert.doesNotThrow(() => resolveSafe(ws, '.git/HEAD'));
});

test('rejects null bytes', () => bad('src/a.ts\0.png', /null/));

test('windows: UNC, device, drive, stream and reserved names', () => {
  for (const p of ['\\\\server\\share\\x', '//server/share', '\\\\?\\C:\\x', '\\\\.\\pipe\\x']) assert.throws(() => checkRawPath(p, 'win32'), /Network and device/);
  assert.throws(() => checkRawPath('file.txt:hidden', 'win32'), /Alternate data/);
  assert.throws(() => checkRawPath('src/NUL', 'win32'), /Reserved/);
  assert.throws(() => checkRawPath('src/com1.txt', 'win32'), /Reserved/);
  assert.throws(() => checkRawPath('src/a.ts.', 'win32'), /dot or space/);
  assert.doesNotThrow(() => checkRawPath('C:\\Users\\me\\proj\\a.ts', 'win32'));
  assert.doesNotThrow(() => checkRawPath('src/a:b', 'linux'));
});

test('windows: isInside handles drives, case and prefixes', () => {
  const r = 'C:\\Users\\Me\\proj';
  assert.ok(isInside(r, 'C:\\Users\\Me\\proj', 'win32'));
  assert.ok(isInside(r, 'c:\\users\\me\\PROJ\\src\\a.ts', 'win32'));
  assert.ok(!isInside(r, 'D:\\Users\\Me\\proj\\a.ts', 'win32'));
  assert.ok(!isInside(r, 'C:\\Users\\Me\\proj-evil\\a.ts', 'win32'));
  assert.ok(!isInside(r, 'C:\\Users\\Me', 'win32'));
  assert.ok(!isInside('/a/Proj', '/a/proj/x', 'linux'));
  assert.ok(isInside('/a/Proj', '/a/proj/x', 'darwin'));
});

test('sensitive paths', () => {
  for (const p of ['.env', '.env.local', 'app/.env', '.jarvin/rules/x.md', '.github/workflows/ci.yml', '.vscode/tasks.json', 'k/server.pem', '.npmrc', 'home/.ssh/config'])
    assert.ok(isSensitivePath(p), p);
  for (const p of ['src/env.ts', 'README.md', 'environment.md', '.gitignore']) assert.ok(!isSensitivePath(p), p);
});
