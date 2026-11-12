import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSandbox, changesOf, applyChanges, discardSandbox, originalText } from '../src/main/verified';

const mk = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-root-'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-tmp-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'node_modules/pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/pkg/index.js'), 'module.exports = 1');
  fs.writeFileSync(path.join(root, 'src/a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(root, 'src/b.ts'), 'export const b = 2;\n');
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  return { root, tmp, done: () => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(tmp, { recursive: true, force: true }); } };
};

test('copy leaves node_modules linked, not copied, and changes start empty', async () => {
  const t = mk();
  const sb = await createSandbox(t.root, t.tmp);
  assert.ok(fs.existsSync(path.join(sb.dir, 'src/a.ts')));
  assert.ok(fs.existsSync(path.join(sb.dir, 'node_modules/pkg/index.js')), 'dependencies resolve through the link');
  assert.deepEqual(await changesOf(sb), []);
  discardSandbox(sb);
  assert.ok(fs.existsSync(path.join(t.root, 'node_modules/pkg/index.js')), 'discarding never touches the real node_modules');
  assert.ok(!fs.existsSync(sb.dir));
  t.done();
});

test('detects modified, added and deleted files, and ignores test output folders', async () => {
  const t = mk();
  const sb = await createSandbox(t.root, t.tmp);
  fs.writeFileSync(path.join(sb.dir, 'src/a.ts'), 'export const a = 99;\n');
  fs.writeFileSync(path.join(sb.dir, 'src/new.ts'), 'x');
  fs.rmSync(path.join(sb.dir, 'src/b.ts'));
  fs.mkdirSync(path.join(sb.dir, 'coverage'));
  fs.writeFileSync(path.join(sb.dir, 'coverage/lcov.info'), 'junk');
  assert.deepEqual(await changesOf(sb), [
    { path: 'src/a.ts', status: 'modified' },
    { path: 'src/b.ts', status: 'deleted' },
    { path: 'src/new.ts', status: 'added' },
  ]);
  assert.equal(await originalText(sb, 'src/a.ts'), 'export const a = 1;\n');
  discardSandbox(sb);
  t.done();
});

test('apply copies the changes and records each write first', async () => {
  const t = mk();
  const sb = await createSandbox(t.root, t.tmp);
  fs.writeFileSync(path.join(sb.dir, 'src/a.ts'), 'export const a = 99;\n');
  fs.writeFileSync(path.join(sb.dir, 'src/deep/new.ts'.replace('deep/', '')), 'x');
  fs.rmSync(path.join(sb.dir, 'src/b.ts'));
  const seen: string[] = [];
  const r = await applyChanges(sb, (abs) => seen.push(path.relative(t.root, abs).replace(/\\/g, '/')));
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.applied.length, 3);
  assert.deepEqual(seen.sort(), ['src/a.ts', 'src/b.ts', 'src/new.ts']);
  assert.equal(fs.readFileSync(path.join(t.root, 'src/a.ts'), 'utf8'), 'export const a = 99;\n');
  assert.ok(!fs.existsSync(path.join(t.root, 'src/b.ts')));
  discardSandbox(sb);
  t.done();
});

test('never overwrites work done in the real folder meanwhile', async () => {
  const t = mk();
  const sb = await createSandbox(t.root, t.tmp);
  fs.writeFileSync(path.join(sb.dir, 'src/a.ts'), 'agent version\n');
  fs.writeFileSync(path.join(sb.dir, 'src/new.ts'), 'agent new\n');
  fs.writeFileSync(path.join(t.root, 'src/a.ts'), 'my own edit\n');
  fs.writeFileSync(path.join(t.root, 'src/new.ts'), 'I made this too\n');
  const r = await applyChanges(sb);
  assert.equal(r.applied.length, 0);
  assert.equal(r.conflicts.length, 2);
  assert.equal(fs.readFileSync(path.join(t.root, 'src/a.ts'), 'utf8'), 'my own edit\n');
  assert.equal(fs.readFileSync(path.join(t.root, 'src/new.ts'), 'utf8'), 'I made this too\n');
  discardSandbox(sb);
  t.done();
});

test('protected files are never applied automatically', async () => {
  const t = mk();
  const sb = await createSandbox(t.root, t.tmp);
  fs.writeFileSync(path.join(sb.dir, '.env'), 'SECRET=1');
  fs.mkdirSync(path.join(sb.dir, '.github/workflows'), { recursive: true });
  fs.writeFileSync(path.join(sb.dir, '.github/workflows/ci.yml'), 'on: push');
  const r = await applyChanges(sb);
  assert.equal(r.applied.length, 0);
  assert.equal(r.conflicts.length, 2);
  assert.ok(!fs.existsSync(path.join(t.root, '.env')));
  discardSandbox(sb);
  t.done();
});

test('apply can be limited to chosen files', async () => {
  const t = mk();
  const sb = await createSandbox(t.root, t.tmp);
  fs.writeFileSync(path.join(sb.dir, 'src/a.ts'), 'A\n');
  fs.writeFileSync(path.join(sb.dir, 'src/b.ts'), 'B\n');
  const r = await applyChanges(sb, undefined, ['src/b.ts']);
  assert.deepEqual(r.applied.map((c) => c.path), ['src/b.ts']);
  assert.equal(fs.readFileSync(path.join(t.root, 'src/a.ts'), 'utf8'), 'export const a = 1;\n');
  discardSandbox(sb);
  t.done();
});
