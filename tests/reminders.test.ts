import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReminderStore } from '../src/main/reminders';

test('reminders survive restart, become due once, and stay until dismissed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-reminders-'));
  try {
    const file = path.join(root, 'reminders.json');
    const first = new ReminderStore(file);
    const r = first.create('  Call home  ', 2000, 1000);
    assert.equal(r.text, 'Call home');
    assert.deepEqual(first.markDue(1999), []);
    const restarted = new ReminderStore(file);
    assert.equal(restarted.list()[0].state, 'pending');
    assert.equal(restarted.markDue(3000)[0].id, r.id);
    assert.deepEqual(restarted.markDue(4000), []);
    assert.equal(new ReminderStore(file).list()[0].state, 'due');
    restarted.remove(r.id);
    assert.deepEqual(restarted.list(), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('reminders reject invalid input and preserve invalid storage instead of overwriting it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-reminders-'));
  try {
    const file = path.join(root, 'reminders.json');
    const store = new ReminderStore(file);
    assert.throws(() => store.create(' ', 2000, 1000));
    assert.throws(() => store.create('x', NaN, 1000));
    assert.throws(() => store.create('x', 1000, 1000));
    assert.throws(() => store.create('x'.repeat(501), 2000, 1000));
    fs.writeFileSync(file, '{invalid');
    assert.throws(() => store.create('x', 2000, 1000));
    assert.equal(fs.readFileSync(file, 'utf8'), '{invalid');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
