import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { RunJournal } from '../src/main/run-journal';
import { pickResumable, resumeRequest, RESUME_WINDOW_MS, type RunRecord } from '../src/shared/run-journal';

test('only a recent, complete, crash-interrupted run continues by itself, and only once', () => {
  const now = 1_000_000_000;
  const run = (patch: Partial<RunRecord>): RunRecord => ({ id: 'a', state: 'interrupted', request: 'Open Notepad and write a note', requestTruncated: false, workspace: 'w', sessionId: 's', model: 'm', hadImages: false, startedAt: now - 5000, updatedAt: now - 1000, tools: [{ id: 't', name: 'launch_app', state: 'requested' }], ...patch });
  assert.equal(pickResumable([run({})], now)?.id, 'a');
  assert.equal(pickResumable([], now), null);
  assert.equal(pickResumable([run({ state: 'paused' })], now), null, 'a task the user paused waits for review');
  assert.equal(pickResumable([run({ updatedAt: now - RESUME_WINDOW_MS - 1 })], now), null, 'old crashes wait for review');
  assert.equal(pickResumable([run({ hadImages: true })], now), null);
  assert.equal(pickResumable([run({ requestTruncated: true })], now), null);
  assert.equal(pickResumable([run({ id: 'old', updatedAt: now - 9000 }), run({ id: 'new', state: 'paused' })], now), null, 'only the newest record is considered');
  const text = resumeRequest(run({}));
  assert.match(text, /Original request:\nOpen Notepad and write a note/);
  assert.match(text, /launch_app: outcome unknown/);
  assert.equal(pickResumable([run({ request: text })], now), null, 'a resumed run that is interrupted again is not retried');
});

test('a restart marks active requests interrupted without replaying tools', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-journal-'));
  try {
    const first = new RunJournal(dir);
    const run = first.start({ request: 'Create a project', workspace: path.join(dir, 'project'), sessionId: 'session', model: 'qwen', hadImages: true, activePath: 'app.py' });
    first.toolStart(run.id, 'a', 'write_file');
    first.toolResult(run.id, 'a', true);
    first.toolStart(run.id, 'b', 'run_command');
    const restarted = new RunJournal(dir);
    assert.equal(restarted.recover(), 1);
    const recovered = restarted.interrupted(path.join(dir, 'project'));
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].state, 'interrupted');
    assert.equal(recovered[0].request, 'Create a project');
    assert.equal(recovered[0].activePath, 'app.py');
    assert.equal(recovered[0].hadImages, true);
    assert.deepEqual(recovered[0].tools.map((item) => [item.name, item.state]), [['write_file', 'reported'], ['run_command', 'requested']]);
    assert.equal(restarted.recover(), 0);
    assert.deepEqual(restarted.interrupted(path.join(dir, 'another-project')), []);
    assert.throws(() => restarted.dismiss(run.id, path.join(dir, 'another-project')), /not found/);
    restarted.dismiss(run.id, path.join(dir, 'project'));
    assert.deepEqual(restarted.interrupted(path.join(dir, 'project')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('paused tasks are reviewable while normally finished, failed and stopped runs are not resumed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-journal-'));
  try {
    const journal = new RunJournal(dir);
    const input = { request: 'task', workspace: dir, sessionId: 's', model: 'qwen', hadImages: false };
    for (const state of ['finished', 'failed', 'stopped', 'paused'] as const) {
      const run = journal.start(input);
      journal.finish(run.id, state);
    }
    assert.equal(journal.recover(), 0);
    assert.deepEqual(journal.interrupted(dir).map((item) => item.state), ['paused']);
    assert.equal(journal.clearFinished(dir), 3);
    assert.deepEqual(journal.interrupted(dir).map((item) => item.state), ['paused']);
    assert.throws(() => journal.dismiss('../outside', dir));
    fs.writeFileSync(path.join(dir, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json'), '{bad');
    assert.equal(journal.recover(), 0, 'one corrupt record does not prevent recovery of other records');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a separate process crash after a side effect leaves a reviewable uncertain action and never replays it', { timeout: 15_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-crash-test-'));
  const journalDir = path.join(root, 'journal');
  const marker = path.join(root, 'effect.txt');
  const server = http.createServer((_req, res) => {
    res.end(JSON.stringify({ message: { tool_calls: [{ function: { name: 'side_effect', arguments: {} } }] }, done: true }) + '\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const child = spawn(process.execPath, [path.join(process.cwd(), 'scripts/recovery-crash-child.cjs'),
      path.join(process.cwd(), '.test-out/src/main/run-journal.js'), path.join(process.cwd(), '.test-out/src/main/agent.js'),
      journalDir, root, base, marker], { stdio: 'ignore', windowsHide: true });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Crash test child timed out.')); }, 7_000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
    });
    assert.equal(exitCode, 73);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'once\n');
    const recovered = new RunJournal(journalDir);
    assert.equal(recovered.recover(), 1);
    const records = recovered.interrupted(root);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].tools.map((item) => [item.name, item.state]), [['side_effect', 'requested']]);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'once\n', 'recovery does not repeat an uncertain action');
  } finally {
    await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
