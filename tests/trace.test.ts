import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fmtMs, parseTrace, summarize, toolTitle, traceToText } from '../src/shared/trace';
import { clearTraces, deleteTrace, listTraces, readTrace, validTraceId } from '../src/main/traces';

const T0 = Date.parse('2026-10-25T10:00:00.000Z');
const line = (ms: number, event: any) => JSON.stringify({ ts: new Date(T0 + ms).toISOString(), event });
const log = (...l: string[]) => l.join('\n') + '\n';

const sample = log(
  line(0, { type: 'run', prompt: 'fix the bug', model: 'qwen3:8b', workspace: '/p', mode: 'ask' }),
  line(2000, { type: 'token', text: 'Let me look.' }),
  line(2000, { type: 'usage', model: 'qwen3:8b', ms: 2000, promptTokens: 900, completionTokens: 30 }),
  line(2100, { type: 'tool_start', id: 'a', name: 'read_file', args: { path: 'src/a.ts' } }),
  line(2150, { type: 'tool_start', id: 'b', name: 'run_command', args: { command: 'npm test' } }),
  line(2200, { type: 'tool_result', id: 'a', ok: true, output: 'file text' }),
  line(2300, { type: 'approval', id: 'b', name: 'run_command', summary: 'npm test' }),
  line(9150, { type: 'tool_output', id: 'b', text: '1 failing' }),
  line(9200, { type: 'tool_result', id: 'b', ok: false, output: 'exit 1\n1 failing' }),
  line(12000, { type: 'token', text: 'It fails because ' }),
  line(12000, { type: 'token', text: 'of the sign.' }),
  line(12000, { type: 'usage', model: 'qwen3:8b', ms: 2800, promptTokens: 1200, completionTokens: 12 }),
  line(12010, { type: 'done' }),
);

test('a run becomes a timeline with times, tools and tokens', () => {
  const t = parseTrace('id1', sample);
  assert.equal(t.prompt, 'fix the bug');
  assert.equal(t.model, 'qwen3:8b');
  assert.equal(t.outcome, 'done');
  assert.equal(t.durationMs, 12010);
  assert.equal(t.totals.toolCalls, 2);
  assert.equal(t.totals.toolErrors, 1);
  assert.equal(t.totals.modelTurns, 2);
  assert.equal(t.totals.tokensIn, 2100);
  assert.equal(t.totals.tokensOut, 42);
  const kinds = t.steps.map((s) => s.kind);
  assert.deepEqual(kinds, ['prompt', 'model', 'tool', 'tool', 'model']);
  const slow = t.steps.find((s) => s.name === 'run_command')!;
  assert.equal(slow.ms, 7050);
  assert.equal(slow.waited, true, 'the wait for approval is flagged');
  assert.equal(slow.ok, false);
  assert.match(slow.detail!, /npm test/);
  assert.match(slow.detail!, /1 failing/);
  const m1 = t.steps[1];
  assert.equal(m1.at, 0);
  assert.equal(m1.ms, 2000);
  assert.equal(m1.tokensIn, 900);
  assert.equal(t.tools[0].name, 'run_command', 'slowest tool first');
  assert.equal(t.tools[0].maxMs, 7050);
});

test('old logs with no header, no usage and token-per-line still open', () => {
  const t = parseTrace('old', log(
    line(0, { type: 'token', text: 'Hel' }), line(10, { type: 'token', text: 'lo' }),
    line(20, { type: 'tool_start', id: 'x', name: 'list_files', args: {} }),
    line(60, { type: 'tool_result', id: 'x', ok: true, output: 'a\nb' }),
  ));
  assert.equal(t.prompt, '');
  assert.equal(t.outcome, 'unknown');
  assert.equal(t.steps.filter((s) => s.kind === 'model').length, 1);
  assert.equal(t.steps.find((s) => s.kind === 'model')!.detail, 'Hello');
  assert.equal(t.steps.find((s) => s.kind === 'tool')!.ms, 40);
});

test('a tool that never answered is shown as unfinished, and bad lines are skipped', () => {
  const t = parseTrace('x', 'garbage\n' + log(
    line(0, { type: 'run', prompt: 'p' }),
    line(50, { type: 'tool_start', id: 'z', name: 'run_command', args: { command: 'sleep 99' } }),
    line(5050, { type: 'note', text: 'Stopped.' }),
  ) + '{"ts":"not a date","event":{}}\n{"half":');
  const s = t.steps.find((x) => x.kind === 'tool')!;
  assert.equal(s.unfinished, true);
  assert.equal(s.ms, 5000);
  assert.equal(t.outcome, 'stopped');
  assert.equal(t.totals.toolCalls, 1);
});

