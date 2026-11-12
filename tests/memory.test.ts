import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deleteManagedMemory, listManagedMemories, memoryFile, readManagedMemory, updateManagedMemory } from '../src/main/memory';

test('managed memories can be listed, edited and selectively deleted without touching the index', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-memory-test-'));
  try {
    fs.writeFileSync(path.join(root, 'MEMORY.md'), 'existing index');
    fs.writeFileSync(path.join(root, 'preference.md'), '---\nname: preference\ndescription: Preferred language\ntype: user\n---\n\nPython\n');
    fs.writeFileSync(path.join(root, 'project.md'), 'Project notes');
    const items = listManagedMemories(root);
    assert.deepEqual(items.map((m) => m.id), ['preference', 'project']);
    assert.equal('file' in items[0], false);
    const first = readManagedMemory('preference', root);
    assert.equal(first.text, 'Python\n');
    updateManagedMemory('preference', first.revision, 'Rust\n  ', root);
    assert.equal(readManagedMemory('preference', root).text, 'Rust\n  ');
    assert.match(fs.readFileSync(path.join(root, 'preference.md'), 'utf8'), /description: Preferred language/);
    const after = readManagedMemory('preference', root);
    deleteManagedMemory('preference', after.revision, root);
    assert.deepEqual(listManagedMemories(root).map((m) => m.id), ['project']);
    assert.match(fs.readFileSync(path.join(root, 'MEMORY.md'), 'utf8'), /project/);
    assert.match(memoryFile('memory'), /memory-item\.md$/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('stale revisions and invalid identifiers cannot edit or delete memories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-memory-test-'));
  try {
    const file = path.join(root, 'note.md');
    fs.writeFileSync(file, 'before');
    const old = readManagedMemory('note', root);
    fs.writeFileSync(file, 'changed elsewhere');
    assert.throws(() => updateManagedMemory('note', old.revision, 'replacement', root), /changed since/);
    assert.throws(() => deleteManagedMemory('note', old.revision, root), /changed since/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'changed elsewhere');
    for (const id of ['../note', 'a/b', 'C:\\note', 'memory', '', null]) {
      assert.throws(() => readManagedMemory(id, root));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
