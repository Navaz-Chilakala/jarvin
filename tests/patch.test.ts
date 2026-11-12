import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyPatch, parsePatch, listPatchHunks, filterPatch } from '../src/main/patch';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-patch-'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\nthree\n');
  return root;
}

test('parsePatch extracts operations', () => {
  const ops = parsePatch(`*** Begin Patch\n*** Update File: a.txt\n@@\n-one\n+ONE\n*** End Patch`);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].type, 'update');
  assert.deepEqual(ops[0].hunks[0].oldLines, ['one']);
  assert.deepEqual(ops[0].hunks[0].newLines, ['ONE']);
});

test('applyPatch updates a file in place', () => {
  const root = setup();
  const before = fs.readFileSync(path.join(root, 'a.txt'), 'utf8');
  const out = applyPatch({ root }, `*** Begin Patch\n*** Update File: a.txt\n@@\n one\n-two\n+TWO\n three\n*** End Patch`);
  assert.match(out.summary, /1 updated/);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one\nTWO\nthree\n');
  assert.ok(fs.readFileSync(path.join(root, 'a.txt'), 'utf8') !== before);
});

test('applyPatch can add and delete files', () => {
  const root = setup();
  const patch = `*** Begin Patch\n*** Add File: new.txt\n+hello\n*** Delete File: a.txt\n*** End Patch`;
  const r = applyPatch({ root }, patch);
  assert.deepEqual(r.result.added, ['new.txt']);
  assert.deepEqual(r.result.deleted, ['a.txt']);
  assert.equal(fs.readFileSync(path.join(root, 'new.txt'), 'utf8'), 'hello');
  assert.equal(fs.existsSync(path.join(root, 'a.txt')), false);
});

test('applyPatch renames a file via Move to', () => {
  const root = setup();
  applyPatch({ root }, `*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n@@\n one\n-two\n+TWO\n three\n*** End Patch`);
  assert.equal(fs.existsSync(path.join(root, 'a.txt')), false);
  assert.match(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), /TWO/);
});

test('applyPatch fails when a hunk does not match', () => {
  const root = setup();
  assert.throws(() => applyPatch({ root }, `*** Begin Patch\n*** Update File: a.txt\n@@\n-nope\n+yes\n*** End Patch`), /did not match/);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one\ntwo\nthree\n');
});

test('applyPatch supports multiple hunks in one file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-patch-'));
  fs.writeFileSync(path.join(root, 'm.txt'), 'a\nb\nc\nd\ne\n');
  applyPatch({ root }, `*** Begin Patch\n*** Update File: m.txt\n@@\n-a\n+A\n@@\n-d\n+D\n*** End Patch`);
  assert.equal(fs.readFileSync(path.join(root, 'm.txt'), 'utf8'), 'A\nb\nc\nD\ne\n');
});

test('listPatchHunks and filterPatch can drop one hunk', () => {
  const patch = `*** Begin Patch\n*** Update File: m.txt\n@@\n-a\n+A\n@@\n-d\n+D\n*** End Patch`;
  const hunks = listPatchHunks(patch).map((h) => h.key);
  assert.deepEqual(hunks, ['m.txt|update|0', 'm.txt|update|1']);
  const filtered = filterPatch(patch, ['m.txt|update|1']);
  assert.match(filtered, /@@\n-d\n\+D/);
  assert.doesNotMatch(filtered, /@@\n-a\n\+A/);
});
