import test from 'node:test';
import assert from 'node:assert/strict';
import { runGraph } from '../src/main/graph';

test('runGraph executes dependency-ordered nodes and returns results', async () => {
  const run = await runGraph([
    { id: 'a', run: async () => 1 },
    { id: 'b', deps: ['a'], run: async ({ results }) => (results.get('a') as number) + 2 },
  ]);
  assert.equal(run.completed, true);
  assert.equal(run.results.get('a'), 1);
  assert.equal(run.results.get('b'), 3);
  assert.deepEqual(run.order, ['a', 'b']);
});

test('runGraph reports dependency failure', async () => {
  const run = await runGraph([
    { id: 'a', run: async () => { throw new Error('boom'); } },
    { id: 'b', deps: ['a'], run: async () => 'ok' },
  ]);
  assert.equal(run.completed, false);
  assert.equal(run.states.get('a'), 'failed');
  assert.equal(run.states.get('b'), 'pending');
});
test('runGraph detects cycles/unresolved dependencies', async () => {
  const run = await runGraph([
    { id: 'a', deps: ['b'], run: async () => 1 },
    { id: 'b', deps: ['a'], run: async () => 2 },
  ]);
  assert.equal(run.completed, false);
});
