import test from 'node:test';
import assert from 'node:assert/strict';
import { isSimpleChromeLaunch } from '../src/main/browser-policy';
import { runAgent } from '../src/main/agent';
import type { Settings } from '../src/shared/types';

test('recognizes only complete requests to open Chrome', () => {
  for (const phrase of ['Open Chrome', 'Can you please open the chrome?', 'Hey there, win! Can you please open the chrome?', 'Launch Google Chrome browser please']) assert.equal(isSimpleChromeLaunch(phrase), true, phrase);
  for (const phrase of ['Open Chrome and search cats', 'Do not open Chrome', 'Open Chrome settings', 'Should I open Chrome?', 'Explain how to open Chrome', 'Close Chrome', 'Open Chrome for cats']) assert.equal(isSimpleChromeLaunch(phrase), false, phrase);
});

test('a direct launch uses the regular approval and tool path without asking the model for a search', async () => {
  for (const allowed of [true, false]) {
    let called = 0, approved = 0; const events: any[] = [];
    const history: any[] = [{ role: 'user', content: 'Hey there, win! Can you please open the chrome?' }];
    const result = await runAgent({
      settings: { baseUrl: 'http://127.0.0.1:1', model: 'test', maxSteps: 3, numCtx: 4096 } as Settings,
      history, system: 'test', ctx: { root: '.', signal: AbortSignal.timeout(5000) },
      tools: [{ name: 'launch_app', description: '', parameters: {}, risk: 'exec', run: async (args) => { called++; assert.deepEqual(args, { app: 'Google Chrome' }); return 'Started Chrome'; } }],
      emit: event => events.push(event), approve: async () => { approved++; return allowed; },
    });
    assert.equal(result, 'finished'); assert.equal(approved, 1); assert.equal(called, allowed ? 1 : 0);
    assert.ok(events.some(e => e.type === 'tool_start' && e.name === 'launch_app'));
    assert.match(history.at(-1).content, allowed ? /asked Windows to open/i : /not approved/i);
  }
});

test('a failed or blocked direct launch does not claim success', async () => {
  for (const blocked of [false, true]) {
    const history: any[] = [{ role: 'user', content: 'Open Chrome.' }]; let called = false;
    await runAgent({
      settings: { baseUrl: 'http://127.0.0.1:1', model: 'test', maxSteps: 3, numCtx: 4096 } as Settings,
      history, system: '', ctx: { root: '.', signal: AbortSignal.timeout(5000) },
      tools: [{ name: 'launch_app', description: '', parameters: {}, risk: 'exec', run: async () => { called = true; throw new Error('not installed'); } }],
      approve: async () => true, emit: () => {},
      hooks: { pre: async () => blocked ? 'blocked by test hook' : null, post: async () => '' },
    });
    assert.equal(called, !blocked); assert.match(history.at(-1).content, /couldn’t open Chrome/);
  }
});
