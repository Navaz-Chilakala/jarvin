import { test } from "node:test";
import assert from "node:assert/strict";

test('looksToolless flags replies that say the model cannot act', async () => {
  const { looksToolless } = await import('../src/main/agent');
  assert.equal(looksToolless("I'm a text-based AI assistant, so I don't have the ability to hear audio."), true);
  assert.equal(looksToolless("I can't open apps directly."), true);
  assert.equal(looksToolless('Done. Settings is open.'), false);
});

test('announcesAction flags a reply that promises an action', async () => {
  const { announcesAction } = await import('../src/main/agent');
  assert.equal(announcesAction("I don't see the Calculator app anymore. Let me try to open it again for you."), true);
  assert.equal(announcesAction("I'll check the window list now."), true);
  assert.equal(announcesAction('The result is 84.'), false);
  assert.equal(announcesAction('Should I open it again?'), false);
  assert.equal(announcesAction('x'.repeat(500) + ' let me try'), false);
});

test('the clock is added to the current request only, so the system prompt stays cacheable', async () => {
  const { withRunTime } = await import('../src/main/agent');
  const { buildSystemPrompt } = await import('../src/main/prompt');
  const old = { role: 'user' as const, content: 'earlier' };
  const asked = { role: 'user' as const, content: 'what time is it?' };
  const history = [old, { role: 'assistant' as const, content: 'ok' }, asked];
  const sent = withRunTime(history, asked, 'Tue Nov 10 2026 10:00:00');
  assert.equal(sent[0], old);
  assert.equal(sent[2].content, 'what time is it?\n\n[Current PC local date and time: Tue Nov 10 2026 10:00:00]');
  assert.equal(asked.content, 'what time is it?', 'the saved chat is not changed');
  const settings = { shell: 'auto', mode: 'auto', workspace: process.cwd() } as any;
  const first = buildSystemPrompt(settings, process.cwd(), true);
  assert.doesNotMatch(first, /\d{2}:\d{2}:\d{2}/, 'no timestamp in the system prompt');
  assert.equal(buildSystemPrompt(settings, process.cwd(), true), first);
});

test('announcesAction catches any promised verb', async () => {
  const { announcesAction } = await import('../src/main/agent');
  assert.equal(announcesAction('I can see the Calculator is open. Let me minimize the window for you.'), true);
  assert.equal(announcesAction('The window is now minimized.'), false);
  assert.equal(announcesAction('The volume has been set to 80%. Let me know if you need any further adjustments!'), false);
  assert.equal(announcesAction('No further tool call is needed. Let me know if you need any other adjustments!'), false);
});
