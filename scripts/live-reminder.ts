/** Optional integration check with the installed Ollama model and an isolated temporary store. */
import { runAgent } from '../src/main/agent';
import { builtinTools } from '../src/main/tools';
import { ReminderStore } from '../src/main/reminders';
import type { Settings } from '../src/shared/types';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-reminder-live-'));
const store = new ReminderStore(path.join(root, 'reminders.json'));
const history: any[] = [{ role: 'user', content: 'Remind me in 5 minutes to drink water.' }];
const settings = { baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:4b', numCtx: 16384, temperature: 0.2, maxSteps: 5 } as Settings;
runAgent({
  settings, history, tools: builtinTools,
  system: `You are Jarvin. Current PC local date and time: ${new Date().toString()}. Use create_reminder when asked to set a reminder.`,
  ctx: { root, signal: AbortSignal.timeout(120_000), createReminder: (text, dueAt) => { store.create(text, dueAt); } },
  approve: async (tool) => tool.name === 'create_reminder',
  emit: (e) => { if (e.type === 'tool_start') console.log(`Tool: ${e.name}`); if (e.type === 'tool_result') console.log(`Result: ${e.ok ? 'ok' : 'failed'} ${e.output}`); },
}).then(() => {
  const records = store.list();
  if (records.length !== 1 || !/water/i.test(records[0].text) || Math.abs(records[0].dueAt - Date.now() - 300_000) > 30_000) throw new Error('Model did not create the expected reminder.');
  console.log('Real Qwen reminder tool check passed using temporary data.');
}).catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
