import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RoutineStore } from '../src/main/routines';
import { routineRequest, routineStepRequests, dueRoutines } from '../src/shared/routines';

test('routines persist ordered instructions and reject stale edits and deletes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-routines-'));
  try {
    const file = path.join(root, 'routines.json');
    const a = new RoutineStore(file);
    const saved = a.save(null, null, ' Morning ', [' Open news ', ' Summarize results ']);
    assert.deepEqual(new RoutineStore(file).list()[0].steps, ['Open news', 'Summarize results']);
    assert.match(routineRequest(saved), /1\. Open news\n2\. Summarize results/);
    const updated = a.save(saved.id, saved.revision, 'Updated', ['Different step']);
    assert.notEqual(updated.revision, saved.revision);
    assert.throws(() => a.save(saved.id, saved.revision, 'Stale', ['A']), /changed/);
    assert.throws(() => a.remove(saved.id, saved.revision), /changed/);
    assert.equal(a.list()[0].name, 'Updated');
    a.remove(updated.id, updated.revision);
    assert.deepEqual(a.list(), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a daily routine is due once, shortly after its time, and can run step by step', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-routines-'));
  try {
    const store = new RoutineStore(path.join(root, 'routines.json'));
    const saved = store.save(null, null, 'Morning', ['Open news', 'Summarize results'], '09:00');
    assert.equal(saved.dailyAt, '09:00');
    assert.deepEqual(routineStepRequests(saved), ['Routine "Morning", step 1 of 2: Open news', 'Routine "Morning", step 2 of 2: Summarize results']);
    const at = (h: number, m: number, day = 10) => new Date(2026, 10, day, h, m);
    assert.deepEqual(dueRoutines([saved], at(8, 59)), []);
    assert.equal(dueRoutines([saved], at(9, 5)).length, 1);
    assert.deepEqual(dueRoutines([saved], at(9, 30)), [], 'a routine missed by more than the grace period is skipped');
    assert.equal(store.takeDue(at(9, 1)).length, 1);
    assert.deepEqual(store.takeDue(at(9, 2)), [], 'runs once a day');
    assert.equal(store.takeDue(at(9, 1, 11)).length, 1, 'and again the next day');
    const kept = store.save(store.list()[0].id, store.list()[0].revision, 'Morning', ['Open news']);
    assert.equal(kept.dailyAt, '09:00', 'saving without a time keeps the schedule (the agent tool does this)');
    const cleared = store.save(kept.id, kept.revision, 'Morning', ['Open news'], '');
    assert.equal(cleared.dailyAt, undefined);
    assert.throws(() => store.save(null, null, 'Bad', ['x'], '25:00'), /HH:MM/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('invalid routines and corrupt storage are rejected without overwriting data', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-routines-'));
  try {
    const file = path.join(root, 'routines.json');
    const store = new RoutineStore(file);
    assert.throws(() => store.save(null, null, '', ['step']));
    assert.throws(() => store.save(null, null, 'name', []));
    assert.throws(() => store.save(null, null, 'name', ['one\ntwo']));
    assert.throws(() => store.save(null, null, 'name', Array(21).fill('x')));
    fs.writeFileSync(file, '{broken');
    assert.throws(() => store.save(null, null, 'name', ['step']));
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
