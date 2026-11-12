import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripFences, cleanEdit, cleanCompletion, shouldAutocomplete, editMessages, completeMessages } from '../src/shared/inline';

test('stripFences removes fences and think blocks', () => {
  assert.equal(stripFences('```ts\nconst a = 1;\n```'), 'const a = 1;');
  assert.equal(stripFences('<think>hmm</think>\nconst b = 2;'), '\nconst b = 2;');
  assert.equal(stripFences('plain'), 'plain');
});

test('cleanEdit keeps trailing newline shape of the original', () => {
  assert.equal(cleanEdit('```\nfoo\nbar\n```', 'x\ny\n'), 'foo\nbar\n');
  assert.equal(cleanEdit('foo\n\n', 'x'), 'foo');
});

test('cleanCompletion drops echoed line start, caps lines and removes duplicate suffix', () => {
  assert.equal(cleanCompletion('const total = items.length;', 'const total = ', ''), 'items.length;');
  assert.equal(cleanCompletion('a\nb\nc\nd', '  ', '', 2), 'a\nb');
  assert.equal(cleanCompletion('x + y)', 'foo(', ')'), 'x + y');
  assert.equal(cleanCompletion('   \n', 'foo', ''), '');
});

test('shouldAutocomplete gates noisy positions', () => {
  assert.equal(shouldAutocomplete('', ''), false);
  assert.equal(shouldAutocomplete('a', ''), false);
  assert.equal(shouldAutocomplete('const x = ', ''), true);
  assert.equal(shouldAutocomplete('foo(', ')'), true);
  assert.equal(shouldAutocomplete('const x = ', 'bar baz'), false);
});

test('prompts mention the instruction, and generation mode is detected', () => {
  const edit = editMessages({ language: 'ts', instruction: 'rename x', before: 'b', code: 'let x', after: 'a' });
  assert.match(edit[1].content, /Instruction: rename x/);
  assert.match(edit[0].content, /Rewrite the SELECTED code/);
  const gen = editMessages({ language: 'ts', instruction: 'add fn', before: '', code: '', after: '' });
  assert.match(gen[0].content, /code generation/);
  assert.match(completeMessages({ language: 'ts', prefix: 'a', suffix: 'b' })[1].content, /a<CURSOR>b/);
});
