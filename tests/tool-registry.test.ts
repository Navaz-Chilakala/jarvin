import test from 'node:test';
import assert from 'node:assert/strict';
import { builtinTools } from '../src/main/tools';

test('built-in tools have unique names so model calls resolve to the advertised tool', () => {
  const seen = new Set<string>();
  for (const tool of builtinTools) {
    assert.equal(seen.has(tool.name), false, `Duplicate tool name: ${tool.name}`);
    seen.add(tool.name);
  }
});