test('errors and paused runs set the outcome', () => {
  assert.equal(parseTrace('e', log(line(0, { type: 'run', prompt: 'p' }), line(5, { type: 'error', message: 'Ollama is down' }), line(6, { type: 'done' }))).outcome, 'error');
  assert.equal(parseTrace('p', log(line(0, { type: 'run', prompt: 'p' }), line(5, { type: 'note', text: 'Paused after 40 steps. Send a message to continue.' }), line(6, { type: 'done' }))).outcome, 'paused');
  assert.equal(parseTrace('empty', '').startedAt, '');
});

test('long output is cut and says how much', () => {
  const t = parseTrace('l', log(line(0, { type: 'tool_start', id: 'q', name: 'read_file', args: {} }), line(5, { type: 'tool_result', id: 'q', ok: true, output: 'x'.repeat(10000) })));
  const s = t.steps[0];
  assert.ok(s.cut! > 5000);
  assert.ok(s.detail!.length < 6000);
});

test('titles, times and the text summary read well', () => {
  assert.equal(toolTitle('read_file', { path: 'src/a.ts' }), 'read_file  src/a.ts');
  assert.equal(toolTitle('x', null), 'x');
  assert.equal(toolTitle('run_command', { command: 'a'.repeat(200) }).length < 110, true);
  assert.equal(fmtMs(250), '250 ms');
  assert.equal(fmtMs(1500), '1.5 s');
  assert.equal(fmtMs(95_000), '1 min 35 s');
  const text = traceToText(parseTrace('id1', sample));
  assert.match(text, /fix the bug/);
  assert.match(text, /ERR run_command/);
  assert.match(text, /tokens in 2100, out 42/);
  assert.equal(summarize(parseTrace('id1', sample), { mtime: 1, bytes: 2 }).toolErrors, 1);
});

const U = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jtr-'));

test('run ids are checked, so a request cannot reach other files', () => {
  assert.equal(validTraceId(U(1)), true);
  for (const bad of ['../x', '..\\x', 'abc', U(1) + '.jsonl', '', null, 5, U(1) + '/..']) assert.equal(validTraceId(bad as any), false, String(bad));
  const d = mk();
  assert.throws(() => readTrace(d, '../../etc/passwd'), /Invalid/);
  assert.throws(() => deleteTrace(d, '..'), /Invalid/);
});

test('listing: newest first, secrets removed, odd files ignored, delete and clear work', () => {
  const d = mk();
  fs.writeFileSync(path.join(d, U(1) + '.jsonl'), log(line(0, { type: 'run', prompt: 'old run' }), line(10, { type: 'done' })));
  fs.writeFileSync(path.join(d, U(2) + '.jsonl'), log(line(0, { type: 'run', prompt: 'use token=abcd1234efgh5678 please' }), line(10, { type: 'tool_start', id: 'a', name: 'run_command', args: { command: 'echo' } }), line(20, { type: 'tool_result', id: 'a', ok: true, output: 'Authorization: Bearer abc.def.ghi' }), line(30, { type: 'done' })));
  fs.writeFileSync(path.join(d, 'notes.txt'), 'x');
  fs.writeFileSync(path.join(d, U(3) + '.jsonl'), '');
  const old = Date.now() / 1000 - 30 * 86400;
  fs.utimesSync(path.join(d, U(1) + '.jsonl'), old, old);
  const l = listTraces(d);
  assert.deepEqual(l.map((x) => x.id), [U(2), U(1)]);
  assert.ok(!l[0].prompt.includes('abcd1234efgh5678'));
  const t = readTrace(d, U(2));
  assert.ok(!JSON.stringify(t).includes('abc.def.ghi'));
  assert.equal(clearTraces(d, 7), 1);
  assert.deepEqual(listTraces(d).map((x) => x.id), [U(2)]);
  deleteTrace(d, U(2));
  assert.deepEqual(listTraces(d), []);
  assert.deepEqual(listTraces(path.join(d, 'nope')), []);
});

test('a huge log is read from its start and end only', () => {
  const d = mk();
  const f = path.join(d, U(9) + '.jsonl');
  const filler = line(5, { type: 'token', text: 'y'.repeat(900) }) + '\n';
  fs.writeFileSync(f, line(0, { type: 'run', prompt: 'big one' }) + '\n' + filler.repeat(4000) + line(9000, { type: 'done' }) + '\n');
  const l = listTraces(d);
  assert.equal(l.length, 1);
  assert.equal(l[0].prompt, 'big one');
  assert.equal(l[0].partial, true);
  assert.equal(l[0].outcome, 'done');
});
