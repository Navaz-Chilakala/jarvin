import test from 'node:test';
import assert from 'node:assert/strict';
import { looksLikePlan } from '../src/shared/plan';

test('a numbered or checkbox list is a plan; a plain answer or a question is not', () => {
  assert.equal(looksLikePlan('Here is the plan:\n1. Read app.py and the tests\n2. Extract the helper into utils.py\n3. Run the tests'), true);
  assert.equal(looksLikePlan('## Plan\n- [ ] add the route in server.ts\n- [ ] add a test for it\n- [x] read the existing routes'), true);
  assert.equal(looksLikePlan('The bug is in line 12 of app.py: the loop never ends because i is not incremented.'), false);
  assert.equal(looksLikePlan('Which framework do you use?\n1. Express\n2. Fastify'), false);
  assert.equal(looksLikePlan(''), false);
});
