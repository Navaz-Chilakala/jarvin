import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFront, combineRules, parsePersona, personaAllows, mergePersonas, parseHooks, hooksFor } from '../src/shared/ext';

test('frontmatter parsing', () => {
  const f = parseFront('---\ndescription: "Hi there"\ntools: read-only\n---\nBody text\n');
  assert.equal(f.meta.description, 'Hi there');
  assert.equal(f.body, 'Body text');
  assert.deepEqual(parseFront('no front').meta, {});
});

test('rules combine in order, skip disabled/empty, respect budget', () => {
  const r = combineRules([
    { label: 'AGENTS.md', text: 'Use tabs.' },
    { label: 'off.md', text: '---\nenabled: false\n---\nIgnore me' },
    { label: 'empty.md', text: '  ' },
    { label: 'big.md', text: 'x'.repeat(5000) },
  ], 1000);
  assert.deepEqual(r.used, ['AGENTS.md', 'big.md']);
  assert.deepEqual(r.truncated, ['big.md']);
  assert.match(r.text, /Use tabs\./);
  assert.ok(!/Ignore me/.test(r.text));
  assert.ok(r.text.length < 1300);
  assert.equal(combineRules([]).text, '');
});

test('personas: parsing, tool filtering, override of built-ins', () => {
  const p = parsePersona('docs', '---\ndescription: d\ntools: read_file, write_file\nmodel: m1\n---\nWrite docs.')!;
  assert.deepEqual(p.tools, ['read_file', 'write_file']);
  assert.equal(p.model, 'm1');
  assert.equal(personaAllows(p, { name: 'write_file', risk: 'write' }), true);
  assert.equal(personaAllows(p, { name: 'run_command', risk: 'exec' }), false);
  const ro = parsePersona('ro', '---\ntools: read-only\n---\nx')!;
  assert.equal(personaAllows(ro, { name: 'read_file', risk: 'read' }), true);
  assert.equal(personaAllows(ro, { name: 'edit_file', risk: 'write' }), false);
  assert.equal(personaAllows(undefined, { name: 'x', risk: 'exec' }), true);
  assert.equal(parsePersona('bad name!', 'x'), null);
  assert.equal(parsePersona('empty', '---\ntools: all\n---\n'), null);
  const m = mergePersonas([{ ...ro, name: 'reviewer', prompt: 'custom' }]);
  assert.equal(m.find((x) => x.name === 'reviewer')!.prompt, 'custom');
  assert.ok(m.some((x) => x.name === 'debugger'));
});

test('hooks: validation and matching', () => {
  const { hooks, errors } = parseHooks(JSON.stringify({ hooks: [
    { event: 'PreToolUse', tool: 'run_command', match: 'git push', command: 'exit 2' },
    { event: 'PostToolUse', tool: 'edit_file|write_file', command: 'fmt', timeout: 999 },
    { event: 'Stop', command: 'echo done' },
    { event: 'Nope', command: 'x' },
    { event: 'Stop' },
    { event: 'PreToolUse', tool: '(', command: 'x' },
  ] }));
  assert.equal(hooks.length, 3);
  assert.equal(errors.length, 3);
  assert.equal(hooks[1].timeout, 120);
  assert.equal(hooksFor(hooks, 'PreToolUse', 'run_command', { command: 'git push origin' }).length, 1);
  assert.equal(hooksFor(hooks, 'PreToolUse', 'run_command', { command: 'git status' }).length, 0);
  assert.equal(hooksFor(hooks, 'PostToolUse', 'write_file', { path: 'a.ts' }).length, 1);
  assert.equal(hooksFor(hooks, 'PostToolUse', 'read_file', { path: 'a.ts' }).length, 0);
  assert.equal(hooksFor(hooks, 'Stop', '', {}).length, 1);
  assert.ok(parseHooks('{oops').errors[0].includes('not valid JSON'));
  assert.equal(parseHooks('{}').hooks.length, 0);
});
