import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from '../src/main/agent';
import { builtinTools } from '../src/main/tools';
import { ReminderStore } from '../src/main/reminders';
import type { Settings } from '../src/shared/types';

async function main() {
  const tools = builtinTools.filter(t => ['read_file', 'edit_file', 'write_file', 'create_reminder'].includes(t.name));
  for (const model of ['qwen3:8b', 'qwen3.5:4b']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvin-compare-'));
    try {
      const store = new ReminderStore(path.join(root, 'reminders.json'));
      fs.writeFileSync(path.join(root, 'note.txt'), 'Keep this line.\nColour: amber\n');
      const requests = [
        'In note.txt replace amber with green and preserve everything else.',
        'Remind me in five minutes to drink water.',
        'Read note.txt and copy its complete contents into copy.txt.',
      ];
      for (const [i, request] of requests.entries()) {
        const start = Date.now();
        const calls: string[] = [];
        const status = await runAgent({
          settings: { baseUrl: 'http://127.0.0.1:11434', model, numCtx: 16384, temperature: 0, maxSteps: 6 } as Settings,
          system: 'You are Jarvin. Use tools to perform the request. Report the result briefly.',
          history: [{ role: 'user', content: request }], tools,
          ctx: { root, signal: AbortSignal.timeout(120_000), createReminder: (text, at, repeat) => { store.create(text, at, repeat); } },
          approve: async () => true, emit(e) { if (e.type === 'tool_start') calls.push(e.name); },
        });
        const expected = 'Keep this line.\nColour: green\n';
        const reminders = store.list();
        const matches = i === 1
          ? reminders.length === 1 && /water/i.test(reminders[0].text) && reminders[0].dueAt >= start + 295000 && reminders[0].dueAt <= Date.now() + 305000
          : fs.readFileSync(path.join(root, i === 0 ? 'note.txt' : 'copy.txt'), 'utf8') === expected;
        console.log(JSON.stringify({ model, request, status, passed: status === 'finished' && matches, seconds: (Date.now()-start)/1000, calls }));
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
