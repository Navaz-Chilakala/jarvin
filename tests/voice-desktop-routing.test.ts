import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/main/agent';
import type { Settings } from '../src/shared/types';

test('direct voice scrolling uses the approved desktop tool and reports input, not verified success', async () => {
  for (const allow of [true, false]) {
    const events: any[] = [], calls: any[] = [];
    const history: any[] = [{ role: 'user', content: 'Scroll down in the currently focused application by 3 steps.' }];
    const result = await runAgent({
      settings: { baseUrl: 'http://127.0.0.1:1', model: 'test', maxSteps: 3, numCtx: 4096 } as Settings,
      history, system: '', ctx: { root: '.', signal: AbortSignal.timeout(5000) },
      tools: [{ name: 'desktop_scroll', description: '', parameters: {}, risk: 'exec', run: async args => { calls.push(args); return '{"sent":true}'; } }],
      emit: event => events.push(event), approve: async () => allow,
    });
    assert.equal(result, 'finished');
    assert.deepEqual(calls, allow ? [{ direction: 'down', amount: 3 }] : []);
    assert.ok(events.some(event => event.type === 'tool_start' && event.name === 'desktop_scroll'));
    assert.match(history.at(-1).content, allow ? /sent a scroll down/i : /not approved/i);
  }
});
