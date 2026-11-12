import test from 'node:test';
import assert from 'node:assert/strict';
import { subagentWorktrees } from '../src/main/tools';

test('subagentWorktrees registry can track and remove records', () => {
  const rec = { id: 'x', task: 't', path: 'p', branch: 'b' };
  subagentWorktrees.set('x', rec);
  assert.equal(subagentWorktrees.get('x')?.id, 'x');
  subagentWorktrees.delete('x');
  assert.equal(subagentWorktrees.has('x'), false);
});