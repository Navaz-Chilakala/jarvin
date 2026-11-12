import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revertHunkText, changeAtLine, type LineChange } from '../src/shared/hunks';

const ch = (os: number, oe: number, ms: number, me: number): LineChange => ({ originalStartLineNumber: os, originalEndLineNumber: oe, modifiedStartLineNumber: ms, modifiedEndLineNumber: me });

test('revert a modified line', () => {
  assert.equal(revertHunkText('a\nb\nc\n', 'a\nB\nc\n', ch(2, 2, 2, 2)), 'a\nb\nc\n');
});
test('revert an insertion removes the added lines', () => {
  assert.equal(revertHunkText('a\nc\n', 'a\nb1\nb2\nc\n', ch(1, 0, 2, 3)), 'a\nc\n');
});
test('revert a deletion puts the lines back', () => {
  assert.equal(revertHunkText('a\nb\nc\n', 'a\nc\n', ch(2, 2, 1, 0)), 'a\nb\nc\n');
});
test('revert one hunk leaves the others', () => {
  const o = 'one\ntwo\nthree\nfour\n';
  const m = 'ONE\ntwo\nthree\nFOUR\n';
  assert.equal(revertHunkText(o, m, ch(4, 4, 4, 4)), 'ONE\ntwo\nthree\nfour\n');
});
test('revert a deletion at the very top', () => {
  assert.equal(revertHunkText('x\na\n', 'a\n', ch(1, 1, 0, 0)), 'x\na\n');
});
test('changeAtLine picks the containing or next change', () => {
  const list = [ch(1, 1, 1, 1), ch(5, 6, 5, 7)];
  assert.equal(changeAtLine(list, 1), 0);
  assert.equal(changeAtLine(list, 3), 1);
  assert.equal(changeAtLine(list, 6), 1);
  assert.equal(changeAtLine(list, 99), 1);
  assert.equal(changeAtLine([], 1), -1);
});
